import type { Config } from "@cohost/config";
import type { Context, ContextEvent } from "@cohost/working-memory";

export interface Decision {
  speak: boolean;
  reason: string;
  score: number;
  /** The event most worth replying to, if any. */
  focus?: ContextEvent;
}

/**
 * Decides *whether* to talk. Deliberately simple and tunable from config —
 * this is the knob that makes a co-host pleasant instead of exhausting.
 * Mood (from the affect region) nudges the threshold: excited = chattier.
 */
export class Scheduler {
  private lastSpoke = 0;
  private lastActivity = Date.now();

  constructor(private cfg: Config["brain"]["salience"]) {}

  noteSpoke(): void {
    this.lastSpoke = Date.now();
    this.lastActivity = this.lastSpoke;
  }
  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  decide(ctx: Context, busy: boolean, muted: boolean, arousal = 0): Decision {
    const now = Date.now();
    if (muted) return { speak: false, reason: "muted", score: 0 };
    if (busy) return { speak: false, reason: "cortex busy", score: 0 };
    if (now - this.lastSpoke < this.cfg.cooldown_ms) return { speak: false, reason: "cooldown", score: 0 };

    const unseen = ctx.unseen();
    if (unseen.length === 0) return { speak: false, reason: "nothing new", score: 0 };

    let score = 0;
    let focus: ContextEvent | undefined;
    let focusScore = 0;
    for (const e of unseen) {
      let s = 0;
      if (e.kind === "speech") s = 0.9;                       // the streamer talked to it (or near it)
      else if (e.kind === "chat") {
        s = 0.15;
        if (e.mention && this.cfg.reply_on_mention) s = 1.0;
        else if (e.text.includes("?")) s = 0.55;
        else if (e.isMod || e.isSub) s = 0.35;
      } else if (e.kind === "vision") s = e.changed ? 0.3 : 0;
      score += s;
      if (s > focusScore) { focusScore = s; focus = e; }
    }

    const threshold = Math.max(0.1, this.cfg.speak_threshold - this.cfg.arousal_bias * arousal);
    if (score >= threshold) {
      return { speak: true, reason: focus?.kind === "chat" && focus.mention ? "mentioned" : "engaged", score, focus };
    }

    const idle = now - this.lastActivity;
    if (this.cfg.idle_chatter_ms > 0 && idle > this.cfg.idle_chatter_ms) {
      return { speak: true, reason: "idle chatter", score, focus };
    }
    return { speak: false, reason: `score ${score.toFixed(2)} < ${threshold.toFixed(2)}`, score, focus };
  }
}
