import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Emotion, Logger } from "@cohost/config";
import type { ChatProvider } from "@cohost/llm";
import type { Module } from "@cohost/modules";
import { controlFor } from "@cohost/shared";
import { Context, propagatedFlags, type InjectionFlags } from "@cohost/working-memory";
import { buildMessages, parseReply, type Focus, type Glitch, type Mood, type People, type Recalled } from "./prompt.js";
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
  /** `control` state and dispatch (shared reader). Paused: keeps reading events but starts no LLM call, reported as "muted" so salience stops waiting. */
  private readonly control: ReturnType<typeof controlFor>;
  private thinking = false;
  private speakingId: string | undefined;
  private speakingSince = 0;
  /** Fires `speaking_timeout_ms` after a line starts, to release a stuck voice sink (CTX-GATE-009). */
  private speakingTimer: ReturnType<typeof setTimeout> | undefined;
  private mood: Mood | undefined;
  /** Who-is-this notes from the memory region, keyed by lowercase user so one viewer's framing never lands on another's reply. */
  private viewerNotes = new Map<string, string>();
  /** A fallback line played in place of this one: kept until a reply that carried its hint is published (CTX-FALL-003, CTX-FALL-005). */
  private glitch: { id: string; intended: string; fallback: string } | undefined;
  private pendingRecall = new Map<string, (m: Recalled) => void>();
  private pendingNotes = new Map<string, (p: People) => void>();

  constructor(private d: CortexDeps) {
    this.ctx = new Context(d.cfg.brain.working_memory_events);
    this.personality = d.loadPersonality();
    this.control = controlFor("cortex", {
      // @spec CTX-CTRL-002
      pause: () => this.status("muted", "paused"),
      resume: () => this.status(this.control.muted ? "muted" : "idle"),
      // @spec CTX-CTRL-003
      mute: () => this.status("muted"),
      unmute: () => this.status(this.control.paused ? "muted" : "idle"),
      // @spec CTX-CTRL-004
      forget_context: () => { this.ctx.clear(); this.ctx.lastVision = ""; this.viewerNotes.clear(); this.glitch = undefined; /* @spec CTX-FALL-005 */ },
      // @spec CTX-CTRL-005
      reload_personality: () => { this.personality = d.loadPersonality(); d.log.info("personality reloaded"); },
      // @spec CTX-CTRL-006, CTX-INJ-002
      say: async (c) => { if (c.text) await this.say(c.text, "neutral", undefined, "operator"); },
    }, { log: d.log });
  }

  async onEvent(ev: BusEvent): Promise<void> {
    switch (ev.type) {
      // @spec CTX-EVT-002
      case "chat.message":
      case "speech.heard":
      case "vision.summary":
        this.ctx.push(ev);
        break;
      // @spec CTX-EVT-003, CTX-EVT-004
      case "brain.say": {
        // Our own lines and anyone else's (reflexes, operator) all land in the transcript.
        const d = ev.data as BusEvent<"brain.say">["data"];
        this.ctx.pushSelf(d.text, d.emotion, ev.ts, d.id); // @spec CTX-FALL-001
        if (ev.source !== "cortex") this.startSpeaking(d.id);
        break;
      }
      // @spec CTX-EVT-005
      case "voice.done": {
        const d = ev.data as BusEvent<"voice.done">["data"];
        if (d.id === this.speakingId) { this.stopSpeaking(); await this.status(this.control.muted || this.control.paused ? "muted" : "idle"); }
        break;
      }
      // @spec CTX-EVT-008, CTX-FALL-002, CTX-FALL-003, CTX-FALL-007
      case "voice.failed": {
        const d = ev.data as BusEvent<"voice.failed">["data"];
        if (!d.fallback) break; // nothing was heard in its place: change nothing
        const line = this.ctx.all().find((e) => e.kind === "self" && e.id === d.id);
        if (line?.kind === "self" && this.ctx.markFallback(d.id, d.fallback.text)) {
          this.glitch = { id: d.id, intended: line.text, fallback: d.fallback.text };
        }
        break;
      }
      // @spec CTX-EVT-006
      case "attention.focus":
        // Don't await: the LLM call must not block the subscription loop, or the
        // memory reply we're waiting on could never be delivered.
        this.think(ev.data as Focus).catch((err) => this.d.log.error({ err }, "think rejected")); // @spec CTX-GATE-008
        break;
      // @spec CTX-RECALL-005
      case "memory.recall.reply": {
        const d = ev.data as BusEvent<"memory.recall.reply">["data"];
        this.pendingRecall.get(d.id)?.(d.memories);
        break;
      }
      // @spec CTX-NOTES-003
      case "memory.notes.reply": {
        const d = ev.data as BusEvent<"memory.notes.reply">["data"];
        this.pendingNotes.get(d.id)?.(d.viewers);
        break;
      }
      // @spec CTX-VIEWER-001, CTX-VIEWER-002
      case "memory.viewer": {
        const d = ev.data as BusEvent<"memory.viewer">["data"];
        // Memory decides who is a regular (the owner's flag or its message threshold); no notes text rides here.
        const note = d.isNew
          ? `${d.user} is new here (first message).`
          : d.regular
            ? `${d.user} is a regular (${d.msgCount} messages).`
            : undefined;
        const key = d.user.toLowerCase();
        this.viewerNotes.delete(key);
        if (note) this.viewerNotes.set(key, note);
        if (this.viewerNotes.size > 50) this.viewerNotes.delete(this.viewerNotes.keys().next().value!);
        break;
      }
      // @spec CTX-EVT-007
      case "affect.state":
        this.mood = ev.data as Mood;
        break;
      // @spec CTX-CTRL-001
      case "control":
        await this.control.handleAsync(ev); // a command addressed to another service changes nothing
        break;
    }
  }

  // @spec CTX-GATE-007, CTX-SAY-002, CTX-SAY-003
  async think(focus: Focus): Promise<void> {
    const { cfg, llm, critic, log } = this.d;
    // Salience assumes we're busy once it fires, so every path out of here reports a status.
    // @spec CTX-GATE-001
    if (this.thinking) { await this.statusLogged("thinking", focus.reason); return; }
    // @spec CTX-GATE-002
    if (this.control.muted || this.control.paused) { await this.statusLogged("muted"); return; } // @spec CTX-GATE-008
    // @spec CTX-GATE-003, CTX-SAY-004
    if (this.voiceBusy()) { await this.statusLogged("speaking"); return; }

    this.thinking = true; // the try/finally below always clears it, even if a status publish fails
    try {
      await this.status("thinking", focus.reason);
      // @spec CTX-RECALL-001
      const query = focus.focus?.text || this.ctx.lastVision;
      // @spec CTX-NOTES-002
      // Both requests go out before either is awaited, so they share one deadline.
      const [memories, people] = await Promise.all([query ? this.recall(query) : [], this.fetchNotes(focus)]);
      // @spec CTX-NOTES-008
      if (people.length) log.info({ viewers: people.length, notes: people.reduce((n, v) => n + v.notes.length, 0) }, "viewer notes");
      // @spec CTX-VIEWER-003
      const who = focus.focus?.who?.toLowerCase();
      const viewerNote = who ? this.viewerNotes.get(who) : undefined;
      // @spec CTX-FALL-004, CTX-FALL-005, CTX-FALL-006
      // The hint states the base chance and nothing more: no draw, and the reply is never checked against it.
      if (this.glitch && !this.ctx.hasSelf(this.glitch.id)) this.glitch = undefined; // its line scrolled out of the window
      const chance = cfg.brain.cortex.fallback_ack_chance;
      const carried = chance > 0 ? this.glitch : undefined;
      const glitch: Glitch | undefined = carried && { intended: carried.intended, fallback: carried.fallback, chance };
      const messages = buildMessages({ cfg, personality: this.personality, ctx: this.ctx, memories, focus, mood: this.mood, viewerNote, people, glitch });
      const t0 = Date.now();
      const raw = await llm.chat(messages);
      let { text, emotion, gesture } = parseReply(raw);
      // @spec CTX-PROMPT-007
      log.info({ ms: Date.now() - t0, reason: focus.reason, memories: memories.length }, "llm reply");
      log.debug({ raw }, "llm reply text"); // raw text can echo chat and is not yet through the critic
      // @spec CTX-PROMPT-006
      if (!text || text.length < 2) { await this.status("idle"); return; }
      // Inhibition: let the critic veto or touch up the line before it's spoken.
      // @spec CTX-CRITIC-001, CTX-CRITIC-002, CTX-CRITIC-003
      const verdict = await critic.run({ text, emotion: emotion as Emotion, reason: focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
      if (!verdict.ok) { log.info({ note: verdict.note, text }, "critic vetoed"); await this.status("idle"); return; }
      if (verdict.text) { log.info({ from: text, to: verdict.text }, "critic rewrote"); text = verdict.text; }
      if (verdict.emotion) emotion = verdict.emotion;
      // A reflex or operator line may have started while we were thinking; don't talk over it.
      // @spec CTX-GATE-005
      if (this.control.muted || this.control.paused) { await this.status("muted"); return; }
      // @spec CTX-GATE-006
      if (this.voiceBusy()) { log.info({ text }, "dropped: something else spoke while thinking"); await this.status("speaking"); return; }
      // @spec CTX-INJ-001
      // The viewer's note is one-shot: consumed only once this reply's brain.say is out (a newer note is kept). @spec CTX-VIEWER-003
      await this.say(text, emotion as Emotion, gesture, focus.reason, propagatedFlags(focus), () => {
        if (who && this.viewerNotes.get(who) === viewerNote) this.viewerNotes.delete(who);
        if (carried && this.glitch === carried) this.glitch = undefined; // a newer glitch stays pending (CTX-FALL-005)
      });
    } catch (err) {
      log.error({ err }, "think failed");
      await this.status("idle").catch(() => {});
    } finally {
      this.thinking = false;
    }
  }

  /** `status` for paths with nothing else to do: a failed publish is logged, never raised (CTX-GATE-008). */
  private statusLogged(state: "idle" | "thinking" | "speaking" | "muted", detail?: string): Promise<void> {
    return this.status(state, detail).catch((err) => this.d.log.error({ err, state }, "brain.status publish failed"));
  }

  async status(state: "idle" | "thinking" | "speaking" | "muted", detail?: string): Promise<void> {
    await this.d.bus.publish("brain.status", { state, detail });
  }

  // @spec CTX-GATE-004
  /** Someone's line is still playing (with the stuck-sink safety valve). */
  private voiceBusy(): boolean {
    if (this.speakingId && performance.now() - this.speakingSince > this.d.cfg.brain.cortex.speaking_timeout_ms) this.stopSpeaking();
    return !!this.speakingId;
  }

  /** A line began playing: remember it and arm the stuck-sink release. */
  private startSpeaking(id: string): void {
    this.stopSpeaking();
    this.speakingId = id;
    this.speakingSince = performance.now(); // monotonic: a stepped wall clock must not move the valve
    // @spec CTX-GATE-009
    this.speakingTimer = setTimeout(() => {
      this.speakingTimer = undefined;
      if (this.speakingId !== id) return;
      this.speakingId = undefined;
      // A think in flight ends with its own status; don't contradict it.
      if (!this.thinking) void this.statusLogged(this.control.muted || this.control.paused ? "muted" : "idle");
    }, this.d.cfg.brain.cortex.speaking_timeout_ms);
    this.speakingTimer.unref();
  }

  private stopSpeaking(): void {
    this.speakingId = undefined;
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = undefined;
  }

  // @spec CTX-RECALL-002, CTX-RECALL-003, CTX-RECALL-004
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

  // @spec CTX-NOTES-001
  /** The replied-to viewer first, then the distinct chat users in the working-memory window, newest first; each name once. */
  private notesUsers(focus: Focus): string[] {
    const seen = new Set<string>();
    const users: string[] = [];
    const add = (name: string | undefined) => {
      const trimmed = name?.trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) return;
      seen.add(trimmed.toLowerCase());
      users.push(trimmed);
    };
    add(focus.focus?.who);
    const events = this.ctx.all();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "chat") add(e.user);
    }
    return users;
  }

  // @spec CTX-NOTES-001, CTX-NOTES-002, CTX-NOTES-003, CTX-NOTES-007
  /** Ask the memory region for the notes of the people in this conversation; none if it is silent or the publish fails. Nothing is kept afterwards. */
  private fetchNotes(focus: Focus): Promise<People> {
    const { cfg, bus, log } = this.d;
    const users = this.notesUsers(focus);
    if (!users.length) return Promise.resolve([]);
    const id = randomUUID();
    return new Promise<People>((resolve) => {
      const timer = setTimeout(() => { this.pendingNotes.delete(id); log.warn("memory region did not answer the viewer-notes request in time"); resolve([]); }, cfg.brain.cortex.recall_timeout_ms);
      this.pendingNotes.set(id, (p) => { clearTimeout(timer); this.pendingNotes.delete(id); resolve(p); });
      void bus.publish("memory.notes.request", { id, users: users as [string, ...string[]] }).catch(() => {
        clearTimeout(timer); this.pendingNotes.delete(id); resolve([]);
      });
    });
  }

  // @spec CTX-SAY-001
  private async say(text: string, emotion: Emotion, gesture: string | undefined, reason: string, flags: InjectionFlags = {}, onPublished?: () => void) {
    const id = randomUUID();
    this.startSpeaking(id);
    await this.d.bus.publish("brain.say", { id, text, emotion, gesture, reason, ...flags });
    onPublished?.();
    await this.status("speaking", text);
  }
}
