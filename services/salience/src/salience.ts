import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { Module } from "@cohost/modules";
import { controlFor, type Heartbeat } from "@cohost/shared";
import { Context, propagatedFlags, type ContextEvent } from "@cohost/working-memory";
import { Scheduler, type Decision } from "./scheduler.js";
import type { ScoreInput, ScoreOutput } from "./scoring.js";
import { Reflexes, type Sense } from "./reflex.js";
import { Reminders, type Reminder, type TimerEvent } from "./reminders.js";

type WithdrawReason = "resumed" | "muted" | "paused" | "forgotten" | "superseded" | "timeout";
type EarlyData = BusEvent<"speech.early">["data"];

/** The provisional focus salience holds until it publishes its one `attention.resolve` (SAL-PROV-010, SAL-PROV-023). */
interface Held {
  utteranceId: string;
  seq: number;
  reason: string;
  score: number;
  /** The events the provisional decision scored: marked seen on a confirm (SAL-PROV-014). */
  scored: ContextEvent[];
  timer?: ReturnType<typeof setTimeout>;
  /** Settles once the provisional focus is on the bus, `true` when it was published: a resolve is ordered behind it. */
  focused?: Promise<boolean>;
  /** The cortex state and its clock before the focus, and the clock the focus set: restored if the focus never went out. */
  prevState?: "idle" | "thinking" | "speaking" | "muted";
  prevSince?: number;
  since?: number;
  /** The focus's own fields, kept so an interjection can confirm it (SAL-INTJ-006). */
  speaker: string;
  text: string;
  source?: string;
  timing?: { audioEndedAt: number; closedAt?: number };
}

/** An interjection request pending cortex's answer: a `brain.say` records it spoken, a status or the limit drops it (SAL-INTJ-006). */
interface Pending {
  utteranceId: string;
  seq: number;
  speaker: string;
  text: string;
  scored: ContextEvent[];
  timer?: ReturnType<typeof setTimeout>;
}

/** An interjection cortex spoke: the early text, the id of the line that carried it and the time (SAL-INTJ-021). */
interface Spoken { utteranceId: string; text: string; lineId: string; at: number }

/** The score of the last early transcript, kept for the final that may reuse it (SAL-PROV-007). */
interface EarlyScore { utteranceId: string; seq: number; text: string; score: number }

/** An early pass while it scores: a final or a retraction of its seq arriving meanwhile cancels nothing but the publish (SAL-PROV-024). */
interface EarlyPass { utteranceId: string; seq: number; finalArrived: boolean; retracted: boolean }

/** What salience keeps about a speech entry: its bus source, its utterance (SAL-PROV-028) and the early transcript it answers. */
interface SpeechInfo { source?: string; utteranceId?: string; earlySeq?: number; text: string }

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
  /**
   * The injectable random source of the interjection draw, in [0, 1) (default `Math.random`). It is read once per retraction
   * that meets every other interjection condition, and not otherwise (SAL-INTJ-004). Tests inject a fixed value.
   */
  random?: () => number;
}

/** The words of a transcript as SAL-BARGE-005 counts them: whitespace-separated tokens holding a letter or a number. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** The words a final adds beyond the early text: the difference of the two word counts, never below zero (SAL-INTJ-011). */
function wordsAdded(early: string, final: string): number {
  return Math.max(0, wordsOf(final).length - wordsOf(early).length);
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
  /** What each speech entry carries beyond the window: its `source` for the speech focus (SAL-FOCUS-003), its utterance (SAL-PROV-028). */
  private readonly speechInfo = new WeakMap<ContextEvent, SpeechInfo>();
  /** The provisional focus held now, if any (SAL-PROV-010). */
  private held?: Held;
  /** The early pass that is scoring now, if any (SAL-PROV-024). */
  private earlyInFlight?: EarlyPass;
  /** The score of the last early transcript (SAL-PROV-007). */
  private earlyScore?: EarlyScore;
  /** The interjection request pending cortex's answer, if any (SAL-INTJ-006). */
  private interjection?: Pending;
  /** The last eight interjections cortex spoke, oldest first (SAL-INTJ-021). */
  private readonly interjected: Spoken[] = [];
  /** When the last interjection was spoken: the gap of SAL-INTJ-003 is counted from it. */
  private lastInterjectedAt?: number;
  /** Finals that arrived while an interjection request was pending, in arrival order (SAL-INTJ-023). */
  private readonly heldFinals: BusEvent[] = [];
  /** The id of the line that last set the cortex state to `speaking`, whoever spoke it (SAL-INTJ-009). */
  private speakingLineId?: string;
  private readonly random: () => number;
  /** Utterances whose final has arrived, newest last, bounded: an early transcript of one of them starts no pass (SAL-PROV-009). */
  private readonly finals = new Set<string>();
  /** Due timer reminders, held apart from working memory: a reminder never enters a transcript (SAL-REM-001). */
  private readonly reminders: Reminders;

  constructor(private d: SalienceDeps) {
    this.ctx = Context.forBrain(d.cfg.brain, d.cfg.viewer_text);
    this.now = d.now ?? (() => performance.now());
    this.random = d.random ?? Math.random;
    this.cortexSince = this.now();
    this.control = controlFor("salience", {
      pause: () => { this.ctx.holdArrivals(); void this.withdraw("paused"); }, // @spec SAL-PROV-018
      resume: () => this.ctx.releaseArrivals(), // @spec SAL-CTRL-007
      mute: () => void this.withdraw("muted"), // @spec SAL-PROV-018
      forget_context: () => { this.ctx.clear(); this.forgetInterjection(); void this.withdraw("forgotten"); }, // @spec SAL-CTRL-005, SAL-PROV-019, SAL-INTJ-024
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
        this.noteFinal(d.utteranceId);
        // A final that arrives while an interjection request is pending waits for its answer, without holding the handler (SAL-INTJ-023).
        // A final of the utterance whose request is pending waits for its answer; another utterance's final is an ordinary line (SAL-INTJ-023).
        if (this.interjection !== undefined && this.interjection.utteranceId === d.utteranceId) { this.heldFinals.push(ev); break; }
        await this.final(ev);
        break;
      }
      // Early reply (SAL-IN-007, SAL-TRIG-002): an early transcript starts only the early pass; neither it nor a retraction enters
      // the window or starts a decision.
      case "speech.early": { // @spec SAL-IN-001, SAL-PROV-001, SAL-PROV-002, SAL-TRIG-002
        if (!this.d.cfg.brain.salience.trigger_on_speech) break; // @spec SAL-PROV-002
        void this.earlyPass(ev.data as EarlyData); // unawaited: the handler never waits on a scorer (SAL-PROV-001)
        break;
      }
      case "speech.retracted": { // @spec SAL-PROV-016, SAL-PROV-017, SAL-PROV-024
        const d = ev.data as BusEvent<"speech.retracted">["data"];
        const pass = this.earlyInFlight;
        if (pass && pass.utteranceId === d.utteranceId && pass.seq === d.seq) pass.retracted = true; // @spec SAL-PROV-009
        const h = this.held;
        if (h && h.utteranceId === d.utteranceId && h.seq === d.seq) await this.retractHeld(h); // @spec SAL-PROV-016, SAL-INTJ-001, SAL-INTJ-005
        break;
      }
      // A timer is never chat, speech or vision: it is held as a reminder, and it starts no decision pass (SAL-REM-007).
      case "tool.timer": { // @spec SAL-REM-001, SAL-REM-002, SAL-REM-003, SAL-REM-007
        // Expired reminders (the held ones, and an arrival already past the expiry) are republished as missed now, not spoken.
        for (const r of this.reminders.arrive(ev.data as TimerEvent, Date.now())) await this.republishMissed(r);
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
        this.speakingLineId = d.id; // @spec SAL-INTJ-009
        // The cortex's own line is the one neither reflex-prefixed nor `operator`; only it replaces the remembered line (SAL-BUSY-005).
        if (!this.reflexLine && reason !== "operator") this.cortexLine = { id: d.id, more: d.more === true };
        // A cortex line answers a pending interjection request: the interjection was spoken (SAL-INTJ-007).
        if (this.interjection && !this.reflexLine && reason !== "operator") this.interjectionSpoken(d.id); // @spec SAL-INTJ-007
        this.barged = false; // @spec SAL-BARGE-010
        await this.withdraw("superseded"); // @spec SAL-PROV-020, SAL-PROV-031 (the state set above stands)
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
        // A status other than `thinking` before any say: cortex did not speak the interjection (SAL-INTJ-008).
        if (this.interjection && d.state !== "thinking") this.interjectionDropped(); // @spec SAL-INTJ-008
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
    this.speakingLineId = undefined; // a reflex line is not the interjected line (SAL-INTJ-009)
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
    if (wordsOf(d.text).length < cfg.barge_in_min_words) return; // @spec SAL-BARGE-005
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

  /**
   * The early pass (SAL-PROV-001 to SAL-PROV-009): scores the early transcript as a decision would, beside the unseen events,
   * and holds a provisional focus when it speaks. It is a decision in flight while it scores (SAL-PROV-032), so a poll is a
   * no-op and a final records one pending rerun. Never rejects.
   * @spec SAL-PROV-001, SAL-PROV-003, SAL-PROV-004, SAL-PROV-005, SAL-PROV-006, SAL-PROV-007, SAL-PROV-008, SAL-PROV-029, SAL-PROV-032, SAL-PROV-033
   */
  private async earlyPass(d: EarlyData): Promise<void> {
    try {
      if (this.control.paused || this.deciding || this.held || this.finals.has(d.utteranceId)) return; // @spec SAL-PROV-003
      if (this.control.muted || this.busy() || this.scheduler.cooling()) return; // @spec SAL-PROV-005
      // An utterance whose interjection was spoken starts a provisional focus only for a follow-up of enough words (SAL-INTJ-015).
      const spoken = this.spokenFor(d.utteranceId);
      if (spoken && wordsAdded(spoken.text, d.text) < this.d.cfg.brain.salience.interject_followup_min_words) return; // @spec SAL-INTJ-015
      // A line a reflex answers is left to the final; the match stamps no rule's cooldown (SAL-PROV-004).
      if (this.reflexes.matches("speech", d.text, this.now())) return; // @spec SAL-PROV-004
      const transient: ContextEvent = {
        kind: "speech", eventId: `early:${d.utteranceId}:${d.seq}`, ts: Date.now(), speaker: d.speaker, text: d.text,
        ...(d.timing ? { timing: d.timing } : {}), seen: false,
      };
      this.speechInfo.set(transient, { source: d.source, utteranceId: d.utteranceId, earlySeq: d.seq, text: d.text });
      const pass: EarlyPass = { utteranceId: d.utteranceId, seq: d.seq, finalArrived: false, retracted: false };
      this.deciding = true;
      this.earlyInFlight = pass;
      try {
        const decision = await this.scheduler.decide(this.ctx, false, false, this.arousal, undefined, transient); // @spec SAL-PROV-006
        this.earlyScore = { utteranceId: d.utteranceId, seq: d.seq, text: d.text, score: this.scheduler.scoreOf(transient) ?? 0 }; // @spec SAL-PROV-007
        await this.provisional(d, decision, pass, transient);
      } finally {
        this.earlyInFlight = undefined;
        this.deciding = false;
      }
      if (this.rerun && !this.control.paused) void this.tick(); // the final that arrived meanwhile (SAL-PROV-033)
    } catch (err) {
      this.d.log.error({ err }, "early pass failed");
    }
  }

  /**
   * Publishes the provisional focus of an early pass that may speak, after the one re-check of SAL-PROV-009. The focus is always
   * the speech itself, never the chat line that might outrank it (SAL-PROV-010). Marks nothing seen, starts no cooldown and leaves
   * the idle timer alone (SAL-PROV-011).
   * @spec SAL-PROV-008, SAL-PROV-009, SAL-PROV-010, SAL-PROV-011, SAL-PROV-012, SAL-PROV-024, SAL-PROV-029
   */
  private async provisional(d: EarlyData, decision: Decision, pass: EarlyPass, transient: ContextEvent): Promise<void> {
    if (pass.retracted || pass.finalArrived) return; // @spec SAL-PROV-024
    if (this.control.muted || this.control.paused || this.busy()) return; // @spec SAL-PROV-009
    if (!decision.speak || decision.reason === "idle chatter") return; // @spec SAL-PROV-008, SAL-PROV-029
    // Only when the early speech is the focus: an event that outranks it is answered on the final, as any decision would (SAL-PROV-010).
    if (decision.focus !== transient) return; // @spec SAL-PROV-010
    const timing = d.timing?.audioEndedAt !== undefined
      ? { audioEndedAt: d.timing.audioEndedAt, ...(d.timing.closedAt !== undefined ? { closedAt: d.timing.closedAt } : {}) }
      : undefined;
    const h: Held = {
      utteranceId: d.utteranceId, seq: d.seq, reason: "engaged", score: decision.score, scored: decision.scored,
      speaker: d.speaker, text: d.text, ...(d.source !== undefined ? { source: d.source } : {}), ...(timing ? { timing } : {}),
    };
    h.prevState = this.cortexState;
    h.prevSince = this.cortexSince;
    this.held = h;
    this.cortexState = "thinking"; // @spec SAL-PROV-025
    h.since = this.cortexSince = this.now();
    h.focused = this.d.bus.publish("attention.focus", {
      reason: h.reason,
      score: h.score,
      focus: { kind: "speech", who: d.speaker, text: d.text, source: d.source },
      provisional: true,
      utteranceId: d.utteranceId,
      seq: d.seq,
      ...(timing ? { timing } : {}),
    }).then(() => true, (err: unknown) => {
      this.d.log.error({ err }, "provisional focus publish failed");
      return false;
    });
    if (!(await h.focused)) { this.dropUnsent(h); return; }
    // The limit counts from the publication (SAL-PROV-012); a resolve sent meanwhile has already dropped the record.
    if (this.held === h) h.timer = this.startLimit(h);
  }

  /** The unresolved limit of a provisional focus: a timeout withdraw when it runs out (SAL-PROV-012, SAL-PROV-021). */
  private startLimit(h: Held): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.withdraw("timeout", h), this.d.cfg.brain.salience.unresolved_limit_ms);
    (timer as { unref?: () => void }).unref?.(); // a pending limit alone never keeps the service alive
    return timer;
  }

  /**
   * Publishes the one `attention.resolve` of a held provisional focus with a withdraw reason and drops the record and the early
   * score (SAL-PROV-022, SAL-PROV-023). Every reason but `superseded` leaves the cortex idle at once (SAL-PROV-030, SAL-PROV-031).
   * A call for a record that is no longer held does nothing, so each provisional focus is resolved exactly once.
   * @spec SAL-PROV-016, SAL-PROV-018, SAL-PROV-019, SAL-PROV-020, SAL-PROV-021, SAL-PROV-022, SAL-PROV-023, SAL-PROV-030, SAL-PROV-031
   */
  private async withdraw(reason: WithdrawReason, h: Held | undefined = this.held): Promise<void> {
    if (!h || this.held !== h) return;
    this.held = undefined;
    clearTimeout(h.timer);
    this.earlyScore = undefined; // @spec SAL-PROV-022
    if (reason !== "superseded") { // @spec SAL-PROV-030, SAL-PROV-031
      this.cortexState = "idle";
      this.cortexSince = this.now();
    }
    try {
      // The resolve follows its focus on the bus; a focus that never went out needs no resolve (SAL-PROV-023).
      if (h.focused && !(await h.focused)) return;
      await this.d.bus.publish("attention.resolve", { utteranceId: h.utteranceId, seq: h.seq, outcome: "withdraw", reason });
    } catch (err) {
      this.d.log.error({ err, reason }, "attention.resolve publish failed");
    }
  }

  /** Notes that the final of an utterance has arrived, for the early pass that may be scoring it (SAL-PROV-024). */
  private noteFinal(utteranceId: string | undefined): void {
    if (utteranceId === undefined) return;
    if (this.earlyInFlight?.utteranceId === utteranceId) this.earlyInFlight.finalArrived = true; // @spec SAL-PROV-024
    this.finals.add(utteranceId);
    if (this.finals.size > 32) {
      const oldest = this.finals.values().next().value;
      if (oldest !== undefined) this.finals.delete(oldest);
    }
  }

  /**
   * A final that matches the held provisional focus (same utterance): `earlySeq` equal to its seq confirms it, anything else
   * withdraws it as `resumed` before the final takes the ordinary path. Returns whether the final was confirmed.
   * @spec SAL-PROV-013, SAL-PROV-015, SAL-PROV-030
   */
  private async resolveFinal(d: BusEvent<"speech.heard">["data"], entry: ContextEvent): Promise<boolean> {
    const h = this.held;
    if (!h || d.utteranceId === undefined || h.utteranceId !== d.utteranceId) return false;
    if (d.earlySeq !== h.seq) {
      await this.withdraw("resumed", h); // @spec SAL-PROV-015
      return false;
    }
    // A confirm waits for its focus to be on the bus (SAL-PROV-013). A focus that never went out confirms nothing: the record is
    // dropped and the final takes the ordinary path. A withdraw that landed meanwhile has already resolved the focus.
    if (h.focused && !(await h.focused)) { this.dropUnsent(h); return false; }
    if (this.held !== h) return false;
    await this.confirm(d, entry, h);
    return true;
  }

  /** A provisional focus that never reached the bus is dropped, and the cortex state it set is restored (SAL-HEALTH-002). */
  private dropUnsent(h: Held): void {
    if (this.held !== h) return;
    this.held = undefined;
    if (this.cortexState === "thinking" && this.cortexSince === h.since) {
      this.cortexState = h.prevState ?? "idle";
      this.cortexSince = h.prevSince ?? this.now();
    }
  }

  /**
   * Confirms the held provisional focus with the final's fields and timing, marks the scored events and the final seen, and
   * holds the cortex as `thinking` with no cooldown (SAL-PROV-013, SAL-PROV-014, SAL-PROV-034).
   * @spec SAL-PROV-013, SAL-PROV-014, SAL-PROV-023, SAL-PROV-034, SAL-FOCUS-006
   */
  private async confirm(d: BusEvent<"speech.heard">["data"], entry: ContextEvent, h: Held): Promise<void> {
    this.held = undefined;
    clearTimeout(h.timer);
    this.earlyScore = undefined; // the final is handled: its cached early score goes with it (SAL-PROV-034)
    this.ctx.markSeenEvents([...h.scored, entry]); // @spec SAL-PROV-014
    this.cortexState = "thinking"; // @spec SAL-PROV-014
    this.cortexSince = this.now();
    const timing = d.timing?.audioEndedAt !== undefined
      ? { audioEndedAt: d.timing.audioEndedAt, ...(d.timing.closedAt !== undefined ? { closedAt: d.timing.closedAt } : {}), heardAt: entry.ts }
      : undefined;
    try {
      await this.d.bus.publish("attention.resolve", {
        utteranceId: h.utteranceId,
        seq: h.seq,
        outcome: "confirm",
        reason: h.reason,
        score: h.score,
        focus: { kind: "speech", who: d.speaker, text: entry.kind === "speech" ? entry.text : d.text, source: d.source },
        ...propagatedFlags(entry),
        ...(timing ? { timing } : {}),
      });
    } catch (err) {
      this.d.log.error({ err }, "attention.resolve confirm publish failed");
    }
  }

  /** The final of an utterance is handled: the early score cached for it goes (SAL-PROV-034). */
  private handledEarly(utteranceId: string | undefined): void {
    if (utteranceId !== undefined && this.earlyScore?.utteranceId === utteranceId) this.earlyScore = undefined;
  }

  /** Gives a final whose early score is held that score, so it is not scored twice (SAL-PROV-007, SAL-PROV-034). */
  private adoptEarlyScore(): void {
    const c = this.earlyScore;
    if (!c) return;
    for (const e of this.ctx.unseen()) {
      const info = e.kind === "speech" ? this.speechInfo.get(e) : undefined;
      if (info && info.utteranceId === c.utteranceId && info.earlySeq === c.seq && info.text === c.text) {
        this.scheduler.primeScore(e, c.score); // @spec SAL-PROV-007, SAL-PROV-033
        this.earlyScore = undefined; // @spec SAL-PROV-034
        return;
      }
    }
  }

  /**
   * The final of an utterance (SAL-IN-002 onward). A spoken interjection of the utterance first applies its rule set: a short
   * continuation is marked seen and decides nothing (SAL-INTJ-010); else the yield stops the interjected line (SAL-INTJ-009) and
   * the barge-in check is skipped; else the ordinary barge-in check applies (SAL-INTJ-012). The final is appended as an ordinary
   * line in every case (SAL-INTJ-013).
   * @spec SAL-IN-002, SAL-BARGE-001, SAL-BARGE-003, SAL-TRIG-001, SAL-INTJ-009, SAL-INTJ-010, SAL-INTJ-012, SAL-INTJ-013, SAL-INTJ-022
   */
  private async final(ev: BusEvent): Promise<void> {
    const d = ev.data as BusEvent<"speech.heard">["data"];
    const entry = this.ctx.push(ev);
    if (entry) this.speechInfo.set(entry, { source: d.source, utteranceId: d.utteranceId, earlySeq: d.earlySeq, text: d.text }); // @spec SAL-FOCUS-003
    this.scheduler.noteActivity();
    const spoken = this.spokenFor(d.utteranceId);
    let stopped = false;
    if (spoken) {
      if (wordsAdded(spoken.text, d.text) < this.d.cfg.brain.salience.interject_followup_min_words) { // @spec SAL-INTJ-010
        if (entry) this.ctx.markSeenEvents([entry]);
        // A provisional focus held for the utterance is withdrawn, so cortex is not left thinking until its limit (SAL-INTJ-010).
        const h = this.held;
        if (h && h.utteranceId === d.utteranceId) await this.withdraw("resumed", h);
        return;
      }
      // A failed yield is handled as a stop that did not happen: the line keeps its state and takes no barge-in either (SAL-BARGE-009).
      if (this.d.cfg.brain.salience.interject_yield) stopped = (await this.yieldTo(spoken)) !== "none"; // @spec SAL-INTJ-009
    }
    if (!stopped) await this.bargeIn(d); // @spec SAL-BARGE-001, SAL-BARGE-003, SAL-INTJ-012
    // A final that answers the held provisional focus is confirmed or withdraws it first (SAL-PROV-013, SAL-PROV-015).
    const confirmed = entry !== undefined && (await this.resolveFinal(d, entry));
    const fired = await this.reflex("speech", d.text, entry);
    if (fired) this.handledEarly(d.utteranceId); // a reflex marks the final seen: it is handled (SAL-PROV-034)
    if (!fired && !confirmed) this.triggerOnSpeech(); // @spec SAL-TRIG-001, SAL-TRIG-003
  }

  /** The record of an interjection cortex spoke for this utterance, if one is kept (SAL-INTJ-021). */
  private spokenFor(utteranceId: string | undefined): Spoken | undefined {
    if (utteranceId === undefined) return undefined;
    // The most recent record wins: an utterance can be interjected again after a follow-up (SAL-INTJ-015).
    for (let i = this.interjected.length - 1; i >= 0; i--) if (this.interjected[i]!.utteranceId === utteranceId) return this.interjected[i];
    return undefined;
  }

  /**
   * A retraction of the held provisional focus: asks for an interjection when every condition of SAL-INTJ-001 to SAL-INTJ-004
   * holds, else withdraws it as `resumed` (SAL-INTJ-005).
   * @spec SAL-PROV-016, SAL-INTJ-001, SAL-INTJ-005
   */
  private async retractHeld(h: Held): Promise<void> {
    if (this.interjectionAllowed(h)) { await this.askInterjection(h); return; } // @spec SAL-INTJ-006
    await this.withdraw("resumed", h); // @spec SAL-PROV-016
  }

  /**
   * The gates of an interjection, in the order the spec lists them. The draw comes last, so it is made once per retraction and only
   * when every other gate holds (SAL-INTJ-004).
   * @spec SAL-INTJ-001, SAL-INTJ-002, SAL-INTJ-003, SAL-INTJ-004
   */
  private interjectionAllowed(h: Held): boolean {
    const cfg = this.d.cfg.brain.salience;
    if (!cfg.interject || this.control.paused || this.control.muted) return false; // @spec SAL-INTJ-001
    if (wordsOf(h.text).length < cfg.interject_min_words) return false; // @spec SAL-INTJ-002
    if (this.lastInterjectedAt !== undefined && this.now() - this.lastInterjectedAt < cfg.interject_min_gap_ms) return false; // @spec SAL-INTJ-003
    return this.random() < cfg.interject_chance; // @spec SAL-INTJ-004
  }

  /**
   * Asks cortex to speak the prepared reply: an interjected confirm of the held focus, with the focus's fields and timing. The
   * request is pending until cortex answers, and the cortex state is `thinking` meanwhile (SAL-INTJ-006, SAL-INTJ-018).
   * @spec SAL-INTJ-006, SAL-INTJ-018
   */
  private async askInterjection(h: Held): Promise<void> {
    // The confirm follows its focus on the bus, as a confirm does (SAL-PROV-013): a focus that never went out asks nothing.
    if (h.focused && !(await h.focused)) { this.dropUnsent(h); return; }
    if (this.held !== h) return;
    this.held = undefined;
    clearTimeout(h.timer);
    this.earlyScore = undefined;
    this.cortexState = "thinking"; // @spec SAL-INTJ-006
    const since = this.cortexSince = this.now();
    const p: Pending = { utteranceId: h.utteranceId, seq: h.seq, speaker: h.speaker, text: h.text, scored: h.scored };
    this.interjection = p;
    p.timer = setTimeout(() => this.interjectionLimit(p), this.d.cfg.brain.salience.unresolved_limit_ms); // @spec SAL-INTJ-018
    (p.timer as { unref?: () => void }).unref?.();
    try {
      await this.d.bus.publish("attention.resolve", {
        utteranceId: h.utteranceId, seq: h.seq, outcome: "confirm", interjected: true, reason: h.reason, score: h.score,
        focus: { kind: "speech", who: h.speaker, text: h.text, ...(h.source !== undefined ? { source: h.source } : {}) },
        ...(h.timing ? { timing: h.timing } : {}),
      });
    } catch (err) {
      // The request was never made: cortex is left with no provisional focus (a withdraw), no pending request, and the held finals go on.
      this.d.log.error({ err }, "attention.resolve interjection publish failed");
      if (this.interjection === p) {
        this.interjection = undefined;
        clearTimeout(p.timer);
        if (this.cortexState === "thinking" && this.cortexSince === since) this.cortexState = "idle";
      }
      try {
        await this.d.bus.publish("attention.resolve", { utteranceId: h.utteranceId, seq: h.seq, outcome: "withdraw", reason: "resumed" });
      } catch (err2) {
        this.d.log.error({ err: err2 }, "attention.resolve withdraw publish failed");
      }
      void this.drainHeldFinals();
    }
  }

  /**
   * cortex spoke the interjected reply: the gap starts now, the scored events are seen, the early text enters the window as the
   * speaker's unfinished line and the record is kept (SAL-INTJ-007, SAL-INTJ-019, SAL-INTJ-020, SAL-INTJ-021).
   * @spec SAL-INTJ-007, SAL-INTJ-019, SAL-INTJ-020, SAL-INTJ-021, SAL-INTJ-023
   */
  private interjectionSpoken(lineId: string): void {
    const p = this.interjection;
    if (!p) return;
    this.interjection = undefined;
    clearTimeout(p.timer);
    const at = this.now();
    this.lastInterjectedAt = at; // @spec SAL-INTJ-007
    this.ctx.markSeenEvents(p.scored); // @spec SAL-INTJ-019
    this.ctx.pushUnfinished(p.utteranceId, p.speaker, p.text, Date.now()); // @spec SAL-INTJ-020
    this.interjected.push({ utteranceId: p.utteranceId, text: p.text, lineId, at }); // @spec SAL-INTJ-021
    if (this.interjected.length > 8) this.interjected.shift();
    void this.drainHeldFinals();
  }

  /**
   * forget_context drops a pending request with no gap and no publish, and discards the finals held for it: cortex is left idle
   * (SAL-INTJ-024). A `brain.say` that cortex sends for the dropped request later is an ordinary line.
   * @spec SAL-INTJ-024
   */
  private forgetInterjection(): void {
    this.heldFinals.length = 0;
    const p = this.interjection;
    if (!p) return;
    this.interjection = undefined;
    clearTimeout(p.timer);
    if (this.cortexState === "thinking") { this.cortexState = "idle"; this.cortexSince = this.now(); }
  }

  /**
   * cortex answered with a status other than `thinking` before any say: nothing was spoken, so no gap and nothing seen (SAL-INTJ-008).
   * The utterance then has no record, so a later early transcript is an ordinary early pass that may ask again (SAL-INTJ-016).
   * @spec SAL-INTJ-008, SAL-INTJ-016
   */
  private interjectionDropped(): void {
    const p = this.interjection;
    if (!p) return;
    this.interjection = undefined;
    clearTimeout(p.timer);
    void this.drainHeldFinals();
  }

  /** The unresolved limit of a pending request: cortex is idle, the gap is not charged and nothing is published (SAL-INTJ-018). */
  private interjectionLimit(p: Pending): void {
    if (this.interjection !== p) return;
    this.interjection = undefined;
    this.cortexState = "idle"; // @spec SAL-INTJ-018
    this.cortexSince = this.now();
    void this.drainHeldFinals();
  }

  /**
   * Handles the finals held for a pending request, in arrival order, once no request is pending (SAL-INTJ-023). Not awaited by the
   * handler that releases them: a final is decided as an ordinary line once its turn comes.
   * @spec SAL-INTJ-023
   */
  private async drainHeldFinals(): Promise<void> {
    while (!this.interjection && this.heldFinals.length > 0) {
      const ev = this.heldFinals.shift()!;
      try { await this.final(ev); }
      catch (err) { this.d.log.error({ err }, "held final failed"); }
    }
  }

  /**
   * The yield of SAL-INTJ-009: when the interjected line still plays, stops it by its id and frees the state and the cooldown, whether
   * or not `barge_in` is on. Reports `none` when the line is not playing, `stopped` on the publish, `failed` when it did not go out.
   * @spec SAL-INTJ-009, SAL-INTJ-017, SAL-BARGE-002, SAL-BARGE-009
   */
  private async yieldTo(rec: Spoken): Promise<"none" | "stopped" | "failed"> {
    // The line that last set `speaking` must be the interjected line: a reflex or operator line, or another cortex line, that set
    // it later does not count. Every cortex line sets both the remembered cortex line (SAL-BUSY-005) and this id, so the id is the
    // remembered line whenever it is a cortex line.
    if (!(this.cortexState === "speaking" && this.busy() && this.speakingLineId === rec.lineId)) return "none";
    try {
      await this.d.bus.publish("voice.stop", { reason: "yield", ids: [rec.lineId] });
    } catch (err) {
      this.d.log.error({ err }, "voice.stop yield publish failed");
      return "failed";
    }
    this.cortexState = "idle";
    this.cortexSince = this.now();
    this.scheduler.clearCooldown();
    return "stopped";
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
    for (const r of this.reminders.takeExpired(Date.now())) await this.republishMissed(r);
  }

  /** Republishes one expired reminder as `tool.timer` with `missed`. A failure is logged and the reminder stays dropped (no retry). */
  private async republishMissed(r: Reminder): Promise<void> {
    try {
      await this.d.bus.publish("tool.timer", { id: r.id, note: r.note, setAt: r.setAt, dueAt: r.dueAt, missed: true });
    } catch (err) {
      this.d.log.error({ err, id: r.id }, "missed timer republish failed");
    }
  }

  private async decideAndPublish(): Promise<void> {
    if (this.control.paused || this.deciding) return; // an llm/http scorer can take longer than a tick; @spec SAL-FOCUS-002, SAL-CTRL-002
    this.deciding = true;
    this.rerun = false; // this pass sees everything that has arrived so far
    // The due reminder is claimed now, synchronously, so no expiry sweep of a later tick can republish it while this pass is in
    // flight (SAL-REM-003). The claim is released on every path that does not settle it (SAL-HEALTH-002).
    const claim = this.reminders.due(Date.now()); // @spec SAL-REM-006
    if (claim) this.reminders.beginSpeak(claim.id); // @spec SAL-REM-005
    try {
      this.adoptEarlyScore(); // @spec SAL-PROV-007, SAL-PROV-033
      let decision;
      try { decision = await this.scheduler.decide(this.ctx, this.busy(), this.control.muted, this.arousal, claim); }
      finally { this.deciding = false; }
      // A final scored by this decision is decided, with or without the early score adopted: its cached score goes (SAL-PROV-034).
      for (const e of decision.scored) this.handledEarly(e.kind === "speech" ? this.speechInfo.get(e)?.utteranceId : undefined);
      await this.publishDecision(decision);
    } finally {
      if (claim) this.reminders.abortSpeak(claim.id); // a no-op once settled
    }
  }

  /** Publishes the focus of a decision that speaks, under the gates the pass just ran (SAL-FOCUS-005, SAL-FOCUS-007). */
  private async publishDecision(decision: Decision): Promise<void> {
    if (!decision.speak) return;
    // A mute, pause or busy cortex may have arrived while the scorer ran: the decision is void then.
    if (this.control.muted || this.control.paused || this.busy()) return; // @spec SAL-FOCUS-005
    // A chat.removed may have taken the focused line out of the window while the scorer ran: no focus, no seen marks, no thinking.
    // Window eviction and forget_context do not void a decision, only a removal does (SAL-FOCUS-007).
    if (decision.focus && this.removed.has(decision.focus)) return; // @spec SAL-FOCUS-007
    // An ordinary focus supersedes a held provisional focus: its resolve goes out first (SAL-PROV-020, SAL-PROV-027).
    await this.withdraw("superseded");
    // Only what was scored: anything that arrived while an llm/http scorer was running stays unseen.
    this.ctx.markSeenEvents(decision.scored); // @spec SAL-FOCUS-004
    // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
    const prevState = this.cortexState;
    const prevSince = this.cortexSince;
    this.cortexState = "thinking";
    const since = this.cortexSince = this.now();
    const f = decision.focus;
    const r = decision.reminder;
    const info = f?.kind === "speech" ? this.speechInfo.get(f) : undefined;
    try {
    await this.d.bus.publish("attention.focus", { // @spec SAL-FOCUS-003
      reason: decision.reason,
      score: decision.score,
      focus:
        r ? { kind: "reminder", text: r.note } // @spec SAL-REM-005
        : f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
        : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text, ...(info?.source !== undefined ? { source: info.source } : {}) }
        : f?.kind === "vision" ? { kind: "vision", text: f.text }
        : undefined,
      ...(info?.utteranceId !== undefined ? { utteranceId: info.utteranceId } : {}), // @spec SAL-PROV-028
      ...(f?.kind === "speech" && f.timing?.audioEndedAt !== undefined
        ? { timing: { audioEndedAt: f.timing.audioEndedAt, ...(f.timing.closedAt !== undefined ? { closedAt: f.timing.closedAt } : {}), heardAt: f.ts } } // @spec SAL-FOCUS-006
        : {}),
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
