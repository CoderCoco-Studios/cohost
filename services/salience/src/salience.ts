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
  private muted = false;
  /** Paused by `control pause`: keeps reading events (context is not lost) but decides and reflexes nothing. */
  private paused = false;
  private arousal = 0;
  /** What the cortex / voice are up to, as last reported on the bus. */
  private cortexState: "idle" | "thinking" | "speaking" | "muted" = "idle";
  private cortexSince = Date.now();
  private deciding = false;

  constructor(private d: SalienceDeps) {
    this.ctx = new Context(d.cfg.brain.working_memory_events);
    this.scheduler = new Scheduler(d.cfg.brain.salience, d.scorer);
    this.reflexes = new Reflexes(d.cfg.brain.salience.reflexes);
  }

  async onEvent(ev: BusEvent): Promise<void> {
    switch (ev.type) {
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        this.ctx.push(ev);
        this.scheduler.noteActivity();
        await this.reflex("chat", d.text);
        break;
      }
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        this.ctx.push(ev);
        this.scheduler.noteActivity();
        await this.reflex("speech", d.text);
        break;
      }
      case "vision.summary": {
        const d = ev.data as BusEvent<"vision.summary">["data"];
        this.ctx.push(ev);
        if (d.changed) await this.reflex("vision", d.text);
        break;
      }
      case "brain.say":
        // Whoever spoke (cortex, a reflex, the operator), the cooldown starts now.
        this.scheduler.noteSpoke();
        this.cortexState = "speaking";
        this.cortexSince = Date.now();
        break;
      case "brain.status": {
        const d = ev.data as BusEvent<"brain.status">["data"];
        this.cortexState = d.state;
        this.cortexSince = Date.now();
        break;
      }
      case "affect.state":
        this.arousal = (ev.data as BusEvent<"affect.state">["data"]).arousal;
        break;
      case "control": {
        const d = ev.data as BusEvent<"control">["data"];
        if (d.target && d.target !== "salience") break; // addressed to another service
        if (d.cmd === "pause") this.paused = true;
        if (d.cmd === "resume") this.paused = false;
        if (d.cmd === "mute") this.muted = true;
        if (d.cmd === "unmute") this.muted = false;
        if (d.cmd === "forget_context") this.ctx.clear();
        break;
      }
    }
  }

  /** Fast path. Fires immediately, bypassing the scheduler and the LLM. */
  private async reflex(sense: Sense, text: string) {
    if (this.paused || this.muted || this.reflexes.size === 0) return;
    // A reflex is still a line of speech: don't talk over the cortex, the voice, or inside the cooldown.
    // Gate before test(), which spends the rule's own cooldown on a hit.
    if (this.busy() || this.scheduler.cooling()) return;
    const trigger = this.ctx.last(); // reflex() runs synchronously after the push, so this is the triggering event
    const hit = this.reflexes.test(sense, text);
    if (!hit) return;
    this.d.log.info({ rule: hit.rule, sense }, "reflex");
    if (trigger) this.ctx.markSeenEvents([trigger]); // only the event that fired it; other unseen events still count
    await this.d.bus.publish("brain.say", { id: randomUUID(), text: hit.text, emotion: hit.emotion, gesture: hit.gesture, reason: `reflex: ${hit.rule}`, ...propagatedFlags(trigger) });
  }

  private busy(): boolean {
    const age = Date.now() - this.cortexSince;
    // Safety valves: a cortex that never reports back, or a voice sink that never says done.
    if (this.cortexState === "thinking") return age < 60_000;
    if (this.cortexState === "speaking") return age < this.d.cfg.brain.cortex.speaking_timeout_ms;
    return false;
  }

  async tick(): Promise<void> {
    if (this.paused || this.deciding) return; // an llm/http scorer can take longer than a tick
    this.deciding = true;
    let decision;
    try { decision = await this.scheduler.decide(this.ctx, this.busy(), this.muted, this.arousal); }
    finally { this.deciding = false; }
    if (!decision.speak) return;
    // Only what was scored: anything that arrived while an llm/http scorer was running stays unseen.
    this.ctx.markSeenEvents(decision.scored);
    // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
    this.cortexState = "thinking";
    this.cortexSince = Date.now();
    const f = decision.focus;
    await this.d.bus.publish("attention.focus", {
      reason: decision.reason,
      score: decision.score,
      focus:
        f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
        : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text }
        : f?.kind === "vision" ? { kind: "vision", text: f.text }
        : undefined,
      ...propagatedFlags(f),
    });
    this.d.log.debug({ reason: decision.reason, score: decision.score }, "focus");
  }
}
