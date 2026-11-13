import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { controlFor, type Heartbeat } from "@cohost/shared";
import { Context, propagatedFlags, type ContextEvent } from "@cohost/working-memory";
import { Scheduler } from "./scheduler.js";
import type { ScoreInput, ScoreOutput } from "./scoring.js";
import { Reflexes, type Sense } from "./reflex.js";

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

  constructor(private d: SalienceDeps) {
    this.ctx = Context.forBrain(d.cfg.brain);
    this.now = d.now ?? (() => performance.now());
    this.cortexSince = this.now();
    this.control = controlFor("salience", {
      pause: () => this.ctx.holdArrivals(),
      resume: () => this.ctx.releaseArrivals(), // @spec SAL-CTRL-007
      forget_context: () => this.ctx.clear(), // @spec SAL-CTRL-005
    }, { log: d.log, heartbeat: d.heartbeat });
    this.scheduler = new Scheduler(d.cfg.brain.salience, d.scorer, this.now);
    this.reflexes = new Reflexes(d.cfg.brain.salience.reflexes);
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
      case "speech.heard": { // @spec SAL-IN-002
        const d = ev.data as BusEvent<"speech.heard">["data"];
        const entry = this.ctx.push(ev);
        this.scheduler.noteActivity();
        const fired = await this.reflex("speech", d.text, entry);
        if (!fired) this.triggerOnSpeech(); // @spec SAL-TRIG-001, SAL-TRIG-003
        break;
      }
      case "vision.summary": { // @spec SAL-IN-003
        const d = ev.data as BusEvent<"vision.summary">["data"];
        const entry = this.ctx.push(ev);
        if (d.changed) await this.reflex("vision", d.text, entry); // @spec SAL-REFLEX-002
        break;
      }
      case "brain.say": // @spec SAL-BUSY-003
        // Whoever spoke (cortex, a reflex, the operator), the cooldown starts now.
        this.scheduler.noteSpoke();
        this.cortexState = "speaking";
        this.cortexSince = this.now();
        break;
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
    await this.d.bus.publish("brain.say", { id: randomUUID(), text: hit.text, emotion: hit.emotion, gesture: hit.gesture, reason: `reflex: ${hit.rule}`, ...propagatedFlags(trigger) }); // @spec SAL-INJ-004
    return true;
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
    do {
      try { await this.decideAndPublish(); }
      catch (err) { this.d.log.error({ err }, "tick failed"); }
    } while (this.rerun && !this.control.paused && !this.deciding);
  }

  private async decideAndPublish(): Promise<void> {
    if (this.control.paused || this.deciding) return; // an llm/http scorer can take longer than a tick; @spec SAL-FOCUS-002, SAL-CTRL-002
    this.deciding = true;
    this.rerun = false; // this pass sees everything that has arrived so far
    let decision;
    try { decision = await this.scheduler.decide(this.ctx, this.busy(), this.control.muted, this.arousal); }
    finally { this.deciding = false; }
    if (!decision.speak) return;
    // A mute, pause or busy cortex may have arrived while the scorer ran: the decision is void then.
    if (this.control.muted || this.control.paused || this.busy()) return; // @spec SAL-FOCUS-005
    // Only what was scored: anything that arrived while an llm/http scorer was running stays unseen.
    this.ctx.markSeenEvents(decision.scored); // @spec SAL-FOCUS-004
    // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
    const prevState = this.cortexState;
    const prevSince = this.cortexSince;
    this.cortexState = "thinking";
    const since = this.cortexSince = this.now();
    const f = decision.focus;
    try {
    await this.d.bus.publish("attention.focus", { // @spec SAL-FOCUS-003
      reason: decision.reason,
      score: decision.score,
      focus:
        f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
        : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text }
        : f?.kind === "vision" ? { kind: "vision", text: f.text }
        : undefined,
      ...(f?.kind === "speech" && f.timing?.audioEndedAt !== undefined ? { timing: { audioEndedAt: f.timing.audioEndedAt, heardAt: f.ts } } : {}), // @spec SAL-FOCUS-006
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
    this.d.log.debug({ reason: decision.reason, score: decision.score }, "focus");
  }
}
