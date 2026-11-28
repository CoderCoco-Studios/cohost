/**
 * The unlock line kept in view (DASH-UNL-009 to DASH-UNL-013): on a terminal with room for it, the line sits in the bottom rows
 * below a scroll region (DECSTBM, `ESC [ top ; bottom r`) that holds every row above it, so log lines scroll past it. It is
 * repainted on a resize, renewed when its nonce's 10 minutes end, and removed (the region reset to the whole terminal and its
 * rows cleared) on the first unlock and when the process exits. Everything goes to standard output, never through the logger.
 */

const ESC = "\x1b";
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const RESET_REGION = `${ESC}[r`;
const CLEAR_BELOW = `${ESC}[J`;
const ERASE_LINE = `${ESC}[2K`;
const region = (bottom: number): string => `${ESC}[1;${bottom}r`;
const rowStart = (row: number): string => `${ESC}[${row};1H`;

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** What the pinned line needs of the terminal and the process; `processTerminalIo` over `process.stdout` by default. */
export interface TerminalIo {
  write(s: string): void;
  isTTY(): boolean;
  /** The terminal's size, undefined when it cannot be told. */
  size(): { rows: number; cols: number } | undefined;
  /** Calls `fn` on every resize; returns what stops that. */
  onResize(fn: () => void): () => void;
  /** Calls `fn` once after `ms`; returns what cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** The process whose exit and signals reset the terminal; `kill` raises a signal on it again. */
  proc: {
    on(event: string, fn: (...args: unknown[]) => void): unknown;
    off(event: string, fn: (...args: unknown[]) => void): unknown;
    listenerCount(event: string): number;
    kill(signal: NodeJS.Signals): void;
  };
}

/** How a pinned line is kept working: `stale` says when its link is due for renewal, `next` makes the line with a fresh one. */
export interface Renewal {
  next(): string;
  stale(): boolean;
}

/** Where the dashboard writes its unlock line (DASH-UNL-001): shown, renewed while shown, released on the first unlock. */
export interface UnlockTerminal {
  /** Writes `line`; while it stays pinned (or held unpinned for lack of rows), `renewal` keeps its link working. A line already pinned is replaced. */
  show(line: string, renewal?: Renewal): void;
  /** Removes the pinned line, if any (DASH-UNL-012). */
  release(): void;
  /** Renews the line now if its link is due (as when its nonce was just dropped by the cap, DASH-UNL-002). */
  check(): void;
  /** True while a line is pinned or held unpinned for lack of rows. */
  readonly pinned: boolean;
}

/** The rows `line` takes at a terminal width of `cols`. */
export const rowsFor = (line: string, cols: number): number => Math.max(1, Math.ceil(line.length / Math.max(1, cols)));

/** Rows the line's own rows leave at least for the logs. */
const LOG_ROWS = 3;

/** An `UnlockTerminal` that writes each line once through `print` and pins nothing (tests, and where the caller prints). */
export const plainTerminal = (print: (line: string) => void): UnlockTerminal => ({
  show: (line) => { print(line); },
  release: () => {},
  check: () => {},
  pinned: false,
});

/**
 * The pinned unlock line. While the terminal has the rows the line needs plus 3 it is pinned; on a resize to fewer rows the
 * region goes back to the whole terminal until a resize leaves room again (DASH-UNL-010). Without a terminal, or without room
 * when it is shown, the line is written once, plain (DASH-UNL-009).
 */
// @spec DASH-UNL-009, DASH-UNL-010, DASH-UNL-011, DASH-UNL-012, DASH-UNL-013
export class PinnedLine implements UnlockTerminal {
  private line = "";
  private active = false;
  /** The first row of the pinned rows, while they are on screen; undefined while the terminal is too small. */
  private top: number | undefined;
  /** How many rows the line took when it was pinned, at the width of that time. */
  private height = 0;
  private cleanups: (() => void)[] = [];
  private renewal: Renewal | undefined;
  private checking = false;
  private readonly pollMs: number;

  /** `pollMs`: how often the link is checked against the wall clock (timers do not count time the machine spent suspended). */
  constructor(private readonly io: TerminalIo, o: { pollMs?: number } = {}) { this.pollMs = o.pollMs ?? 15_000; }

  get pinned(): boolean { return this.active; }

  show(line: string, renewal?: Renewal): void {
    if (this.active) this.release();
    const size = this.io.isTTY() ? this.io.size() : undefined;
    if (!size || !this.fits(line, size)) { this.io.write(`${line}\n`); return; }
    this.active = true;
    this.line = line;
    this.pin(size);

    const offResize = this.io.onResize(() => { this.resized(); });
    const onExit = (): void => { this.release(); };
    const onSignal = (signal: NodeJS.Signals): (() => void) => () => {
      this.release();
      // Alone, this listener would have replaced Node's default for the signal: raise it again so the process ends as it would have.
      if (this.io.proc.listenerCount(signal) === 0) this.io.proc.kill(signal);
    };
    this.io.proc.on("exit", onExit);
    const handlers = SIGNALS.map((s) => [s, onSignal(s)] as const);
    for (const [s, fn] of handlers) this.io.proc.on(s, fn);
    let cancelTimer = (): void => {};
    this.renewal = renewal;
    if (renewal) {
      const schedule = (): void => { cancelTimer = this.io.setTimer(() => { this.check(); if (this.active) schedule(); }, this.pollMs); };
      schedule();
    }
    this.cleanups = [offResize, () => { cancelTimer(); }, () => { this.io.proc.off("exit", onExit); }, ...handlers.map(([s, fn]) => () => { this.io.proc.off(s, fn); })];
  }

  check(): void {
    if (!this.active || !this.renewal || this.checking) return;
    this.checking = true;
    try {
      if (!this.renewal.stale()) return;
      this.line = this.renewal.next();
      if (this.top !== undefined) this.paint();
    } finally { this.checking = false; }
  }

  release(): void {
    if (!this.active) return;
    this.active = false;
    this.renewal = undefined;
    for (const c of this.cleanups.splice(0)) c();
    if (this.top !== undefined) this.io.write(`${SAVE}${RESET_REGION}${rowStart(this.top)}${CLEAR_BELOW}${RESTORE}`);
    this.top = undefined;
  }

  private fits(line: string, size: { rows: number; cols: number }): boolean {
    return size.rows >= rowsFor(line, size.cols) + LOG_ROWS;
  }

  /**
   * Makes room below the cursor (newlines scroll the screen when the cursor is near the bottom), narrows the scroll region to
   * the rows above the line, puts the cursor back where the newlines left it, moved up into the region, and paints the line.
   */
  private pin(size: { rows: number; cols: number }): void {
    const need = rowsFor(this.line, size.cols);
    const bottom = size.rows - need;
    this.top = bottom + 1;
    this.height = need;
    this.io.write(`${"\n".repeat(need)}${SAVE}${region(bottom)}${RESTORE}${ESC}[${need}A`);
    this.paint();
  }

  /** Writes the line in the pinned rows and leaves the cursor in the scroll region where it was. */
  private paint(): void {
    this.io.write(`${SAVE}${rowStart(this.top!)}${CLEAR_BELOW}${this.line}${RESTORE}`);
  }

  private resized(): void {
    if (!this.active) return;
    const size = this.io.size();
    const fits = size !== undefined && this.fits(this.line, size);
    // With room, the old line's own rows are erased at the old geometry, one by one, so no stale copy of the link is left in the
    // scrollback and no log row a growing terminal pulled down is lost; without room they are left to scroll away (DASH-UNL-010).
    if (this.top !== undefined) {
      const top = this.top;
      const erase = fits ? Array.from({ length: this.height }, (_, i) => `${rowStart(top + i)}${ERASE_LINE}`).join("") : "";
      this.io.write(`${SAVE}${RESET_REGION}${erase}${RESTORE}`);
    }
    this.top = undefined;
    if (fits) this.pin(size);
  }
}

/** The terminal of this process: standard output, its resize event, the process's exit and signals. */
export const processTerminalIo = (): TerminalIo => ({
  write: (s) => { process.stdout.write(s); },
  isTTY: () => process.stdout.isTTY, // undefined (falsy) when not a terminal, though typed true
  size: () => (process.stdout.rows > 0 && process.stdout.columns > 0 ? { rows: process.stdout.rows, cols: process.stdout.columns } : undefined),
  onResize: (fn) => { process.stdout.on("resize", fn); return () => { process.stdout.off("resize", fn); }; },
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => { clearTimeout(t); }; },
  proc: {
    on: (e, fn) => process.on(e, fn),
    off: (e, fn) => process.off(e, fn),
    listenerCount: (e) => process.listenerCount(e),
    kill: (s) => { process.kill(process.pid, s); },
  },
});

let shared: PinnedLine | undefined;
/** The one pinned line of this process, over its standard output: config recovery mode and normal mode share it. */
export const processTerminal = (): UnlockTerminal => (shared ??= new PinnedLine(processTerminalIo()));
