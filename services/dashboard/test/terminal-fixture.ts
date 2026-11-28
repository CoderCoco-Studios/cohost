/** A fake terminal for `PinnedLine` (DASH-UNL-009 to DASH-UNL-013), shared by the pinned-line tests. */
import { EventEmitter } from "node:events";
import type { TerminalIo } from "../src/pinned-line.js";

/**
 * A terminal as `PinnedLine` sees it: what was written, its size (changed with `resize`), its one-shot timers (fired with
 * `fire`) and a process whose signal and exit listeners the test can emit and whose `kill` it records.
 */
export function fakeTerminal(o: { tty?: boolean; rows?: number; cols?: number } = {}) {
  let size = { rows: o.rows ?? 24, cols: o.cols ?? 80 };
  const out: string[] = [];
  const resizers = new Set<() => void>();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const proc = Object.assign(new EventEmitter(), { killed: [] as string[], kill(sig: NodeJS.Signals) { this.killed.push(sig); } });
  const io: TerminalIo = {
    write: (s) => { out.push(s); },
    isTTY: () => o.tty ?? true,
    size: () => size,
    onResize: (fn) => { resizers.add(fn); return () => { resizers.delete(fn); }; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    proc,
  };
  return {
    io, out, proc, timers,
    /** Everything written since the last call. */
    take: (): string => out.splice(0).join(""),
    resize: (rows: number, cols = size.cols) => { size = { rows, cols }; for (const fn of [...resizers]) fn(); },
    /** Fires the live timers, as the clock reaching them would. */
    fire: () => { for (const t of timers.splice(0)) if (t.live) t.fn(); },
    liveTimers: () => timers.filter((t) => t.live),
    resizeListeners: () => resizers.size,
  };
}

