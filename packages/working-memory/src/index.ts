import type { BusEvent } from "@cohost/bus";
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

export type ContextEvent =
  | ({ kind: "chat"; ts: number; user: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "vision"; ts: number; text: string; changed: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "speech"; ts: number; speaker: string; text: string; seen: boolean } & InjectionFlags)
  | { kind: "self"; ts: number; text: string; emotion: Emotion; seen: true; id?: string; fallback?: string };

/** Rolling window of what's happened recently — the brain's working memory. */
export class Context {
  private events: ContextEvent[] = [];
  lastVision = "";

  constructor(private max: number) {}

  push(ev: BusEvent): void {
    switch (ev.type) {
      case "chat.message": { // @spec WM-PUSH-001
        const d = ev.data as BusEvent<"chat.message">["data"];
        this.events.push({ kind: "chat", ts: ev.ts, user: d.user, text: d.text, mention: d.mentionsCohost, isMod: d.isMod, isSub: d.isSub, seen: false, ...flagsOf(d) });
        break;
      }
      case "vision.summary": { // @spec WM-PUSH-004, WM-PUSH-005
        const d = ev.data as BusEvent<"vision.summary">["data"];
        this.lastVision = d.text;
        // Keep only the latest vision line in the window; older ones are noise.
        this.events = this.events.filter((e) => e.kind !== "vision");
        this.events.push({ kind: "vision", ts: ev.ts, text: d.text, changed: d.changed, seen: !d.changed, ...flagsOf(d) });
        break;
      }
      case "speech.heard": { // @spec WM-PUSH-002
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.events.push({ kind: "speech", ts: ev.ts, speaker: d.speaker, text: d.text, seen: false, ...flagsOf(d) });
        break;
      }
      default: // @spec WM-PUSH-003
        return;
    }
    this.trim();
  }

  pushSelf(text: string, emotion: Emotion, id?: string): void { // @spec WM-PUSH-006, WM-PUSH-007
    this.events.push({ kind: "self", ts: Date.now(), text, emotion, seen: true, ...(id !== undefined ? { id } : {}) });
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
  /** Mark only these events seen (not ones that arrived while a decision was in flight). */
  markSeenEvents(events: readonly ContextEvent[]): void { // @spec WM-SEEN-002
    const set = new Set<ContextEvent>(events);
    for (const e of this.events) if (set.has(e)) e.seen = true;
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
