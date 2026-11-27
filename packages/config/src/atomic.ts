import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * Replace `file` with `text` through a temporary file in the same directory and a rename, so a failed write leaves the
 * previous file whole: the settings store's projections and exports, the personality outbox and the runtime's state file.
 *
 * `mode` is the temporary file's permission bits, given when the file is created, so a file holding settings or credentials
 * is never readable by others for a moment; the renamed file keeps it. Without it the process default applies.
 */
// @spec STORE-PROJ-002
export function writeFileAtomic(file: string, text: string, opts: { mode?: number } = {}): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx", ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* the temp file was never created */ }
    throw e;
  }
}
