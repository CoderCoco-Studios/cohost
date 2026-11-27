import { execFile as nodeExecFile, spawn } from "node:child_process";
import { ISOLATION_ENV, encodeIsolation, findWorkspaceRoot } from "@cohost/config";
import { findService, SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import { resolveDockerBin, dockerEnv } from "./docker.js";
import { ensureLogsDir, stderrWarn } from "./logs-dir.js";
import { ComposeProvisioner, storeSource, type DockerRun, type Provisioner } from "./provision.js";

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

/** The stream an output chunk came from. */
export type OutputStream = "stdout" | "stderr";

/**
 * Runs a program with an argv (no shell); `input` is written to its standard input, which is then closed. With `onOutput`,
 * each chunk of standard output and standard error is passed to it as it arrives, with the stream it came from (CTRL-STACK-021).
 */
export type ExecFile = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; input?: string; onOutput?: (chunk: string, stream: OutputStream) => void }) => Promise<{ stdout: string; stderr: string }>;

/** How much of each stream a streamed exec keeps for its result. */
export const STREAM_TAIL_CHARS = 65_536;
/** How long a streamed exec waits after SIGTERM at its timeout before it sends SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How long a streamed exec waits, after the process exits, for its output pipes to close before it settles anyway. */
export const CLOSE_GRACE_MS = 2_000;

/** A consolidation pass makes model calls and can take minutes; the lifecycle verbs' 120 s would kill it. */
export const CONSOLIDATE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export const defaultExec: ExecFile = (file, args, opts) => (opts.onOutput ? streamExec(file, args, opts) : bufferedExec(file, args, opts));

/**
 * `spawn` (no shell) that forwards each output chunk and keeps the last `STREAM_TAIL_CHARS` of each stream, so a command that
 * prints without end (a long image build) never hits a buffer limit and never holds all of its output in memory. At its
 * timeout it sends SIGTERM, then SIGKILL after `killGraceMs` unless the process has exited by then. Once the process has
 * exited it waits at most `closeGraceMs` for the output pipes to close (a process it started can hold them open) and then
 * settles with the exit's code and signal, so a caller (and the lifecycle lock it holds) never waits for ever. A settle forced
 * that way closes the pipes, so output still buffered in them (at most the last chunk) is dropped.
 */
// @spec CTRL-STACK-021
export function streamExecWith(killGraceMs = KILL_GRACE_MS, closeGraceMs = CLOSE_GRACE_MS): ExecFile {
  return (file, args, opts) =>
    new Promise((resolve, reject) => {
      const { timeoutMs, input, onOutput, ...rest } = opts;
      const child = spawn(file, args, { ...rest, stdio: ["pipe", "pipe", "pipe"] });
      const tails = { stdout: "", stderr: "" };
      const take = (which: OutputStream) => (chunk: string) => {
        tails[which] = (tails[which] + chunk).slice(-STREAM_TAIL_CHARS);
        try { onOutput?.(chunk, which); } catch { /* a progress callback must not fail the command */ }
      };
      child.stdout.setEncoding("utf8").on("data", take("stdout"));
      child.stderr.setEncoding("utf8").on("data", take("stderr"));
      let timedOut = false;
      let settled = false;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let kill: NodeJS.Timeout | undefined;
      let closeWait: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        clearTimeout(timer);
        if (kill) clearTimeout(kill);
        if (closeWait) clearTimeout(closeWait);
      };
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (code === 0 && !timedOut) resolve({ ...tails });
        else reject(Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}${timedOut ? " (timed out)" : signal ? ` (${signal})` : ` (exit ${code})`}`), { code, signal, killed: timedOut }, tails));
      };
      /** Settles on the recorded exit without waiting for `close`: the pipes are held by a process the program started. */
      const forceSettle = () => {
        if (!exited) return;
        child.stdout.destroy();
        child.stderr.destroy();
        settle(exited.code, exited.signal);
      };
      const timer = setTimeout(() => {
        if (exited) { forceSettle(); return; } // it ended in time; only its pipes are still open
        timedOut = true;
        child.kill("SIGTERM");
        kill = setTimeout(() => {
          if (exited) forceSettle();
          else child.kill("SIGKILL");
        }, killGraceMs);
      }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(Object.assign(err, tails));
      });
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        closeWait = setTimeout(forceSettle, closeGraceMs);
      });
      child.on("close", settle);
      child.stdin.on("error", () => { /* the program exited before reading: its status reports the failure */ });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
}

const streamExec = streamExecWith();

const bufferedExec: ExecFile = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // execFile never spawns a shell; args is an argv array.
    const { timeoutMs, input, onOutput: _onOutput, ...rest } = opts;
    const child = nodeExecFile(file, args, { ...rest, timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- `err` is node's ExecFileException, an Error
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    // The input (a credentials message) goes to standard input only: never an argument or the environment (STORE-DLV-001).
    child.stdin?.on("error", () => { /* the program exited before reading: its status reports the failure */ });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
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
  /** What runs around a command that may start a container: the projections and the delivery; the settings store's by default. */
  provision?: Provisioner;
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
  private provisioner: Provisioner | undefined;
  constructor(private o: ComposeRuntimeOptions = {}) {
    this.exec = o.exec ?? defaultExec;
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
    this.provisioner = o.provision;
  }

  /** The workspace root: Compose's working directory, where `data/` is. */
  private get root(): string { return this.o.cwd ?? findWorkspaceRoot() ?? process.cwd(); }

  /** The provisioner, built at first use over the settings store and this runtime's docker binary. */
  private provision(bin: string, base: NodeJS.ProcessEnv): Provisioner {
    this.provisioner ??= defaultProvisioner(this.exec, bin, base, this.root, this.manifest);
    return this.provisioner;
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
    // A command that creates, starts or restarts a container projects first and delivers after; stop only stops (CTRL-RUNTIME-014).
    if (verb[0] === "stop") {
      try {
        await this.exec(docker.bin, ["compose", ...verb, def.composeName], { env: this.composeEnv(docker.bin, base, preset), cwd: this.o.cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: execDetail(err) };
      }
    }
    const before = await this.provision(docker.bin, base).before();
    if (!before.ok) return { ok: false, detail: before.detail };
    ensureLogsDir(this.root, this.o.warn ?? stderrWarn); // CTRL-RUNTIME-016
    try {
      await this.exec(docker.bin, ["compose", ...verb, def.composeName], { env: this.composeEnv(docker.bin, base, preset), cwd: this.o.cwd });
    } catch (err) {
      return { ok: false, detail: execDetail(err) };
    }
    return before.after(); // CTRL-RUNTIME-018
  }

  start(id: string, opts: StartOptions = {}) { return this.run(id, ["up", "-d"], opts.env); }
  stop(id: string) { return this.run(id, ["stop"]); }
  // @spec CTRL-RUNTIME-002
  restart(id: string, opts: StartOptions = {}) {
    // `restart` keeps the container's env; recreate through `up` when overrides must be applied.
    return opts.env && Object.keys(opts.env).length > 0 ? this.run(id, ["up", "-d", "--force-recreate"], opts.env) : this.run(id, ["restart"]);
  }

  /**
   * Runs the one-shot viewer-note consolidation (`docker compose run -d --rm --name <name> consolidate`), delivers the memory
   * unit's credentials to it, follows its output and waits for it to exit. A job, not a service: the argv is fixed apart from
   * the generated name and takes nothing from the caller. `run` starts postgres and ollama if they are down.
   */
  // @spec CTRL-RUNTIME-010, CTRL-STACK-012
  consolidate(): Promise<RuntimeResult> { return this.oneShot("consolidate"); }

  /** Runs the one-shot memory re-embedding (`docker compose run -d --rm --name <name> reembed`), a fixed job like `consolidate`. */
  // @spec CTRL-RUNTIME-011
  reembed(): Promise<RuntimeResult> { return this.oneShot("reembed"); }

  // @spec CTRL-RUNTIME-010, CTRL-RUNTIME-011, CTRL-RUNTIME-018
  private async oneShot(job: "consolidate" | "reembed"): Promise<RuntimeResult> {
    const base = this.o.env ?? process.env;
    const docker = resolveDockerBin(base, this.o.onPath);
    if (!docker.ok) return { ok: false, detail: docker.detail };
    const before = await this.provision(docker.bin, base).before();
    if (!before.ok) return { ok: false, detail: before.detail };
    ensureLogsDir(this.root, this.o.warn ?? stderrWarn); // CTRL-RUNTIME-016
    const env = this.composeEnv(docker.bin, base);
    const name = oneShotName(job);
    try {
      await this.exec(docker.bin, ["compose", "run", "-d", "--rm", "--name", name, job], { env, cwd: this.o.cwd });
    } catch (err) {
      return { ok: false, detail: execDetail(err) };
    }
    // Waiting and following start before the delivery, so a pass that ends at once is still seen before Docker removes it.
    const waited = this.exec(docker.bin, ["wait", name], { env: base, cwd: this.o.cwd, timeoutMs: CONSOLIDATE_TIMEOUT_MS }).then((r) => ({ ok: true as const, r }), (err: unknown) => ({ ok: false as const, err }));
    const followed = this.exec(docker.bin, ["logs", "-f", name], { env: base, cwd: this.o.cwd, timeoutMs: CONSOLIDATE_TIMEOUT_MS }).then((r) => r, (err: unknown) => err as { stdout?: string; stderr?: string });
    const delivered = await before.after({ name, unit: "memory" });
    if (!delivered.ok) {
      try { await this.exec(docker.bin, ["rm", "-f", name], { env: base, cwd: this.o.cwd }); } catch { /* already gone */ }
      await Promise.all([waited, followed]);
      return delivered;
    }
    const [w, logs] = await Promise.all([waited, followed]);
    const out = logs.stdout ?? "";
    const tail = (logs.stderr?.trim() || lastLine(out)).slice(0, 500);
    if (!w.ok) {
      // A job that does not end within the wait is removed, so it holds no credentials and no lock beyond the action.
      try { await this.exec(docker.bin, ["rm", "-f", name], { env: base, cwd: this.o.cwd }); } catch { /* already gone */ }
      return { ok: false, detail: `${job} did not finish (${execDetail(w.err)}); its container ${name} was removed` };
    }
    const status = Number(w.r.stdout.trim());
    if (status === 0) {
      const last = lastLine(out);
      return last ? { ok: true, detail: last.slice(0, 500) } : { ok: true };
    }
    return { ok: false, detail: tail || `exit ${Number.isNaN(status) ? w.r.stdout.trim() : status}` };
  }
}

/** The name of a one-shot's container: the job and a random suffix, so two runs never collide. */
const oneShotName = (job: string): string => `cohost-${job}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** The settings store's provisioner over `exec` and the docker binary `bin`, under the workspace root `root`. */
export function defaultProvisioner(exec: ExecFile, bin: string, env: NodeJS.ProcessEnv, root: string, manifest: readonly ServiceDef[]): Provisioner {
  const docker: DockerRun = (args, opts = {}) => exec(bin, args, {
    env: args[0] === "compose" ? dockerEnv(bin, env, { [ISOLATION_ENV]: "" }) : env, cwd: root,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return new ComposeProvisioner({ root, docker, env, source: storeSource(root), manifest });
}

const lastLine = (text: string): string => text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
