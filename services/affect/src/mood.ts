import type { Config, Emotion } from "@cohost/config";
import type { AppraiseOutput } from "./appraise.js";

export interface MoodState { valence: number; arousal: number; mood: Emotion; cause?: string }

/**
 * A two-number model of mood: valence (how good) and arousal (how awake).
 * Events nudge it; it relaxes back to baseline with an exponential half-life.
 * That's the whole "limbic system" — cheap, continuous, and the rest of the
 * brain can read it without anyone calling an LLM.
 */
export class Mood {
  valence: number;
  arousal = 0.1;
  cause: string | undefined;
  private lastTick = Date.now();

  constructor(private cfg: Config["brain"]["affect"]) {
    this.valence = cfg.baseline_valence;
  }

  /** Apply decay for the time elapsed since the last call. */
  tick(now = Date.now()): void {
    const dt = now - this.lastTick;
    this.lastTick = now;
    const k = Math.pow(0.5, dt / this.cfg.half_life_ms);
    this.valence = this.cfg.baseline_valence + (this.valence - this.cfg.baseline_valence) * k;
    this.arousal = 0.1 + (this.arousal - 0.1) * k;
  }

  nudge(dv: number, da: number, cause: string): void {
    this.tick();
    this.valence = clamp(this.valence + dv, -1, 1);
    this.arousal = clamp(this.arousal + da, 0, 1);
    this.cause = cause;
  }

  /** Apply an appraisal (from the appraiser module) of a line someone said. */
  applyAppraisal(a: AppraiseOutput, cause: string): void {
    this.nudge(a.valence_delta, a.arousal_delta, cause);
  }

  state(): MoodState {
    return { valence: round(this.valence), arousal: round(this.arousal), mood: label(this.valence, this.arousal), cause: this.cause };
  }
}

/** Nearest canonical emotion for a point on the valence/arousal plane. */
export function label(v: number, a: number): Emotion {
  if (a > 0.6) return v > 0.3 ? "laugh" : v < -0.3 ? "angry" : "surprised";
  if (a > 0.3) return v > 0.2 ? "happy" : v < -0.2 ? "confused" : "think";
  return v > 0.35 ? "smug" : v < -0.3 ? "sad" : "neutral";
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x * 1000) / 1000;
