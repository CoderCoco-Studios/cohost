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
 * The due timer reminders of the salience region. `dueAt` is measured against the host wall clock: callers pass `Date.now()`
 * as `now` (the injected monotonic clock is for durations only).
 * @spec SAL-REM-001, SAL-REM-002, SAL-REM-003, SAL-REM-008
 */
export class Reminders {
  private held: Reminder[] = [];
  /** Ids already spoken, oldest first, at most SPOKEN_MEMORY. */
  private spoken: string[] = [];
  /** Ids whose `attention.focus` publish is in flight: never expired, due or evicted until it settles or aborts (SAL-REM-005). */
  private speaking = new Set<string>();

  constructor(
    private readonly maxHeld: number,
    private readonly expiryMs: number,
  ) {}

  get size(): number { return this.held.length; }

  /**
   * Handles an arriving `tool.timer`. The expiry sweep of the held list runs first, so a held reminder gone stale is
   * republished rather than evicted by the bound. Then a `missed` republish, or an id already held or spoken, is ignored. An
   * arrival already past the expiry is never held. Otherwise it is held, and when the list is over `maxHeld` the unspoken
   * reminder with the earliest `dueAt` is dropped (SAL-REM-001); a dropped reminder is not republished as missed.
   * Returns the reminders to republish as `missed` now; the caller must republish each.
   * @spec SAL-REM-001, SAL-REM-002, SAL-REM-003
   */
  arrive(t: TimerEvent, now: number): Reminder[] {
    const late = this.takeExpired(now);
    if (t.missed) return late;
    if (this.spoken.includes(t.id) || this.held.some((r) => r.id === t.id)) return late;
    const r: Reminder = { id: t.id, note: t.note, setAt: t.setAt, dueAt: t.dueAt };
    if (now - r.dueAt > this.expiryMs) return [...late, r];
    this.held.push(r);
    if (this.held.length > this.maxHeld) {
      let oldest: number | undefined;
      for (let i = 0; i < this.held.length; i++) {
        const h = this.held[i]!;
        if (this.speaking.has(h.id)) continue;
        if (oldest === undefined || h.dueAt < this.held[oldest]!.dueAt) oldest = i;
      }
      if (oldest !== undefined) this.held.splice(oldest, 1);
    }
    return late;
  }

  /**
   * Removes and returns every held reminder more than `expiryMs` past its `dueAt` at `now`, except one whose publish is in
   * flight. Expired reminders are never spoken; the caller republishes them as missed (SAL-REM-003).
   * @spec SAL-REM-003
   */
  takeExpired(now: number): Reminder[] {
    const expired = this.held.filter((r) => !this.speaking.has(r.id) && now - r.dueAt > this.expiryMs);
    if (expired.length > 0) this.held = this.held.filter((r) => !expired.includes(r));
    return expired;
  }

  /**
   * The due reminder with the earliest `dueAt` at `now`, or undefined. One whose publish is in flight is not offered again
   * (SAL-REM-006).
   * @spec SAL-REM-006
   */
  due(now: number): Reminder | undefined {
    let best: Reminder | undefined;
    for (const r of this.held) {
      if (this.speaking.has(r.id) || r.dueAt > now) continue;
      if (!best || r.dueAt < best.dueAt) best = r;
    }
    return best;
  }

  /** Marks a reminder whose focus publish has started: it cannot expire or be evicted meanwhile (SAL-REM-003, SAL-REM-005). */
  beginSpeak(id: string): void { this.speaking.add(id); }

  /** A focus publish failed: the reminder is due again and may expire normally (SAL-HEALTH-002). */
  abortSpeak(id: string): void { this.speaking.delete(id); }

  /**
   * Forgets a reminder once its focus is published, and remembers its id as spoken (SAL-REM-005, SAL-REM-002).
   * @spec SAL-REM-005
   */
  settle(id: string): void {
    this.speaking.delete(id);
    this.held = this.held.filter((r) => r.id !== id);
    this.spoken.push(id);
    if (this.spoken.length > SPOKEN_MEMORY) this.spoken.splice(0, this.spoken.length - SPOKEN_MEMORY);
  }
}
