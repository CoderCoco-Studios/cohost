import { findWorkspaceRoot } from "@cohost/config";
import { resolveDockerBin } from "./docker.js";
import type { ServiceController } from "./controller.js";
import { SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import { ComposeRuntime, defaultExec, execDetail, type ExecFile, type RuntimeResult } from "./runtime.js";

/** One container of the Compose project, as `docker compose ps` reports it. */
export interface ContainerStatus {
  service: string;
  status: string;
  health?: string;
  exitCode?: number;
}

export interface StackStatus {
  docker: { ok: boolean; detail?: string };
  services: ContainerStatus[];
}

export type StackActionKind = "launch" | "stop" | "restart" | "consolidate";
export type StackState = "docker-unavailable" | "stopping" | "starting" | "down" | "up" | "degraded";

export interface RestartOutcome { id: string; ok: boolean; detail?: string }

export interface StackResult {
  ok: boolean;
  detail?: string;
  /** The last status the action saw (launch, restart-all). */
  services?: ContainerStatus[];
  /** Per-unit outcomes of restart-all, in manifest order. */
  restarts?: RestartOutcome[];
}

export interface StackControllerOptions {
  exec?: ExecFile;
  /** Compose's working directory: the workspace root, else the process cwd. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  manifest?: readonly ServiceDef[];
  onPhase?: (kind: StackActionKind, phase: string) => void;
  /** PATH lookup used to find the docker binary (injectable for tests). */
  onPath?: (name: string, env: NodeJS.ProcessEnv) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Containers that run to completion; they are never waited for and never count as down or degraded. */
export const ONE_SHOTS: readonly string[] = ["models", "consolidate", "reembed"];

export const LAUNCH_TIMEOUT_MS = 30 * 60_000;
export const READY_TIMEOUT_MS = 180_000;
export const POLL_INTERVAL_MS = 2000;
export const STOP_TIMEOUT_MS = 300_000;
export const STATUS_TIMEOUT_MS = 10_000;

const isLongRunning = (c: ContainerStatus): boolean => !ONE_SHOTS.includes(c.service);
const isReady = (c: ContainerStatus): boolean => c.status === "running" && (c.health === undefined || c.health === "healthy");
const describe = (c: ContainerStatus): string => `${c.service} (${c.status}${c.health ? `, ${c.health}` : ""})`;

/** Parses `docker compose ps --format json`: a JSON array, or one JSON object per line. Throws on anything else. */
function parsePs(stdout: string): ContainerStatus[] {
  const text = stdout.trim();
  if (text === "") return [];
  const rows: unknown[] = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (!Array.isArray(rows)) throw new Error("unexpected output from docker compose ps");
  return rows.map((r) => {
    const o = r as { Service?: unknown; State?: unknown; Health?: unknown; ExitCode?: unknown };
    if (typeof o.Service !== "string" || typeof o.State !== "string") throw new Error("unexpected output from docker compose ps");
    return {
      service: o.Service, status: o.State,
      ...(typeof o.Health === "string" && o.Health !== "" ? { health: o.Health } : {}),
      ...(o.State === "exited" && typeof o.ExitCode === "number" ? { exitCode: o.ExitCode } : {}),
    };
  });
}

/**
 * The one stack state a status and the running action (if any) add up to. Pure, so the dashboard and
 * `cohostctl launch` share the readiness test.
 */
// @spec CTRL-STACK-011
export function stackState(status: StackStatus, running?: "launch" | "stop"): StackState {
  if (!status.docker.ok) return "docker-unavailable";
  if (running === "stop") return "stopping";
  if (running === "launch") return "starting";
  const long = status.services.filter(isLongRunning);
  if (!long.some((c) => c.status === "running")) return "down";
  const notReady = long.filter((c) => !isReady(c));
  if (notReady.length === 0) return "up";
  return notReady.every((c) => c.status === "running" && c.health === "starting") ? "starting" : "degraded";
}

/**
 * Whole-stack actions (launch, stop-all, restart-all, consolidate) and the Compose status probe, shared by the
 * dashboard and cohostctl. Every command is a fixed argv run without a shell; nothing a caller passes reaches one.
 */
// @spec CTRL-STACK-001, CTRL-STACK-009, CTRL-STACK-010
export class StackController {
  private exec: ExecFile;
  private cwd: string;
  private env: NodeJS.ProcessEnv;
  private manifest: readonly ServiceDef[];
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private runtime: ComposeRuntime;

  constructor(private o: StackControllerOptions = {}) {
    this.exec = o.exec ?? defaultExec;
    this.cwd = o.cwd ?? findWorkspaceRoot() ?? process.cwd();
    this.env = o.env ?? process.env;
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.runtime = new ComposeRuntime({ exec: this.exec, manifest: this.manifest, cwd: this.cwd, env: this.env, ...(o.onPath ? { onPath: o.onPath } : {}) });
  }

  private phase(kind: StackActionKind, phase: string): void {
    try { this.o.onPhase?.(kind, phase); } catch { /* a progress callback must not fail the action */ }
  }

  /** Runs one fixed `docker compose` command. */
  private async compose(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
    const docker = resolveDockerBin(this.env, this.o.onPath);
    if (!docker.ok) return { ok: false, detail: docker.detail };
    try {
      const { stdout } = await this.exec(docker.bin, ["compose", ...args], { env: this.env, cwd: this.cwd, timeoutMs });
      return { ok: true, stdout };
    } catch (err) {
      return { ok: false, detail: execDetail(err) };
    }
  }

  // @spec CTRL-STACK-008
  async status(): Promise<StackStatus> {
    const r = await this.compose(["ps", "--all", "--format", "json"], STATUS_TIMEOUT_MS);
    if (!r.ok) return { docker: { ok: false, detail: r.detail }, services: [] };
    try {
      return { docker: { ok: true }, services: parsePs(r.stdout) };
    } catch (err) {
      return { docker: { ok: false, detail: `cannot read docker compose ps output: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) }, services: [] };
    }
  }

  /** Appends `<service> exited <code>` for each one-shot that exited non-zero. */
  private withOneShotWarnings(res: StackResult, services: ContainerStatus[]): StackResult {
    const warn = services.filter((c) => ONE_SHOTS.includes(c.service) && c.status === "exited" && c.exitCode !== undefined && c.exitCode !== 0).map((c) => `${c.service} exited ${c.exitCode}`);
    if (warn.length === 0) return res;
    return { ...res, detail: [res.detail, ...warn].filter(Boolean).join("; ") };
  }

  // @spec CTRL-STACK-002, CTRL-STACK-003, CTRL-STACK-004, CTRL-STACK-005
  async launch(): Promise<StackResult> {
    this.phase("launch", "compose-up");
    const up = await this.compose(["up", "-d", "--remove-orphans"], LAUNCH_TIMEOUT_MS);
    if (!up.ok) return { ok: false, detail: up.detail };
    this.phase("launch", "waiting");
    const started = this.now();
    for (;;) {
      const st = await this.status();
      if (!st.docker.ok) return { ok: false, detail: `docker unavailable while waiting: ${st.docker.detail ?? "unknown error"}` };
      const notReady = st.services.filter((c) => isLongRunning(c) && !isReady(c));
      if (notReady.length === 0) return this.withOneShotWarnings({ ok: true, services: st.services }, st.services);
      if (this.now() - started >= READY_TIMEOUT_MS) {
        const detail = `not ready after ${READY_TIMEOUT_MS / 1000}s: ${notReady.map(describe).join(", ")}`;
        return this.withOneShotWarnings({ ok: false, detail, services: st.services }, st.services);
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  // @spec CTRL-STACK-006
  async stopAll(): Promise<StackResult> {
    this.phase("stop", "stopping");
    const r = await this.compose(["stop"], STOP_TIMEOUT_MS);
    return r.ok ? { ok: true } : { ok: false, detail: r.detail };
  }

  // @spec CTRL-STACK-007
  async restartAll(controller: Pick<ServiceController, "restart">): Promise<StackResult> {
    const st = await this.status();
    if (!st.docker.ok) return { ok: false, detail: st.docker.detail ?? "docker unavailable" };
    const running = new Set(st.services.filter((c) => c.status === "running").map((c) => c.service));
    const restarts: RestartOutcome[] = [];
    for (const def of this.manifest) {
      if (!def.pnpmFilter || !running.has(def.composeName)) continue;
      this.phase("restart", `restarting ${def.id}`);
      const r = await controller.restart(def.id);
      restarts.push({ id: def.id, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) });
    }
    if (restarts.length === 0) return { ok: false, detail: "no application service is running", services: st.services, restarts };
    const failed = restarts.filter((x) => !x.ok);
    return {
      ok: failed.length === 0,
      ...(failed.length ? { detail: failed.map((x) => `${x.id}${x.detail ? `: ${x.detail}` : " failed"}`).join("; ") } : {}),
      services: st.services, restarts,
    };
  }

  /** The viewer-note one-shot through the per-unit runtime, which already runs the same docker binary and cwd. */
  // @spec CTRL-STACK-009
  async consolidate(): Promise<RuntimeResult> {
    this.phase("consolidate", "running");
    return this.runtime.consolidate();
  }
}
