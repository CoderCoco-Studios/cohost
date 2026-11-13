import type { BusEvent, EventType, SpeechTiming } from "@cohost/bus";
import type { Emotion } from "@cohost/config";

/** Set on events that came from test injection; absent on real ones. */
export interface InjectionFlags { injected?: boolean; remember?: boolean }

/** Only the flags the bus event actually carries, so real events stay free of them. */
function flagsOf(d: InjectionFlags): InjectionFlags { // @spec WM-FLAG-001, WM-FLAG-002
  return {
    ...(d.injected !== undefined ? { injected: d.injected } : {}),
    ...(d.remember !== undefined ? { remember: d.remember } : {}),
  };
}

/** The flags to copy onto a derived bus event: only for injected inputs, never for real ones (a stray `remember` is dropped). */
export function propagatedFlags(src: object | undefined): InjectionFlags { // @spec WM-FLAG-003, WM-FLAG-004
  const e = src as InjectionFlags | undefined; // `self` events have no flags
  if (!e?.injected) return {};
  return { injected: true, ...(e.remember !== undefined ? { remember: e.remember } : {}) };
}

/**
 * A bus event narrowed on its `type`: `BusEvent` defaults to the union of every payload and does not correlate `type`
 * with `data`, so one cast at the entry of `push` buys a `switch` that narrows each case.
 */
type TaggedEvent = { [K in EventType]: BusEvent<K> }[EventType];

/** `eventId` is the id of the bus event an entry was built from (`markSeenEvents` matches on it). */
export type ContextEvent =
  | ({ kind: "chat"; eventId: string; ts: number; user: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "vision"; eventId: string; ts: number; text: string; changed: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "speech"; eventId: string; ts: number; speaker: string; text: string; timing?: SpeechTiming; seen: boolean } & InjectionFlags)
  | { kind: "self"; ts: number; text: string; emotion: Emotion; seen: true; id?: string; fallback?: string };

/** Rolling window of what's happened recently — the brain's working memory. */
export class Context {
  private events: ContextEvent[] = [];
  lastVision = "";

  /** Entries `push` returned since `holdArrivals`; `undefined` when not holding. */
  private held: ContextEvent[] | undefined;

  constructor(private max: number) {}

  /** The one place a region sizes its window: `brain.working_memory_events`. */
  static forBrain(brain: { working_memory_events: number }): Context { // @spec WM-WIN-005, WM-WIN-008
    return new Context(brain.working_memory_events);
  }

  /** Start recording what `push` appends (a fresh record), at most one window's worth. */
  holdArrivals(): void { // @spec WM-SEEN-004
    this.held = [];
  }

  /** Stop recording and mark seen every recorded entry; marks nothing when not holding. */
  releaseArrivals(): void { // @spec WM-SEEN-004
    const held = this.held;
    this.held = undefined;
    if (held) this.markSeenEvents(held);
  }

  /** Append the perception in `bus` to the window and return its context entry; `undefined` for any other event type. */
  push(bus: BusEvent): ContextEvent | undefined {
    const ev = bus as TaggedEvent;
    let entry: ContextEvent;
    switch (ev.type) {
      case "chat.message": { // @spec WM-PUSH-001, WM-PUSH-010
        const d = ev.data;
        entry = { kind: "chat", eventId: ev.id, ts: ev.ts, user: d.user, text: d.text, mention: d.mentionsCohost, isMod: d.isMod, isSub: d.isSub, seen: false, ...flagsOf(d) };
        break;
      }
      case "vision.summary": { // @spec WM-PUSH-004, WM-PUSH-005
        const d = ev.data;
        this.lastVision = d.text;
        // Keep only the latest vision line in the window; older ones are noise.
        this.events = this.events.filter((e) => e.kind !== "vision");
        entry = { kind: "vision", eventId: ev.id, ts: ev.ts, text: d.text, changed: d.changed, seen: !d.changed, ...flagsOf(d) };
        break;
      }
      case "speech.heard": { // @spec WM-PUSH-002
        const d = ev.data;
        entry = { kind: "speech", eventId: ev.id, ts: ev.ts, speaker: d.speaker, text: d.text, ...(d.timing ? { timing: d.timing } : {}), seen: false, ...flagsOf(d) }; // @spec WM-PUSH-011
        break;
      }
      default: // @spec WM-PUSH-003
        return undefined;
    }
    this.events.push(entry); // @spec WM-PUSH-009
    this.trim();
    if (this.held) {
      this.held.push(entry);
      if (this.held.length > this.max) this.held.splice(0, this.held.length - this.max);
    }
    return entry;
  }

  /** Append the co-host's own line; `ts` is the bus `ts` of the `brain.say` it came from, so every kind shares the publisher's clock. */
  pushSelf(text: string, emotion: Emotion, ts: number, id?: string): void { // @spec WM-PUSH-006, WM-PUSH-007
    this.events.push({ kind: "self", ts, text, emotion, seen: true, ...(id !== undefined ? { id } : {}) });
    this.trim();
  }

  /** Record the text actually heard on the `self` event with this id; false (and no change) when it is not in the window. */
  markFallback(id: string, fallbackText: string): boolean { // @spec WM-PUSH-008
    const e = this.events.find((x) => x.kind === "self" && x.id === id);
    if (!e || e.kind !== "self") return false;
    e.fallback = fallbackText;
    return true;
  }

  /** Whether a `self` event with this id is still in the window. */
  hasSelf(id: string): boolean { // @spec WM-WIN-007
    return this.events.some((e) => e.kind === "self" && e.id === id);
  }

  unseen(): ContextEvent[] { // @spec WM-SEEN-001
    return this.events.filter((e) => !e.seen);
  }
  /** Mark only these events seen (not ones that arrived while a decision was in flight), matched by event id. */
  markSeenEvents(events: readonly ContextEvent[]): void { // @spec WM-SEEN-002
    const ids = new Set<string>();
    for (const e of events) if (e.kind !== "self") ids.add(e.eventId);
    for (const e of this.events) if (e.kind !== "self" && ids.has(e.eventId)) e.seen = true;
  }
  /** The most recently added event, if any. */
  last(): ContextEvent | undefined { // @spec WM-WIN-004
    return this.events[this.events.length - 1];
  }
  markSeen(): void { // @spec WM-SEEN-003
    for (const e of this.events) e.seen = true;
  }
  clear(): void { // @spec WM-WIN-003
    this.events = [];
    if (this.held) this.held = [];
    this.lastVision = "";
  }
  all(): readonly ContextEvent[] { // @spec WM-WIN-006
    return [...this.events];
  }

  /** Render the window as transcript lines for the prompt. */
  transcript(cohostName: string): string { // @spec WM-TRANS-001, WM-TRANS-007
    return this.events
      .map((e) => {
        switch (e.kind) {
          case "chat": return `${LINE_TAG.chat} ${oneLine(e.user)}${e.isMod ? " (mod)" : ""}: ${oneLine(e.text)}`; // @spec WM-TRANS-002, WM-TRANS-006
          case "speech": return `${LINE_TAG.speech} ${oneLine(e.speaker)}: ${oneLine(e.text)}`; // @spec WM-TRANS-003, WM-TRANS-006
          case "vision": return `${LINE_TAG.vision} ${oneLine(e.text)}`; // @spec WM-TRANS-004, WM-TRANS-006
          case "self": // @spec WM-TRANS-005, WM-TRANS-010
            return e.fallback !== undefined
              ? `${cohostName}: [${e.emotion}] ${oneLine(e.fallback)} [your line "${oneLine(e.text)}" failed to play; this came out instead]`
              : `${cohostName}: [${e.emotion}] ${e.text}`;
        }
      })
      .join("\n");
  }

  private trim(): void { // @spec WM-WIN-001, WM-WIN-002
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }
}

/**
 * The tag that opens a transcript line, per input kind. This package owns the list; the LLM layer derives its
 * transcript stop sequences from `TRANSCRIPT_TAGS` (WM-TRANS-009). The co-host's own `Name:` line has no tag.
 */
const LINE_TAG = { chat: "[chat]", speech: "[voice]", vision: "[screen]" } as const;
export const TRANSCRIPT_TAGS: readonly string[] = [LINE_TAG.chat, LINE_TAG.speech, LINE_TAG.vision]; // @spec WM-TRANS-009

/** One line per event: a CR or LF inside a field would let it forge a tag or a co-host line. */
const oneLine = (s: string): string => s.replace(/[\r\n]/g, " "); // @spec WM-TRANS-008
