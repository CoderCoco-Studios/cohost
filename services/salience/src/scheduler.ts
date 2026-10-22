import type { Config } from "@cohost/config";
import type { Context, ContextEvent } from "@cohost/working-memory";
import type { Module } from "@cohost/modules";
import { toScoreInput, type ScoreInput, type ScoreOutput } from "./scoring.js";

export interface Decision {
  speak: boolean;
  reason: string;
  score: number;
  /** The event most worth replying to, if any. */
  focus?: ContextEvent;
  /** Exactly the events this decision scored; mark only these seen. */
  scored: ContextEvent[];
}

/**
 * Decides *whether* to talk. The per-event scores come from the scorer
 * module (rules / llm / http); this class owns the timing around them:
 * threshold, cooldown, idle chatter. Mood nudges the threshold: excited =
 * chattier.
 */
export class Scheduler {
  private lastSpoke = 0;
  private lastActivity = Date.now();
  private scoreCache = new WeakMap<ContextEvent, number>();

  constructor(private cfg: Config["brain"]["salience"], private scorer: Module<ScoreInput, ScoreOutput>) {}

  noteSpoke(): void {
    this.lastSpoke = Date.now();
    this.lastActivity = this.lastSpoke;
  }
  /** Inside the minimum gap since the last line (anyone's, including reflexes). */
  cooling(): boolean {
    return Date.now() - this.lastSpoke < this.cfg.cooldown_ms;
  }
  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  async decide(ctx: Context, busy: boolean, muted: boolean, arousal = 0): Promise<Decision> {
    const now = Date.now();
    if (muted) return { speak: false, reason: "muted", score: 0, scored: [] };
    if (busy) return { speak: false, reason: "cortex busy", score: 0, scored: [] };
    if (now - this.lastSpoke < this.cfg.cooldown_ms) return { speak: false, reason: "cooldown", score: 0, scored: [] };

    const unseen = ctx.unseen().filter((e) => e.kind !== "self");
    if (unseen.length === 0) return { speak: false, reason: "nothing new", score: 0, scored: [] };

    // Score only events we haven't scored yet: an event stays unseen across ticks while the
    // total is below threshold, and an llm/http scorer must not be re-asked about the same input.
    const fresh = unseen.filter((e) => !this.scoreCache.has(e));
    if (fresh.length > 0) {
      const { scores: fs } = await this.scorer.run(toScoreInput(fresh, arousal));
      fresh.forEach((e, i) => this.scoreCache.set(e, fs[i] ?? 0));
    }
    let score = 0;
    let focus: ContextEvent | undefined;
    let focusScore = 0;
    unseen.forEach((e) => {
      const s = this.scoreCache.get(e) ?? 0;
      score += s;
      if (s > focusScore) { focusScore = s; focus = e; }
    });

    const threshold = Math.max(0.1, this.cfg.speak_threshold - this.cfg.arousal_bias * arousal);
    if (score >= threshold) {
      return { speak: true, reason: focus?.kind === "chat" && focus.mention ? "mentioned" : "engaged", score, focus, scored: unseen };
    }

    const idle = now - this.lastActivity;
    if (this.cfg.idle_chatter_ms > 0 && idle > this.cfg.idle_chatter_ms) {
      return { speak: true, reason: "idle chatter", score, focus, scored: unseen };
    }
    return { speak: false, reason: `score ${score.toFixed(2)} < ${threshold.toFixed(2)}`, score, focus, scored: unseen };
  }
}
