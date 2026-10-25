import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Emotion, Logger } from "@cohost/config";
import type { ChatProvider } from "@cohost/llm";
import type { Module } from "@cohost/modules";
import { Context } from "@cohost/working-memory";
import { buildMessages, parseReply, type Focus, type Mood, type Recalled } from "./prompt.js";
import type { CriticInput, CriticOutput } from "./critic.js";

export interface CortexDeps {
  cfg: Config;
  bus: Publisher;
  llm: ChatProvider;
  critic: Module<CriticInput, CriticOutput>;
  log: Logger;
  loadPersonality: () => string;
}

/** The cortex's state and event handling; index.ts wires it to the bus. */
export class Cortex {
  readonly ctx: Context;
  private personality: string;
  private muted = false;
  /** Paused by `control pause`: keeps reading events but starts no LLM call. Reported as "muted" so salience stops waiting. */
  private paused = false;
  private thinking = false;
  private speakingId: string | undefined;
  private speakingSince = 0;
  private mood: Mood | undefined;
  /** Who-is-this notes from the memory region, keyed by lowercase user so one viewer's framing never lands on another's reply. */
  private viewerNotes = new Map<string, string>();
  private pendingRecall = new Map<string, (m: Recalled) => void>();

  constructor(private d: CortexDeps) {
    this.ctx = new Context(d.cfg.brain.working_memory_events);
    this.personality = d.loadPersonality();
  }

  async onEvent(ev: BusEvent): Promise<void> {
    switch (ev.type) {
      case "chat.message":
      case "speech.heard":
      case "vision.summary":
        this.ctx.push(ev);
        break;
      case "brain.say": {
        // Our own lines and anyone else's (reflexes, operator) all land in the transcript.
        const d = ev.data as BusEvent<"brain.say">["data"];
        this.ctx.pushSelf(d.text, d.emotion);
        if (ev.source !== "cortex") { this.speakingId = d.id; this.speakingSince = Date.now(); }
        break;
      }
      case "voice.done": {
        const d = ev.data as BusEvent<"voice.done">["data"];
        if (d.id === this.speakingId) { this.speakingId = undefined; await this.status(this.muted || this.paused ? "muted" : "idle"); }
        break;
      }
      case "attention.focus":
        // Don't await: the LLM call must not block the subscription loop, or the
        // memory reply we're waiting on could never be delivered.
        void this.think(ev.data as Focus);
        break;
      case "memory.recall.reply": {
        const d = ev.data as BusEvent<"memory.recall.reply">["data"];
        this.pendingRecall.get(d.id)?.(d.memories);
        break;
      }
      case "memory.viewer": {
        const d = ev.data as BusEvent<"memory.viewer">["data"];
        const note = d.isNew
          ? `${d.user} is new here (first message).`
          : d.msgCount > 25
            ? `${d.user} is a regular (${d.msgCount} messages).${d.notes ? " Notes: " + d.notes : ""}`
            : undefined;
        const key = d.user.toLowerCase();
        this.viewerNotes.delete(key);
        if (note) this.viewerNotes.set(key, note);
        if (this.viewerNotes.size > 50) this.viewerNotes.delete(this.viewerNotes.keys().next().value!);
        break;
      }
      case "affect.state":
        this.mood = ev.data as Mood;
        break;
      case "control": {
        const d = ev.data as BusEvent<"control">["data"];
        if (d.target && d.target !== "cortex") break; // addressed to another service
        if (d.cmd === "pause") { this.paused = true; await this.status("muted", "paused"); }
        if (d.cmd === "resume") { this.paused = false; await this.status(this.muted ? "muted" : "idle"); }
        if (d.cmd === "mute") { this.muted = true; await this.status("muted"); }
        if (d.cmd === "unmute") { this.muted = false; await this.status(this.paused ? "muted" : "idle"); }
        if (d.cmd === "forget_context") { this.ctx.clear(); this.viewerNotes.clear(); }
        if (d.cmd === "reload_personality") { this.personality = this.d.loadPersonality(); this.d.log.info("personality reloaded"); }
        if (d.cmd === "say" && d.text) await this.say(d.text, "neutral", undefined, "operator");
        break;
      }
    }
  }

  async think(focus: Focus): Promise<void> {
    const { cfg, llm, critic, log } = this.d;
    // Salience assumes we're busy once it fires, so every path out of here reports a status.
    if (this.thinking) { await this.status("thinking", focus.reason).catch(() => {}); return; }
    if (this.muted || this.paused) { await this.status("muted"); return; }
    if (this.voiceBusy()) { await this.status("speaking"); return; }

    this.thinking = true; // the try/finally below always clears it, even if a status publish fails
    try {
      await this.status("thinking", focus.reason);
      const query = focus.focus?.text ?? this.ctx.lastVision;
      const memories = query ? await this.recall(query) : [];
      const who = focus.focus?.who?.toLowerCase();
      const viewerNote = who ? this.viewerNotes.get(who) : undefined;
      if (who) this.viewerNotes.delete(who);
      const messages = buildMessages({ cfg, personality: this.personality, ctx: this.ctx, memories, focus, mood: this.mood, viewerNote });
      const t0 = Date.now();
      const raw = await llm.chat(messages);
      let { text, emotion, gesture } = parseReply(raw);
      log.info({ ms: Date.now() - t0, reason: focus.reason, memories: memories.length, raw }, "llm reply");
      if (!text || text.length < 2) { await this.status("idle"); return; }
      // Inhibition: let the critic veto or touch up the line before it's spoken.
      const verdict = await critic.run({ text, emotion: emotion as Emotion, reason: focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
      if (!verdict.ok) { log.info({ note: verdict.note, text }, "critic vetoed"); await this.status("idle"); return; }
      if (verdict.text) { log.info({ from: text, to: verdict.text }, "critic rewrote"); text = verdict.text; }
      if (verdict.emotion) emotion = verdict.emotion;
      // A reflex or operator line may have started while we were thinking; don't talk over it.
      if (this.muted || this.paused) { await this.status("muted"); return; }
      if (this.voiceBusy()) { log.info({ text }, "dropped: something else spoke while thinking"); await this.status("speaking"); return; }
      await this.say(text, emotion as Emotion, gesture, focus.reason);
    } catch (err) {
      log.error({ err }, "think failed");
      await this.status("idle").catch(() => {});
    } finally {
      this.thinking = false;
    }
  }

  async status(state: "idle" | "thinking" | "speaking" | "muted", detail?: string): Promise<void> {
    await this.d.bus.publish("brain.status", { state, detail });
  }

  /** Someone's line is still playing (with the stuck-sink safety valve). */
  private voiceBusy(): boolean {
    if (this.speakingId && Date.now() - this.speakingSince > this.d.cfg.brain.cortex.speaking_timeout_ms) this.speakingId = undefined;
    return !!this.speakingId;
  }

  /** Ask the memory region over the bus; give up gracefully if it doesn't answer. */
  private recall(query: string): Promise<Recalled> {
    const { cfg, bus, log } = this.d;
    if (cfg.brain.memory.recall_k <= 0) return Promise.resolve([]);
    const id = randomUUID();
    return new Promise<Recalled>((resolve) => {
      const timer = setTimeout(() => { this.pendingRecall.delete(id); log.warn("memory region did not answer in time"); resolve([]); }, cfg.brain.cortex.recall_timeout_ms);
      this.pendingRecall.set(id, (m) => { clearTimeout(timer); this.pendingRecall.delete(id); resolve(m); });
      void bus.publish("memory.recall.request", { id, query, k: cfg.brain.memory.recall_k }).catch(() => {
        clearTimeout(timer); this.pendingRecall.delete(id); resolve([]);
      });
    });
  }

  private async say(text: string, emotion: Emotion, gesture: string | undefined, reason: string) {
    const id = randomUUID();
    this.speakingId = id;
    this.speakingSince = Date.now();
    await this.d.bus.publish("brain.say", { id, text, emotion, gesture, reason });
    await this.status("speaking", text);
  }
}
