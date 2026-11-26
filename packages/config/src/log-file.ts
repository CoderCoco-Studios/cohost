/**
 * A program's log file, `<dir>/<service>.log`, appended synchronously and rotated by size (config design, "Logging"). Before
 * each entry it stats the path: the size decides rotation, and a path that is gone or names another file than the open
 * descriptor is reopened. Nothing here throws: a failure warns once per episode through `warn` and is retried at the next entry.
 */
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, chmodSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";

export interface LogFileOptions {
  /** The `logs` directory. */
  dir: string;
  /** The program's name: the file is `<service>.log`. */
  service: string;
  /** Rotate before an entry would make a non-empty file larger than this. */
  maxBytes: number;
  /** How many rotated files (`<service>.<n>.log`) are kept. */
  maxFiles: number;
  /** Prints one warning line to the terminal (never to the file). */
  warn: (msg: string) => void;
}

const codeOf = (err: unknown): string => (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// @spec CFG-LOG-012, CFG-LOG-013, CFG-LOG-014, CFG-LOG-015, CFG-LOG-016, CFG-LOG-020, CFG-LOG-021
export class LogFile {
  readonly path: string;
  private fd: number | undefined;
  private ino = 0;
  private dev = 0;
  private writeFailing = false;
  private rotateFailing = false;

  constructor(private readonly o: LogFileOptions) {
    this.path = join(o.dir, `${o.service}.log`);
  }

  /** Appends one serialised entry (it ends in a line feed). */
  write(line: string): void {
    const bytes = Buffer.from(line, "utf8");
    try {
      let st: Stats | undefined = statSync(this.path, { throwIfNoEntry: false });
      if (this.fd !== undefined && (!st || st.ino !== this.ino || st.dev !== this.dev)) this.close(); // deleted or replaced by hand
      if (st && st.size > 0 && st.size + bytes.length > this.o.maxBytes && this.rotate()) st = undefined;
      if (this.fd === undefined) this.open(st === undefined);
      let off = 0;
      while (off < bytes.length) off += writeSync(this.fd!, bytes, off, bytes.length - off);
      this.writeFailing = false;
    } catch (err) {
      this.close();
      if (!this.writeFailing) this.o.warn(`cannot write the log file ${this.path}: ${codeOf(err)}`);
      this.writeFailing = true;
    }
  }

  /** Closes the descriptor; the next entry reopens the file. */
  close(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* already gone; nothing to release */ }
    this.fd = undefined;
  }

  private open(fresh: boolean): void {
    if (mkdirSync(this.o.dir, { recursive: true, mode: 0o755 }) !== undefined) chmodSync(this.o.dir, 0o755);
    const fd = openSync(this.path, "a", 0o644);
    try {
      if (fresh) fchmodSync(fd, 0o644);
      const st = fstatSync(fd);
      this.ino = st.ino;
      this.dev = st.dev;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    this.fd = fd;
  }

  /**
   * Shifts `<service>.<n>.log` up one number from the highest down, moves `<service>.log` to `.1.log` and deletes every file
   * numbered past `maxFiles`. True when the current file was moved away, so the entry goes to a new one.
   */
  private rotate(): boolean {
    const own = new RegExp(`^${escapeRegExp(this.o.service)}\\.(\\d+)\\.log$`);
    const numbered = (): number[] => readdirSync(this.o.dir).flatMap((f) => { const m = own.exec(f); return m ? [Number(m[1])] : []; }).toSorted((a, b) => b - a);
    const at = (n: number): string => join(this.o.dir, `${this.o.service}.${n}.log`);
    let moved = false;
    try {
      // Shift only when `.1.log` is taken: after a failed `.log` rename the older files were already shifted, and a retry
      // must not move them up again.
      if (existsSync(at(1))) for (const n of numbered()) renameSync(at(n), at(n + 1));
      this.close();
      renameSync(this.path, at(1));
      moved = true;
      for (const n of numbered()) if (n > this.o.maxFiles) unlinkSync(at(n));
      this.rotateFailing = false;
    } catch (err) {
      const path = (err as { path?: string }).path ?? this.path;
      if (!this.rotateFailing) this.o.warn(`cannot rotate the log file ${path}: ${codeOf(err)}`);
      this.rotateFailing = true;
    }
    return moved;
  }
}
