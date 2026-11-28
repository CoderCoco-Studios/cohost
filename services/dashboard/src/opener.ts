/**
 * `--open` (DASH-UNL-014, DASH-UNL-015): hands the start unlock link to the platform's opener, so the owner's browser opens
 * already unlocked. A failure is one warning that names the opener and never the link, which carries a one-time nonce.
 */
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** What choosing an opener reads of the machine. */
export interface OpenerHost {
  platform: NodeJS.Platform;
  /** The kernel release (`/proc/sys/kernel/osrelease`); it names `microsoft` under WSL. */
  osRelease(): string;
  /** True when `cmd` is an executable on `PATH`. */
  onPath(cmd: string): boolean;
}

/** How a spawned opener ended: not started (`error`), or its exit code (null with the signal that ended it). */
export type SpawnOutcome = { error: Error } | { code: number | null; signal?: string | null };
export type Spawn = (cmd: string, args: readonly string[]) => Promise<SpawnOutcome>;

/** `open` for the first call only: the browser opens for the first unlock line of the process and no later one (DASH-UNL-014). */
// @spec DASH-UNL-014
export function firstOnly<A extends unknown[]>(open: (...args: A) => void): (...args: A) => void {
  let done = false;
  return (...args) => { if (done) return; done = true; open(...args); };
}

/** True when the dashboard was started with `--open` (`mise run dashboard --open`, deployment DEPLOY-HOST-001). */
export const wantsOpen = (argv: readonly string[]): boolean => argv.slice(2).includes("--open");

/** The opener for this machine and the arguments that go before the URL, or undefined when the platform has none. */
// @spec DASH-UNL-014
export function openerFor(host: OpenerHost): { cmd: string; args: string[] } | undefined {
  if (host.platform === "darwin") return { cmd: "open", args: [] };
  if (host.platform !== "linux") return undefined;
  if (/microsoft/i.test(host.osRelease())) return host.onPath("wslview") ? { cmd: "wslview", args: [] } : { cmd: "cmd.exe", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

/** Opens `url` once with the platform's opener; logs one warning, naming the opener and not the URL, when that fails. */
// @spec DASH-UNL-014, DASH-UNL-015
export async function openInBrowser(url: string, d: { host?: OpenerHost; spawn?: Spawn; warn: (msg: string) => void }): Promise<void> {
  const opener = openerFor(d.host ?? thisHost);
  if (!opener) { d.warn(`--open: no browser opener is known for this platform (${(d.host ?? thisHost).platform}); open the unlock link printed in this terminal`); return; }
  const out = await (d.spawn ?? ((cmd, args) => spawnOpener(cmd, args)))(opener.cmd, [...opener.args, url]);
  const why = "error" in out
    ? `could not be started (${(out.error as NodeJS.ErrnoException).code ?? "error"})`
    : out.code === 0 ? undefined : out.code === null ? `ended on ${out.signal ?? "a signal"}` : `exited with status ${out.code}`;
  if (why) d.warn(`--open: the browser opener ${opener.cmd} ${why}; open the unlock link printed in this terminal`);
}

const onPath = (cmd: string): boolean => (process.env.PATH ?? "").split(delimiter).some((dir) => {
  if (!dir) return false;
  try { accessSync(join(dir, cmd), constants.X_OK); return true; } catch { return false; }
});

/** This machine. */
export const thisHost: OpenerHost = {
  platform: process.platform,
  osRelease: () => { try { return readFileSync("/proc/sys/kernel/osrelease", "utf8"); } catch { return ""; } },
  onPath,
};

/**
 * Runs the opener in its own process group (`detached`), its output discarded and not waited on (`unref`), so Ctrl+C in the
 * dashboard's terminal does not reach a browser the opener started in the foreground; resolves when it ends or cannot be
 * started, for the warning of DASH-UNL-015.
 */
// @spec DASH-UNL-015
export function spawnOpener(cmd: string, args: readonly string[], spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess = spawnChild): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
    child.once("error", (error) => { resolve({ error }); });
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
    child.unref();
  });
}
