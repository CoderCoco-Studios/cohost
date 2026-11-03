import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { Context, propagatedFlags } from "@cohost/working-memory";
import { Scheduler } from "./scheduler.js";
import type { ScoreInput, ScoreOutput } from "./scoring.js";
import { Reflexes, type Sense } from "./reflex.js";

export interface SalienceDeps {
  cfg: Config;
  bus: Publisher;
  scorer: Module<ScoreInput, ScoreOutput>;
  log: Logger;
}

/** The salience region's state and event handling; index.ts wires it to the bus and the tick timer. */
export class Salience {
  readonly ctx: Context;
  readonly scheduler: Scheduler;
  readonly reflexes: Reflexes;
  private muted = false; // @spec SAL-CTRL-006
  /** Paused by `control pause`: keeps reading events (context is not lost) but decides and reflexes nothing. */
  private paused = false; // @spec SAL-CTRL-006
  private arousal = 0; // @spec SAL-IN-006
  /** What the cortex / voice are up to, as last reported on the bus. */
  private cortexState: "idle" | "thinking" | "speaking" | "muted" = "idle"; // @spec SAL-IN-006
  private cortexSince = Date.now();
  private deciding = false;

  constructor(private d: SalienceDeps) {
    this.ctx = new Context(d.cfg.brain.working_memory_events);
    this.scheduler = new Scheduler(d.cfg.brain.salience, d.scorer);
    this.reflexes = new Reflexes(d.cfg.brain.salience.reflexes);
  }

  async onEvent(ev: BusEvent): Promise<void> {
    switch (ev.type) {
      case "chat.message": { // @spec SAL-IN-002
        const d = ev.data as BusEvent<"chat.message">["data"];
        this.ctx.push(ev);
        this.scheduler.noteActivity();
        await this.reflex("chat", d.text);
        break;
      }
      case "speech.heard": { // @spec SAL-IN-002
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.ctx.push(ev);
        this.scheduler.noteActivity();
        await this.reflex("speech", d.text);
        break;
      }
      case "vision.summary": { // @spec SAL-IN-003
        const d = ev.data as BusEvent<"vision.summary">["data"];
        this.ctx.push(ev);
        if (d.changed) await this.reflex("vision", d.text); // @spec SAL-REFLEX-002
        break;
      }
      case "brain.say": // @spec SAL-BUSY-003
        // Whoever spoke (cortex, a reflex, the operator), the cooldown starts now.
        this.scheduler.noteSpoke();
        this.cortexState = "speaking";
        this.cortexSince = Date.now();
        break;
      case "brain.status": { // @spec SAL-IN-005
        const d = ev.data as BusEvent<"brain.status">["data"];
        this.cortexState = d.state;
        this.cortexSince = Date.now();
        break;
      }
      case "affect.state": // @spec SAL-IN-004
        this.arousal = (ev.data as BusEvent<"affect.state">["data"]).arousal;
        break;
      case "control": {
        const d = ev.data as BusEvent<"control">["data"];
        if (d.target && d.target !== "salience") break; // addressed to another service; @spec SAL-CTRL-001
        if (d.cmd === "pause") this.paused = true; // @spec SAL-CTRL-002
        if (d.cmd === "resume") this.paused = false; // @spec SAL-CTRL-003
        if (d.cmd === "mute") this.muted = true; // @spec SAL-CTRL-004
        if (d.cmd === "unmute") this.muted = false;
        if (d.cmd === "forget_context") this.ctx.clear(); // @spec SAL-CTRL-005
        break;
      }
    }
  }

  /** Fast path. Fires immediately, bypassing the scheduler and the LLM. */
  private async reflex(sense: Sense, text: string) { // @spec SAL-REFLEX-001
    if (this.paused || this.muted || this.reflexes.size === 0) return; // @spec SAL-REFLEX-006
    // A reflex is still a line of speech: don't talk over the cortex, the voice, or inside the cooldown.
    // Gate before test(), which spends the rule's own cooldown on a hit.
    if (this.busy() || this.scheduler.cooling()) return; // @spec SAL-REFLEX-005
    const trigger = this.ctx.last(); // reflex() runs synchronously after the push, so this is the triggering event
    const hit = this.reflexes.test(sense, text);
    if (!hit) return;
    this.d.log.info({ rule: hit.rule, sense }, "reflex");
    if (trigger) this.ctx.markSeenEvents([trigger]); // only the event that fired it; other unseen events still count; @spec SAL-REFLEX-004
    // Own the cooldown and the voice state now; the brain.say echo would only arrive later.
    this.scheduler.noteSpoke(); // @spec SAL-REFLEX-007
    this.cortexState = "speaking";
    this.cortexSince = Date.now();
    await this.d.bus.publish("brain.say", { id: randomUUID(), text: hit.text, emotion: hit.emotion, gesture: hit.gesture, reason: `reflex: ${hit.rule}`, ...propagatedFlags(trigger) }); // @spec SAL-INJ-004
  }

  private busy(): boolean {
    const age = Date.now() - this.cortexSince;
    // Safety valves: a cortex that never reports back, or a voice sink that never says done.
    if (this.cortexState === "thinking") return age < this.d.cfg.brain.salience.thinking_timeout_ms; // @spec SAL-BUSY-001
    if (this.cortexState === "speaking") return age < this.d.cfg.brain.cortex.speaking_timeout_ms; // @spec SAL-BUSY-002
    return false; // @spec SAL-BUSY-004
  }

  /** One scheduling pass. Never rejects: a failed decision or publish is logged and the next tick runs (SAL-HEALTH-002). */
  async tick(): Promise<void> { // @spec SAL-HEALTH-002
    try { await this.decideAndPublish(); }
    catch (err) { this.d.log.error({ err }, "tick failed"); }
  }

  private async decideAndPublish(): Promise<void> {
    if (this.paused || this.deciding) return; // an llm/http scorer can take longer than a tick; @spec SAL-FOCUS-002, SAL-CTRL-002
    this.deciding = true;
    let decision;
    try { decision = await this.scheduler.decide(this.ctx, this.busy(), this.muted, this.arousal); }
    finally { this.deciding = false; }
    if (!decision.speak) return;
    // A mute, pause or busy cortex may have arrived while the scorer ran: the decision is void then.
    if (this.muted || this.paused || this.busy()) return; // @spec SAL-FOCUS-005
    // Only what was scored: anything that arrived while an llm/http scorer was running stays unseen.
    this.ctx.markSeenEvents(decision.scored); // @spec SAL-FOCUS-004
    // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
    this.cortexState = "thinking";
    this.cortexSince = Date.now();
    const f = decision.focus;
    await this.d.bus.publish("attention.focus", { // @spec SAL-FOCUS-003
      reason: decision.reason,
      score: decision.score,
      focus:
        f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
        : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text }
        : f?.kind === "vision" ? { kind: "vision", text: f.text }
        : undefined,
      ...propagatedFlags(f), // @spec SAL-INJ-001, SAL-INJ-002, SAL-INJ-003
    });
    this.d.log.debug({ reason: decision.reason, score: decision.score }, "focus");
  }
}
