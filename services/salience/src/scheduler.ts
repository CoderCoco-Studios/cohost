import type { Config } from "@cohost/config";
import type { Context, ContextEvent } from "@cohost/working-memory";
import type { Module } from "@cohost/modules";
import { toScoreInput, type ScoreInput, type ScoreOutput } from "./scoring.js";
import type { Reminder } from "./reminders.js";
import { createOnceCounter, viewerKey } from "@cohost/shared/untrusted";

export interface Decision {
  speak: boolean;
  reason: string;
  score: number;
  /** The event most worth replying to, if any. */
  focus?: ContextEvent;
  /** Exactly the events this decision scored; mark only these seen. */
  scored: ContextEvent[];
  /** The due timer reminder this decision speaks, when the reason is `reminder` (SAL-REM-005). */
  reminder?: Reminder;
}

/**
 * Decides *whether* to talk. The per-event scores come from the scorer
 * module (rules / llm / http); this class owns the timing around them:
 * threshold, cooldown, idle chatter. Mood nudges the threshold: excited =
 * chattier.
 */
export class Scheduler {
  private lastSpoke = -Infinity;
  private lastActivity: number;
  private scoreCache = new WeakMap<ContextEvent, number>();

  /**
   * `now` is a monotonic millisecond clock: cooldown and idle chatter are durations, so they must not move when the
   * wall clock is stepped (NTP, VM time sync). Tests inject a fake one.
   */
  constructor(
    private cfg: Config["brain"]["salience"],
    private scorer: Module<ScoreInput, ScoreOutput>,
    private now: () => number = () => performance.now(),
  ) {
    this.lastActivity = this.now();
  }

  /** A barge-in ends the cooldown so the interrupter's line is not held back (SAL-BARGE-002). */
  clearCooldown(): void { this.lastSpoke = -Infinity; }

  noteSpoke(): void {
    this.lastSpoke = this.now();
    this.lastActivity = this.lastSpoke;
  }
  /** Inside the minimum gap since the last line (anyone's, including reflexes). */
  cooling(): boolean {
    return this.now() - this.lastSpoke < this.cfg.cooldown_ms;
  }
  noteActivity(): void {
    this.lastActivity = this.now();
  }

  /** The score the scorer (or a primed score) gave an event, if it has one. */
  scoreOf(e: ContextEvent): number | undefined { return this.scoreCache.get(e); }

  /**
   * Gives an event a score already obtained for the same words, so the scorer is not asked again (SAL-PROV-007, SAL-PROV-033).
   * @spec SAL-PROV-007, SAL-PROV-033
   */
  primeScore(e: ContextEvent, score: number): void { this.scoreCache.set(e, score); }

  /**
   * `reminder` is the due timer reminder, if any. It is spoken ahead of unseen events and without calling the scorer
   * (SAL-REM-005, SAL-REM-006). `transient` is an event that is scored beside the unseen ones but is not in the window: the
   * early transcript of the early pass (SAL-PROV-006).
   */
  async decide(ctx: Context, busy: boolean, muted: boolean, arousal = 0, reminder?: Reminder, transient?: ContextEvent): Promise<Decision> {
    const now = this.now();
    if (muted) return { speak: false, reason: "muted", score: 0, scored: [] }; // @spec SAL-DECIDE-001, SAL-CTRL-004
    if (busy) return { speak: false, reason: "cortex busy", score: 0, scored: [] };
    if (this.cooling()) return { speak: false, reason: "cooldown", score: 0, scored: [] }; // @spec SAL-DECIDE-001
    if (reminder) return { speak: true, reason: "reminder", score: 1, reminder, scored: [] }; // @spec SAL-DECIDE-001, SAL-REM-005, SAL-REM-006

    const unseen: ContextEvent[] = ctx.unseen().filter((e) => e.kind !== "self"); // @spec SAL-DECIDE-007
    if (transient) unseen.push(transient); // @spec SAL-PROV-006
    if (unseen.length === 0) return { speak: false, reason: "nothing new", score: 0, scored: [] }; // @spec SAL-DECIDE-005

    // Score only events we haven't scored yet: an event stays unseen across ticks while the
    // total is below threshold, and an llm/http scorer must not be re-asked about the same input.
    const fresh = unseen.filter((e) => !this.scoreCache.has(e)); // @spec SAL-SCORE-006
    if (fresh.length > 0) {
      const { scores: fs } = await this.scorer.run(toScoreInput(fresh, arousal)); // @spec SAL-SCORE-005
      fresh.forEach((e, i) => this.scoreCache.set(e, fs[i] ?? 0));
    }
    // The walk (SAL-DECIDE-009): highest cached score first; equal scores go to the later window event. A chat
    // line counts only if its viewer and text are new to this decision (SAL-DECIDE-011, -012); speech and vision
    // always count (SAL-DECIDE-010). Only counted events add to the total or can be the focus (SAL-DECIDE-013).
    // Viewers are keyed by viewerKey (platform and user id, else platform and lowercased name), so renames do not split a viewer
    // and the same name on two platforms does not merge one. @spec SAL-DECIDE-017, SAL-DECIDE-018, SAL-DECIDE-019
    // @spec SAL-DECIDE-002, SAL-DECIDE-007, SAL-DECIDE-009, SAL-DECIDE-010, SAL-DECIDE-013, SAL-DECIDE-014, SAL-DECIDE-015, SAL-DECIDE-016
    const ranked = unseen
      .map((e, i) => ({ e, i, s: this.scoreCache.get(e) ?? 0 }))
      .sort((a, b) => b.s - a.s || b.i - a.i);
    const once = createOnceCounter();
    let score = 0; // @spec SAL-DECIDE-002
    let focus: ContextEvent | undefined;
    for (const { e, s } of ranked) {
      if (e.kind === "chat" && !once.admit(viewerKey(e), e.text)) continue; // @spec SAL-DECIDE-011, SAL-DECIDE-012
      score += s;
      if (!focus && s > 0) focus = e; // @spec SAL-DECIDE-014 (a zero-score event is never the focus)
    }

    const threshold = Math.max(0.1, this.cfg.speak_threshold - this.cfg.arousal_bias * arousal); // @spec SAL-DECIDE-003
    if (score >= threshold) {
      const mentioned = focus?.kind === "chat" && focus.mention && this.cfg.reply_on_mention; // @spec SAL-DECIDE-008
      return { speak: true, reason: mentioned ? "mentioned" : "engaged", score, focus, scored: unseen };
    }

    const idle = now - this.lastActivity;
    if (this.cfg.idle_chatter_ms > 0 && idle > this.cfg.idle_chatter_ms) { // @spec SAL-DECIDE-004
      return { speak: true, reason: "idle chatter", score, focus, scored: unseen };
    }
    return { speak: false, reason: `score ${score.toFixed(2)} < ${threshold.toFixed(2)}`, score, focus, scored: unseen }; // @spec SAL-DECIDE-006
  }
}
