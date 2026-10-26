import type { BusEvent } from "@cohost/bus";
import type { Emotion } from "@cohost/config";

/** Set on events that came from test injection; absent on real ones. */
export interface InjectionFlags { injected?: boolean; remember?: boolean }

/** Only the flags the bus event actually carries, so real events stay free of them. */
function flagsOf(d: InjectionFlags): InjectionFlags {
  return {
    ...(d.injected !== undefined ? { injected: d.injected } : {}),
    ...(d.remember !== undefined ? { remember: d.remember } : {}),
  };
}

/** The flags to copy onto a derived bus event: only for injected inputs, never for real ones (a stray `remember` is dropped). */
export function propagatedFlags(src: object | undefined): InjectionFlags {
  const e = src as InjectionFlags | undefined; // `self` events have no flags
  if (!e?.injected) return {};
  return { injected: true, ...(e.remember !== undefined ? { remember: e.remember } : {}) };
}

export type ContextEvent =
  | ({ kind: "chat"; ts: number; user: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "vision"; ts: number; text: string; changed: boolean; seen: boolean } & InjectionFlags)
  | ({ kind: "speech"; ts: number; speaker: string; text: string; seen: boolean } & InjectionFlags)
  | { kind: "self"; ts: number; text: string; emotion: Emotion; seen: true };

/** Rolling window of what's happened recently — the brain's working memory. */
export class Context {
  private events: ContextEvent[] = [];
  lastVision = "";

  constructor(private max: number) {}

  push(ev: BusEvent): void {
    switch (ev.type) {
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        this.events.push({ kind: "chat", ts: ev.ts, user: d.user, text: d.text, mention: d.mentionsCohost, isMod: d.isMod, isSub: d.isSub, seen: false, ...flagsOf(d) });
        break;
      }
      case "vision.summary": {
        const d = ev.data as BusEvent<"vision.summary">["data"];
        this.lastVision = d.text;
        // Keep only the latest vision line in the window; older ones are noise.
        this.events = this.events.filter((e) => e.kind !== "vision");
        this.events.push({ kind: "vision", ts: ev.ts, text: d.text, changed: d.changed, seen: !d.changed, ...flagsOf(d) });
        break;
      }
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.events.push({ kind: "speech", ts: ev.ts, speaker: d.speaker, text: d.text, seen: false, ...flagsOf(d) });
        break;
      }
      default:
        return;
    }
    this.trim();
  }

  pushSelf(text: string, emotion: Emotion): void {
    this.events.push({ kind: "self", ts: Date.now(), text, emotion, seen: true });
    this.trim();
  }

  unseen(): ContextEvent[] {
    return this.events.filter((e) => !e.seen);
  }
  /** Mark only these events seen (not ones that arrived while a decision was in flight). */
  markSeenEvents(events: readonly ContextEvent[]): void {
    const set = new Set<ContextEvent>(events);
    for (const e of this.events) if (set.has(e)) e.seen = true;
  }
  /** The most recently added event, if any. */
  last(): ContextEvent | undefined {
    return this.events[this.events.length - 1];
  }
  markSeen(): void {
    for (const e of this.events) e.seen = true;
  }
  clear(): void {
    this.events = [];
  }
  all(): readonly ContextEvent[] {
    return this.events;
  }

  /** Render the window as transcript lines for the prompt. */
  transcript(cohostName: string): string {
    return this.events
      .map((e) => {
        switch (e.kind) {
          case "chat": return `[chat] ${e.user}${e.isMod ? " (mod)" : ""}: ${e.text}`;
          case "speech": return `[voice] ${e.speaker}: ${e.text}`;
          case "vision": return `[screen] ${e.text}`;
          case "self": return `${cohostName}: [${e.emotion}] ${e.text}`;
        }
      })
      .join("\n");
  }

  private trim(): void {
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }
}
