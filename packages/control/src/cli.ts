#!/usr/bin/env node
/**
 * cohostctl: a second client of the same ServiceController the dashboard uses.
 *
 *   cohostctl status [service]
 *   cohostctl start|stop|restart <service> [--mode resume|fresh] [--isolated]
 *   cohostctl latency [--count N]  speech- and vision-path latency per stage from bus history (read-only, takes no lock)
 *   cohostctl consolidate     one-shot viewer-note pass (the compose `consolidate` job; best-effort, works with the stack down)
 *   cohostctl reembed         one-shot re-embedding of stored memory vectors after an embedder change (the compose `reembed` job)
 *   cohostctl launch          build the images, bring the whole stack up and wait until it is ready (never opens the bus)
 *   cohostctl rebuild         the same as launch (never opens the bus)
 *   cohostctl stop-all        stop every container of the stack, never removing any (never opens the bus)
 *   cohostctl restart-all     restart every running application service
 *   cohostctl deliver         deliver credentials to every running unit that waits for them or was started since its last delivery
 *
 * Always drives services through the compose runtime. Honours CONTROL_ADVANCED and REDIS_URL.
 * It runs as the invoking user (the OS user and the Docker socket are its boundary), so CONTROL_TOKEN, the dashboard's lock,
 * does not apply; it never reads it, and refuses to start anything while `.env` or its environment defines it.
 * Publishes `service.lifecycle` with by:"cohostctl". Every command but `status` and `latency` holds the lifecycle lock shared
 * with the dashboard (a held lock is a refusal, exit 1).
 */
import { parseArgs } from "node:util";
import { Bus, type BusEvent, type HeartbeatEvent } from "@cohost/bus";
import { findWorkspaceRoot, urls } from "@cohost/config";
import { ComposeRuntime, type RuntimeResult } from "./runtime.js";
import { ServiceController, type ActionOptions, type GroupResetter, type LifecycleRecord } from "./controller.js";
import { StackController, ONE_SHOTS, type StackResult } from "./stack.js";
import { LifecycleLock, type LockResult } from "./lock.js";
import { HealthTracker, withContainerRestarts, type ServiceHealth } from "./health.js";
import { appServiceIds } from "./manifest.js";
import { latencyReport } from "./latency.js";
import { configRefusal } from "./config-gate.js";
import { ComposeProvisioner, storeSource } from "./provision.js";
import { resolveDockerBin, dockerEnv } from "./docker.js";
import { defaultExec, type ExecFile } from "./runtime.js";
import { WAITING_DETAIL as WAITING } from "./healthcheck.js";

export type CliCommand =
  | { cmd: "status"; id?: string }
  | { cmd: "start" | "stop" | "restart"; id: string; opts: ActionOptions }
  | { cmd: "latency"; count: number }
  | { cmd: "consolidate" }
  | { cmd: "reembed" }
  | { cmd: "launch" }
  | { cmd: "rebuild" }
  | { cmd: "stop-all" }
  | { cmd: "restart-all" }
  | { cmd: "deliver" };

export const USAGE = `usage:
  cohostctl status [service]
  cohostctl start|stop|restart <service> [--mode resume|fresh] [--isolated]
  cohostctl latency [--count N]  per-stage p50 and p95 of the speech and vision paths from the last N bus events (default 5000)
  cohostctl consolidate        run the viewer-note consolidation one-shot (exit 0 ok, 1 failed)
  cohostctl reembed            re-embed stored memory vectors after changing the embedder (exit 0 ok, 1 failed)
  cohostctl launch             build the images, bring the whole stack up and wait until it is ready
  cohostctl rebuild            the same as launch
  cohostctl stop-all           stop every container of the stack (nothing is removed)
  cohostctl restart-all        restart every running application service
  cohostctl deliver            deliver credentials to every running unit that waits for them or was started since its last delivery`;

export class UsageError extends Error {}

// @spec CTRL-CLI-001, CTRL-LAT-001
export function parseCli(argv: readonly string[]): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { mode: { type: "string" }, isolated: { type: "boolean", default: false }, count: { type: "string" } },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const [cmd, id, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const { mode, isolated, count } = parsed.values;
  if (count !== undefined && cmd !== "latency") throw new UsageError("--count is only for latency");
  if (mode !== undefined && mode !== "resume" && mode !== "fresh") throw new UsageError(`--mode must be resume or fresh, got ${JSON.stringify(mode)}`);
  if (cmd === "status") {
    if (mode !== undefined || isolated) throw new UsageError("status takes no options");
    return { cmd, ...(id ? { id } : {}) };
  }
  if (cmd === "latency") {
    if (id) throw new UsageError("latency takes no arguments");
    if (mode !== undefined || isolated) throw new UsageError("latency takes only --count");
    if (count !== undefined && !/^[1-9][0-9]*$/.test(count)) throw new UsageError(`--count must be a positive integer, got ${JSON.stringify(count)}`);
    return { cmd, count: count === undefined ? 5000 : Number(count) };
  }
  if (cmd === "consolidate" || cmd === "reembed") {
    if (id) throw new UsageError(`${cmd} takes no arguments`);
    if (mode !== undefined || isolated) throw new UsageError(`${cmd} takes no options`);
    return { cmd };
  }
  if (cmd === "launch" || cmd === "rebuild" || cmd === "stop-all" || cmd === "restart-all" || cmd === "deliver") {
    if (id) throw new UsageError(`${cmd} takes no arguments`);
    if (mode !== undefined || isolated) throw new UsageError(`${cmd} takes no options`);
    return { cmd };
  }
  if (cmd === "start" || cmd === "stop" || cmd === "restart") {
    if (!id) throw new UsageError(`${cmd} needs a service name`);
    if (cmd === "stop" && (mode !== undefined || isolated)) throw new UsageError("stop takes no options");
    return { cmd, id, opts: { ...(mode ? { mode } : {}), ...(isolated ? { isolated: true } : {}) } };
  }
  throw new UsageError(cmd ? `unknown command: ${cmd}` : "missing command");
}

export interface CliDeps {
  controller: Pick<ServiceController, "start" | "stop" | "restart">;
  health: () => Promise<ServiceHealth[]>;
  /** Bus history, oldest first (`Bus.recent`). */
  recent: (count: number) => Promise<BusEvent[]>;
  consolidate: () => Promise<RuntimeResult>;
  reembed: () => Promise<RuntimeResult>;
  /** The whole-stack actions; `restartAll` runs through `controller`. */
  stack: {
    launch(onPhase: (phase: string) => void): Promise<StackResult>;
    rebuild(onPhase: (phase: string) => void): Promise<StackResult>;
    stopAll(): Promise<StackResult>;
    restartAll(): Promise<StackResult>;
  };
  /** Delivers to every running unit that waits or was started since its last delivery (CTRL-CLI-019). */
  deliver: () => Promise<DeliverResult>;
  /** The lifecycle lock shared with the dashboard (CTRL-LOCK-004); absent means no locking. */
  lock?: { tryAcquire(action: string): LockResult };
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Returns the process exit code: 0 ok, 1 failed or refused, 2 usage. */
// @spec CTRL-LAT-002, CTRL-CLI-002, CTRL-CLI-003, CTRL-CLI-008, CTRL-CLI-010, CTRL-CLI-011, CTRL-CLI-012, CTRL-LOCK-004
export async function runCli(argv: readonly string[], d: CliDeps): Promise<number> {
  let c: CliCommand;
  try { c = parseCli(argv); } catch (e) {
    d.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (c.cmd === "status" || c.cmd === "latency" || !d.lock) return runCommand(c, d);
  const held = d.lock.tryAcquire(c.cmd);
  if (!held.ok) { d.err(`refused: ${held.detail}`); return 1; }
  try { return await runCommand(c, d); } finally { held.release(); }
}

async function runCommand(c: CliCommand, d: CliDeps): Promise<number> {
  if (c.cmd === "status") {
    const all = await d.health();
    const rows = c.id ? all.filter((s) => s.service === c.id) : all;
    if (c.id && rows.length === 0) { d.err(`unknown service: ${c.id}`); return 1; }
    for (const s of rows) {
      const age = s.lastSeenAgeMs == null ? "never" : `${Math.round(s.lastSeenAgeMs / 1000)}s ago`;
      d.out(`${s.service.padEnd(10)} ${s.state.padEnd(13)} ${(s.heartbeat?.mode ?? "-").padEnd(5)} ${age}`);
    }
    return 0;
  }
  if (c.cmd === "latency") {
    for (const line of latencyReport(await d.recent(c.count), c.count)) d.out(line);
    return 0;
  }
  if (c.cmd === "consolidate") {
    const r = await d.consolidate();
    if (!r.ok) { d.err(`consolidate failed: ${r.detail ?? "unknown error"}`); return 1; }
    d.out(`consolidate: ok${r.detail ? ` (${r.detail})` : ""}`);
    return 0;
  }
  if (c.cmd === "reembed") {
    const r = await d.reembed();
    if (!r.ok) { d.err(`reembed failed: ${r.detail ?? "unknown error"}`); return 1; }
    d.out(`reembed: ok${r.detail ? ` (${r.detail})` : ""}`);
    return 0;
  }
  if (c.cmd === "launch" || c.cmd === "rebuild") {
    const name = c.cmd;
    const r = await d.stack[name]((phase) => d.out(`${name}: ${phase}`));
    for (const s of r.services ?? []) {
      if (ONE_SHOTS.includes(s.service)) continue;
      d.out(`${s.service.padEnd(12)} ${s.status}${s.health ? ` ${s.health}` : ""}`);
    }
    if (!r.ok) { d.err(`${name} failed: ${r.detail ?? "unknown error"}`); return 1; }
    d.out(`${name}: ok${r.detail ? ` (${r.detail})` : ""}`);
    return 0;
  }
  if (c.cmd === "stop-all") {
    const r = await d.stack.stopAll();
    if (!r.ok) { d.err(`stop-all failed: ${r.detail ?? "unknown error"}`); return 1; }
    d.out("stop-all: ok");
    d.out("run `cohostctl consolidate` to tidy viewer notes");
    return 0;
  }
  if (c.cmd === "deliver") {
    const r = await d.deliver();
    if (r.warning) d.err(`warning: ${r.warning}`);
    for (const u of r.delivered) d.out(`delivered credentials to ${u}`);
    for (const f of r.failures) d.err(f);
    if (r.delivered.length === 0 && r.failures.length === 0) d.out("deliver: no unit waits for credentials");
    return r.failures.length === 0 ? 0 : 1;
  }
  if (c.cmd === "restart-all") {
    const r = await d.stack.restartAll();
    for (const x of r.restarts ?? []) {
      if (x.ok) d.out(`restart ${x.id}: ok`);
      else d.err(`restart ${x.id} failed: ${x.detail ?? "unknown error"}`);
    }
    if (!r.ok && (r.restarts ?? []).length === 0) d.err(`restart-all failed: ${r.detail ?? "unknown error"}`);
    return r.ok ? 0 : 1;
  }
  const r = await (c.cmd === "stop" ? d.controller.stop(c.id) : d.controller[c.cmd](c.id, c.opts));
  if (r.refused) { d.err(`refused (${r.refused}): ${r.detail ?? ""}`); return 1; }
  if (!r.ok) { d.err(`${c.cmd} ${c.id} failed: ${r.detail ?? "unknown error"}`); return 1; }
  d.out(`${c.cmd} ${c.id}: ok${r.detail ? ` (${r.detail})` : ""}`);
  return 0;
}

/**
 * The re-delivery over the settings store and the docker CLI, under the workspace root (STORE-DLV-005, CTRL-CLI-019): what
 * `cohostctl deliver` runs once and the dashboard runs at its start and while it runs.
 */
export function storeRedeliver(env: NodeJS.ProcessEnv, exec: ExecFile = defaultExec): NonNullable<CliWiring["redeliver"]> {
  return async (sets) => {
    const docker = resolveDockerBin(env);
    if (!docker.ok) return { delivered: [], failures: [docker.detail] };
    const root = findWorkspaceRoot() ?? process.cwd();
    const source = storeSource(root);
    try {
      const p = new ComposeProvisioner({
        root, env, source,
        docker: (args, opts = {}) => exec(docker.bin, args, { env: args[0] === "compose" ? dockerEnv(docker.bin, env, {}) : env, cwd: root, ...opts }),
      });
      return await p.redeliver(sets);
    } finally {
      source.close();
    }
  };
}

/** Compose is the only runtime. */
export function buildRuntime(): ComposeRuntime {
  // Compose finds docker-compose.yml, .env and the project name from its working directory, wherever cohostctl was started.
  return new ComposeRuntime({ cwd: findWorkspaceRoot() ?? process.cwd() });
}

/** The part of the bus cohostctl uses. */
export type CliBus = Pick<Bus, "publish" | "resetGroup" | "recentHealth" | "recent"> & { stop(): void | Promise<void> };

/** The stack controller as the CLI drives it. */
export type CliStack = Pick<StackController, "launch" | "rebuild" | "stopAll" | "restartAll" | "statusWithRestarts">;

/** What `cohostctl deliver` did: the units delivered to, the failures (each naming its unit), and a warning (Redis unreachable). */
export interface DeliverResult { delivered: string[]; failures: string[]; warning?: string }

/** What `executeCli` builds things with; every field defaults to the real thing. Tests inject fakes. */
export interface CliWiring {
  openBus?: () => CliBus;
  buildRuntime?: () => Pick<ComposeRuntime, "name" | "start" | "stop" | "restart" | "consolidate" | "reembed">;
  buildStack?: (onPhase: (phase: string) => void) => CliStack;
  /** The lifecycle lock; the workspace root's `data/control.lock` by default. */
  lock?: { tryAcquire(action: string): LockResult };
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The config gate (CTRL-GATE-001): a refusal text while the settings store cannot be used; the store's check by default. */
  configRefusal?: () => string | undefined | Promise<string | undefined>;
  /** The delivery of `cohostctl deliver`, given the units waiting and the units ready by their heartbeats. */
  redeliver?: (o: { waiting: ReadonlySet<string>; ready: ReadonlySet<string> }) => Promise<{ delivered: string[]; failures: string[] }>;
  /** Runs docker for the default delivery (tests). */
  exec?: ExecFile;
}

/** The commands that start a service or deliver credentials, refused while the settings store cannot be used (CTRL-CLI-018). */
const GATED = new Set(["launch", "rebuild", "start", "restart", "restart-all", "deliver", "consolidate", "reembed"]);


/**
 * The units waiting for credentials and the units ready, by each unit's newest heartbeat. A unit whose newest heartbeat is
 * `starting` with the detail `waiting for credentials` waits; one in `ready` or `degraded` holds its credentials.
 */
export function heartbeatSets(beats: readonly HeartbeatEvent[]): { waiting: Set<string>; ready: Set<string> } {
  const newest = new Map<string, HeartbeatEvent>();
  for (const h of beats) {
    const prior = newest.get(h.data.service);
    if (!prior || h.ts >= prior.ts) newest.set(h.data.service, h);
  }
  const waiting = new Set<string>();
  const ready = new Set<string>();
  for (const [service, h] of newest) {
    if (h.data.state === "starting" && h.data.detail === WAITING) waiting.add(service);
    else if (h.data.state === "ready" || h.data.state === "degraded") ready.add(service);
  }
  return { waiting, ready };
}

/** The reason, when `e` is a failure to reach Redis (error `code` `BUS_CONNECTION`, its message names the cause); otherwise undefined. */
// @spec CTRL-CLI-017
function connectFailure(e: unknown): string | undefined {
  if (!(e instanceof Error) || (e as { code?: unknown }).code !== "BUS_CONNECTION") return undefined;
  return e.message || "connection failed";
}

/** The Redis URL the bus used, without credentials. */
function redisUrl(env: NodeJS.ProcessEnv | undefined): string {
  const raw = env?.REDIS_URL ?? urls.redis();
  try { const u = new URL(raw); u.username = ""; u.password = ""; return u.toString().replace(/\/$/, ""); } catch { return "redis"; }
}

/**
 * The whole of cohostctl: parse, then build what the command needs. Arguments that do not parse never build a
 * runtime, open the bus or run Docker; the bus is opened on first use and always stopped.
 */
// @spec CTRL-CLI-018, CTRL-CLI-002, CTRL-CLI-004, CTRL-CLI-009, CTRL-CLI-010, CTRL-CLI-012, CTRL-CLI-013, CTRL-CLI-014, CTRL-CLI-015, CTRL-CLI-016, CTRL-CLI-017, CTRL-STACK-001, CTRL-LOCK-004
export async function executeCli(argv: readonly string[], w: CliWiring = {}): Promise<number> {
  const out = w.out ?? console.log;
  const err = w.err ?? console.error;
  let cmd: CliCommand;
  try { cmd = parseCli(argv); } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  // @spec CTRL-CLI-018
  if (GATED.has(cmd.cmd)) {
    let refusal: string | undefined;
    try { refusal = await (w.configRefusal ?? (() => configRefusal()))(); } catch (e) { err(e instanceof Error ? e.message : String(e)); return 1; }
    if (refusal !== undefined) { err(refusal); return 1; }
  }
  // Opened on first use, so `consolidate`, `launch`, `rebuild` and `stop-all` (run when redis may be stopped) never connect.
  let bus: CliBus | undefined;
  const getBus = (): CliBus => (bus ??= (w.openBus ?? (() => new Bus("cohostctl", undefined, undefined, { failFast: true })))());
  try {
    const runtime = (w.buildRuntime ?? buildRuntime)();
    const groups: GroupResetter = { resetGroup: (g) => getBus().resetGroup(g) };
    const controller = new ServiceController({
      runtime,
      groups,
      by: "cohostctl",
      advanced: (w.env ?? process.env).CONTROL_ADVANCED === "1",
      audit: async (rec: LifecycleRecord) => { await getBus().publish("service.lifecycle", rec); },
    });
    let phase: (p: string) => void = () => {};
    const makeStack = w.buildStack ?? ((onPhase) => new StackController({ onPhase: (_kind, p) => onPhase(p) }));
    const stackFor = (): CliStack => makeStack((p) => phase(p));
    const health = async () => {
      const tracker = new HealthTracker({ known: appServiceIds() });
      const recent: HeartbeatEvent[] = await getBus().recentHealth(200);
      tracker.seed(recent.map((h) => ({ ts: h.ts, data: h.data })));
      return withContainerRestarts(tracker.snapshot(), await stackFor().statusWithRestarts());
    };
    const stack: CliDeps["stack"] = {
      launch: (onPhase) => { phase = onPhase; return stackFor().launch(); },
      rebuild: (onPhase) => { phase = onPhase; return stackFor().rebuild(); },
      stopAll: () => stackFor().stopAll(),
      restartAll: () => stackFor().restartAll(controller),
    };
    // @spec CTRL-CLI-019
    const deliver = async (): Promise<DeliverResult> => {
      let beats: HeartbeatEvent[] = [];
      let warning: string | undefined;
      try {
        beats = await getBus().recentHealth(200);
      } catch (e) {
        const reason = connectFailure(e);
        if (reason === undefined) throw e;
        warning = `cannot reach Redis at ${redisUrl(w.env)}: ${reason}; delivering to the units started since their last delivery only`;
      }
      const redeliver = w.redeliver ?? storeRedeliver(w.env ?? process.env, w.exec);
      const r = await redeliver(heartbeatSets(beats));
      return { ...r, ...(warning ? { warning } : {}) };
    };
    return await runCli(argv, { controller, health, recent: (n) => getBus().recent(n), consolidate: () => runtime.consolidate(), reembed: () => runtime.reembed(), stack, deliver, lock: w.lock ?? new LifecycleLock({ by: "cohostctl" }), out, err });
  } catch (e) {
    const refused = connectFailure(e);
    err(refused !== undefined ? `cannot reach Redis at ${redisUrl(w.env)}: ${refused} (is the stack up? run cohostctl launch)` : e instanceof Error ? e.message : String(e));
    return e instanceof UsageError ? 2 : 1;
  } finally {
    await bus?.stop();
  }
}

// @spec CTRL-CLI-005
if (process.argv[1]?.endsWith("cli.js")) {
  executeCli(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
