import type { Config, Emotion } from "@cohost/config";
import { clamp } from "@cohost/modules";
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
  arousal: number;
  cause: string | undefined;
  private lastTick: number;

  /**
   * `now` is a monotonic millisecond clock (default `performance.now`): decay is a function of elapsed time, so a
   * stepped wall clock (NTP, VM time sync) must neither decay the mood at once nor amplify it. Tests inject a fake one.
   */
  constructor(private cfg: Config["brain"]["affect"], private now: () => number = () => performance.now()) { // @spec AFF-MOOD-001
    this.lastTick = now();
    this.valence = cfg.baseline_valence;
    this.arousal = cfg.baseline_arousal; // @spec AFF-MOOD-006
  }

  /** Apply decay for the time elapsed since the last call. */
  tick(now = this.now()): void { // @spec AFF-MOOD-003
    const dt = now - this.lastTick;
    this.lastTick = now;
    const k = Math.pow(0.5, dt / this.cfg.half_life_ms);
    this.valence = this.cfg.baseline_valence + (this.valence - this.cfg.baseline_valence) * k;
    this.arousal = this.cfg.baseline_arousal + (this.arousal - this.cfg.baseline_arousal) * k; // @spec AFF-MOOD-006
  }

  nudge(dv: number, da: number, cause: string): void { // @spec AFF-MOOD-002
    this.tick();
    this.valence = clamp(this.valence + dv, -1, 1);
    this.arousal = clamp(this.arousal + da, 0, 1);
    this.cause = cause;
  }

  /** Apply the pending decay, then land exactly on the resting valence and arousal. */
  reset(cause: string): void { // @spec AFF-IN-007, AFF-MOOD-006
    this.tick();
    this.valence = this.cfg.baseline_valence;
    this.arousal = this.cfg.baseline_arousal;
    this.cause = cause;
  }

  /** Apply an appraisal (from the appraiser module) of a line someone said. */
  applyAppraisal(a: AppraiseOutput, cause: string): void {
    this.nudge(a.valence_delta, a.arousal_delta, cause);
  }

  state(): MoodState { // @spec AFF-MOOD-005
    return { valence: round(this.valence), arousal: round(this.arousal), mood: label(this.valence, this.arousal), cause: this.cause };
  }
}

/** Nearest canonical emotion for a point on the valence/arousal plane. */
export function label(v: number, a: number): Emotion { // @spec AFF-MOOD-004
  if (a > 0.6) return v > 0.3 ? "laugh" : v < -0.3 ? "angry" : "surprised";
  if (a > 0.3) return v > 0.2 ? "happy" : v < -0.2 ? "confused" : "think";
  return v > 0.35 ? "smug" : v < -0.3 ? "sad" : "neutral";
}

const round = (x: number) => Math.round(x * 1000) / 1000;
