import { execFile as nodeExecFile } from "node:child_process";
import { ISOLATION_ENV, encodeIsolation } from "@cohost/config";
import { findService, SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import { resolveDockerBin, dockerEnv } from "./docker.js";
import { projectManifestSecrets, projectionRoot } from "./secrets.js";
import { ensureLogsDir, stderrWarn } from "./logs-dir.js";

export interface RuntimeResult {
  ok: boolean;
  detail?: string;
}

export interface StartOptions {
  /** The isolation preset (override names to values) for the started service, delivered as `COHOST_ISOLATION`. Only ever comes from the manifest. */
  env?: Readonly<Record<string, string>>;
}

/** Starts and stops services by manifest id. Adapters build argv from manifest fields only. */
export interface Runtime {
  readonly name: "compose";
  start(id: string, opts?: StartOptions): Promise<RuntimeResult>;
  stop(id: string): Promise<RuntimeResult>;
  restart(id: string, opts?: StartOptions): Promise<RuntimeResult>;
}

const unknown = (id: string): RuntimeResult => ({ ok: false, detail: `unknown service: ${JSON.stringify(id)}` });

// ---- compose ----

export type ExecFile = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

/** A consolidation pass makes model calls and can take minutes; the lifecycle verbs' 120 s would kill it. */
export const CONSOLIDATE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export const defaultExec: ExecFile = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // execFile never spawns a shell; args is an argv array.
    const { timeoutMs, ...rest } = opts;
    nodeExecFile(file, args, { ...rest, timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- `err` is node's ExecFileException, an Error
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

export interface ComposeRuntimeOptions {
  exec?: ExecFile;
  manifest?: readonly ServiceDef[];
  /** Directory holding docker-compose.yml (default: cwd). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** PATH lookup used to find the docker binary (injectable for tests). */
  onPath?: (name: string, env: NodeJS.ProcessEnv) => boolean;
  /** Where a warning goes (the `data/logs` directory could not be created); standard error by default. */
  warn?: (msg: string) => void;
}

/** The detail of a failed exec: trimmed stderr, else the error message, cut to 500 characters. */
export function execDetail(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 500);
}

/** `docker compose up -d|stop|restart <composeName>` through the docker CLI. */
// @spec CTRL-RUNTIME-001
export class ComposeRuntime implements Runtime {
  readonly name = "compose" as const;
  private exec: ExecFile;
  private manifest: readonly ServiceDef[];
  constructor(private o: ComposeRuntimeOptions = {}) {
    this.exec = o.exec ?? defaultExec;
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
  }

  /**
   * The environment of a `docker compose` process: `COHOST_ISOLATION` is the JSON of `preset` (names and values of
   * `ISOLATION_OVERRIDES`), or the empty string when there is none, replacing any value this process inherited.
   */
  // @spec CTRL-RUNTIME-009, CTRL-RUNTIME-012, CTRL-RUNTIME-013
  private composeEnv(bin: string, base: NodeJS.ProcessEnv, preset?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return dockerEnv(bin, base, { [ISOLATION_ENV]: preset ? encodeIsolation(preset) : "" });
  }

  // @spec CTRL-RUNTIME-014, CTRL-RUNTIME-016, CTRL-RUNTIME-003, CTRL-RUNTIME-004, CTRL-RUNTIME-009, CTRL-RUNTIME-013, CTRL-STACK-012
  private async run(id: string, verb: string[], preset?: Readonly<Record<string, string>>): Promise<RuntimeResult> {
    const def = findService(id, this.manifest);
    if (!def) return unknown(id);
    const base = this.o.env ?? process.env;
    const docker = resolveDockerBin(base, this.o.onPath);
    if (!docker.ok) return { ok: false, detail: docker.detail };
    // A command that creates, starts or restarts a container projects first; stop only stops (CTRL-RUNTIME-014).
    if (verb[0] !== "stop") {
      const failed = await projectManifestSecrets(projectionRoot(this.o.cwd), this.manifest, base);
      if (failed) return { ok: false, detail: failed.detail };
      ensureLogsDir(projectionRoot(this.o.cwd), this.o.warn ?? stderrWarn); // CTRL-RUNTIME-016
    }
    try {
      await this.exec(docker.bin, ["compose", ...verb, def.composeName], { env: this.composeEnv(docker.bin, base, preset), cwd: this.o.cwd });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: execDetail(err) };
    }
  }

  start(id: string, opts: StartOptions = {}) { return this.run(id, ["up", "-d"], opts.env); }
  stop(id: string) { return this.run(id, ["stop"]); }
  // @spec CTRL-RUNTIME-002
  restart(id: string, opts: StartOptions = {}) {
    // `restart` keeps the container's env; recreate through `up` when overrides must be applied.
    return opts.env && Object.keys(opts.env).length > 0 ? this.run(id, ["up", "-d", "--force-recreate"], opts.env) : this.run(id, ["restart"]);
  }

  /**
   * Runs the one-shot viewer-note consolidation (`docker compose run --rm -T consolidate`) and waits for it. A job, not a
   * service: the argv is fixed and takes nothing from the caller. `run` starts postgres and ollama if they are down.
   */
  // @spec CTRL-RUNTIME-010, CTRL-STACK-012
  consolidate(): Promise<RuntimeResult> { return this.oneShot("consolidate"); }

  /** Runs the one-shot memory re-embedding (`docker compose run --rm -T reembed`), a fixed job like `consolidate`. */
  // @spec CTRL-RUNTIME-011
  reembed(): Promise<RuntimeResult> { return this.oneShot("reembed"); }

  private async oneShot(job: "consolidate" | "reembed"): Promise<RuntimeResult> {
    const base = this.o.env ?? process.env;
    const docker = resolveDockerBin(base, this.o.onPath);
    if (!docker.ok) return { ok: false, detail: docker.detail };
    const failed = await projectManifestSecrets(projectionRoot(this.o.cwd), this.manifest, base);
    if (failed) return { ok: false, detail: failed.detail };
    ensureLogsDir(projectionRoot(this.o.cwd), this.o.warn ?? stderrWarn); // CTRL-RUNTIME-016
    try {
      const { stdout } = await this.exec(docker.bin, ["compose", "run", "--rm", "-T", job], { env: this.composeEnv(docker.bin, base), cwd: this.o.cwd, timeoutMs: CONSOLIDATE_TIMEOUT_MS });
      const last = lastLine(stdout);
      return last ? { ok: true, detail: last.slice(0, 500) } : { ok: true };
    } catch (err) {
      const e = err as { message?: string; stderr?: string; stdout?: string };
      return { ok: false, detail: (e.stderr?.trim() || lastLine(e.stdout ?? "") || e.message || String(err)).slice(0, 500) };
    }
  }
}

const lastLine = (text: string): string => text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
