#!/usr/bin/env node
/**
 * cohostctl: a second client of the same ServiceController the dashboard uses.
 *
 *   cohostctl status [service]
 *   cohostctl start|stop|restart <service> [--mode resume|fresh] [--isolated]
 *   cohostctl consolidate     one-shot viewer-note pass (the compose `consolidate` job; best-effort, works with the stack down)
 *
 * Always drives services through the compose runtime. Honours CONTROL_ADVANCED and REDIS_URL.
 * It runs as the invoking user, so CONTROL_ENABLED / CONTROL_TOKEN (the dashboard's HTTP gate) do not apply.
 * Publishes `service.lifecycle` with by:"cohostctl".
 */
import { parseArgs } from "node:util";
import { Bus, type HeartbeatEvent } from "@cohost/bus";
import { ComposeRuntime, type RuntimeResult } from "./runtime.js";
import { ServiceController, type ActionOptions, type GroupResetter, type LifecycleRecord } from "./controller.js";
import { HealthTracker, type ServiceHealth } from "./health.js";
import { SERVICE_MANIFEST } from "./manifest.js";

export type CliCommand =
  | { cmd: "status"; id?: string }
  | { cmd: "start" | "stop" | "restart"; id: string; opts: ActionOptions }
  | { cmd: "consolidate" };

export const USAGE = `usage:
  cohostctl status [service]
  cohostctl start|stop|restart <service> [--mode resume|fresh] [--isolated]
  cohostctl consolidate        run the viewer-note consolidation one-shot (exit 0 ok, 1 failed)`;

export class UsageError extends Error {}

// @spec CTRL-CLI-001
export function parseCli(argv: readonly string[]): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { mode: { type: "string" }, isolated: { type: "boolean", default: false } },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const [cmd, id, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const { mode, isolated } = parsed.values;
  if (mode !== undefined && mode !== "resume" && mode !== "fresh") throw new UsageError(`--mode must be resume or fresh, got ${JSON.stringify(mode)}`);
  if (cmd === "status") {
    if (mode !== undefined || isolated) throw new UsageError("status takes no options");
    return { cmd, ...(id ? { id } : {}) };
  }
  if (cmd === "consolidate") {
    if (id) throw new UsageError("consolidate takes no arguments");
    if (mode !== undefined || isolated) throw new UsageError("consolidate takes no options");
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
  consolidate: () => Promise<RuntimeResult>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Returns the process exit code: 0 ok, 1 failed or refused, 2 usage. */
// @spec CTRL-CLI-002, CTRL-CLI-003, CTRL-CLI-008
export async function runCli(argv: readonly string[], d: CliDeps): Promise<number> {
  let c: CliCommand;
  try { c = parseCli(argv); } catch (e) {
    d.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
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
  if (c.cmd === "consolidate") {
    const r = await d.consolidate();
    if (!r.ok) { d.err(`consolidate failed: ${r.detail ?? "unknown error"}`); return 1; }
    d.out(`consolidate: ok${r.detail ? ` (${r.detail})` : ""}`);
    return 0;
  }
  const r = await (c.cmd === "stop" ? d.controller.stop(c.id) : d.controller[c.cmd](c.id, c.opts));
  if (r.refused) { d.err(`refused (${r.refused}): ${r.detail ?? ""}`); return 1; }
  if (!r.ok) { d.err(`${c.cmd} ${c.id} failed: ${r.detail ?? "unknown error"}`); return 1; }
  d.out(`${c.cmd} ${c.id}: ok${r.detail ? ` (${r.detail})` : ""}`);
  return 0;
}

/** Compose is the only runtime. */
export function buildRuntime(): ComposeRuntime {
  return new ComposeRuntime();
}

// @spec CTRL-CLI-002, CTRL-CLI-004, CTRL-CLI-009
async function main(): Promise<number> {
  // Opened on first use, so `consolidate` (run when redis may be stopped) never connects.
  let bus: Bus | undefined;
  const getBus = (): Bus => (bus ??= new Bus("cohostctl"));
  try {
    const runtime = buildRuntime();
    const groups: GroupResetter = { resetGroup: (g) => getBus().resetGroup(g) };
    const controller = new ServiceController({
      runtime,
      groups,
      by: "cohostctl",
      advanced: process.env.CONTROL_ADVANCED === "1",
      audit: async (rec: LifecycleRecord) => { await getBus().publish("service.lifecycle", rec); },
    });
    const health = async () => {
      const tracker = new HealthTracker({ known: SERVICE_MANIFEST.filter((s) => !s.infra && s.pnpmFilter).map((s) => s.id) });
      const recent: HeartbeatEvent[] = await getBus().recentHealth(200);
      tracker.seed(recent.map((h) => ({ ts: h.ts, data: h.data })));
      return tracker.snapshot();
    };
    return await runCli(process.argv.slice(2), { controller, health, consolidate: () => runtime.consolidate(), out: console.log, err: console.error });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return e instanceof UsageError ? 2 : 1;
  } finally {
    bus?.stop();
  }
}

// @spec CTRL-CLI-005
if (process.argv[1]?.endsWith("cli.js")) {
  main().then((code) => process.exit(code), () => process.exit(1));
}
