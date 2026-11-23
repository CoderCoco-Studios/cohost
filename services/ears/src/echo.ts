/** How long a recorded clause may go without a `voice.done` before ears stops counting it as playing (EARS-ECHO-003). */
export const ECHO_CLAUSE_CEILING_MS = 60_000;

/**
 * The echo gate (EARS-ECHO-*): a source that can hear the co-host's own voice is deaf while a clause plays and for `tailMs` after the
 * last one ended. It records the windows it was open, so an utterance is judged by when its audio ended, not when it is handled.
 * Held in memory only (EARS-ECHO-007); every time is ears' own clock, `now()`.
 */
// @spec EARS-ECHO-002, EARS-ECHO-003, EARS-ECHO-004, EARS-ECHO-006, EARS-ECHO-007, EARS-ECHO-009
export class EchoGate {
  /** Clauses recorded as playing, keyed `<id>-<seq>` (internal only), with the time their `voice.playing` was read. */
  private clauses = new Map<string, number>();
  /** Windows the gate was open: `end` is absent while a clause plays. Oldest first, bounded. */
  private windows: { start: number; end?: number }[] = [];

  constructor(private readonly tailMs: number, private readonly now: () => number = Date.now) {}

  /** A non-virtual `voice.playing` of clause `seq` of line `id` was read. */
  playing(id: string, seq: number): void {
    const t = this.now();
    this.sweep(t);
    const last = this.windows.at(-1);
    if (this.clauses.size === 0) {
      if (last && last.end !== undefined && t <= last.end) last.end = undefined; // the tail was still open: extend it (EARS-ECHO-006)
      else if (!last || last.end !== undefined) this.windows.push({ start: t });
    }
    this.clauses.set(clauseKey(id, seq), t);
    if (this.windows.length > 100) this.windows.shift();
  }

  /** A `voice.done` of clause `seq` of line `id` was read: that clause, when recorded, is removed and no other. */
  done(id: string, seq: number): void {
    const t = this.now();
    this.sweep(t);
    if (this.clauses.delete(clauseKey(id, seq))) this.release(t);
  }

  /** Whether `at` (epoch ms, ears' clock) falls inside a window the gate was open. */
  blocks(at: number): boolean {
    this.sweep(this.now());
    return this.windows.some((w) => at >= w.start && (w.end === undefined || at <= w.end));
  }

  /** Clauses whose `voice.done` never came are removed at their ceiling, as if it had been read then. */
  private sweep(t: number): void {
    for (const [key, since] of [...this.clauses].sort((a, b) => a[1] - b[1])) {
      if (t - since < ECHO_CLAUSE_CEILING_MS) continue;
      this.clauses.delete(key);
      this.release(since + ECHO_CLAUSE_CEILING_MS);
    }
  }

  private release(at: number): void {
    if (this.clauses.size > 0) return;
    const last = this.windows.at(-1);
    if (last && last.end === undefined) last.end = at + this.tailMs;
  }
}

function clauseKey(id: string, seq: number): string {
  return `${id}-${seq}`;
}
