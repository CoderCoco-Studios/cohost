import type { BusEvent } from "@cohost/bus";

export type TimerEvent = BusEvent<"tool.timer">["data"];

/** A fired timer salience holds until it speaks it, or it expires. Held in memory only: a restart holds none (SAL-REM-008). */
export interface Reminder {
  id: string;
  note: string;
  setAt: number;
  dueAt: number;
}

/** How many spoken ids salience remembers, so a repeated `tool.timer` for a line already said is ignored (SAL-REM-002). */
const SPOKEN_MEMORY = 64;

/**
 * The due timer reminders of the salience region. `dueAt` is measured against the host wall clock, read here through
 * `Date.now()` (the injected monotonic clock is for durations only).
 * @spec SAL-REM-001, SAL-REM-002, SAL-REM-003, SAL-REM-008
 */
export class Reminders {
  private held: Reminder[] = [];
  /** Ids already spoken, oldest first, at most SPOKEN_MEMORY. */
  private spoken: string[] = [];

  constructor(
    private readonly maxHeld: number,
    private readonly expiryMs: number,
  ) {}

  get size(): number { return this.held.length; }

  /**
   * Keeps an arriving `tool.timer` as a reminder. A `missed` republish, an id already held or already spoken is ignored.
   * When the list is full the reminder with the earliest `dueAt` is dropped (SAL-REM-001); a reminder dropped this way
   * is not republished as missed.
   * @spec SAL-REM-001, SAL-REM-002
   */
  arrive(t: TimerEvent): void {
    if (t.missed) return;
    if (this.spoken.includes(t.id) || this.held.some((r) => r.id === t.id)) return;
    this.held.push({ id: t.id, note: t.note, setAt: t.setAt, dueAt: t.dueAt });
    if (this.held.length > this.maxHeld) {
      let oldest = 0;
      for (let i = 1; i < this.held.length; i++) if (this.held[i]!.dueAt < this.held[oldest]!.dueAt) oldest = i;
      this.held.splice(oldest, 1);
    }
  }

  /**
   * Removes and returns every reminder more than `expiryMs` past its `dueAt` at the wall-clock instant `now`.
   * Expired reminders are never spoken; the caller republishes them as missed (SAL-REM-003).
   * @spec SAL-REM-003
   */
  takeExpired(now: number): Reminder[] {
    const expired = this.held.filter((r) => now - r.dueAt > this.expiryMs);
    if (expired.length > 0) this.held = this.held.filter((r) => now - r.dueAt <= this.expiryMs);
    return expired;
  }

  /**
   * The due reminder with the earliest `dueAt` at `now`, or undefined (SAL-REM-006).
   * @spec SAL-REM-006
   */
  due(now: number): Reminder | undefined {
    let best: Reminder | undefined;
    for (const r of this.held) if (r.dueAt <= now && (!best || r.dueAt < best.dueAt)) best = r;
    return best;
  }

  /**
   * Forgets a reminder once its focus is published, and remembers its id as spoken (SAL-REM-005, SAL-REM-002).
   * @spec SAL-REM-005
   */
  settle(id: string): void {
    this.held = this.held.filter((r) => r.id !== id);
    this.spoken.push(id);
    if (this.spoken.length > SPOKEN_MEMORY) this.spoken.splice(0, this.spoken.length - SPOKEN_MEMORY);
  }
}
