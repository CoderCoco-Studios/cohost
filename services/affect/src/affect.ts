import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { controlFor } from "@cohost/shared";
import { Mood } from "./mood.js";
import { appraiseRules, type AppraiseInput, type AppraiseOutput } from "./appraise.js";

export interface AffectDeps {
  cfg: Config;
  bus: Publisher;
  appraiser: Module<AppraiseInput, AppraiseOutput>;
  log: Logger;
  /** Monotonic millisecond clock for mood decay and the publish heartbeat (default `performance.now`); tests inject a fake one. */
  now?: () => number;
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
  private readonly now: () => number;
  private lastPublished = "";
  private lastPublishedAt = -Infinity;
  private queue: { input: AppraiseInput; cause: string; epoch: number }[] = [];
  private draining?: Promise<void>;
  /** `control` state (shared reader). Paused: events no longer nudge the mood, decay and publishing continue (AFF-CTRL-005). Its epoch is bumped by pause and forget_context: a job queued under an older epoch never changes the mood. */
  private readonly control: ReturnType<typeof controlFor>;

  constructor(private d: AffectDeps) {
    this.now = d.now ?? (() => performance.now());
    this.mood = new Mood(d.cfg.brain.affect, this.now);
    this.control = controlFor("affect", {
      forget_context: () => { // @spec AFF-HOOK-008
        this.queue.length = 0;
        this.mood.reset("reset"); // @spec AFF-IN-007
      },
    }, { log: d.log });
  }

  onEvent(ev: BusEvent): void {
    const mood = this.mood;
    if (this.control.paused && ev.type !== "control") return; // @spec AFF-CTRL-002
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
      // @spec AFF-CTRL-001, AFF-CTRL-002, AFF-CTRL-004, AFF-HOOK-008
      case "control":
        this.control.handle(ev); // a command addressed to another service changes nothing
        break;
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
    this.queue.push({ input, cause, epoch: this.control.epoch }); // @spec AFF-HOOK-005
    while (this.queue.length > MAX_QUEUED) this.queue.shift(); // @spec AFF-HOOK-006
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined; });
  }

  private async drain() {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      if (this.stale(job)) continue; // @spec AFF-HOOK-008
      const out = await this.d.appraiser.run({ ...job.input, valence: this.mood.valence, arousal: this.mood.arousal }); // @spec AFF-HOOK-003, AFF-HOOK-005
      if (this.stale(job)) continue; // paused or reset while the appraiser was working; @spec AFF-HOOK-008
      this.mood.applyAppraisal(out, job.cause);
    }
  }

  /** A job that must not touch the mood: affect is paused, or a pause or reset happened since it was queued. */
  private stale(job: { epoch: number }): boolean {
    return this.control.paused || job.epoch !== this.control.epoch;
  }

  publish(): void { // @spec AFF-PUB-001, AFF-PUB-002, AFF-PUB-003, AFF-CTRL-003
    this.mood.tick();
    const s = this.mood.state();
    const key = `${s.mood}:${s.valence.toFixed(2)}:${s.arousal.toFixed(2)}`;
    const now = this.now();
    // Only publish when it moved, plus a heartbeat so late joiners get a value.
    if (key === this.lastPublished && now - this.lastPublishedAt < 15_000) return;
    this.lastPublished = key;
    this.lastPublishedAt = now;
    this.d.bus.publish("affect.state", s).catch((err) => { // @spec AFF-PUB-004
      this.d.log.warn({ err }, "affect.state publish failed");
    });
  }
}
