import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { findService, SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";

export interface RuntimeResult { ok: boolean; detail?: string }

export interface StartOptions {
  /** `dev` (tsx watch) or `start` (built dist); process runtime only. */
  processMode?: "dev" | "start";
  /** Extra env for the started service (isolation presets). Only ever comes from the manifest. */
  env?: Readonly<Record<string, string>>;
}

/** Starts and stops services by manifest id. Adapters build argv from manifest fields only. */
export interface Runtime {
  readonly name: "compose" | "process";
  start(id: string, opts?: StartOptions): Promise<RuntimeResult>;
  stop(id: string): Promise<RuntimeResult>;
  restart(id: string, opts?: StartOptions): Promise<RuntimeResult>;
}

const unknown = (id: string): RuntimeResult => ({ ok: false, detail: `unknown service: ${JSON.stringify(id)}` });

// ---- compose ----

export type ExecFile = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFile = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // execFile never spawns a shell; args is an argv array.
    nodeExecFile(file, args, { ...opts, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

export interface ComposeRuntimeOptions {
  exec?: ExecFile;
  manifest?: readonly ServiceDef[];
  /** Directory holding docker-compose.yml (default: cwd). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** `docker compose up -d|stop|restart <composeName>` through the docker CLI. */
export class ComposeRuntime implements Runtime {
  readonly name = "compose" as const;
  private exec: ExecFile;
  private manifest: readonly ServiceDef[];
  constructor(private o: ComposeRuntimeOptions = {}) {
    this.exec = o.exec ?? defaultExec;
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
  }

  private async run(id: string, verb: string[], extraEnv?: Readonly<Record<string, string>>): Promise<RuntimeResult> {
    const def = findService(id, this.manifest);
    if (!def) return unknown(id);
    try {
      await this.exec("docker", ["compose", ...verb, def.composeName], { env: { ...(this.o.env ?? process.env), ...extraEnv }, cwd: this.o.cwd });
      return { ok: true };
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      return { ok: false, detail: (e.stderr?.trim() || e.message || String(err)).slice(0, 500) };
    }
  }

  start(id: string, opts: StartOptions = {}) { return this.run(id, ["up", "-d"], opts.env); }
  stop(id: string) { return this.run(id, ["stop"]); }
  restart(id: string, opts: StartOptions = {}) {
    // `restart` keeps the container's env; recreate through `up` when overrides must be applied.
    return opts.env && Object.keys(opts.env).length > 0 ? this.run(id, ["up", "-d", "--force-recreate"], opts.env) : this.run(id, ["restart"]);
  }
}

// ---- process ----

/** The slice of a ChildProcess the process runtime uses (lets tests inject a fake). */
export interface ChildLike extends EventEmitter {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  unref?(): void;
}
export type Spawner = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildLike;
export type Signaller = (child: ChildLike, signal: NodeJS.Signals) => void;

const defaultSpawn: Spawner = (cmd, args, opts) =>
  // Fixed argv, no shell. detached: own process group, so pnpm's whole tree can be signalled.
  nodeSpawn(cmd, args, { ...opts, shell: false, detached: true, stdio: "ignore" });

const defaultSignal: Signaller = (child, signal) => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { try { process.kill(child.pid, signal); } catch { /* already gone */ } }
};

export interface ProcessRuntimeOptions {
  spawn?: Spawner;
  signal?: Signaller;
  manifest?: readonly ServiceDef[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default `dev`. */
  mode?: "dev" | "start";
  /** SIGTERM -> SIGKILL escalation, ms. */
  killTimeoutMs?: number;
}

/** `pnpm --filter @cohost/<svc> dev|start` as a host process; pids are tracked in memory. */
export class ProcessRuntime implements Runtime {
  readonly name = "process" as const;
  private children = new Map<string, ChildLike>();
  private spawnFn: Spawner;
  private signalFn: Signaller;
  private manifest: readonly ServiceDef[];
  private killTimeoutMs: number;
  constructor(private o: ProcessRuntimeOptions = {}) {
    this.spawnFn = o.spawn ?? defaultSpawn;
    this.signalFn = o.signal ?? defaultSignal;
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
    this.killTimeoutMs = o.killTimeoutMs ?? 10_000;
  }

  /** pid of the tracked process for a service, if running. */
  pid(id: string): number | undefined { return this.children.get(id)?.pid; }

  async start(id: string, opts: StartOptions = {}): Promise<RuntimeResult> {
    const def = findService(id, this.manifest);
    if (!def) return unknown(id);
    if (!def.pnpmFilter) return { ok: false, detail: `${id} is not a pnpm package; use the compose runtime` };
    if (this.children.has(id)) return { ok: true, detail: `already running (pid ${this.pid(id)})` };
    const script = opts.processMode ?? this.o.mode ?? "dev";
    const child = this.spawnFn("pnpm", ["--filter", def.pnpmFilter, script], {
      env: { ...(this.o.env ?? process.env), ...opts.env }, cwd: this.o.cwd,
    });
    const spawned = await new Promise<RuntimeResult>((resolve) => {
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (err: Error) => resolve({ ok: false, detail: `spawn failed: ${err.message}` }));
    });
    if (!spawned.ok) return spawned;
    this.children.set(id, child);
    child.once("exit", () => { if (this.children.get(id) === child) this.children.delete(id); });
    child.unref?.();
    return { ok: true, detail: `pid ${child.pid}` };
  }

  async stop(id: string): Promise<RuntimeResult> {
    if (!findService(id, this.manifest)) return unknown(id);
    const child = this.children.get(id);
    if (!child) return { ok: false, detail: "not running under this process runtime (no tracked pid)" };
    if (child.exitCode !== null || child.signalCode !== null) { this.children.delete(id); return { ok: true, detail: "already exited" }; }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.signalFn(child, "SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), this.killTimeoutMs); });
    const escalated = await Promise.race([exited.then(() => false as const), timedOut]);
    clearTimeout(timer);
    if (escalated) {
      this.signalFn(child, "SIGKILL");
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000).unref())]);
    }
    this.children.delete(id);
    return { ok: true, detail: escalated ? "killed (SIGKILL after timeout)" : "stopped" };
  }

  async restart(id: string, opts: StartOptions = {}): Promise<RuntimeResult> {
    const stopped = await this.stop(id);
    if (!stopped.ok) return stopped;
    return this.start(id, opts);
  }
}
