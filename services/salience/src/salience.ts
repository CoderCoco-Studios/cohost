import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { controlFor, type Heartbeat } from "@cohost/shared";
import { Context, propagatedFlags, type ContextEvent } from "@cohost/working-memory";
import { Scheduler } from "./scheduler.js";
import type { ScoreInput, ScoreOutput } from "./scoring.js";
import { Reflexes, type Sense } from "./reflex.js";
import { Reminders, type TimerEvent } from "./reminders.js";

export interface SalienceDeps {
  cfg: Config;
  bus: Publisher;
  scorer: Module<ScoreInput, ScoreOutput>;
  log: Logger;
  /**
   * Monotonic millisecond clock for the busy valves and the cooldown (default `performance.now`): they are durations,
   * so a stepped wall clock must not stretch or cut them. Tests inject a fake one.
   */
  now?: () => number;
  /** The service's heartbeat: a pause shows as its standing detail `paused` (SAL-HEALTH-004). */
  heartbeat?: Pick<Heartbeat, "setDetail">;
}

/** The salience region's state and event handling; index.ts wires it to the bus and the tick timer. */
export class Salience {
  readonly ctx: Context;
  readonly scheduler: Scheduler;
  readonly reflexes: Reflexes;
  /** `control` state (shared reader). Paused: keeps reading events (context is not lost) but decides and reflexes nothing. @spec SAL-CTRL-006 */
  private readonly control: ReturnType<typeof controlFor>;
  private arousal = 0; // @spec SAL-IN-006
  /** What the cortex / voice are up to, as last reported on the bus. */
  private cortexState: "idle" | "thinking" | "speaking" | "muted" = "idle"; // @spec SAL-IN-006
  private readonly now: () => number;
  private cortexSince: number;
  private deciding = false;
  /** A speech trigger landed while a decision was in flight: run one more pass when it ends (SAL-TRIG-005). */
  private rerun = false;
  /** The line that last set the cortex state to `speaking` is a reflex line, which is never interrupted (SAL-BARGE-006). */
  private reflexLine = false;
  /** A barge-in has stopped the voice and no `brain.say` has arrived since (SAL-BARGE-010). */
  private barged = false;
  /** The cortex's latest line (a `brain.say` that is neither reflex nor operator), whose playback renews `speaking` (SAL-BUSY-005). */
  private cortexLine: { id: string; more: boolean } | undefined;
  /** Entries a `chat.removed` took out of the window. A decision whose focus is one of them publishes nothing (SAL-FOCUS-007). */
  private readonly removed = new WeakSet<ContextEvent>();
  /** The bus `source` of each speech entry, kept for the speech focus (SAL-FOCUS-003). */
  private readonly speechSource = new WeakMap<ContextEvent, string>();
  /** Due timer reminders, held apart from working memory: a reminder never enters a transcript (SAL-REM-001). */
  private readonly reminders: Reminders;

  constructor(private d: SalienceDeps) {
    this.ctx = Context.forBrain(d.cfg.brain, d.cfg.viewer_text);
    this.now = d.now ?? (() => performance.now());
    this.cortexSince = this.now();
    this.control = controlFor("salience", {
      pause: () => this.ctx.holdArrivals(),
      resume: () => this.ctx.releaseArrivals(), // @spec SAL-CTRL-007
      forget_context: () => this.ctx.clear(), // @spec SAL-CTRL-005
    }, { log: d.log, heartbeat: d.heartbeat });
    this.scheduler = new Scheduler(d.cfg.brain.salience, d.scorer, this.now);
    this.reflexes = new Reflexes(d.cfg.brain.salience.reflexes);
    this.reminders = new Reminders(d.cfg.tools.timer.max_active, d.cfg.brain.salience.reminder_expiry_ms);
  }

  async onEvent(ev: BusEvent): Promise<void> {
    switch (ev.type) {
      case "chat.message": { // @spec SAL-IN-002
        const d = ev.data as BusEvent<"chat.message">["data"];
        const entry = this.ctx.push(ev);
        this.scheduler.noteActivity();
        await this.reflex("chat", d.text, entry);
        break;
      }
      // A removal leaves the window whether or not salience is paused, so a paused line is not scored after resume.
      case "chat.removed": { // @spec SAL-IN-008, SAL-IN-009
        const before = this.ctx.all();
        this.ctx.forget(ev.data as BusEvent<"chat.removed">["data"]);
        const kept = new Set(this.ctx.all());
        for (const e of before) if (!kept.has(e)) this.removed.add(e); // @spec SAL-FOCUS-007
        break;
      }
      case "speech.heard": { // @spec SAL-IN-002
        const d = ev.data as BusEvent<"speech.heard">["data"];
        const entry = this.ctx.push(ev);
        if (entry && d.source !== undefined) this.speechSource.set(entry, d.source); // @spec SAL-FOCUS-003
        this.scheduler.noteActivity();
        await this.bargeIn(d); // @spec SAL-BARGE-001, SAL-BARGE-003
        const fired = await this.reflex("speech", d.text, entry);
        if (!fired) this.triggerOnSpeech(); // @spec SAL-TRIG-001, SAL-TRIG-003
        break;
      }
      // A timer is never chat, speech or vision: it is held as a reminder, and it starts no decision pass (SAL-REM-007).
      case "tool.timer": { // @spec SAL-REM-001, SAL-REM-002, SAL-REM-003, SAL-REM-007
        this.reminders.arrive(ev.data as TimerEvent);
        await this.expireReminders(); // a reminder that arrives already past the expiry is republished as missed now
        break;
      }
      case "vision.summary": { // @spec SAL-IN-003
        const d = ev.data as BusEvent<"vision.summary">["data"];
        const entry = this.ctx.push(ev);
        if (d.changed) await this.reflex("vision", d.text, entry); // @spec SAL-REFLEX-002
        break;
      }
      case "brain.say": { // @spec SAL-BUSY-003, SAL-BUSY-005, SAL-BUSY-008
        // Whoever spoke (cortex, a reflex, the operator), the cooldown starts now.
        const d = ev.data as BusEvent<"brain.say">["data"];
        const reason = d.reason ?? "";
        this.scheduler.noteSpoke();
        this.cortexState = "speaking";
        this.cortexSince = this.now();
        this.reflexLine = reason.startsWith("reflex:"); // @spec SAL-BARGE-006
        // The cortex's own line is the one neither reflex-prefixed nor `operator`; only it replaces the remembered line (SAL-BUSY-005).
        if (!this.reflexLine && reason !== "operator") this.cortexLine = { id: d.id, more: d.more === true };
        this.barged = false; // @spec SAL-BARGE-010
        break;
      }
      // @spec SAL-BUSY-006, SAL-BUSY-007
      // Playback of the remembered cortex line renews `speaking` from any sink while it carries `more`; anything else is ignored.
      case "voice.playing":
      case "voice.done": {
        const d = ev.data as BusEvent<"voice.playing" | "voice.done">["data"];
        if (this.cortexState === "speaking" && this.cortexLine?.more && d.id === this.cortexLine.id) this.cortexSince = this.now();
        break;
      }
      case "brain.status": { // @spec SAL-IN-005
        const d = ev.data as BusEvent<"brain.status">["data"];
        this.cortexState = d.state;
        this.cortexSince = this.now();
        break;
      }
      case "affect.state": // @spec SAL-IN-004
        this.arousal = (ev.data as BusEvent<"affect.state">["data"]).arousal;
        break;
      // @spec SAL-CTRL-001, SAL-CTRL-002, SAL-CTRL-003, SAL-CTRL-004
      case "control":
        this.control.handle(ev); // a command addressed to another service changes nothing
        break;
    }
  }

  /** Fast path. Fires immediately, bypassing the scheduler and the LLM. `trigger` is the entry the event just became. */
  private async reflex(sense: Sense, text: string, trigger: ContextEvent | undefined): Promise<boolean> { // @spec SAL-REFLEX-001, SAL-REFLEX-008
    if (this.control.paused || this.control.muted || this.reflexes.size === 0) return false; // @spec SAL-REFLEX-006
    // A reflex is still a line of speech: don't talk over the cortex, the voice, or inside the cooldown.
    // Gate before test(), which spends the rule's own cooldown on a hit.
    if (this.busy() || this.scheduler.cooling()) return false; // @spec SAL-REFLEX-005
    const hit = this.reflexes.test(sense, text, this.now());
    if (!hit) return false;
    this.d.log.info({ rule: hit.rule, sense }, "reflex");
    if (trigger) this.ctx.markSeenEvents([trigger]); // only the event that fired it; other unseen events still count; @spec SAL-REFLEX-004
    // Own the cooldown and the voice state now; the brain.say echo would only arrive later.
    this.scheduler.noteSpoke(); // @spec SAL-REFLEX-007
    this.cortexState = "speaking";
    this.cortexSince = this.now();
    this.reflexLine = true; // from now, before the echo arrives; @spec SAL-BARGE-006
    await this.d.bus.publish("brain.say", { id: randomUUID(), text: hit.text, emotion: hit.emotion, gesture: hit.gesture, reason: `reflex: ${hit.rule}`, ...propagatedFlags(trigger) }); // @spec SAL-INJ-004
    return true;
  }

  /**
   * Someone spoke over the co-host: publish `voice.stop`, then free the cortex state and the cooldown so the interrupter's line
   * is handled like any other. The barge-in itself publishes no focus and no say (SAL-BARGE-003).
   * @spec SAL-BARGE-001, SAL-BARGE-002, SAL-BARGE-004, SAL-BARGE-005, SAL-BARGE-007, SAL-BARGE-008, SAL-BARGE-009, SAL-BARGE-010, SAL-BARGE-011
   */
  private async bargeIn(d: BusEvent<"speech.heard">["data"]): Promise<void> {
    const cfg = this.d.cfg.brain.salience;
    if (!cfg.barge_in || this.control.paused || this.control.muted) return;
    if (this.cortexState !== "speaking" || !this.busy() || this.reflexLine || this.barged) return;
    if (!d.source || !cfg.barge_in_sources.includes(d.source)) return;
    const words = d.text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
    if (words < cfg.barge_in_min_words) return;
    try {
      await this.d.bus.publish("voice.stop", { reason: "barge-in" });
    } catch (err) {
      this.d.log.error({ err }, "voice.stop publish failed");
      return;
    }
    this.barged = true;
    this.cortexState = "idle";
    this.cortexSince = this.now();
    this.scheduler.clearCooldown();
  }

  private busy(): boolean {
    const age = this.now() - this.cortexSince;
    // Safety valves: a cortex that never reports back, or a voice sink that never says done.
    if (this.cortexState === "thinking") return age < this.d.cfg.brain.salience.thinking_timeout_ms; // @spec SAL-BUSY-001
    if (this.cortexState === "speaking") return age < this.d.cfg.brain.cortex.speaking_timeout_ms; // @spec SAL-BUSY-002
    return false; // @spec SAL-BUSY-004
  }

  /**
   * A final `speech.heard` that no reflex answered starts a decision pass now rather than at the next poll. Not awaited: the
   * handler must not wait on a slow llm/http scorer (SAL-TRIG-004). While a decision is in flight the trigger only records one
   * pending rerun (SAL-TRIG-005); while paused it does nothing (SAL-TRIG-006).
   * @spec SAL-TRIG-001, SAL-TRIG-004, SAL-TRIG-005, SAL-TRIG-006, SAL-TRIG-007
   */
  private triggerOnSpeech(): void {
    if (!this.d.cfg.brain.salience.trigger_on_speech || this.control.paused) return; // @spec SAL-TRIG-007
    if (this.deciding) { this.rerun = true; return; }
    void this.tick();
  }

  /**
   * One scheduling pass, then one more if a trigger landed during it. Never rejects: a failed decision or publish is logged and
   * the pending rerun still runs (SAL-HEALTH-002, SAL-TRIG-009). A rerun left over from before a pause waits for the next pass.
   * @spec SAL-HEALTH-002, SAL-TRIG-008, SAL-TRIG-009
   */
  async tick(): Promise<void> {
    // Expiry is evaluated whatever the gates (SAL-REM-003). It is started without awaiting so the decision below begins in
    // this same turn, as a pass always has: a removal arriving while the scorer runs is then seen as one.
    const expiring = this.expireReminders();
    do {
      try { await this.decideAndPublish(); }
      catch (err) { this.d.log.error({ err }, "tick failed"); }
    } while (this.rerun && !this.control.paused && !this.deciding);
    await expiring;
  }

  /**
   * Republishes every held reminder past its expiry as `tool.timer` with `missed`, and drops it: it is never spoken. A failed
   * republish is logged and the reminder is still dropped (no retry). Never rejects.
   * @spec SAL-REM-003
   */
  private async expireReminders(): Promise<void> {
    for (const r of this.reminders.takeExpired(Date.now())) {
      try {
        await this.d.bus.publish("tool.timer", { id: r.id, note: r.note, setAt: r.setAt, dueAt: r.dueAt, missed: true });
      } catch (err) {
        this.d.log.error({ err, id: r.id }, "missed timer republish failed");
      }
    }
  }

  private async decideAndPublish(): Promise<void> {
    if (this.control.paused || this.deciding) return; // an llm/http scorer can take longer than a tick; @spec SAL-FOCUS-002, SAL-CTRL-002
    this.deciding = true;
    this.rerun = false; // this pass sees everything that has arrived so far
    let decision;
    try { decision = await this.scheduler.decide(this.ctx, this.busy(), this.control.muted, this.arousal, this.reminders.due(Date.now())); } // @spec SAL-REM-006
    finally { this.deciding = false; }
    if (!decision.speak) return;
    // A mute, pause or busy cortex may have arrived while the scorer ran: the decision is void then.
    if (this.control.muted || this.control.paused || this.busy()) return; // @spec SAL-FOCUS-005
    // A chat.removed may have taken the focused line out of the window while the scorer ran: no focus, no seen marks, no thinking.
    // Window eviction and forget_context do not void a decision, only a removal does (SAL-FOCUS-007).
    if (decision.focus && this.removed.has(decision.focus)) return; // @spec SAL-FOCUS-007
    // Only what was scored: anything that arrived while an llm/http scorer was running stays unseen.
    this.ctx.markSeenEvents(decision.scored); // @spec SAL-FOCUS-004
    // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
    const prevState = this.cortexState;
    const prevSince = this.cortexSince;
    this.cortexState = "thinking";
    const since = this.cortexSince = this.now();
    const f = decision.focus;
    const r = decision.reminder;
    const src = f?.kind === "speech" ? this.speechSource.get(f) : undefined;
    try {
    await this.d.bus.publish("attention.focus", { // @spec SAL-FOCUS-003
      reason: decision.reason,
      score: decision.score,
      focus:
        r ? { kind: "reminder", text: r.note } // @spec SAL-REM-005
        : f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
        : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text, ...(src !== undefined ? { source: src } : {}) }
        : f?.kind === "vision" ? { kind: "vision", text: f.text }
        : undefined,
      ...(f?.kind === "speech" && f.timing?.audioEndedAt !== undefined ? { timing: { audioEndedAt: f.timing.audioEndedAt, heardAt: f.ts } } : {}), // @spec SAL-FOCUS-006
      ...(f?.kind === "vision" && f.timing?.capturedAt !== undefined && f.timing.describedAt !== undefined ? { timing: { capturedAt: f.timing.capturedAt, describedAt: f.timing.describedAt } } : {}), // @spec SAL-FOCUS-006
      ...propagatedFlags(f), // @spec SAL-INJ-001, SAL-INJ-002, SAL-INJ-003
    });
    } catch (err) {
      // Nothing reached the cortex: roll back so the next tick can retry these events (SAL-HEALTH-002).
      // Skip the state rollback if a brain.status/say arrived meanwhile (cortexSince moved on).
      if (this.cortexState === "thinking" && this.cortexSince === since) {
        this.cortexState = prevState;
        this.cortexSince = prevSince;
      }
      for (const e of decision.scored) e.seen = false;
      throw err;
    }
    if (r) this.reminders.settle(r.id); // removed only once published (SAL-REM-005)
    this.d.log.debug({ reason: decision.reason, score: decision.score }, "focus");
  }
}
