import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher, Timing } from "@cohost/bus";
import type { Config, Emotion, Logger } from "@cohost/config";
import type { ChatEvent, ChatMessage, ChatProvider, ChatResult } from "@cohost/llm";
import type { Module } from "@cohost/modules";
import { controlFor, type Heartbeat } from "@cohost/shared";
import { normalizeKey, speakerLabel, viewerKey } from "@cohost/shared/untrusted";
import { Context, propagatedFlags, type ContextEvent, type InjectionFlags } from "@cohost/working-memory";
import { buildMessages, parseReply, type Focus, type Glitch, type Mood, type People, type Recalled } from "./prompt.js";
import type { CriticInput, CriticOutput } from "./critic.js";
import { repeatMatch, type RecentLine } from "./repeat.js";
import { cleanClause, cutClause, hasWord, readHead, type Head } from "./clauses.js";

export interface CortexDeps {
  cfg: Config;
  bus: Publisher;
  llm: ChatProvider;
  critic: Module<CriticInput, CriticOutput>;
  log: Logger;
  loadPersonality: () => string;
  /** The service's heartbeat: a pause shows as its standing detail `paused` (CTX-HEALTH-005). */
  heartbeat?: Pick<Heartbeat, "setDetail">;
}

/** Most viewer notes kept at once (CTX-VIEWER-002). */
const MAX_VIEWER_NOTES = 50;

/** A viewer a notes request names: a platform and user id when the sender has them, else the name alone. */
type ViewerRef = BusEvent<"memory.notes.request">["data"]["viewers"][number];

/** The one identity a viewer ref is deduplicated by: its `viewerKey`, or its name when it has no platform. */
function refKey(r: ViewerRef): string {
  return r.platform ? viewerKey({ platform: r.platform, userId: r.userId, user: r.user }) : `name:${normalizeKey(r.user)}`;
}

/**
 * The viewers of a notes request: the focus's viewer first, then the chat viewers in the window newest first, one per
 * `refKey`. The first spelling of a viewer wins, so the focus keeps its own and a window viewer takes its newest.
 */
// @spec CTX-NOTES-001
function notesViewers(focus: Focus, events: readonly ContextEvent[]): ViewerRef[] {
  const out: ViewerRef[] = [];
  const seen = new Set<string>();
  const add = (r: ViewerRef) => {
    const k = refKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  // A viewer ref carries the platform and user id only when the event has a platform: a focus with none is named alone (MEM-SURF-006).
  const ref = (user: string, platform?: ViewerRef["platform"], userId?: string): ViewerRef =>
    platform ? { user, platform, ...(userId ? { userId } : {}) } : { user };
  const who = focus.focus?.who?.trim();
  if (who) add(ref(who, focus.focus?.platform, focus.focus?.userId));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "chat") continue;
    const user = e.user.trim();
    if (user) add(ref(user, e.platform, e.userId));
  }
  return out;
}

/**
 * Keep the reply entries that name a requested viewer, each once and as that viewer's name. An entry with a platform
 * matches on its full key (`refKey`: the user id, or the name when it has none); an entry with no platform matches by
 * name, and only when exactly one requested viewer has that name. An entry with a user id but no platform matches nothing.
 */
// @spec CTX-NOTES-011
function matchNotes(people: People, requested: readonly ViewerRef[]): People {
  const out: People = [];
  const matched = new Set<number>();
  for (const entry of people) {
    let idx = -1;
    if (entry.platform) {
      const key = refKey(entry);
      idx = requested.findIndex((r) => refKey(r) === key);
    } else if (!entry.userId) {
      const named = requested.flatMap((r, i) => (normalizeKey(r.user) === normalizeKey(entry.user) ? [i] : []));
      if (named.length === 1) idx = named[0]!;
    }
    if (idx < 0 || matched.has(idx)) continue;
    matched.add(idx);
    out.push({ ...entry, user: requested[idx]!.user });
  }
  return out;
}

/** A streamed line while its reply is read and published: the cortex keeps at most one. */
interface Line {
  ctrl: AbortController;
  /** The `brain.say` id once the first clause is out; undefined for a think that publishes no line. */
  id?: string;
  /** The `seq` of the last published clause (0 is the `brain.say`); -1 before it. */
  lastSeq: number;
  /** The last produced clause (CTX-REL-004): `lastSeq`, lowered to the clause before an `error` final's clause. */
  lastProduced: number;
  /** The published clauses, cleaned, in order. */
  published: string[];
  emotion: Emotion;
  gesture?: string;
  criticEndedAt?: number;
  /** The closing clause (or the last clause, marked `last`) is out: nothing more is published for the line. */
  closed: boolean;
  /** The think ended without a line. */
  exited: boolean;
  /** `stop()` ended the line or the think: nothing more is published, and the think's end is not logged as a reply. */
  stopped: boolean;
}

/** Why a streamed line was closed short (`cut` of its closing `brain.clause`). */
type LineCut = NonNullable<BusEvent<"brain.clause">["data"]["cut"]>;

/** The claim window a streamed line's players have to start it (VOICE-SINK-002, CTX-REL-011). */
const CLAIM_WINDOW_MS = 1500;

/** A sink that published `voice.playing` for a pending line (CTX-REL-002). */
interface Player {
  /** The clauses it reported a plain `voice.done` for. */
  done: Set<number>;
  /** It reported a `final` or `interrupted` done: it has completed the line (CTX-REL-003). */
  completedAll: boolean;
  /** It reported a `final` done or a `voice.failed`: it plays no more of the line (CTX-REL-012). */
  ended: boolean;
}

/** A `voice.failed` whose mark and glitch wait until the closing clause is read back (CTX-REL-016). */
interface Mark { sink: string; seq: number; fallback?: string }

/** A line pending on the voice: its valve, its players and, for a line of the cortex's own reply, its release record. */
interface Pending {
  since: number;
  /** The valve (CTX-GATE-004, CTX-GATE-009); a streamed line's valve runs only while a clause is outstanding (CTX-REL-001). */
  timer?: ReturnType<typeof setTimeout>;
  /** A streamed line's claim window (CTX-REL-011), started at its first `voice.utterance`. */
  window?: ReturnType<typeof setTimeout>;
  windowEnded: boolean;
  players: Map<string, Player>;
  /** A reply line the cortex published: the line, and whether it is streamed (its `brain.say` carried `more`). */
  own?: { line: Line; streamed: boolean };
  /** A `final` done or a `voice.failed` has been read for it (CTX-REL-012). */
  failureRead: boolean;
  /** An `error` `final` for clause 0 has been read (CTX-REL-007, CTX-FALL-012). */
  errorZero: boolean;
  /** The closing clause has been read back, or the line is not streamed: its marks apply now (CTX-REL-016). */
  readBack: boolean;
  marks: Mark[];
}

/** What a think needs to read its reply and publish the line. */
interface ReplyRequest {
  focus: Focus;
  focusedAt?: number;
  /** When the think's LLM request began (`timing.llmStartedAt`). */
  t0: number;
  memories: number;
  onSaid: () => void;
}

/** The cortex's state and event handling; main.ts wires it to the bus. */
export class Cortex {
  readonly ctx: Context;
  private personality: string;
  /** `control` state and dispatch (shared reader). Paused: keeps reading events but starts no LLM call, reported as "muted" so salience stops waiting. */
  private readonly control: ReturnType<typeof controlFor>;
  private thinking = false;
  /** The streamed line being read, if any: `stop()` closes it (CTX-STREAM-037). */
  private line: Line | undefined;
  /**
   * Lines that have begun and not yet ended, by `brain.say` id: the cortex's own, a reflex's and the operator's. An operator
   * `say` over a playing line leaves that line here, so its `voice.done` is still reconciled (CTX-SAY-005). Each entry has
   * `speaking_timeout_ms` to end before it is released as a stuck sink (CTX-GATE-004, CTX-GATE-009).
   */
  private pending = new Map<string, Pending>();
  /** A status a line's end owes the end of the think in flight, which publishes it (CTX-REL-009, CTX-EVT-005). */
  private statusOwed = false;
  private mood: Mood | undefined;
  /** Who-is-this notes from the memory region, keyed by `viewerKey` so one viewer's framing never lands on another's reply (CTX-VIEWER-002). */
  private viewerNotes = new Map<string, string>();
  /** A fallback line played in place of this one: kept until a reply that carried its hint is published (CTX-FALL-003, CTX-FALL-005). `partial`: it began after clause 0 (CTX-FALL-010). */
  private glitch: { id: string; intended: string; fallback: string; partial?: boolean } | undefined;
  private pendingRecall = new Map<string, (m: Recalled) => void>();
  private pendingNotes = new Map<string, (p: People) => void>();

  constructor(private d: CortexDeps) {
    this.ctx = Context.forBrain(d.cfg.brain, d.cfg.viewer_text);
    this.personality = d.loadPersonality();
    this.control = controlFor("cortex", {
      // @spec CTX-CTRL-002, CTX-CTRL-008, CTX-CTRL-009
      pause: async () => { await this.stopOwnLines("paused"); await this.status("muted", "paused"); },
      resume: () => this.status(this.control.muted ? "muted" : "idle"),
      // @spec CTX-CTRL-003, CTX-CTRL-008, CTX-CTRL-009
      mute: async () => { await this.stopOwnLines("muted"); await this.status("muted"); },
      unmute: () => this.status(this.control.paused ? "muted" : "idle"),
      // @spec CTX-CTRL-004
      forget_context: () => { this.ctx.clear(); this.viewerNotes.clear(); this.glitch = undefined; /* @spec CTX-FALL-005 */ },
      // @spec CTX-CTRL-005
      reload_personality: () => { this.personality = d.loadPersonality(); d.log.info("personality reloaded"); },
      // @spec CTX-CTRL-006, CTX-CTRL-007, CTX-INJ-002
      say: async (c) => { if (c.text) await this.say(c.text, "neutral", undefined, "operator", c.route ? { route: c.route } : {}); },
    }, { log: d.log, heartbeat: d.heartbeat });
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
        if (ev.source !== "cortex") this.startSpeaking(d.id); // @spec CTX-EVT-004
        break;
      }
      // A clause of the cortex's own streamed line extends its working-memory line (CTX-STREAM-034).
      // @spec CTX-STREAM-034
      case "brain.clause": {
        if (ev.source !== "cortex") break;
        const d = ev.data as BusEvent<"brain.clause">["data"];
        this.ctx.extendSelf(d.id, d.seq, d.text);
        // The closing clause read back: the failures read while the reply was open apply now (CTX-REL-016).
        // @spec CTX-REL-016
        const p = d.last ? this.pending.get(d.id) : undefined;
        if (p) { p.readBack = true; const marks = p.marks; p.marks = []; this.applyMarks(d.id, p, marks); }
        break;
      }
      // @spec CTX-REL-001, CTX-REL-011
      case "voice.utterance": {
        const d = ev.data as BusEvent<"voice.utterance">["data"];
        const p = this.pending.get(d.id);
        if (p?.own?.streamed) {
          if (!p.window && !p.windowEnded) this.startWindow(d.id, p);
          this.armValve(d.id, p, true);
        }
        break;
      }
      // @spec CTX-REL-002, CTX-REL-001
      case "voice.playing": {
        const d = ev.data as BusEvent<"voice.playing">["data"];
        const p = this.pending.get(d.id);
        if (!p) break;
        if (!p.players.has(d.sink)) p.players.set(d.sink, { done: new Set(), completedAll: false, ended: false });
        if (p.own?.streamed) this.armValve(d.id, p, true);
        break;
      }
      // @spec CTX-EVT-005
      case "voice.done": {
        const d = ev.data as BusEvent<"voice.done">["data"];
        // What the audience heard of an interrupted line, recorded whether or not the line is still pending (CTX-EVT-011, CTX-GATE-011).
        // @spec CTX-EVT-011, CTX-GATE-011
        if (d.interrupted && d.spokenText !== undefined) this.ctx.markHeard(d.id, d.spokenText);
        // A plain done clears the heard record, pending or not (CTX-EVT-012).
        // @spec CTX-EVT-012
        else if (!d.interrupted && !d.final) this.ctx.markHeard(d.id, undefined);
        const p = this.pending.get(d.id);
        if (!p) break;
        if (p.own?.streamed) { await this.streamDone(d, p); break; }
        if (this.endSpeaking(d.id)) await this.endedLine();
        break;
      }
      // A stop ends lines, never a think: no cancel, restart or start (CTX-GATE-010). A later `voice.done` flagged interrupted
      // finds its line gone and is ignored by the case above (CTX-GATE-011). A stop closes an open streamed reply `stopped`
      // (CTX-STREAM-035) and, as the cortex's own mute or pause stop reads back, releases the lines it names (CTX-EVT-013).
      // @spec CTX-EVT-010, CTX-GATE-010, CTX-GATE-011, CTX-STREAM-035, CTX-EVT-013
      case "voice.stop": {
        const { ids } = ev.data as BusEvent<"voice.stop">["data"];
        let ended = false;
        for (const id of [...this.pending.keys()]) {
          if (ids && !ids.includes(id)) continue;
          const p = this.pending.get(id);
          if (!p) continue;
          if (p.own?.streamed && !p.own.line.closed) await this.closeLine(p.own.line, "stopped");
          ended = this.endSpeaking(id) || ended;
        }
        if (ended) await this.endedLine();
        break;
      }
      // A failed sink plays no more of its line. Its marks apply now, or once the closing clause is read back (CTX-REL-016).
      // @spec CTX-EVT-008, CTX-FALL-002, CTX-FALL-003, CTX-FALL-007, CTX-REL-012, CTX-REL-014
      case "voice.failed": {
        const d = ev.data as BusEvent<"voice.failed">["data"];
        const p = this.pending.get(d.id);
        if (p) {
          p.failureRead = true;
          const pl = p.players.get(d.sink);
          if (pl) pl.ended = true;
        }
        const mark: Mark = { sink: d.sink, seq: d.seq, ...(d.fallback ? { fallback: d.fallback.text } : {}) };
        if (p && !p.readBack) p.marks.push(mark);
        else this.applyMarks(d.id, p, [mark]);
        if (p?.own?.streamed) await this.settle(d.id);
        break;
      }
      // @spec CTX-EVT-006
      case "attention.focus":
        // Don't await: the LLM call must not block the subscription loop, or the
        // memory reply we're waiting on could never be delivered.
        this.think(ev.data as Focus, ev.ts).catch((err) => this.d.log.error({ err }, "think rejected")); // @spec CTX-GATE-008
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
        // A viewer with no platform has no key, so it makes no note (CTX-VIEWER-002).
        if (!d.platform) break;
        // Memory decides who is a regular (the owner's flag or its message threshold); no notes text rides here.
        // @spec CTX-VIEWER-001, CTX-VIEWER-004
        const name = speakerLabel(d.user, this.d.cfg.viewer_text.max_name_chars);
        const note = d.isNew
          ? `${name} is new here (first message).`
          : d.regular
            ? `${name} is a regular (${d.msgCount} messages).`
            : undefined;
        const key = viewerKey({ platform: d.platform, userId: d.userId, user: d.user });
        this.viewerNotes.delete(key);
        if (note) this.viewerNotes.set(key, note);
        if (this.viewerNotes.size > MAX_VIEWER_NOTES) {
          for (const oldest of this.viewerNotes.keys()) { this.viewerNotes.delete(oldest); break; } // a Map iterates in insertion order
        }
        break;
      }
      // @spec CTX-FORGET-001, CTX-FORGET-002
      case "chat.removed": {
        const d = ev.data as BusEvent<"chat.removed">["data"];
        this.ctx.forget(d);
        // Only a user removal ends that viewer's familiarity note; a message removal keeps it. The key needs no name when it has a userId.
        if (d.scope === "user" && d.userId) this.viewerNotes.delete(viewerKey({ platform: d.platform, userId: d.userId, user: "" }));
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
  // @spec CTX-SAY-006, CTX-SAY-007, CTX-SAY-008
  /** `focusedAt` is the `attention.focus` envelope `ts`; a direct call without one leaves that stamp off. */
  async think(focus: Focus, focusedAt?: number): Promise<void> {
    const { cfg, log } = this.d;
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
      const focusKey = focus.focus?.platform && focus.focus.who
        ? viewerKey({ platform: focus.focus.platform, userId: focus.focus.userId, user: focus.focus.who })
        : undefined;
      const viewerNote = focusKey ? this.viewerNotes.get(focusKey) : undefined;
      // @spec CTX-FALL-004, CTX-FALL-005, CTX-FALL-006
      // The hint states the base chance and nothing more: no draw, and the reply is never checked against it.
      if (this.glitch && !this.ctx.hasSelf(this.glitch.id)) this.glitch = undefined; // its line scrolled out of the window
      const chance = cfg.brain.cortex.fallback_ack_chance;
      const carried = chance > 0 ? this.glitch : undefined;
      const glitch: Glitch | undefined = carried && { intended: carried.intended, fallback: carried.fallback, chance, partial: carried.partial };
      const messages = buildMessages({ cfg, personality: this.personality, ctx: this.ctx, memories, focus, mood: this.mood, viewerNote, people, glitch });
      const t0 = Date.now();
      await this.readReply(messages, {
        focus,
        focusedAt,
        t0,
        memories: memories.length,
        // The viewer's note and the glitch hint are consumed once this reply's first clause is out (CTX-VIEWER-003, CTX-FALL-005).
        onSaid: () => {
          if (focusKey && this.viewerNotes.get(focusKey) === viewerNote) this.viewerNotes.delete(focusKey);
          if (carried && this.glitch === carried) this.glitch = undefined;
        },
      });
    } catch (err) {
      log.error({ err }, "think failed");
      await this.status("idle").catch(() => {});
    } finally {
      // @spec CTX-STREAM-029
      this.thinking = false;
      // A line that ended during the think owes its status to the end of the think (CTX-REL-010).
      if (this.statusOwed) {
        this.statusOwed = false;
        if (this.pending.size === 0) await this.statusLogged(this.control.muted || this.control.paused ? "muted" : "idle");
      }
    }
  }

  /** The co-host's recent `self` lines as the repetition check reads them (CTX-REPEAT-002); `except` leaves out one line by id. */
  private recentSelf(except?: string): RecentLine[] {
    const lines: RecentLine[] = [];
    for (const e of this.ctx.all()) {
      if (e.kind === "self" && (except === undefined || e.id !== except)) lines.push({ text: e.text, heard: e.heard, fallback: e.fallback });
    }
    return lines;
  }

  // @spec CTX-GATE-012
  /** The status of a think that ends without a line: muted when muted or paused, speaking while a line plays, else idle. */
  private noLineState(): "muted" | "speaking" | "idle" {
    if (this.control.muted || this.control.paused) return "muted";
    return this.voiceBusy() ? "speaking" : "idle";
  }

  // @spec CTX-GATE-012
  /** The think ends without a line: stop reading, publish no `brain.say`, publish the status of CTX-GATE-012. */
  private async noLine(line: Line): Promise<void> {
    line.exited = true;
    line.ctrl.abort();
    await this.status(this.noLineState());
  }

  // @spec CTX-STREAM-026, CTX-STREAM-028, CTX-REL-013, CTX-REL-015, CTX-STREAM-035, CTX-STREAM-036, CTX-CTRL-008
  /**
   * Close a streamed line once: abort the stream, then publish the closing `brain.clause` (with `cut` when cut short), `through`
   * the last produced clause. Closing may release the line (CTX-REL-006, CTX-REL-007).
   */
  private async closeLine(line: Line, cut?: LineCut): Promise<void> {
    if (line.id === undefined || line.closed) return;
    line.closed = true;
    line.ctrl.abort();
    await this.d.bus.publish("brain.clause", {
      id: line.id, seq: line.lastSeq + 1, text: "", last: true, through: line.lastProduced, ...(cut ? { cut } : {}),
    });
    await this.settle(line.id);
  }

  // @spec CTX-CTRL-008, CTX-CTRL-009, CTX-CTRL-010, CTX-CTRL-011
  /**
   * A mute or pause stops the cortex's own reply lines that are pending: each open streamed reply closes `cut` `muted`, then one
   * `voice.stop` names them with `reason` and they are released. Operator, reflex and foreign lines are not reply lines.
   */
  private async stopOwnLines(reason: "muted" | "paused"): Promise<void> {
    const ids = [...this.pending].filter(([, p]) => p.own !== undefined).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) {
      const p = this.pending.get(id);
      if (p?.own?.streamed && !p.own.line.closed) await this.closeLine(p.own.line, "muted");
    }
    await this.d.bus.publish("voice.stop", { reason, ids });
    for (const id of ids) this.endSpeaking(id);
  }

  // @spec CTX-STREAM-002, CTX-STREAM-003, CTX-STREAM-004, CTX-STREAM-005, CTX-STREAM-012, CTX-STREAM-013, CTX-GATE-013
  /**
   * Reads one reply through `llm.stream` and publishes its line. A `rules` critic is asked about the first clause as it is cut
   * and each clause is checked as it arrives; an `llm` or `http` critic is given the whole reply, checked once, then cut.
   * A think that publishes no line ends through `noLine`.
   */
  private async readReply(messages: ChatMessage[], r: ReplyRequest): Promise<void> {
    const { cfg, llm, critic, log } = this.d;
    // @spec CTX-STREAM-033
    const { clause_min_chars: min, clause_max_chars: max, max_clauses: maxClauses } = cfg.brain.cortex;
    const incremental = critic.kind === "rules";
    const line: Line = { ctrl: new AbortController(), lastSeq: -1, lastProduced: -1, published: [], emotion: "neutral", closed: false, exited: false, stopped: false };
    this.line = line;
    const cursor = { at: 0 };

    // One cut clause: the first is the brain.say, the rest brain.clause; `final` is the reply's last clause. Resolves false
    // when the reply stops (the line closed or a no-line exit).
    const emit = async (text: string, final: boolean, endedAt: number): Promise<boolean> => {
      if (line.closed || line.exited) return false; // a line cortex has ended publishes nothing more
      if (line.id === undefined) {
        let t = text;
        if (incremental) {
          if (t.length < 2) { await this.noLine(line); return false; } // CTX-PROMPT-006
          // @spec CTX-CRITIC-001, CTX-STREAM-016
          const verdict = await critic.run({ text: t, emotion: line.emotion, reason: r.focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
          line.criticEndedAt = Date.now();
          if (!verdict.ok) { log.info({ note: verdict.note, text: t }, "critic vetoed"); await this.noLine(line); return false; } // CTX-CRITIC-002
          if (verdict.text) {
            // A rewrite is parsed like a reply; the critic's emotion tag and gesture are ignored, the model's gesture is kept.
            t = parseReply(verdict.text).text;
            log.info({ to: t }, "critic rewrote");
            if (t.length < 2) { await this.noLine(line); return false; } // CTX-CRITIC-008
          }
          if (verdict.emotion) line.emotion = verdict.emotion;
          // @spec CTX-REPEAT-010, CTX-REPEAT-011
          if (this.repeatHit(t)) { await this.noLine(line); return false; }
        }
        // @spec CTX-GATE-005, CTX-GATE-006
        if (this.control.muted || this.control.paused) { await this.noLine(line); return false; }
        if (this.voiceBusy()) { log.info({ text: t }, "dropped: something else spoke while thinking"); await this.noLine(line); return false; }

        const id = randomUUID();
        line.id = id;
        line.lastSeq = 0;
        line.lastProduced = 0;
        line.published.push(t);
        // pending from its brain.say until it is released (CTX-SAY-004); a streamed line is released by its players (CTX-REL-*)
        this.startSpeaking(id, { line, streamed: !final });
        // @spec CTX-SAY-007
        const timing: Timing = {
          ...(r.focusedAt === undefined ? {} : { focusedAt: r.focusedAt }),
          llmStartedAt: r.t0,
          llmEndedAt: endedAt,
          ...(line.criticEndedAt === undefined ? {} : { criticEndedAt: line.criticEndedAt }),
          ...r.focus.timing,
        };
        // @spec CTX-SAY-001, CTX-STREAM-017, CTX-STREAM-019
        await this.d.bus.publish("brain.say", {
          id, text: t, emotion: line.emotion, gesture: line.gesture, reason: r.focus.reason,
          ...propagatedFlags(r.focus), timing, ...(final ? {} : { more: true as const }),
        });
        r.onSaid();
        // @spec CTX-STREAM-018
        await this.status("speaking", t);
        if (final) { line.closed = true; await this.settle(id); }
        return !final;
      }

      // A later clause: the length cut, the repetition check on the reply so far, the mute and busy re-check, then publish.
      // @spec CTX-STREAM-024, CTX-STREAM-025
      if (line.lastSeq + 1 >= maxClauses) { await this.closeLine(line, "length"); return false; }
      // @spec CTX-STREAM-021, CTX-REPEAT-001, CTX-REPEAT-002
      if (incremental && this.repeatHit([...line.published, text].join(" "), line.id)) { await this.closeLine(line, "repeat"); return false; }
      // @spec CTX-STREAM-022, CTX-STREAM-023
      if (this.control.muted || this.control.paused) { await this.closeLine(line, "muted"); return false; }
      if (this.voiceBusy(line.id)) { await this.closeLine(line, "busy"); return false; }
      const seq = line.lastSeq + 1;
      // A clause published while none is outstanding is progress (CTX-REL-001): the valve restarts.
      const p = this.pending.get(line.id);
      const wasOutstanding = p !== undefined && this.outstanding(p);
      line.lastSeq = seq;
      line.lastProduced = seq;
      line.published.push(text);
      // @spec CTX-STREAM-020, CTX-STREAM-027
      await this.d.bus.publish("brain.clause", { id: line.id, seq, text, ...(final ? { last: true as const, through: seq } : {}) });
      if (p && this.pending.get(line.id) === p) this.armValve(line.id, p, !wasOutstanding);
      if (final) { line.closed = true; await this.settle(line.id); }
      return !final;
    };

    // Cut every clause the body allows; with `final` the rest is the last clause. Resolves false when the reply stopped.
    const pump = async (body: string, final: boolean, endedAt: number): Promise<boolean> => {
      for (;;) {
        const rest = body.slice(cursor.at);
        if (!rest) return true;
        const cut = cutClause(rest, min, max, final, literal);
        if (!cut) return true;
        const piece = rest.slice(0, cut.end);
        cursor.at += cut.next;
        while (cursor.at < body.length && /\s/.test(body[cursor.at]!)) cursor.at++;
        const text = cleanClause(piece, literal);
        if (!hasWord(text)) continue; // CTX-STREAM-015
        if (!(await emit(text, final && cursor.at >= body.length, incremental ? Date.now() : endedAt))) return false;
      }
    };

    let raw = "";
    let head: Head | undefined;
    let literal = false;
    let finish: ChatResult["finish"] | undefined;
    let streamErr: unknown;
    // @spec CTX-PROMPT-008: the transcript the messages carry is checked against the provider stop strings by the transcript-stops test.
    const stream = llm.stream(messages, { signal: line.ctrl.signal }); // CTX-STREAM-003
    const it = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Only reading the stream tolerates an abort: an error raised by publishing reaches the caller.
        let next: IteratorResult<ChatEvent>;
        try {
          next = await it.next();
        } catch (err) {
          if (!line.ctrl.signal.aborted) streamErr = err;
          break;
        }
        if (next.done) break;
        const ev = next.value;
        if (ev.type === "done") { finish = ev.result.finish; continue; }
        if (ev.type !== "text") continue;
        if (line.ctrl.signal.aborted) break;
        raw += ev.delta;
        const trimmed = raw.trimStart();
        const nl = trimmed.indexOf("\n");
        const ended = nl >= 0; // CTX-STREAM-004: the first newline ends the reply
        if (ended) raw = trimmed.slice(0, nl);
        const h = readHead(raw, ended, cfg.cohost.name);
        if (h) { head = h; literal = h.literal === true; line.emotion = h.emotion; line.gesture = h.gesture; }
        if (ended) { line.ctrl.abort(); break; }
        if (incremental && head && !(await pump(head.body, false, 0))) break;
      }
      if (streamErr !== undefined) {
        // A stream that fails before its first clause is the think's error (its catch below). After one, the line closes `failed`:
        // no fallback line and no repair call (CTX-STREAM-031).
        // @spec CTX-STREAM-031
        if (line.id === undefined) throw streamErr;
        log.warn({ err: streamErr, reason: r.focus.reason }, "the model stream failed after a clause; the line closes failed");
        await this.closeLine(line, "failed");
        return;
      }
      await it.return?.(undefined);
      if (!line.closed && !line.exited) {
        if (finish === "refusal") {
          // @spec CTX-STREAM-032, CTX-GATE-012: a refusal ends the reply; its held tail is not published.
          if (line.id !== undefined) await this.closeLine(line);
          else await this.noLine(line);
        } else if (incremental) {
          head = readHead(raw, true, cfg.cohost.name) ?? { emotion: "neutral", body: "" };
          literal = head.literal === true;
          line.emotion = head.emotion;
          line.gesture = head.gesture;
          await pump(head.body, true, 0);
        } else {
          // @spec CTX-PROMPT-005, CTX-CRITIC-001, CTX-REPEAT-001, CTX-PROMPT-006
          const inHand = Date.now();
          const whole = parseReply(raw);
          line.emotion = whole.emotion;
          line.gesture = whole.gesture;
          if (whole.text.length < 2) {
            await this.noLine(line);
          } else {
            const verdict = await critic.run({ text: whole.text, emotion: whole.emotion, reason: r.focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
            line.criticEndedAt = Date.now();
            if (!verdict.ok) {
              log.info({ note: verdict.note, text: whole.text }, "critic vetoed");
              await this.noLine(line);
            } else {
              let text = whole.text;
              if (verdict.text) { text = parseReply(verdict.text).text; log.info({ from: whole.text, to: text }, "critic rewrote"); }
              if (verdict.emotion) line.emotion = verdict.emotion;
              if (text.length < 2) await this.noLine(line); // CTX-CRITIC-008
              else if (this.repeatHit(text)) await this.noLine(line);
              else await pump(text, true, inHand);
            }
          }
        }
        // Nothing left to say: the line closes with an empty closing clause, or a think with no line takes its no-line exit.
        if (!line.closed && !line.exited) {
          if (line.id !== undefined) await this.closeLine(line);
          else await this.noLine(line);
        }
      }
      if (!line.stopped) log.info({ ms: Date.now() - r.t0, reason: r.focus.reason, memories: r.memories }, "llm reply");
    } catch (err) {
      // A publish that failed is not a stopped stream: the line closes if it can, and the error reaches think()'s catch.
      if (line.id !== undefined && !line.closed) await this.closeLine(line).catch(() => {});
      throw err;
    } finally {
      this.line = undefined;
      log.debug({ raw }, "llm reply text"); // raw text can echo chat and is not yet through the critic
    }
  }

  /** The repetition check on `reply` against the recent lines; a hit is logged with its similarity and the line it matched (CTX-REPEAT-010). */
  private repeatHit(reply: string, except?: string): boolean {
    const m = repeatMatch(reply, this.recentSelf(except), this.d.cfg.brain.cortex.repeat_similarity);
    if (m) this.d.log.info({ score: m.score, match: m.said, text: reply }, "repeat withheld");
    return m !== undefined;
  }

  /** `status` for paths with nothing else to do: a failed publish is logged, never raised (CTX-GATE-008). */
  private statusLogged(state: "idle" | "thinking" | "speaking" | "muted", detail?: string): Promise<void> {
    return this.status(state, detail).catch((err) => this.d.log.error({ err, state }, "brain.status publish failed"));
  }

  async status(state: "idle" | "thinking" | "speaking" | "muted", detail?: string): Promise<void> {
    await this.d.bus.publish("brain.status", { state, detail });
  }

  // @spec CTX-GATE-004
  /** Some line is still pending on the voice (with the stuck-sink safety valve per line). A streamed line's valve is timed by its clauses (CTX-REL-001). */
  private voiceBusy(except?: string): boolean {
    const limit = this.d.cfg.brain.cortex.speaking_timeout_ms;
    for (const [id, p] of this.pending) if (!p.own?.streamed && performance.now() - p.since > limit) this.endSpeaking(id); // monotonic: a stepped wall clock must not move the valve
    for (const id of this.pending.keys()) if (id !== except) return true;
    return false;
  }

  /**
   * A line began playing: remember it and arm its valve. `own` marks a reply line of the cortex's own think, with its line object
   * and whether it is streamed. Lines already pending stay pending.
   */
  private startSpeaking(id: string, own?: { line: Line; streamed: boolean }): void {
    this.endSpeaking(id); // the same id again restarts its valve
    const p: Pending = {
      since: performance.now(), windowEnded: false, players: new Map(), failureRead: false, errorZero: false,
      readBack: own?.streamed !== true, marks: [], ...(own ? { own } : {}),
    };
    this.pending.set(id, p);
    if (own?.streamed) { this.armValve(id, p, true); return; } // CTX-GATE-004, CTX-REL-001
    // @spec CTX-GATE-009
    const timer = setTimeout(() => {
      void this.release(id).catch((err) => this.d.log.error({ err }, "brain.status publish failed"));
    }, this.d.cfg.brain.cortex.speaking_timeout_ms);
    timer.unref();
    p.timer = timer;
  }

  /** Service shutdown: release the valves, end a think that has published no clause, and close an open streamed line as `stopped`, once (CTX-STREAM-037). */
  // @spec CTX-STREAM-037
  async stop(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.endSpeaking(id);
    const line = this.line;
    if (!line) return;
    line.stopped = true;
    if (line.id === undefined) { line.exited = true; line.ctrl.abort(); return; } // nothing published: no brain.say after stop
    await this.closeLine(line, "stopped").catch((err) => this.d.log.error({ err }, "closing the streamed line failed"));

  }

  /** A line ended (its release, its valve or a stop); false when it was not pending. Clears its timers. */
  private endSpeaking(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    clearTimeout(p.window);
    this.pending.delete(id);
    return true;
  }

  /** A line ended: publish the status it leaves, or owe it to the end of the think in flight (CTX-EVT-005, CTX-REL-009, CTX-REL-010). */
  private async endedLine(): Promise<void> {
    if (this.pending.size > 0) return;
    if (this.thinking) { this.statusOwed = true; return; }
    await this.status(this.control.muted || this.control.paused ? "muted" : "idle");
  }

  /** Release a pending line as its rule says: end it, then report the status it leaves. */
  private async release(id: string): Promise<void> {
    if (this.endSpeaking(id)) await this.endedLine();
  }

  /** Every player of a streamed line has completed its last produced clause; false with no player (CTX-REL-003, CTX-REL-006). */
  private allCompleted(p: Pending): boolean {
    if (!p.own || p.players.size === 0) return false;
    const last = p.own.line.lastProduced;
    return [...p.players.values()].every((pl) => pl.completedAll || pl.done.has(last));
  }

  /** A clause is outstanding until every player has completed the line (CTX-REL-001). */
  private outstanding(p: Pending): boolean {
    return !this.allCompleted(p);
  }

  // @spec CTX-REL-012
  /** The failure condition: a failure read and the claim window over, with every player ended; with no player, the failure and the window (CTX-REL-012). */
  private failureHolds(p: Pending): boolean {
    return p.failureRead && p.windowEnded && [...p.players.values()].every((pl) => pl.ended);
  }

  // @spec CTX-REL-011
  /** Start the claim window of a streamed line: its end re-judges the failure condition. */
  private startWindow(id: string, p: Pending): void {
    const timer = setTimeout(() => {
      p.window = undefined;
      p.windowEnded = true;
      void this.settle(id).catch((err) => this.d.log.error({ err }, "claim window release failed"));
    }, CLAIM_WINDOW_MS);
    timer.unref();
    p.window = timer;
  }

  // @spec CTX-REL-001, CTX-GATE-004, CTX-GATE-009
  /**
   * (Re)arm the valve of a streamed line while a clause is outstanding; with none outstanding it is off. `restart` false keeps a
   * running valve (a clause published while one is outstanding is not progress).
   */
  private armValve(id: string, p: Pending, restart: boolean): void {
    if (!p.own?.streamed) return;
    if (!this.outstanding(p)) { clearTimeout(p.timer); p.timer = undefined; return; }
    if (!restart && p.timer) return;
    clearTimeout(p.timer);
    const timer = setTimeout(() => {
      void this.onValve(id).catch((err) => this.d.log.error({ err }, "valve release failed"));
    }, this.d.cfg.brain.cortex.speaking_timeout_ms);
    timer.unref();
    p.timer = timer;
  }

  // @spec CTX-GATE-004, CTX-GATE-009, CTX-STREAM-036
  /** The valve ran out with a clause outstanding and no progress: an open streamed reply closes `timeout`, then the line is released. */
  private async onValve(id: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p?.own?.streamed) return;
    if (!p.own.line.closed) await this.closeLine(p.own.line, "timeout");
    await this.release(id);
  }

  // @spec CTX-REL-003, CTX-REL-004, CTX-REL-005, CTX-REL-008, CTX-REL-015, CTX-FALL-012, CTX-REL-001
  /** A `voice.done` for a streamed line: a player's completion, an `error` final's lowered clause, then the release rules. */
  private async streamDone(d: BusEvent<"voice.done">["data"], p: Pending): Promise<void> {
    const line = p.own!.line;
    if (d.final) p.failureRead = true;
    if (d.sink === "error" && d.final) {
      // Voice could not synthesize clause `seq`: no audio exists for it, so the reply is not played with a hole (CTX-REL-015).
      if (d.seq === 0) { p.errorZero = true; this.ctx.markHeard(d.id, ""); } // CTX-FALL-012
      line.lastProduced = Math.max(0, Math.min(line.lastProduced, d.seq - 1));
      if (!line.closed) await this.closeLine(line, "failed");
    } else {
      const pl = p.players.get(d.sink);
      if (pl) {
        if (d.final || d.interrupted) pl.completedAll = true;
        if (d.final) pl.ended = true;
        if (!d.final && !d.interrupted) pl.done.add(d.seq);
      }
    }
    if (this.pending.get(d.id) === p) this.armValve(d.id, p, true);
    await this.settle(d.id);
  }

  // @spec CTX-REL-006, CTX-REL-007, CTX-REL-013
  /** The release and failure rules of a streamed line, judged again after each change of its state. */
  private async settle(id: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p?.own?.streamed) return;
    const line = p.own.line;
    if (!line.closed && this.failureHolds(p)) await this.closeLine(line, "failed"); // CTX-REL-013
    if (this.pending.get(id) !== p || !line.closed) return;
    const completed = p.players.size > 0 && this.allCompleted(p); // CTX-REL-006
    const nobodyPlayed = p.players.size === 0 && (this.failureHolds(p) || p.errorZero); // CTX-REL-007
    if (completed || nobodyPlayed) await this.release(id);
  }

  // @spec CTX-FALL-008, CTX-FALL-009, CTX-FALL-011, CTX-FALL-012, CTX-REL-016
  /**
   * Apply failed sinks' marks to the working-memory line: a fallback marks it from the failed `seq` and sets the glitch; without one the
   * clauses before the `seq` are its heard text. Nothing applies when another sink played the line (CTX-FALL-009).
   */
  private applyMarks(id: string, p: Pending | undefined, marks: Mark[]): void {
    for (const m of marks) {
      if (p && [...p.players.keys()].some((sink) => sink !== m.sink)) continue; // heard on another output
      const entry = this.ctx.all().find((e) => e.kind === "self" && e.id === id);
      if (m.fallback !== undefined) {
        if (entry?.kind !== "self" || !this.ctx.markFallback(id, m.fallback, m.seq)) continue;
        const partial = m.seq > 0 && p?.own !== undefined;
        const intended = partial ? p.own!.line.published.slice(m.seq).join(" ") : entry.text;
        this.glitch = { id, intended, fallback: m.fallback, ...(partial ? { partial: true } : {}) };
      } else {
        const heard = m.seq > 0 && p?.own !== undefined ? p.own.line.published.slice(0, m.seq).join(" ") : "";
        this.ctx.markHeard(id, heard);
      }
    }
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

  // @spec CTX-NOTES-001, CTX-NOTES-002, CTX-NOTES-003, CTX-NOTES-007, CTX-NOTES-011
  /** Ask the memory region for the notes of the people in this conversation; none if it is silent or the publish fails. Nothing is kept afterwards. */
  private fetchNotes(focus: Focus): Promise<People> {
    const { cfg, bus, log } = this.d;
    const viewers = notesViewers(focus, this.ctx.all());
    if (!viewers.length) return Promise.resolve([]);
    const id = randomUUID();
    return new Promise<People>((resolve) => {
      const timer = setTimeout(() => { this.pendingNotes.delete(id); log.warn("memory region did not answer the viewer-notes request in time"); resolve([]); }, cfg.brain.cortex.recall_timeout_ms);
      this.pendingNotes.set(id, (p) => { clearTimeout(timer); this.pendingNotes.delete(id); resolve(matchNotes(p, viewers)); });
      void bus.publish("memory.notes.request", { id, viewers: viewers as [ViewerRef, ...ViewerRef[]] }).catch(() => {
        clearTimeout(timer); this.pendingNotes.delete(id); resolve([]);
      });
    });
  }

  // @spec CTX-SAY-001
  private async say(text: string, emotion: Emotion, gesture: string | undefined, reason: string, flags: InjectionFlags & { route?: string[]; timing?: Timing } = {}, onPublished?: () => void) {
    const id = randomUUID();
    this.startSpeaking(id);
    await this.d.bus.publish("brain.say", { id, text, emotion, gesture, reason, ...flags });
    onPublished?.();
    await this.status("speaking", text);
  }
}
