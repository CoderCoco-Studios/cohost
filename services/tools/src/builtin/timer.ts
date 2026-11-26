/**
 * The built-in `timer` tool (TOOL-TIMER-001 to TOOL-TIMER-008, TOOL-MOCK-006): starts a timer that publishes `tool.timer` when it
 * runs out. Pending timers live in the Redis hash `<prefix>:tools:timers` (live) or in the service's memory (mock). The
 * one scheduler holds every due time; a delay longer than the platform's timer maximum is re-armed in chunks.
 */
import { randomUUID } from "node:crypto";
import type { Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { boundText } from "@cohost/shared/untrusted";
import { SourceFailed, type SourceCallResult } from "../source.js";
import { MINUTE_MS, zoned } from "./format.js";
import type { BuiltinSeams, BuiltinTool } from "./types.js";

/** The latest instant a `Date` holds, in epoch milliseconds: a due time past it cannot be shown (TOOL-TIMER-010). */
export const MAX_DATE_MS = 8.64e15;

/** The longest delay `setTimeout` takes; a longer one would fire at once (TOOL-TIMER-001). */
export const MAX_DELAY_MS = 2 ** 31 - 1;
/** The note is cut to this many characters (TOOL-TIMER-001). */
export const NOTE_MAX = 200;

/** Where pending timers are kept: the Redis hash in live mode, the service's memory in mock mode. */
export interface TimerStore {
  put(id: string, json: string): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<{ id: string; json: string }[]>;
}

export type TimerBus = Pick<Publisher, "publish"> & {
  putTimer(id: string, json: string): Promise<void>;
  deleteTimer(id: string): Promise<void>;
  listTimers(): Promise<{ id: string; json: string }[]>;
};

interface Pending { id: string; note: string; setAt: number; dueAt: number; cancel: () => void }

/** A stored timer that is well formed: its field is its id and it holds exactly the four members (TOOL-TIMER-005). */
// @spec TOOL-TIMER-007
export function parseStored(field: string, json: string): Omit<Pending, "cancel"> | undefined {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return undefined; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.id !== field || typeof o.note !== "string" || o.note.trim() === "") return undefined;
  if (!Number.isSafeInteger(o.setAt) || !Number.isSafeInteger(o.dueAt)) return undefined;
  return { id: field, note: o.note, setAt: o.setAt as number, dueAt: o.dueAt as number };
}

export class TimerTool {
  private readonly pending = new Map<string, Pending>();
  private stopped = false;
  /** Resolves once the stored timers are read at start; a timer call waits for it, so the limit counts them (TOOL-TIMER-004). */
  private readonly loaded: Promise<void>;
  private markLoaded: () => void = () => {};

  constructor(
    private readonly cfg: Config,
    private readonly seams: BuiltinSeams,
    private readonly bus: TimerBus,
    private readonly store: TimerStore,
    private readonly log: Pick<Logger, "info" | "warn" | "error">,
    private readonly mock: boolean,
  ) {
    this.loaded = new Promise<void>((resolve) => { this.markLoaded = resolve; });
    if (mock) this.markLoaded();
  }

  tool(): BuiltinTool {
    const max = this.cfg.tools.timer.max_minutes;
    return {
      name: "timer",
      description: `Sets a timer that tells the co-host when it runs out: minutes from 1 to ${max}, and a note of what to say then. At most ${this.cfg.tools.timer.max_active} run at once.`,
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "integer", minimum: 1, maximum: max, description: "Minutes until the timer runs out." },
          note: { type: "string", description: "What the timer is for." },
        },
        required: ["minutes", "note"],
      },
      label: "acts",
      accepts: (args) => {
        const m = args.minutes;
        if (!(typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= max && typeof args.note === "string" && boundText(args.note, NOTE_MAX) !== "")) return false;
        // A due time that no Date can show is refused before anything is stored (TOOL-TIMER-010).
        return this.seams.now() + m * MINUTE_MS <= MAX_DATE_MS;
      },
      call: (args, signal) => this.setTimer(args, signal),
    };
  }

  /** Reads the stored timers at start: a due one fires at once, oldest due first; the rest are armed (TOOL-TIMER-007). */
  // @spec TOOL-TIMER-007
  async load(): Promise<void> {
    if (this.mock) return;
    try {
      await this.readStored();
    } finally {
      this.markLoaded();
    }
  }

  private async readStored(): Promise<void> {
    let stored: { id: string; json: string }[];
    try {
      stored = await this.bus.listTimers();
    } catch {
      this.log.error("pending timers could not be read at start");
      return;
    }
    const parsed: Omit<Pending, "cancel">[] = [];
    for (const { id, json } of stored) {
      const t = parseStored(id, json);
      if (t === undefined) { this.log.warn({ id }, "skipped a stored timer that is not a timer"); continue; }
      parsed.push(t);
    }
    parsed.sort((a, b) => a.dueAt - b.dueAt);
    const now = this.seams.now();
    const due = parsed.filter((t) => t.dueAt <= now);
    for (const t of parsed) if (t.dueAt > now) this.pending.set(t.id, { ...t, cancel: () => {} });
    for (const t of due) await this.fire({ ...t, cancel: () => {} });
    for (const t of parsed) if (t.dueAt > now && this.pending.has(t.id)) this.arm(this.pending.get(t.id)!);
  }

  /** Cancels every wait; the pending timers stay in the store for the next start (TOOL-SVC-008). */
  stop(): void {
    this.stopped = true;
    for (const t of this.pending.values()) t.cancel();
    this.pending.clear();
  }

  /**
   * Resolves true once the stored timers are read, false when the call's signal ends first (its limit passed, or the service
   * stopped): a call the pipeline has already ended must set nothing.
   */
  private loadedBefore(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.loaded.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      });
    });
  }

  /** Sets one timer: the limit is checked and the slot reserved before the store is written (TOOL-TIMER-004). */
  // @spec TOOL-TIMER-001, TOOL-TIMER-003, TOOL-TIMER-004, TOOL-TIMER-005, TOOL-MOCK-006
  private async setTimer(args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult> {
    // The stored timers are read first, so the limit counts them (TOOL-TIMER-004). A call ended while it waits sets nothing.
    if (!(await this.loadedBefore(signal)) || signal.aborted || this.stopped) throw new SourceFailed("The timer was not set.");
    const zone = this.cfg.cohost.timezone;
    if (this.pending.size >= this.cfg.tools.timer.max_active) {
      throw new SourceFailed("The timers are all running; one must run out before another can be set.", "limit");
    }
    const minutes = args.minutes as number;
    const note = boundText(args.note as string, NOTE_MAX);
    // Read again after the wait: the clock may have moved, so the due time is checked against the current instant.
    const setAt = this.seams.now();
    const dueAt = setAt + minutes * MINUTE_MS;
    if (dueAt > MAX_DATE_MS) throw new SourceFailed("The timer was not set: its due time is out of range.");
    const id = randomUUID();
    const entry: Pending = { id, note, setAt, dueAt, cancel: () => {} };
    this.pending.set(id, entry);
    try {
      await this.store.put(id, JSON.stringify({ id, note, setAt, dueAt }));
    } catch {
      this.pending.delete(id);
      throw new SourceFailed("The timer could not be stored, so none was set.");
    }
    if (signal.aborted || this.stopped) {
      // The call ended while the store was written: the stored field is removed again, so no timer is announced.
      this.pending.delete(id);
      await this.store.delete(id).catch(() => {});
      throw new SourceFailed("The timer was not set.");
    }
    this.arm(entry);
    const at = zoned(dueAt, zone);
    return { content: [{ type: "text", text: `Timer set. It fires at ${at.clock} on ${at.weekday}, ${at.date} (${zone}).` }] };
  }

  /** Publishes `tool.timer`, then deletes the stored field (TOOL-TIMER-006); a timer whose publish fails stays stored. */
  // @spec TOOL-TIMER-006
  private async fire(t: Pending): Promise<void> {
    this.pending.delete(t.id);
    t.cancel();
    try {
      await this.bus.publish("tool.timer", { id: t.id, note: t.note, setAt: t.setAt, dueAt: t.dueAt });
    } catch {
      this.log.error({ id: t.id }, "tool.timer was not published; the timer stays stored until the next start");
      return;
    }
    try {
      await this.store.delete(t.id);
    } catch {
      this.log.warn({ id: t.id }, "a fired timer could not be deleted from the store");
    }
  }

  private arm(t: Pending): void {
    const step = (): void => {
      if (this.stopped || !this.pending.has(t.id)) return;
      const left = t.dueAt - this.seams.now();
      if (left > 0) t.cancel = this.seams.schedule(step, Math.min(left, MAX_DELAY_MS));
      else void this.fire(t);
    };
    t.cancel = this.seams.schedule(step, Math.min(Math.max(0, t.dueAt - this.seams.now()), MAX_DELAY_MS));
  }
}
