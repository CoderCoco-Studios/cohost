import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "@cohost/config";

/** Who holds the lifecycle lock, as the lock file records it. */
export interface LockHolder { pid: number; by: string; action: string; startedAt: number }

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holder: LockHolder; detail: string };

export interface LifecycleLockOptions {
  /** The entry point taking the lock: `dashboard` or `cohostctl`. */
  by: string;
  /** Directory of the lock file; the workspace root's `data/` by default. */
  dir?: string;
  pid?: number;
  /** Whether a process exists (injectable for tests); signals pid with 0 by default. */
  alive?: (pid: number) => boolean;
  /** Wall-clock stamp recorded for display only. */
  now?: () => number;
}

export const LOCK_FILE = "control.lock";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseHolder(text: string): LockHolder | undefined {
  try {
    const o = JSON.parse(text) as Partial<LockHolder>;
    if (Number.isInteger(o.pid) && o.pid! > 0 && typeof o.by === "string" && typeof o.action === "string" && typeof o.startedAt === "number") {
      return { pid: o.pid!, by: o.by, action: o.action, startedAt: o.startedAt };
    }
  } catch { /* an unreadable file is a stale one */ }
  return undefined;
}

/**
 * One lock across the dashboard and `cohostctl`, so two lifecycle actions (stack or service) never run at once.
 * A file under the data directory names the holder; a file whose pid is gone is stale and is replaced.
 * Taken at the entry point, around a whole action, never inside the controllers.
 */
// @spec CTRL-LOCK-001, CTRL-LOCK-002, CTRL-LOCK-003
export class LifecycleLock {
  private dir: string;
  private pid: number;
  private alive: (pid: number) => boolean;
  private now: () => number;

  constructor(private o: LifecycleLockOptions) {
    this.dir = o.dir ?? join(findWorkspaceRoot() ?? process.cwd(), "data");
    this.pid = o.pid ?? process.pid;
    this.alive = o.alive ?? processAlive;
    this.now = o.now ?? Date.now;
  }

  get file(): string { return join(this.dir, LOCK_FILE); }

  tryAcquire(action: string): LockResult {
    mkdirSync(this.dir, { recursive: true });
    const mine: LockHolder = { pid: this.pid, by: this.o.by, action, startedAt: this.now() };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(this.file, "wx");
        try { writeSync(fd, JSON.stringify(mine)); } finally { closeSync(fd); }
        return { ok: true, release: () => this.release(mine) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let text: string;
      try { text = readFileSync(this.file, "utf8"); } catch { continue; } // released between the two calls: retry
      const holder = parseHolder(text);
      if (holder && this.alive(holder.pid)) {
        return { ok: false, holder, detail: `busy: ${holder.action} held by ${holder.by} (pid ${holder.pid})` };
      }
      try { unlinkSync(this.file); } catch { /* another process removed it first */ }
    }
    throw new Error(`cannot take the lifecycle lock ${this.file}`);
  }

  /** Removes the file only while it still names `mine`; safe to call twice. */
  private release(mine: LockHolder): void {
    try {
      const h = parseHolder(readFileSync(this.file, "utf8"));
      if (h && h.pid === mine.pid && h.by === mine.by && h.action === mine.action && h.startedAt === mine.startedAt) unlinkSync(this.file);
    } catch { /* already gone */ }
  }
}
