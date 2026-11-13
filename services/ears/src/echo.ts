/** How long a recorded line may go without a `voice.done` before ears stops counting it as playing (EARS-ECHO-003). */
export const ECHO_LINE_CEILING_MS = 60_000;

/**
 * The echo gate (EARS-ECHO-*): a source that can hear the co-host's own voice is deaf while a line plays and for `tailMs` after the
 * last one ended. It records the windows it was open, so an utterance is judged by when its audio ended, not when it is handled.
 * Held in memory only (EARS-ECHO-007); every time is ears' own clock, `now()`.
 */
// @spec EARS-ECHO-002, EARS-ECHO-003, EARS-ECHO-004, EARS-ECHO-006, EARS-ECHO-007, EARS-ECHO-009
export class EchoGate {
  /** Lines recorded as playing, by id, with the time their `voice.playing` was read. */
  private lines = new Map<string, number>();
  /** Windows the gate was open: `end` is absent while a line plays. Oldest first, bounded. */
  private windows: { start: number; end?: number }[] = [];

  constructor(private readonly tailMs: number, private readonly now: () => number = Date.now) {}

  /** A non-virtual `voice.playing` was read. */
  playing(id: string): void {
    const t = this.now();
    this.sweep(t);
    const last = this.windows.at(-1);
    if (this.lines.size === 0) {
      if (last && last.end !== undefined && t <= last.end) last.end = undefined; // the tail was still open: extend it (EARS-ECHO-006)
      else if (!last || last.end !== undefined) this.windows.push({ start: t });
    }
    this.lines.set(id, t);
    if (this.windows.length > 100) this.windows.shift();
  }

  /** A `voice.done` was read: the line, when recorded, is removed. */
  done(id: string): void {
    const t = this.now();
    this.sweep(t);
    if (this.lines.delete(id)) this.release(t);
  }

  /** Whether `at` (epoch ms, ears' clock) falls inside a window the gate was open. */
  blocks(at: number): boolean {
    this.sweep(this.now());
    return this.windows.some((w) => at >= w.start && (w.end === undefined || at <= w.end));
  }

  /** Lines whose `voice.done` never came are removed at their ceiling, as if it had been read then. */
  private sweep(t: number): void {
    for (const [id, since] of [...this.lines].sort((a, b) => a[1] - b[1])) {
      if (t - since < ECHO_LINE_CEILING_MS) continue;
      this.lines.delete(id);
      this.release(since + ECHO_LINE_CEILING_MS);
    }
  }

  private release(at: number): void {
    if (this.lines.size > 0) return;
    const last = this.windows.at(-1);
    if (last && last.end === undefined) last.end = at + this.tailMs;
  }
}
