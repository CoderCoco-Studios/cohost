import type { BusEvent } from "@cohost/bus";
import type { Emotion } from "@cohost/config";

export type ContextEvent =
  | { kind: "chat"; ts: number; user: string; text: string; mention: boolean; isMod: boolean; isSub: boolean; seen: boolean }
  | { kind: "vision"; ts: number; text: string; changed: boolean; seen: boolean }
  | { kind: "speech"; ts: number; speaker: string; text: string; seen: boolean }
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
        this.events.push({ kind: "chat", ts: ev.ts, user: d.user, text: d.text, mention: d.mentionsCohost, isMod: d.isMod, isSub: d.isSub, seen: false });
        break;
      }
      case "vision.summary": {
        const d = ev.data as BusEvent<"vision.summary">["data"];
        this.lastVision = d.text;
        // Keep only the latest vision line in the window; older ones are noise.
        this.events = this.events.filter((e) => e.kind !== "vision");
        this.events.push({ kind: "vision", ts: ev.ts, text: d.text, changed: d.changed, seen: !d.changed });
        break;
      }
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.events.push({ kind: "speech", ts: ev.ts, speaker: d.speaker, text: d.text, seen: false });
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
