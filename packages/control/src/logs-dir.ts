import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Where a control-plane warning goes when the caller gives no logger: one plain line on standard error. */
export const stderrWarn = (msg: string): void => { process.stderr.write(`warning: ${msg}\n`); };

/**
 * Creates `data/logs` under the workspace root (`mkdir -p`, as the user running the control plane) before a Compose command
 * that can create a container, so the directory the `./data/logs` bind mount names is the owner's and not made by Compose as
 * root. A failure is a warning: the command still runs.
 */
// @spec CTRL-RUNTIME-016
export function ensureLogsDir(root: string, warn: (msg: string) => void = stderrWarn): void {
  const dir = join(root, "data", "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    warn(`cannot create ${dir} (${(err as { code?: string }).code ?? String(err)}); Compose may create it as root`);
  }
}
