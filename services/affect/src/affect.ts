import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { Mood } from "./mood.js";
import { appraiseRules, type AppraiseInput, type AppraiseOutput } from "./appraise.js";

export interface AffectDeps {
  cfg: Config;
  bus: Publisher;
  appraiser: Module<AppraiseInput, AppraiseOutput>;
  log: Logger;
}

/**
 * rules appraise inline. An llm/http appraiser can take its whole timeout per line, so those run
 * on a small worker queue instead of the bus handler: the consumer never stalls behind a slow
 * module, and when appraisal falls behind the oldest waiting lines are dropped (mood is a
 * smoothed signal; a missed line costs less than a stale one).
 */
const MAX_QUEUED = 8;

/** The affect region's state and event handling; index.ts wires it to the bus and the publish timer. */
export class Affect {
  readonly mood: Mood;
  private lastPublished = "";
  private lastPublishedAt = 0;
  private queue: { input: AppraiseInput; cause: string }[] = [];
  private draining?: Promise<void>;
  /** Paused by `control pause`: events no longer nudge the mood; decay and publishing continue. */
  private paused = false; // @spec AFF-CTRL-005

  constructor(private d: AffectDeps) {
    this.mood = new Mood(d.cfg.brain.affect);
  }

  onEvent(ev: BusEvent): void {
    const mood = this.mood;
    if (this.paused && ev.type !== "control") return; // @spec AFF-CTRL-002
    switch (ev.type) {
      case "chat.message": { // @spec AFF-IN-002
        const d = ev.data as BusEvent<"chat.message">["data"];
        this.appraise("chat", d.user, d.text, d.mentionsCohost);
        if (d.isSub) mood.nudge(0.05, 0.05, `sub: ${d.user}`); // @spec AFF-IN-004
        break;
      }
      case "speech.heard": { // @spec AFF-IN-003
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.appraise("speech", d.speaker, d.text, false);
        break;
      }
      case "vision.summary": {
        const d = ev.data as BusEvent<"vision.summary">["data"];
        if (d.changed) mood.nudge(0, 0.08, "screen changed"); // @spec AFF-IN-005
        break;
      }
      case "brain.say": { // @spec AFF-IN-006
        // Saying something emotional reinforces the mood a little (and talking is arousing).
        const d = ev.data as BusEvent<"brain.say">["data"];
        const dv = ["happy", "laugh", "smug"].includes(d.emotion) ? 0.08 : ["sad", "angry"].includes(d.emotion) ? -0.08 : 0;
        mood.nudge(dv, 0.05, `said: ${d.emotion}`);
        break;
      }
      case "control": {
        const d = ev.data as BusEvent<"control">["data"];
        if (d.target && d.target !== "affect") break; // addressed to another service; @spec AFF-CTRL-001
        if (d.cmd === "pause") this.paused = true; // @spec AFF-CTRL-002
        if (d.cmd === "resume") this.paused = false; // @spec AFF-CTRL-004
        if (d.cmd === "forget_context") { mood.nudge(this.d.cfg.brain.affect.baseline_valence - mood.valence, 0.1 - mood.arousal, "reset"); } // @spec AFF-IN-007
        break;
      }
    }
  }

  /** Resolves once queued llm/http appraisals have been applied. */
  async settled(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private appraise(source: "chat" | "speech", who: string, text: string, mention: boolean) {
    const mood = this.mood;
    mood.tick();
    const input: AppraiseInput = { source, who, text, mention, valence: mood.valence, arousal: mood.arousal };
    const cause = `${source === "speech" ? "voice" : "chat"}: ${who}`;
    // Rules are instant, and a line too short to carry tone isn't worth a model call.
    if (this.d.appraiser.kind === "rules" || (!mention && text.trim().length < 4)) { // @spec AFF-HOOK-004, AFF-HOOK-007
      mood.applyAppraisal(appraiseRules(input), cause);
      return;
    }
    this.queue.push({ input, cause }); // @spec AFF-HOOK-005
    while (this.queue.length > MAX_QUEUED) this.queue.shift(); // @spec AFF-HOOK-006
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined; });
  }

  private async drain() {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const out = await this.d.appraiser.run({ ...job.input, valence: this.mood.valence, arousal: this.mood.arousal }); // @spec AFF-HOOK-003, AFF-HOOK-005
      this.mood.applyAppraisal(out, job.cause);
    }
  }

  publish(): void { // @spec AFF-PUB-001, AFF-PUB-002, AFF-PUB-003, AFF-CTRL-003
    this.mood.tick();
    const s = this.mood.state();
    const key = `${s.mood}:${s.valence.toFixed(2)}:${s.arousal.toFixed(2)}`;
    const now = Date.now();
    // Only publish when it moved, plus a heartbeat so late joiners get a value.
    if (key === this.lastPublished && now - this.lastPublishedAt < 15_000) return;
    this.lastPublished = key;
    this.lastPublishedAt = now;
    void this.d.bus.publish("affect.state", s);
  }
}
