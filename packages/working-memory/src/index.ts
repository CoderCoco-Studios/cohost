import type { BusEvent, EventType, Timing } from "@cohost/bus";
import type { Emotion } from "@cohost/config";
import { boundText, quoteUntrusted, speakerLabel, UNKNOWN_NAME } from "@cohost/shared/untrusted";

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

/** The platform a chat message or removal came from, as the bus names it. */
export type ChatPlatform = BusEvent<"chat.message">["data"]["platform"];

/** A `chat.removed` bus event's payload: what `Context.forget` removes. */
export type ChatRemoval = BusEvent<"chat.removed">["data"];

/**
 * `eventId` is the id of the bus event an entry was built from (`markSeenEvents` matches on it). A chat entry holds
 * `platform` always and `userId` and `messageId` only when the bus event carried them (WM-PUSH-001).
 */
export type ContextEvent =
  | ({ kind: "chat"; eventId: string; ts: number; platform: ChatPlatform; userId?: string; messageId?: string; user: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "vision"; eventId: string; ts: number; text: string; changed: boolean; timing?: Timing; seen: boolean } & InjectionFlags)
  | ({ kind: "speech"; eventId: string; ts: number; speaker: string; text: string; timing?: Timing; seen: boolean } & InjectionFlags)
  | { kind: "self"; ts: number; text: string; emotion: Emotion; seen: true; id?: string; fallback?: string; heard?: string };

/**
 * The character limits a window bounds text to on intake and renders with. Absent (a directly constructed `Context`)
 * the window bounds nothing: text is stored and rendered as given, apart from the transcript's own line flattening.
 */
export interface ContextLimits {
  chatChars: number;
  nameChars: number;
  speechChars: number;
  visionChars: number;
}

/** `ownLines`: how many of the newest `self` events eviction never drops (capped at `max - 1`); 0 when absent. */
export interface ContextOptions {
  ownLines?: number;
  limits?: ContextLimits;
}

/** Bounds `raw` to `max` when a limit is set; otherwise returns it unchanged. */
const bounded = (raw: string, max: number | undefined): string => (max === undefined ? raw : boundText(raw, max)); // @spec WM-WIN-011

/** A viewer or speaker name as stored: bounded, and `unknown` when nothing is left. */
const nameOf = (raw: string, max: number | undefined): string => bounded(raw, max) || UNKNOWN_NAME; // @spec WM-PUSH-015, WM-PUSH-017

/** Rolling window of what's happened recently — the brain's working memory. */
export class Context {
  private events: ContextEvent[] = [];
  lastVision = "";

  /** Entries `push` returned since `holdArrivals`; `undefined` when not holding. */
  private held: ContextEvent[] | undefined;
  private readonly ownLines: number;
  private readonly limits: ContextLimits | undefined;

  constructor(private max: number, opts: ContextOptions = {}) { // @spec WM-WIN-012
    this.ownLines = opts.ownLines ?? 0;
    this.limits = opts.limits;
  }

  /**
   * The one place a region sizes its window and reads the limit keys for it: `brain.working_memory_events` sizes it,
   * `brain.working_memory_own_lines` protects its newest own lines, and `viewerText` plus `brain.input_limits` bound
   * what `push` stores and `transcript` renders.
   */
  static forBrain( // @spec WM-WIN-008, WM-WIN-010, WM-WIN-011
    brain: {
      working_memory_events: number;
      working_memory_own_lines: number;
      input_limits: { speech_max_chars: number; vision_max_chars: number };
    },
    viewerText: { max_chars: number; max_name_chars: number },
  ): Context {
    return new Context(brain.working_memory_events, {
      ownLines: brain.working_memory_own_lines,
      limits: {
        chatChars: viewerText.max_chars,
        nameChars: viewerText.max_name_chars,
        speechChars: brain.input_limits.speech_max_chars,
        visionChars: brain.input_limits.vision_max_chars,
      },
    });
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
  push(bus: BusEvent): ContextEvent | undefined { // @spec WM-PUSH-014, WM-PUSH-015, WM-PUSH-016, WM-PUSH-017, WM-PUSH-018
    const ev = bus as TaggedEvent;
    const limits = this.limits;
    let entry: ContextEvent;
    switch (ev.type) {
      case "chat.message": { // @spec WM-PUSH-001, WM-PUSH-010
        const d = ev.data;
        entry = { kind: "chat", eventId: ev.id, ts: ev.ts, platform: d.platform, ...(d.userId !== undefined ? { userId: d.userId } : {}), ...(d.messageId !== undefined ? { messageId: d.messageId } : {}), user: nameOf(d.user, limits?.nameChars), text: bounded(d.text, limits?.chatChars), mention: d.mentionsCohost, isMod: d.isMod, isSub: d.isSub, seen: false, ...flagsOf(d) };
        break;
      }
      case "vision.summary": { // @spec WM-PUSH-004, WM-PUSH-005
        const d = ev.data;
        const text = bounded(d.text, limits?.visionChars);
        this.lastVision = text;
        // Keep only the latest vision line in the window; older ones are noise.
        this.events = this.events.filter((e) => e.kind !== "vision");
        entry = { kind: "vision", eventId: ev.id, ts: ev.ts, text, changed: d.changed, ...(d.timing ? { timing: d.timing } : {}), seen: !d.changed, ...flagsOf(d) }; // @spec WM-PUSH-013
        break;
      }
      case "speech.heard": { // @spec WM-PUSH-002
        const d = ev.data;
        entry = { kind: "speech", eventId: ev.id, ts: ev.ts, speaker: nameOf(d.speaker, limits?.nameChars), text: bounded(d.text, limits?.speechChars), ...(d.timing ? { timing: d.timing } : {}), seen: false, ...flagsOf(d) }; // @spec WM-PUSH-011
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

  /**
   * Record (a string) or clear (`undefined`) the text the audience heard of the `self` event with this id, without
   * moving it or changing its `seen`; false (and no change) when no such event is in the window.
   */
  markHeard(id: string, heard: string | undefined): boolean { // @spec WM-PUSH-019, WM-PUSH-020
    const e = this.events.find((x) => x.kind === "self" && x.id === id);
    if (!e || e.kind !== "self") return false;
    if (heard === undefined) delete e.heard;
    else e.heard = heard;
    return true;
  }

  /** Whether a `self` event with this id is still in the window. */
  hasSelf(id: string): boolean { // @spec WM-WIN-007
    return this.events.some((e) => e.kind === "self" && e.id === id);
  }

  /**
   * Remove the chat entries a `chat.removed` names (WM-FORGET-001..003): `message` by `messageId`, `user` by `userId`
   * (an entry with no `userId` never matches), `all` every entry; always only this removal's platform. A removed entry
   * also leaves the arrivals record, so it is never marked seen later (WM-FORGET-005). Returns how many were removed.
   */
  forget(removal: ChatRemoval): number { // @spec WM-FORGET-001, WM-FORGET-002, WM-FORGET-003, WM-FORGET-004, WM-FORGET-005, WM-FORGET-006
    const matches = (e: ContextEvent): boolean => {
      if (e.kind !== "chat" || e.platform !== removal.platform) return false;
      switch (removal.scope) {
        // An empty id names nothing: an unvalidated removal with "" matches no entry (WM-FORGET-006).
        case "message": return !!removal.messageId && e.messageId === removal.messageId;
        case "user": return !!removal.userId && e.userId === removal.userId;
        case "all": return true;
      }
    };
    const before = this.events.length;
    this.events = this.events.filter((e) => !matches(e));
    if (this.held) this.held = this.held.filter((e) => !matches(e));
    return before - this.events.length;
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

  /**
   * Render the window as transcript lines for the prompt. Every line is one line starting with its tag. Chat is
   * a labelled, quoted line; a `self` line renders the same whether or not it has `heard` text.
   */
  transcript(cohostName: string): string { // @spec WM-TRANS-001, WM-TRANS-007, WM-TRANS-013, WM-TRANS-014
    const limits = this.limits;
    return this.events
      .map((e) => {
        switch (e.kind) {
          case "chat": { // @spec WM-TRANS-002, WM-TRANS-008
            const label = speakerLabel(e.user, limits?.nameChars ?? Infinity);
            const quoted = quoteUntrusted(e.text, limits?.chatChars ?? Infinity);
            return `${LINE_TAG.chat} ${label}${e.isMod ? " (mod)" : ""}: ${quoted}`;
          }
          case "speech": return `${LINE_TAG.speech} ${speakerLabel(e.speaker, limits?.nameChars ?? Infinity)}: ${oneLine(e.text)}`; // @spec WM-TRANS-003, WM-TRANS-006
          case "vision": return `${LINE_TAG.vision} ${oneLine(e.text)}`; // @spec WM-TRANS-004, WM-TRANS-006, WM-TRANS-012
          case "self": // @spec WM-TRANS-005, WM-TRANS-010, WM-TRANS-011
            return e.fallback !== undefined
              ? `${cohostName}: [${e.emotion}] ${oneLine(e.fallback)} [your line "${oneLine(e.text)}" failed to play; this came out instead]`
              : `${cohostName}: [${e.emotion}] ${oneLine(e.text)}`;
        }
      })
      .join("\n");
  }

  /**
   * Keep the window at `max`: drop the oldest event that is not among the newest protected `self` events, repeating
   * until the count is `max`. Protection is `ownLines` capped at `max - 1`, so an unprotected event always exists.
   */
  private trim(): void { // @spec WM-WIN-001, WM-WIN-002, WM-WIN-009
    let excess = this.events.length - this.max;
    if (excess <= 0) return;
    const protectedSet = new Set<ContextEvent>();
    let budget = Math.min(this.ownLines, this.max - 1);
    for (let i = this.events.length - 1; i >= 0 && budget > 0; i--) {
      const e = this.events[i]!;
      if (e.kind === "self") { protectedSet.add(e); budget--; }
    }
    const kept: ContextEvent[] = [];
    for (const e of this.events) {
      if (excess > 0 && !protectedSet.has(e)) { excess--; continue; }
      kept.push(e);
    }
    this.events = kept;
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
