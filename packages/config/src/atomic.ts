import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * Replace `file` with `text` through a temporary file in the same directory and a rename, so a failed write leaves the
 * previous file whole. Shared by `savePersonality`, the settings editor's section writer and `updateSecrets`.
 *
 * `mode` is the temporary file's permission bits, given when the file is created, so a credential file is never readable
 * for a moment; the renamed file keeps it. Without it the process default applies.
 */
// @spec CFG-USR-013, CFG-SEC-012, MOD-CFG-014
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
