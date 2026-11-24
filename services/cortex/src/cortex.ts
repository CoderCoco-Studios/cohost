import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher, Timing } from "@cohost/bus";
import type { Config, Emotion, Logger } from "@cohost/config";
import type { ChatEvent, ChatMessage, ChatProvider, ChatRequest, ChatResult, ToolCall } from "@cohost/llm";
import type { Module } from "@cohost/modules";
import { controlFor, type Heartbeat } from "@cohost/shared";
import { normalizeKey, quoteUntrusted, speakerLabel, viewerKey } from "@cohost/shared/untrusted";
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
  /** A detail that stands whatever the pause or tool state (the unprobed-ping note, CTX-HEALTH-004); composed with the others. */
  standingDetail?: string;
}

/** The line the cortex speaks while a tool answers and no clause is out (CTX-TOOL-031). */
const SORRY = "Sorry, I couldn't find that out.";

/** The heartbeat detail while a call is treated as cut off by the token cap (CTX-HEALTH-009). */
const CUT_OFF_DETAIL = "a tool call was cut off by tools.reply.max_tokens";

/** A tool of the catalog as the cortex reads it (BUS-EVT-046). */
type ToolDef = BusEvent<"tool.catalog">["data"]["tools"][number];
/** The outcome of a `tool.result` as cortex relays it (BUS-EVT-044). */
type Result = BusEvent<"tool.result">["data"];
/** Who asked for a reply's tools (CTX-TOOL-002). */
type Origin = BusEvent<"tool.request">["data"]["origin"];
/** How one request's wait ended: its result and when it arrived, no answer in time, or abandoned by a mute, pause or stop. */
type WaitOutcome = { kind: "result"; result: Result; at: number } | { kind: "timeout" } | { kind: "abandoned" };

// @spec CTX-TOOL-002
/** The origin of a reply from its focus kind (injected or not), and whether the owner's source list names its speech source (CTX-TOOL-014). */
function originOf(focus: Focus, owner: "all" | string[]): { origin: Origin; listed: boolean } {
  const injected = focus.injected === true;
  const kind = focus.focus?.kind;
  if (kind === "speech") {
    if (owner === "all") return { origin: "speech", listed: false };
    const source = focus.focus?.source;
    const named = source !== undefined && owner.includes(source);
    return { origin: named ? "speech" : "guest", listed: named && !injected };
  }
  if (kind === "chat") return { origin: "chat", listed: false };
  if (kind === "vision") return { origin: "vision", listed: false };
  if (kind === "reminder") return { origin: "reminder", listed: false };
  return { origin: "idle", listed: false };
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
  /** The `seq` of the last output that reached the bus (-1 before it): where a stop mid-release closes the line through (CTX-STREAM-037). */
  lastOut: number;
  /** The reply's end reached the bus (a `last` output or the closing clause): nothing is left to close. */
  outClosed?: boolean;
  /** Why a release in flight was halted: the cut its line closes with (CTX-STREAM-037, CTX-CTRL-008). */
  haltCut?: LineCut;
  emotion: Emotion;
  gesture?: string;
  criticEndedAt?: number;
  /** The closing clause (or the last clause, marked `last`) is out: nothing more is published for the line. */
  closed: boolean;
  /** The think ended without a line. */
  exited: boolean;
  /** `stop()` ended the line or the think: nothing more is published, and the think's end is not logged as a reply. */
  stopped: boolean;
  /** Clauses counted toward `max_clauses` (CTX-TOOL-009): the filler and built-in line count under `rules` only. */
  counted: number;
  /** The clauses of the model's own text, for the repetition check across rounds; the filler and built-in line are not in it (CTX-TOOL-025). */
  checked: string[];
  /** The line's emotion and gesture are fixed by its first clause (CTX-TOOL-008). */
  emotionFixed: boolean;
  /** The critic has been asked about the first model clause (CTX-STREAM-012). */
  criticAsked: boolean;
  /** A tool wait has run in this reply (CTX-SAY-003, CTX-TOOL-031). */
  waited: boolean;
  /** A tool wait is running: the valve holds (CTX-TOOL-023). */
  waiting: boolean;
  /** The held think this reply belongs to, while it is held (CTX-PROV-003). */
  hold?: Held;
}

/** One output of a reply before it is published: the first clause is the `brain.say`, the rest `brain.clause`s (CTX-STREAM-017, CTX-STREAM-020). */
interface Out {
  seq: number;
  text: string;
  last: boolean;
  kind: "normal" | "filler" | "builtin";
  /** When the model stream had produced the clause (the first clause's `llmEndedAt`). */
  llmEndedAt?: number;
  criticEndedAt?: number;
  /** The closing clause: empty text, `through` the last clause, and `cut` when the reply was cut short (CTX-STREAM-024 to 026). */
  closing?: true;
  through?: number;
  cut?: LineCut;
}

/** A provisional think from its start until it is released or ended (cortex-design.md, Provisional think; CTX-PROV-001 to 038). */
interface Held {
  utteranceId?: string;
  seq?: number;
  /** The early text of the provisional focus; a confirmation with the same text is its confirmation (CTX-PROV-020). */
  text: string;
  speaker: string;
  reason: string;
  /** The reply's line, once its reading has begun. */
  line?: Line;
  /** Output held in order and not yet published (CTX-PROV-006). */
  queue: Out[];
  /** When the think first became ready or parked, whichever came first (CTX-PROV-030). */
  heldAt?: number;
  /** The think waits at a tool call (CTX-PROV-009). */
  parked: boolean;
  /** The reply ended without a line, held as such (CTX-PROV-008). */
  none: boolean;
  /** Released by a confirmation: the think is an ordinary think from here (CTX-PROV-035). */
  released: boolean;
  /** Ended without a release (CTX-PROV-016). */
  ended: boolean;
  /** The release's timing members: the final's, and `confirmedAt` for a confirmation (CTX-PROV-019). */
  tail: Timing;
  flags: InjectionFlags;
  interjected?: true;
  timer?: ReturnType<typeof setTimeout>;
  /** Resolved when the think is released or ended. */
  settled: Promise<void>;
  resolve: () => void;
  /** Publishes the queued output and marks the think released; set by readReply. */
  drain: () => Promise<void>;
  /** The drain is publishing: a stop leaves the line's close to the drain (CTX-STREAM-037). */
  draining?: boolean;
  /** A publish that failed during the release; think() rethrows it. */
  error?: unknown;
}

/** An `attention.resolve`, and its confirm variant (CTX-PROV-019). */
type Confirm = Extract<BusEvent<"attention.resolve">["data"], { outcome: "confirm" }>;
type Resolve = BusEvent<"attention.resolve">["data"];

/** The members of a final's timing that a released reply takes (CTX-PROV-019): the close, the end and the hearing of the speech. */
function finalTiming(t: Timing | undefined): Timing {
  const out: Timing = {};
  if (t?.audioEndedAt !== undefined) out.audioEndedAt = t.audioEndedAt;
  if (t?.closedAt !== undefined) out.closedAt = t.closedAt;
  if (t?.heardAt !== undefined) out.heardAt = t.heardAt;
  return out;
}

/** The ordinary focus a confirm without a held think stands for (CTX-PROV-023). */
function focusOf(d: Confirm): Focus {
  return { reason: d.reason ?? "", score: d.score ?? 0, focus: d.focus, timing: d.timing, injected: d.injected, remember: d.remember } as Focus;
}

/** Why a streamed line was closed short (`cut` of its closing `brain.clause`). */
type LineCut = NonNullable<BusEvent<"brain.clause">["data"]["cut"]>;

/** The claim window a streamed line's players have to start it (VOICE-SINK-002, CTX-REL-011). */
const CLAIM_WINDOW_MS = 1500;

/** Released lines kept for late marks and players (see `retired`). */
const RETIRED_MAX = 64;

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

/** The tools a think offers and who asked for them (CTX-TOOL-001 to CTX-TOOL-003). */
interface Offer { tools: ToolDef[]; origin: Origin; listed: boolean }

/** What a think needs to read its reply and publish the line. */
interface ReplyRequest extends Offer {
  focus: Focus;
  /** The reply's `injected` flag (CTX-TOOL-014). */
  injected: boolean;
  focusedAt?: number;
  /** When the think's LLM request began (`timing.llmStartedAt`). */
  t0: number;
  memories: number;
  onSaid: () => void;
  /** The held think of a provisional focus (CTX-PROV-001); absent for an ordinary think. */
  hold?: Held;
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
  /**
   * Lines released recently, by id, bounded (RETIRED_MAX): kept until their closing clause is read back, so a `voice.failed`
   * queued before the release still applies its mark, and a late failure still judges who played (CTX-REL-016, CTX-FALL-009).
   */
  private retired = new Map<string, Pending>();
  /** A status a line's end owes the end of the think in flight, which publishes it (CTX-REL-009, CTX-EVT-005). */
  private statusOwed = false;
  private mood: Mood | undefined;
  /** Who-is-this notes from the memory region, keyed by `viewerKey` so one viewer's framing never lands on another's reply (CTX-VIEWER-002). */
  private viewerNotes = new Map<string, string>();
  /** A fallback line played in place of this one: kept until a reply that carried its hint is published (CTX-FALL-003, CTX-FALL-005). `partial`: it began after clause 0 (CTX-FALL-010). */
  private glitch: { id: string; intended: string; fallback: string; partial?: boolean } | undefined;
  private pendingRecall = new Map<string, (m: Recalled) => void>();
  private pendingNotes = new Map<string, (p: People) => void>();
  /** The latest `tool.catalog` and when it arrived (CTX-TOOL-001). */
  private catalog?: { at: number; intervalMs: number; tools: ToolDef[] };
  /** The results a running tool wait is waiting for, by request id (CTX-TOOL-021). */
  private awaiting = new Map<string, (o: WaitOutcome) => void>();
  /** The filler line used last (CTX-TOOL-024). */
  private lastFiller?: string;
  /** A call was cut off by the token cap and no later tool round has been clean (CTX-HEALTH-009). */
  private cutOff = false;
  /** The standing detail `control` sets (`paused`). */
  private pausedDetail?: string;
  /** The provisional think held now, if any (CTX-PROV-001). */
  private held?: Held;
  /** Identifies the think whose `thinking` flag is set, so a think that was ended never clears a later one's flag. */
  private turn?: object;
  /** The utterance and seq of the held think last released: a redelivered confirm for it is ignored (CTX-PROV-023). */
  private lastReleased?: { utteranceId?: string; seq?: number };
  /** The held think whose release is in flight, from its start until its end (CTX-PROV-038). */
  private releasing?: Held;
  /** Set by `stop()`: no think starts after it (CTX-STREAM-037). */
  private stopped = false;

  constructor(private d: CortexDeps) {
    this.ctx = Context.forBrain(d.cfg.brain, d.cfg.viewer_text);
    this.personality = d.loadPersonality();
    this.control = controlFor("cortex", {
      // @spec CTX-CTRL-002, CTX-CTRL-008, CTX-CTRL-009
      // @spec CTX-PROV-012
      pause: async () => { await this.dropHeld(false); await this.stopOwnLines("paused"); await this.status("muted", "paused"); },
      resume: () => this.status(this.control.muted ? "muted" : "idle"),
      // @spec CTX-CTRL-003, CTX-CTRL-008, CTX-CTRL-009
      // @spec CTX-PROV-012
      mute: async () => { await this.dropHeld(false); await this.stopOwnLines("muted"); await this.status("muted"); },
      unmute: () => this.status(this.control.paused ? "muted" : "idle"),
      // @spec CTX-CTRL-004
      // @spec CTX-PROV-013
      forget_context: async () => { await this.dropHeld(true); this.ctx.clear(); this.viewerNotes.clear(); this.glitch = undefined; /* @spec CTX-FALL-005 */ },
      // @spec CTX-CTRL-005
      reload_personality: () => { this.personality = d.loadPersonality(); d.log.info("personality reloaded"); },
      // @spec CTX-CTRL-006, CTX-CTRL-007, CTX-INJ-002
      say: async (c) => {
        if (!c.text) return;
        await this.dropHeld(false); // a line of the cortex's own ends a held think (CTX-PROV-027); the line's own status follows
        await this.say(c.text, "neutral", undefined, "operator", c.route ? { route: c.route } : {});
      },
    }, { log: d.log, heartbeat: { setDetail: (detail) => { this.pausedDetail = detail; this.publishDetail(); } } });
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
        const p = d.last ? (this.pending.get(d.id) ?? this.retired.get(d.id)) : undefined;
        if (p) { p.readBack = true; const marks = p.marks; p.marks = []; this.applyMarks(d.id, p, marks); }
        break;
      }
      // @spec CTX-REL-001, CTX-REL-011
      case "voice.utterance": {
        const d = ev.data as BusEvent<"voice.utterance">["data"];
        const p = this.pending.get(d.id);
        if (!p) break;
        if (p.own?.streamed && !p.window && !p.windowEnded) this.startWindow(d.id, p);
        this.progress();
        break;
      }
      // @spec CTX-REL-002, CTX-REL-001
      case "voice.playing": {
        const d = ev.data as BusEvent<"voice.playing">["data"];
        const p = this.pending.get(d.id);
        if (!p) break;
        if (!p.players.has(d.sink)) p.players.set(d.sink, { done: new Set(), completedAll: false, ended: false });
        this.progress();
        break;
      }
      // @spec CTX-EVT-005, CTX-STREAM-001
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
        if (p.own?.streamed) await this.streamDone(d, p);
        else if (this.endSpeaking(d.id)) await this.endedLine();
        this.progress();
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
        // A stop that names the reply's line, or names none, ends a tool wait too (CTX-TOOL-038); with no line out, it leaves the think alone.
        if (this.line?.id !== undefined && (!ids || ids.includes(this.line.id))) this.abandonWait();
        break;
      }
      // A failed sink plays no more of its line. Its marks apply now, or once the closing clause is read back (CTX-REL-016).
      // @spec CTX-EVT-008, CTX-FALL-002, CTX-FALL-003, CTX-FALL-007, CTX-REL-012, CTX-REL-014
      case "voice.failed": {
        const d = ev.data as BusEvent<"voice.failed">["data"];
        const live = this.pending.get(d.id);
        if (live) {
          live.failureRead = true;
          const pl = live.players.get(d.sink);
          if (pl) pl.ended = true;
        }
        const p = live ?? this.retired.get(d.id);
        const mark: Mark = { sink: d.sink, seq: d.seq, ...(d.fallback ? { fallback: d.fallback.text } : {}) };
        if (p && !p.readBack) p.marks.push(mark);
        else this.applyMarks(d.id, p, [mark]);
        if (live?.own?.streamed) await this.settle(d.id);
        break;
      }
      // @spec CTX-EVT-006
      case "attention.focus": {
        const f = ev.data as Focus;
        // A provisional focus starts a held think only when none is held and no ordinary think is in flight (CTX-PROV-026).
        if (f.provisional === true) {
          if (this.held === undefined && !this.thinking) this.think(f, ev.ts).catch((err) => this.d.log.error({ err }, "think rejected"));
          break;
        }
        // The same speech, by the same utterance, confirms a held think (CTX-PROV-020).
        const h = this.held;
        if (h !== undefined && f.focus?.kind === "speech" && h.utteranceId !== undefined && f.utteranceId === h.utteranceId && f.focus.text === h.text) {
          await this.releaseHeld(h, { tail: { ...finalTiming(f.timing), confirmedAt: Date.now() }, flags: propagatedFlags(f) });
          break;
        }
        // Don't await: the LLM call must not block the subscription loop, or the
        // memory reply we're waiting on could never be delivered.
        this.think(f, ev.ts).catch((err) => this.d.log.error({ err }, "think rejected")); // @spec CTX-GATE-008
        break;
      }
      // @spec CTX-EVT-001, CTX-PROV-011, CTX-PROV-019, CTX-INTJ-001
      case "attention.resolve":
        await this.onResolve(ev.data as Resolve, ev.ts);
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
      // The latest catalog and when it came: current for three intervals (CTX-TOOL-001, CTX-HEALTH-008).
      // @spec CTX-TOOL-001
      case "tool.catalog": {
        const d = ev.data as BusEvent<"tool.catalog">["data"];
        this.catalog = { at: Date.now(), intervalMs: d.intervalMs, tools: d.tools };
        break;
      }
      // @spec CTX-TOOL-021
      case "tool.result":
        this.onToolResult(ev.data as Result);
        break;
    }
  }

  // @spec CTX-GATE-007, CTX-SAY-002, CTX-SAY-003
  // @spec CTX-SAY-006, CTX-SAY-007, CTX-SAY-008
  /** `focusedAt` is the `attention.focus` envelope `ts`; a direct call without one leaves that stamp off. */
  async think(focus: Focus, focusedAt?: number): Promise<void> {
    const { cfg, log } = this.d;
    if (this.stopped) return; // a stopped cortex starts no think (CTX-STREAM-037)
    // An ordinary focus replaces a held think as an ordinary one would (CTX-PROV-015, CTX-PROV-018): nothing is published for the ended think.
    if (focus.provisional !== true && this.held !== undefined) await this.endHeld(this.held, { status: false });
    // Salience assumes we're busy once it fires, so every path out of here reports a status.
    // @spec CTX-GATE-001
    if (this.thinking) { await this.statusLogged("thinking", focus.reason); return; }
    // @spec CTX-GATE-002
    if (this.control.muted || this.control.paused) { await this.statusLogged("muted"); return; } // @spec CTX-GATE-008
    // @spec CTX-GATE-003, CTX-SAY-004
    if (this.voiceBusy()) { await this.statusLogged("speaking"); return; }

    const turn = {};
    this.turn = turn;
    this.thinking = true; // the try/finally below always clears it, even if a status publish fails
    let hold: Held | undefined;
    try {
      // A provisional focus holds its think from here, so the hold limit covers the recall too (CTX-PROV-010).
      if (focus.provisional === true) hold = this.openHold(focus);
      // The prompt of a provisional think is built from the window as it stood now, with the early text as a transient `[voice]` line
      // only for speech (CTX-PROV-005): events that reach the window during the recall wait or the hold stay out of it.
      const early = hold !== undefined && focus.focus?.kind === "speech" && focus.focus.text ? { speaker: focus.focus.who ?? "", text: focus.focus.text } : undefined;
      const startTranscript = hold !== undefined ? this.ctx.transcript(cfg.cohost.name, early) : undefined;
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
      // The offer is fixed for the think (CTX-TOOL-004): the catalog is read once, here.
      const offer = this.offerFor(focus);
      // @spec CTX-PROV-005: the early text is the prompt's transient last line; the window is not changed.
      const messages = buildMessages({ cfg, personality: this.personality, ctx: this.ctx, memories, focus, mood: this.mood, viewerNote, people, glitch, tools: offer.tools.length > 0, transcript: startTranscript });
      const t0 = Date.now();
      await this.readReply(messages, {
        ...offer,
        focus,
        injected: focus.injected === true,
        focusedAt,
        t0,
        memories: memories.length,
        ...(hold === undefined ? {} : { hold }),
        // The viewer's note and the glitch hint are consumed once this reply's first clause is out (CTX-VIEWER-003, CTX-FALL-005).
        onSaid: () => {
          if (focusKey && this.viewerNotes.get(focusKey) === viewerNote) this.viewerNotes.delete(focusKey);
          if (carried && this.glitch === carried) this.glitch = undefined;
        },
      });
      // A held think is in flight until it is released or ended (CTX-PROV-028).
      if (hold !== undefined) await hold.settled;
      // A publish that failed during the release reaches here as the think's failure (CTX-REL-010).
      if (hold?.error !== undefined) throw hold.error;
    } catch (err) {
      log.error({ err }, "think failed");
      if (hold !== undefined) await this.endHeld(hold, { status: false });
      // A pending line keeps the status (CTX-REL-010): idle only when nothing is pending, and the owed status is taken here so the finally does not repeat it.
      this.statusOwed = false;
      if (this.pending.size === 0) await this.status("idle").catch(() => {});
    } finally {
      // @spec CTX-STREAM-029
      // A think that was ended by a replacement has no flag left to clear: the flag belongs to the think that replaced it.
      if (this.turn === turn) {
        this.thinking = false;
        this.turn = undefined;
        // @spec CTX-REL-009, CTX-REL-010: a line that ended during the think owes its status to the end of the think.
        if (this.statusOwed) {
          this.statusOwed = false;
          if (this.pending.size === 0) await this.statusLogged(this.control.muted || this.control.paused ? "muted" : "idle");
        }
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
    const held = this.heldOf(line);
    if (held !== undefined) { held.none = true; return; } // a held think's no-line result is published on its release or end (CTX-PROV-022)
    await this.status(this.noLineState());
  }

  /** The held think a line belongs to while it is held; undefined for a live line or one already released. */
  private heldOf(line: Line): Held | undefined {
    return line.hold !== undefined && !line.hold.released ? line.hold : undefined;
  }

  /** Whether a line has output: a published clause, or a held one not yet published. */
  private lineOut(line: Line): boolean {
    return line.id !== undefined || (line.hold?.queue.length ?? 0) > 0;
  }

  // @spec CTX-STREAM-026, CTX-STREAM-028, CTX-REL-013, CTX-REL-015, CTX-STREAM-035, CTX-STREAM-036, CTX-CTRL-008
  /**
   * Close a streamed line once: abort the stream, then publish the closing `brain.clause` (with `cut` when cut short), `through`
   * the last produced clause. Closing may release the line (CTX-REL-006, CTX-REL-007).
   */
  private async closeLine(line: Line, cut?: LineCut): Promise<void> {
    if (line.closed) return;
    const held = this.heldOf(line);
    if (held !== undefined) {
      // A held reply's closing clause is queued behind the clauses it holds and published on the release (CTX-PROV-038).
      if (held.queue.length === 0) { await this.noLine(line); return; }
      line.closed = true;
      line.ctrl.abort();
      held.queue.push({ seq: line.lastSeq + 1, text: "", last: true, kind: "normal", closing: true, through: line.lastProduced, ...(cut ? { cut } : {}) });
      return;
    }
    if (line.id === undefined) return;
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
    this.abandonWait(); // a tool wait ends with the mute or pause (CTX-TOOL-037)
    this.haltRelease("muted"); // a release in flight publishes nothing more after a mute or pause (CTX-CTRL-008)
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
  // @spec CTX-TOOL-006, CTX-TOOL-007, CTX-TOOL-008, CTX-TOOL-009, CTX-TOOL-010, CTX-TOOL-011, CTX-TOOL-015, CTX-TOOL-016, CTX-TOOL-017
  // @spec CTX-TOOL-022, CTX-TOOL-023, CTX-TOOL-024, CTX-TOOL-027, CTX-TOOL-031, CTX-TOOL-036, CTX-TOOL-037, CTX-TOOL-038
  /**
   * Reads one reply through `llm.stream`, round by round, and publishes its line. A round that offers tools is read to its end; its
   * text is published as clauses before its calls run, each call's result goes back in a `tool` message, and the next round is asked
   * with the history. A `rules` critic is asked about the first clause and checks each clause as it is cut; an `llm` or `http` critic
   * is given the whole collected reply once, when the last round ends. A think that publishes no line ends through `noLine`.
   */
  private async readReply(messages: ChatMessage[], r: ReplyRequest): Promise<void> {
    const { cfg, llm, critic, log, bus } = this.d;
    if (r.hold?.ended || this.stopped) return; // ended, or stopped, before its reading began (CTX-PROV-016, CTX-STREAM-037)
    // @spec CTX-STREAM-033
    const { clause_min_chars: min, clause_max_chars: max, max_clauses: maxClauses } = cfg.brain.cortex;
    const tcfg = cfg.tools.reply;
    const incremental = critic.kind === "rules";
    const offer = r.tools;
    const offering = offer.length > 0;
    const line: Line = {
      ctrl: new AbortController(), lastSeq: -1, lastProduced: -1, lastOut: -1, published: [], emotion: "neutral", closed: false, exited: false, stopped: false,
      counted: 0, checked: [], emotionFixed: false, criticAsked: false, waited: false, waiting: false,
      ...(r.hold === undefined ? {} : { hold: r.hold }),
    };
    this.line = line;
    if (r.hold !== undefined) r.hold.line = line;
    const convo: ChatMessage[] = [...messages];
    const collected: ReturnType<typeof parseReply>[] = [];
    let raw = "";
    let cursor = { at: 0 };
    let literal = false;
    let round = 0;
    let roundsWithCalls = 0;
    let finalCallRounds = 0;
    let firstReqAt: number | undefined;
    let lastWaitEnd: number | undefined;
    let failed = false;
    let fillerArmed = false;
    let fillerTimer: ReturnType<typeof setTimeout> | undefined;
    const budgetPassed = (): boolean => firstReqAt !== undefined && Date.now() - firstReqAt >= tcfg.budget_ms;
    const counts = (kind: "normal" | "filler" | "builtin"): boolean => incremental || kind === "normal";

    // One clause out. A clause that passes its checks is queued while the think is held (CTX-PROV-006) and published otherwise. `first`
    // is the reply's first clause, the `brain.say`; the rest are `brain.clause`s; `last` marks the reply's final clause. Resolves false
    // when the reply stops (the line closed or a no-line exit). `filler` and `builtin` skip the critic and the repetition check (CTX-TOOL-025, CTX-TOOL-031).
    const emit = async (text: string, last: boolean, endedAt: number, kind: "normal" | "filler" | "builtin" = "normal"): Promise<boolean> => {
      if (line.closed || line.exited) return false; // a line cortex has ended publishes nothing more
      let t = text;
      if (kind === "normal" && incremental && !line.criticAsked) {
        // @spec CTX-STREAM-012, CTX-TOOL-025
        line.criticAsked = true;
        if (t.length < 2) { await this.endOpen(line, "vetoed"); return false; } // CTX-PROMPT-006
        // @spec CTX-CRITIC-001, CTX-STREAM-016
        const verdict = await critic.run({ text: t, emotion: line.emotion, reason: r.focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
        line.criticEndedAt = Date.now();
        if (line.exited) return false; // the think ended while the critic was asked (CTX-PROV-016)
        if (!verdict.ok) { log.info({ note: verdict.note, text: t }, "critic vetoed"); await this.endOpen(line, "vetoed"); return false; } // CTX-CRITIC-002
        if (verdict.text) {
          // A rewrite is parsed like a reply; the critic's emotion tag and gesture are ignored, the model's gesture is kept.
          t = parseReply(verdict.text).text;
          log.info({ to: t }, "critic rewrote");
          if (t.length < 2) { await this.endOpen(line, "vetoed"); return false; } // CTX-CRITIC-008
        }
        if (verdict.emotion && !line.emotionFixed) line.emotion = verdict.emotion;
      }
      const first = !line.emotionFixed;
      if (first) {
        // @spec CTX-REPEAT-010, CTX-REPEAT-011
        if (kind === "normal" && incremental && this.repeatHit(t)) { await this.endOpen(line); return false; }
      } else {
        // @spec CTX-STREAM-024, CTX-STREAM-025, CTX-TOOL-009
        if (counts(kind) && line.counted >= maxClauses) { await this.closeLine(line, "length"); return false; }
        // @spec CTX-STREAM-021, CTX-REPEAT-001, CTX-REPEAT-002, CTX-TOOL-035
        if (kind === "normal" && incremental && this.repeatHit([...line.checked, t].join(" "), line.id)) { await this.closeLine(line, "repeat"); return false; }
      }
      const held = this.heldOf(line);
      // @spec CTX-STREAM-022, CTX-STREAM-023, CTX-TOOL-036, CTX-GATE-005, CTX-GATE-006
      // A held clause is checked again at its release (CTX-PROV-036), so the mute and busy check runs only for a live clause.
      if (held === undefined) {
        if (this.control.muted || this.control.paused) { await (first ? this.noLine(line) : this.closeLine(line, "muted")); return false; }
        if (this.voiceBusy(first ? undefined : line.id)) {
          if (first) { log.info({ text: t }, "dropped: something else spoke while thinking"); await this.noLine(line); }
          else await this.closeLine(line, "busy");
          return false;
        }
      }
      const seq = first ? 0 : line.lastSeq + 1;
      // A clause published while none is outstanding is progress (CTX-REL-001): the valve restarts (publishOut).
      line.lastSeq = seq;
      line.lastProduced = seq;
      line.published.push(t);
      if (kind === "normal") line.checked.push(t);
      if (counts(kind)) line.counted++;
      if (first) {
        line.emotion = kind === "filler" ? "think" : kind === "builtin" ? "confused" : line.emotion;
        line.emotionFixed = true;
      }
      if (last) line.closed = true;
      const out: Out = {
        seq, text: t, last, kind, llmEndedAt: endedAt,
        ...(kind === "normal" && line.criticEndedAt !== undefined ? { criticEndedAt: line.criticEndedAt } : {}),
      };
      // @spec CTX-PROV-003, CTX-PROV-004, CTX-PROV-006, CTX-PROV-030: a held clause is queued, not published, and the think is ready at its first.
      if (held !== undefined) {
        if (held.heldAt === undefined) held.heldAt = Date.now(); // CTX-PROV-030: the think is ready
        held.queue.push(out);
      } else {
        await publishOut(out);
      }
      return !last;
    };

    /** Publishes one output: the `brain.say` of the first clause (its id, pending entry and status), then `brain.clause`s and the closing one. */
    const publishOut = async (o: Out): Promise<void> => {
      if (o.closing) {
        // The closing clause of a held think, published on its release (CTX-PROV-038).
        await bus.publish("brain.clause", {
          id: line.id!, seq: o.seq, text: "", last: true, through: o.through!, ...(o.cut ? { cut: o.cut } : {}),
        });
        await this.settle(line.id!);
        return;
      }
      if (line.id === undefined) {
        const id = randomUUID();
        line.id = id;
        // pending from its brain.say until it is released (CTX-SAY-004); a streamed line is released by its players (CTX-REL-*)
        this.startSpeaking(id, { line, streamed: !o.last });
        const hold = line.hold;
        // @spec CTX-SAY-007, CTX-SAY-008, CTX-SAY-009, CTX-SAY-010
        // A released think's line takes its own stamps and the release's (CTX-PROV-025); any other line takes the focus's (CTX-SAY-006).
        const timing: Timing = {
          ...(r.focusedAt === undefined ? {} : { focusedAt: r.focusedAt }),
          llmStartedAt: r.t0,
          ...(o.llmEndedAt === undefined ? {} : { llmEndedAt: o.llmEndedAt }),
          ...(o.criticEndedAt === undefined ? {} : { criticEndedAt: o.criticEndedAt }),
          ...(firstReqAt === undefined ? {} : { toolStartedAt: firstReqAt }),
          ...(lastWaitEnd === undefined ? {} : { toolEndedAt: lastWaitEnd }),
          ...(hold?.heldAt === undefined ? {} : { heldAt: hold.heldAt }),
          ...(hold ? { ...r.focus.timing, ...hold.tail } : r.focus.timing),
        };
        // @spec CTX-SAY-001, CTX-STREAM-017, CTX-STREAM-019, CTX-INJ-001
        await bus.publish("brain.say", {
          id, text: o.text, emotion: line.emotion, gesture: o.kind === "normal" ? line.gesture : undefined, reason: r.focus.reason,
          ...(hold ? hold.flags : propagatedFlags(r.focus)), ...(hold?.interjected ? { interjected: true as const } : {}),
          timing, ...(o.last ? {} : { more: true as const }),
        }).catch((err) => {
          this.endSpeaking(id); // a line that never reached the bus is not pending
          throw err;
        });
        line.lastOut = o.seq;
        if (o.last) line.outClosed = true;
        r.onSaid();
        // @spec CTX-STREAM-018
        if (!line.stopped) await this.status("speaking", o.text); // a say already in flight at a stop is the last thing the line says
        if (o.last) await this.settle(id);
        return;
      }
      // @spec CTX-STREAM-020, CTX-STREAM-027
      const id = line.id;
      const p = this.pending.get(id);
      const wasOutstanding = p !== undefined && this.outstanding(p);
      await bus.publish("brain.clause", { id, seq: o.seq, text: o.text, ...(o.last ? { last: true as const, through: o.seq } : {}) });
      line.lastOut = o.seq;
      if (o.last) line.outClosed = true;
      if (p && this.pending.get(id) === p) this.armValve(id, p, !wasOutstanding);
      if (o.last) await this.settle(id);
    };

    // The held think's release publishes what was queued, in order, and only then lets the reading of the stream publish live (CTX-PROV-038).
    // @spec CTX-PROV-021, CTX-PROV-038
    if (r.hold !== undefined) {
      const h = r.hold;
      h.drain = async () => {
        h.draining = true;
        try {
          // A stop ends the loop: the queue is dropped and the publish in flight is the last one (CTX-STREAM-037).
          while (h.queue.length > 0 && !line.exited) await publishOut(h.queue.shift()!);
        } finally {
          h.draining = false;
        }
        h.released = true;
        // A stop that came during the release closes the line here, once, after the publish in flight (CTX-STREAM-037).
        if (line.stopped && !line.closed && line.id !== undefined) {
          line.lastSeq = line.lastProduced = line.lastOut; // the line closes through what reached the bus
          await this.closeLine(line, line.haltCut ?? "stopped");
        }
      };
    }

    // Cut every clause the body allows; with `cutTail` the rest is cut too, and `last` marks the reply's final clause. Resolves false when the reply stopped.
    const pump = async (body: string, cutTail: boolean, last: boolean, endedAt: number, kind: "normal" | "filler" | "builtin" = "normal"): Promise<boolean> => {
      for (;;) {
        const rest = body.slice(cursor.at);
        if (!rest) return true;
        const cut = cutClause(rest, min, max, cutTail, literal);
        if (!cut) return true;
        const piece = rest.slice(0, cut.end);
        cursor.at += cut.next;
        while (cursor.at < body.length && /\s/.test(body[cursor.at]!)) cursor.at++;
        const text = cleanClause(piece, literal);
        if (!hasWord(text)) continue; // CTX-STREAM-015
        if (!(await emit(text, last && cursor.at >= body.length, incremental ? Date.now() : endedAt, kind))) return false;
      }
    };

    /** A line closed or ended without a clause: the built-in line when a wait came before (CTX-TOOL-031), then the closing clause. */
    const closeEmpty = async (cut: LineCut | undefined, said: boolean): Promise<void> => {
      if (line.closed || line.exited) return;
      // @spec CTX-TOOL-031, CTX-TOOL-029
      const sorry = (cut === "tools" && !this.lineOut(line)) || (line.waited && (cut === "failed" || (cut === undefined && !said)));
      if (sorry && !(await emit(SORRY, false, Date.now(), "builtin"))) return;
      if (line.closed || line.exited) return;
      if (this.lineOut(line)) await this.closeLine(line, cut);
      else await this.noLine(line);
    };

    /** The hard stop after the final round made calls again (CTX-TOOL-029): what was said stands, or the built-in line is said first. */
    const hardStop = async (): Promise<void> => {
      if (incremental) await closeEmpty("tools", false);
      else await endCollected("tools", false);
    };

    /** Heartbeat and log for a round the token cap cut off (CTX-TOOL-018, CTX-HEALTH-009). */
    const cutOffWarning = (): void => {
      log.warn({ reason: r.focus.reason }, "a tool call was cut off by tools.reply.max_tokens");
      this.setCutOff(true);
    };

    /** Mute or busy re-check before a round or a request (CTX-TOOL-036): false when the reply has ended. */
    const gate = async (): Promise<boolean> => {
      if (this.control.muted || this.control.paused) { await this.endOpen(line, "muted"); return false; }
      if (this.voiceBusy(line.id)) { await this.endOpen(line, "busy"); return false; }
      return true;
    };

    /** The filler of CTX-TOOL-024: armed at the first request, fired while the wait holds and no clause is out. */
    const armFiller = (): void => {
      if (fillerArmed || tcfg.filler_lines.length === 0) return;
      fillerArmed = true;
      const delay = Math.max(0, tcfg.filler_after_ms - (Date.now() - (firstReqAt ?? Date.now())));
      fillerTimer = setTimeout(() => {
        if (!line.waiting || line.id !== undefined || line.closed || line.exited) return;
        const text = this.pickFiller();
        if (text === undefined) return;
        void emit(text, false, Date.now(), "filler").then((ok) => { if (!ok) this.abandonWait(); }, (err) => log.error({ err }, "filler failed"));
      }, delay);
      fillerTimer.unref();
    };

    /** The calls of one round, in the order asked (CTX-TOOL-011 to CTX-TOOL-016, CTX-TOOL-027 to CTX-TOOL-028). False when the reply stopped. */
    const runCalls = async (calls: ToolCall[], final: boolean): Promise<{ ok: boolean; msgs: ChatMessage[] }> => {
      // Answers are keyed by the call's position in the round, never by its id: a backend may repeat or leave out ids.
      type Plan = { i: number; call: ToolCall; tool?: ToolDef; local?: string };
      const plan: Plan[] = calls.map((call, i) => {
        if (i >= tcfg.max_calls) return { i, call, local: "Too many calls in one turn." }; // @spec CTX-TOOL-011
        if (call.invalid !== undefined) return { i, call, local: "The call was not valid." }; // @spec CTX-TOOL-012
        const tool = offer.find((t) => t.name === call.name);
        return tool ? { i, call, tool } : { i, call, local: "That tool is not available." }; // @spec CTX-TOOL-013
      });
      const answers = new Map<number, { content: string; isError: boolean }>();
      const asks = plan.filter((p): p is Plan & { tool: ToolDef } => p.tool !== undefined);
      for (const p of plan) if (p.local !== undefined) answers.set(p.i, { content: p.local, isError: true });
      const groups = asks.some((p) => p.tool.effect === "acts") ? asks.map((a) => [a]) : asks.length ? [asks] : [];
      for (const group of groups) {
        // @spec CTX-TOOL-028, CTX-TOOL-030
        if (final || budgetPassed()) {
          for (const p of group) answers.set(p.i, { content: "No more tool calls.", isError: true });
          continue;
        }
        if (!(await gate())) return { ok: false, msgs: [] };
        const waits = group.map((p) => {
          const id = randomUUID();
          // @spec CTX-TOOL-019
          const bound = cfg.tools.timeout_ms + 2000 + (p.tool.effect === "acts" && p.tool.name !== "timer" ? cfg.tools.confirm_timeout_ms : 0);
          return { p, id, outcome: this.awaitResult(id, bound) };
        });
        firstReqAt ??= Date.now();
        armFiller();
        line.waiting = true;
        line.waited = true;
        const p0 = line.id !== undefined ? this.pending.get(line.id) : undefined;
        if (p0) clearTimeout(p0.timer); // CTX-TOOL-023: no valve runs for the line during a wait
        const names = group.map((p) => p.tool.name).join(", ");
        let stopRenew: (() => void) | undefined;
        let outcomes: WaitOutcome[];
        try {
          // @spec CTX-TOOL-014, CTX-TOOL-015
          for (const w of waits) {
            await bus.publish("tool.request", {
              id: w.id, tool: w.p.tool.name, arguments: w.p.call.arguments, origin: r.origin, round, listed: r.listed,
              ...(r.injected ? { injected: true as const } : {}),
            });
          }
          stopRenew = this.renew(line, `waiting for ${names}`); // @spec CTX-TOOL-022
          await this.status(line.id !== undefined ? "speaking" : "thinking", `waiting for ${names}`).catch(() => {});
          outcomes = await Promise.all(waits.map((w) => w.outcome));
        } finally {
          // A failed publish must not leave the valve held: the wait ends, and the line's valve is re-armed (CTX-TOOL-023).
          stopRenew?.();
          for (const w of waits) this.awaiting.delete(w.id);
          line.waiting = false;
          this.progress();
        }
        if (outcomes.some((o) => o.kind === "abandoned")) {
          // CTX-TOOL-037, CTX-TOOL-038: a mute, pause or stop ended the wait; nothing more is requested.
          if (!line.closed && !line.exited) { if (this.lineOut(line)) await this.closeLine(line, "stopped"); else await this.noLine(line); }
          return { ok: false, msgs: [] };
        }
        let lastAt = 0;
        let complete = true;
        waits.forEach((w, i) => {
          const o = outcomes[i]!;
          if (o.kind === "result") {
            answers.set(w.p.i, { content: quoteUntrusted(o.result.content, cfg.tools.max_result_chars), isError: o.result.status !== "ok" }); // @spec CTX-PROMPT-018, CTX-TOOL-020
            lastAt = Math.max(lastAt, o.at);
          } else {
            answers.set(w.p.i, { content: "The tool did not answer in time.", isError: true }); // CTX-TOOL-019
            complete = false;
          }
        });
        lastWaitEnd = complete ? lastAt : undefined;
      }
      // @spec CTX-PROMPT-018: a result is quoted here, and the fixed messages above are not.
      const msgs: ChatMessage[] = plan.map((p) => {
        const a = answers.get(p.i) ?? { content: "No more tool calls.", isError: true };
        return { role: "tool", callId: p.call.id, name: p.call.name, content: a.content, isError: a.isError };
      });
      return { ok: true, msgs };
    };

    /** One round: its stream read to the end (or to the first newline of a round without tools, which then stops). */
    const readRound = async (msgs: ChatMessage[]): Promise<{ text: string; calls: ToolCall[]; finish?: ChatResult["finish"]; message?: ChatMessage & { role: "assistant" }; failed?: unknown; stopped: boolean }> => {
      cursor = { at: 0 };
      literal = false;
      let text = "";
      let head: Head | undefined;
      let feeding = true;
      let failed: unknown;
      let stopped = false;
      const streamed: ToolCall[] = [];
      let finish: ChatResult["finish"] | undefined;
      let message: (ChatMessage & { role: "assistant" }) | undefined;
      let calls: ToolCall[] = [];
      // @spec CTX-STREAM-003, CTX-TOOL-005
      const opts: ChatRequest = {
        signal: line.ctrl.signal,
        ...(offering ? { tools: offer.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), maxTokens: tcfg.max_tokens } : {}),
      };
      const it = llm.stream(msgs, opts)[Symbol.asyncIterator]();
      for (;;) {
        // Only reading the stream tolerates an abort: an error raised by publishing reaches the caller.
        let next: IteratorResult<ChatEvent>;
        try {
          next = await it.next();
        } catch (err) {
          if (!line.ctrl.signal.aborted) failed = err;
          break;
        }
        if (next.done) break;
        const ev = next.value;
        if (ev.type === "done") { finish = ev.result.finish; message = ev.result.message; calls = ev.result.toolCalls; continue; }
        // @spec CTX-STREAM-003: a call event of a round that offers no tools is ignored
        if (ev.type === "tool_call") { if (offering) streamed.push(ev.call); continue; }
        if (ev.type !== "text") continue;
        if (line.ctrl.signal.aborted) { stopped = true; break; }
        if (!feeding) continue; // CTX-TOOL-006: text after the first newline is discarded
        text += ev.delta;
        const trimmed = text.trimStart();
        const nl = trimmed.indexOf("\n");
        const ended = nl >= 0; // CTX-STREAM-004: the first newline ends the reply's text
        if (ended) { text = trimmed.slice(0, nl); feeding = false; }
        const h = readHead(text, ended, cfg.cohost.name);
        if (h) { head = h; literal = h.literal === true; if (!line.emotionFixed) { line.emotion = h.emotion; line.gesture = h.gesture; } }
        if (ended && !offering) { line.ctrl.abort(); break; } // CTX-STREAM-004
        if (incremental && head && !(await pump(head.body, false, false, 0))) { stopped = true; line.ctrl.abort(); break; }
      }
      await it.return?.(undefined).catch(() => {}); // ends the stream, so an abort is seen by the provider (CTX-STREAM-004)
      if (!calls.length && streamed.length) calls = streamed;
      return { text, calls, finish, message, failed, stopped };
    };

    // @spec CTX-PROV-007, CTX-TOOL-032
    /** The reply's end for a collected (`llm`/`http`) critic: criticise the whole reply once, check it, then cut and publish. */
    const endCollected = async (cut: LineCut | undefined, said: boolean): Promise<void> => {
      if (line.closed || line.exited) return;
      // The emotion and gesture are the first spoken round's; the text is the spoken rounds joined by single spaces.
      const spoken = collected.filter((c) => c.text.length > 0);
      const whole = {
        text: spoken.map((c) => c.text).join(" ").replace(/\s{2,}/g, " ").trim(),
        emotion: spoken[0]?.emotion ?? ("neutral" as Emotion),
        gesture: spoken[0]?.gesture,
      };
      if (!line.emotionFixed) { line.emotion = whole.emotion; line.gesture = whole.gesture; }
      if (whole.text.length < 2) { await closeEmpty(cut, said); return; } // CTX-PROMPT-006
      // @spec CTX-CRITIC-001, CTX-TOOL-033
      const verdict = await critic.run({ text: whole.text, emotion: whole.emotion, reason: r.focus.reason, transcript: this.ctx.transcript(cfg.cohost.name) });
      line.criticEndedAt = Date.now();
      if (!verdict.ok) { log.info({ note: verdict.note, text: whole.text }, "critic vetoed"); await this.endOpen(line, "vetoed"); return; } // CTX-CRITIC-002, CTX-TOOL-034
      let text = whole.text;
      if (verdict.text) { text = parseReply(verdict.text).text; log.info({ from: whole.text, to: text }, "critic rewrote"); }
      if (verdict.emotion && !line.emotionFixed) line.emotion = verdict.emotion;
      if (text.length < 2) { await closeEmpty(cut, said); return; } // CTX-CRITIC-008
      if (this.repeatHit(text)) { await this.endOpen(line, "repeat"); return; }
      const inHand = Date.now();
      if (!(await pump(text, true, cut === undefined, inHand))) return;
      if (line.closed || line.exited) return;
      if (!this.lineOut(line)) { await closeEmpty(cut, said); return; }
      await this.closeLine(line, cut);
    };

    try {
      for (;;) {
        round++;
        const final = round > 1 && (roundsWithCalls >= tcfg.max_rounds || budgetPassed() || finalCallRounds >= 1); // CTX-TOOL-027, CTX-TOOL-029
        if (round > 1) {
          // @spec CTX-TOOL-036
          if (!(await gate())) return;
          // @spec CTX-TOOL-022
          await this.status(line.id !== undefined ? "speaking" : "thinking", `tool round ${round}`).catch(() => {});
        }
        const stopRenew = round > 1 ? this.renew(line, `tool round ${round}`) : undefined;
        const said0 = line.published.length;
        let out: Awaited<ReturnType<typeof readRound>>;
        try {
          out = await readRound(convo);
        } finally {
          stopRenew?.();
        }
        raw += out.text;
        if (out.stopped || line.closed || line.exited) return;
        // @spec CTX-CTRL-008, CTX-STREAM-031, CTX-TOOL-031, CTX-TOOL-040
        if (out.failed !== undefined) {
          if (!line.waited) {
            if (!this.lineOut(line)) throw out.failed; // a think that fails before its first clause is the think's error (CTX-STREAM-030)
            log.warn({ err: out.failed, reason: r.focus.reason }, "the model stream failed after a clause; the line closes failed");
            await this.closeLine(line, "failed");
            return;
          }
          log.warn({ err: out.failed, reason: r.focus.reason }, "the model stream failed after a tool wait");
          await closeEmpty("failed", false);
          return;
        }
        if (offering) {
          // @spec CTX-TOOL-018, CTX-HEALTH-009
          if (out.finish === "length") cutOffWarning();
          else this.setCutOff(false);
        }
        // Text of this round: a `rules` critic gets it clause by clause, an `llm` or `http` critic collects it.
        const roundHead = readHead(out.text, true, cfg.cohost.name) ?? { emotion: "neutral" as Emotion, body: "" };
        if (!line.emotionFixed && offering) { line.emotion = roundHead.emotion; line.gesture = roundHead.gesture; }
        literal = roundHead.literal === true;
        const lengthCut = offering && out.finish === "length"; // CTX-TOOL-017
        const wantCalls = offering && !lengthCut && out.calls.length > 0;
        // @spec CTX-TOOL-032: an llm or http critic gets each round parsed on its own, so no later round's `Name:` or tag is spoken.
        if (!incremental) collected.push(parseReply(out.text));
        const roundSaid = (): boolean => line.published.length > said0;

        if (!wantCalls) {
          // The reply ends with this round.
          // @spec CTX-STREAM-032, CTX-GATE-012: a refusal ends the reply; its held tail is not published.
          if (out.finish === "refusal") { if (this.lineOut(line)) await this.closeLine(line); else await this.noLine(line); return; }
          if (incremental) {
            const cut: LineCut | undefined = lengthCut ? "length" : undefined;
            if (!(await pump(roundHead.body, true, cut === undefined, Date.now()))) return;
            if (line.closed || line.exited) return;
            await closeEmpty(cut, roundSaid());
          } else {
            await endCollected(lengthCut ? "length" : undefined, false);
          }
          return;
        }

        // The round asks for tools: its text first, then its calls.
        if (incremental) {
          if (!(await pump(roundHead.body, true, false, Date.now()))) return;
          if (line.closed || line.exited) return;
          // @spec CTX-TOOL-009: a round that reaches max_clauses ends the reply and runs none of its calls.
          if (line.counted >= maxClauses) { await this.endOpen(line, "length"); return; }
        }
        // A held think parks at its first tool call: no request goes out until it is released (CTX-PROV-009, CTX-INTJ-001).
        if (line.hold !== undefined && !line.hold.released) {
          line.hold.parked = true;
          if (line.hold.heldAt === undefined) line.hold.heldAt = Date.now(); // CTX-PROV-030
          await line.hold.settled;
          if (line.exited) return; // ended while parked (CTX-PROV-016)
        }
        if (final && finalCallRounds >= 1) { await hardStop(); return; } // CTX-TOOL-029
        if (final) finalCallRounds++;
        else roundsWithCalls++;
        const res = await runCalls(out.calls, final);
        if (!res.ok) return;
        convo.push(out.message ?? { role: "assistant", content: out.text, toolCalls: out.calls }, ...res.msgs);
      }
    } catch (err) {
      failed = true;
      // A publish that failed is not a stopped stream: the line closes if it can, and the error reaches think()'s catch.
      if (this.lineOut(line) && !line.closed) await this.closeLine(line).catch(() => {});
      throw err;
    } finally {
      if (fillerTimer) clearTimeout(fillerTimer);
      if (this.line === line) this.line = undefined;
      log.debug({ raw }, "llm reply text"); // raw text can echo chat and is not yet through the critic
      // Every reply that was read to its end, whatever line it published (or none), is logged once.
      if (!line.stopped && !failed) log.info({ ms: Date.now() - r.t0, reason: r.focus.reason, memories: r.memories }, "llm reply");
    }
  }

  // @spec CTX-TOOL-001, CTX-TOOL-002, CTX-TOOL-003
  /** The tools a think offers: the current catalog's offered tools that the reply's origin allows; none when the catalog is not current. */
  private offerFor(focus: Focus): Offer {
    const { origin, listed } = originOf(focus, this.d.cfg.tools.owner_sources);
    if (!this.catalogCurrent()) return { tools: [], origin, listed };
    const allows = (t: ToolDef): boolean => {
      if (origin === "speech") return true;
      if (origin === "reminder") return t.effect === "read";
      if (origin === "chat" || origin === "guest") return t.chat && t.effect === "read";
      return false; // vision and idle: no tool
    };
    return { tools: this.catalog!.tools.filter((t) => t.offered && allows(t)), origin, listed };
  }

  /** The latest catalog arrived within three of its intervals (CTX-TOOL-001). */
  private catalogCurrent(): boolean {
    return this.catalog !== undefined && Date.now() - this.catalog.at <= 3 * this.catalog.intervalMs;
  }

  // @spec CTX-HEALTH-008
  /** `deps.tools`: `ok` while a current catalog offers a tool, `down` once a catalog that offered one is stale, `n/a` otherwise. */
  toolsState(): "ok" | "down" | "n/a" {
    const c = this.catalog;
    if (c === undefined || !c.tools.some((t) => t.offered)) return "n/a";
    return this.catalogCurrent() ? "ok" : "down";
  }

  // @spec CTX-TOOL-019, CTX-TOOL-021
  /** A wait for one request's result: resolved by its `tool.result`, by the bound, or by an abandon. */
  private awaitResult(id: string, bound: number): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      const done = (o: WaitOutcome): void => { clearTimeout(timer); this.awaiting.delete(id); resolve(o); };
      const timer = setTimeout(() => done({ kind: "timeout" }), bound);
      timer.unref(); // a wait never holds the process up
      this.awaiting.set(id, done);
    });
  }

  // @spec CTX-TOOL-021
  /** A `tool.result` for an id a wait holds ends that wait; any other, or a second one, is ignored. */
  private onToolResult(d: Result): void {
    const done = this.awaiting.get(d.id);
    if (!done) return;
    done({ kind: "result", result: d, at: Date.now() });
  }

  // @spec CTX-TOOL-037, CTX-TOOL-038
  /** Every running tool wait ends abandoned; its requests are not cancelled (CTX-TOOL-039). */
  private abandonWait(): void {
    for (const done of [...this.awaiting.values()]) done({ kind: "abandoned" });
  }

  // @spec CTX-TOOL-022
  /** Publishes `detail` as a status every half of the valve interval for the line's state, until the returned stop is called. */
  private renew(line: Line, detail: string): () => void {
    const { cortex: c, salience: s } = this.d.cfg.brain;
    const ms = Math.max(1, Math.floor((line.id !== undefined ? c.speaking_timeout_ms : s.thinking_timeout_ms) / 2));
    const timer = setInterval(() => {
      void this.status(line.id !== undefined ? "speaking" : "thinking", detail).catch((err) => this.d.log.error({ err }, "brain.status publish failed"));
    }, ms);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** A line that ends without a clause of its own: a line out is closed with `cut`; with none, the think ends without a line. */
  private async endOpen(line: Line, cut?: LineCut): Promise<void> {
    if (line.closed || line.exited) return;
    if (this.lineOut(line)) await this.closeLine(line, cut);
    else await this.noLine(line);
  }

  // @spec CTX-TOOL-024
  /** A filler line picked at random from `tools.reply.filler_lines`, never the one used last when the list holds another. */
  private pickFiller(): string | undefined {
    const lines = this.d.cfg.tools.reply.filler_lines;
    if (lines.length === 0) return undefined;
    const pool = lines.length > 1 ? lines.filter((l) => l !== this.lastFiller) : lines;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.lastFiller = pick;
    return pick;
  }

  // @spec CTX-HEALTH-009
  /** Sets the cut-off flag and republishes the heartbeat detail, joined by `; ` to the paused detail. */
  private setCutOff(on: boolean): void {
    if (this.cutOff === on) return; // an unchanged flag publishes nothing
    this.cutOff = on;
    this.publishDetail();
  }

  /** The standing detail: the base note, the pause and the cut-off call, joined by `; ` (CTX-HEALTH-009). */
  private publishDetail(): void {
    const detail = [this.d.standingDetail, this.pausedDetail, this.cutOff ? CUT_OFF_DETAIL : undefined]
      .filter((x): x is string => x !== undefined && x !== "").join("; ");
    this.d.heartbeat?.setDetail(detail === "" ? undefined : detail);
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
  /** Some line is still pending on the voice. Each line's valve is armed on its own progress (CTX-GATE-004, CTX-REL-001), so none is swept here. */
  private voiceBusy(except?: string): boolean {
    for (const id of this.pending.keys()) if (id !== except) return true;
    return false;
  }

  /**
   * A line began playing: remember it and arm its valve. `own` marks a reply line of the cortex's own think, with its line object
   * and whether it is streamed. Lines already pending stay pending.
   */
  // @spec CTX-SAY-005, CTX-GATE-004, CTX-GATE-009
  private startSpeaking(id: string, own?: { line: Line; streamed: boolean }): void {
    this.endSpeaking(id); // the same id again restarts its valve
    const p: Pending = {
      windowEnded: false, players: new Map(), failureRead: false, errorZero: false,
      readBack: own?.streamed !== true, marks: [], ...(own ? { own } : {}),
    };
    this.pending.set(id, p);
    this.armValve(id, p, true);
  }

  /** Service shutdown: release the valves, end a think that has published no clause, and close an open streamed line as `stopped`, once (CTX-STREAM-037). */
  // @spec CTX-STREAM-037
  async stop(): Promise<void> {
    this.stopped = true;
    this.abandonWait();
    if (this.held !== undefined) await this.endHeld(this.held, { status: false });
    for (const id of [...this.pending.keys()]) this.endSpeaking(id);
    // A release in flight outlives the reading of its stream: its queue is dropped and its line stopped. Its drain closes the line after
    // any publish in flight; a release still before its drain publishes nothing more (CTX-STREAM-037).
    if (this.haltRelease("stopped")) return;
    const line = this.line;
    if (!line) return;
    line.stopped = true;
    if (line.id === undefined) { line.exited = true; line.ctrl.abort(); return; } // nothing published: no brain.say after stop
    await this.closeLine(line, "stopped").catch((err) => this.d.log.error({ err }, "closing the streamed line failed"));
  }

  /** A line ended (its release, its valve or a stop); false when it was not pending. Clears its timers and keeps it as retired. */
  private endSpeaking(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    clearTimeout(p.window);
    this.pending.delete(id);
    this.retired.delete(id);
    this.retired.set(id, p);
    if (this.retired.size > RETIRED_MAX) this.retired.delete(this.retired.keys().next().value!); // a Map iterates in insertion order
    return true;
  }

  // @spec CTX-REL-009, CTX-REL-010, CTX-EVT-005
  /** A line ended: publish the status it leaves, or owe it to the end of the think in flight. */
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

  /** A clause is outstanding until every player has completed it (CTX-REL-001); a single-clause line is outstanding until it ends. */
  private outstanding(p: Pending): boolean {
    return p.own?.streamed ? !this.allCompleted(p) : true;
  }

  // @spec CTX-REL-001, CTX-GATE-004
  /** Voice made progress on some pending line: every pending line's valve restarts, since voice plays the lines in order. */
  private progress(): void {
    for (const [id, p] of this.pending) this.armValve(id, p, true);
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
   * (Re)arm a line's valve while a clause is outstanding; with none outstanding it is off. `restart` false keeps a running valve
   * (a clause published while one is outstanding is not progress).
   */
  private armValve(id: string, p: Pending, restart: boolean): void {
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
    if (!p) return;
    if (p.own?.line.waiting) return; // CTX-TOOL-023: no valve runs during a tool wait
    if (p.own?.streamed && !p.own.line.closed) await this.closeLine(p.own.line, "timeout");
    await this.release(id);
  }

  // @spec CTX-REL-003, CTX-REL-004, CTX-REL-005, CTX-REL-008, CTX-REL-015, CTX-FALL-012
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

  // @spec CTX-PROV-001, CTX-PROV-010
  /** Opens the held think of a provisional focus: the cortex's one held think, whose hold limit starts now (CTX-PROV-010). */
  private openHold(focus: Focus): Held {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    const h: Held = {
      utteranceId: focus.utteranceId, seq: focus.seq, text: focus.focus?.text ?? "", speaker: focus.focus?.who ?? "", reason: focus.reason,
      queue: [], parked: false, none: false, released: false, ended: false, tail: {}, flags: {}, settled, resolve, drain: async () => {},
    };
    h.drain = async () => { h.released = true; }; // until readReply reads the stream, a release has nothing to publish
    // @spec CTX-PROV-029: the hold limit ends the think as CTX-PROV-033 says.
    h.timer = setTimeout(() => {
      this.endHeld(h, { status: true }).catch((err) => this.d.log.error({ err }, "ending the held think failed"));
    }, this.d.cfg.brain.cortex.hold_limit_ms);
    h.timer.unref();
    this.held = h;
    return h;
  }

  // @spec CTX-PROV-011, CTX-PROV-012, CTX-PROV-013, CTX-PROV-014, CTX-PROV-015, CTX-PROV-016, CTX-PROV-027, CTX-PROV-031, CTX-PROV-032, CTX-PROV-033, CTX-PROV-034
  /**
   * Ends the held think without a line: aborts its stream through its signal, drops the held clauses, clears the hold timer and the
   * thinking flag. `status` publishes the no-line exit (CTX-PROV-033); a replacement passes false and publishes nothing for the think.
   */
  private async endHeld(h: Held, opts: { status: boolean }): Promise<void> {
    if (this.held !== h) return;
    this.held = undefined;
    clearTimeout(h.timer);
    h.ended = true;
    h.queue.length = 0;
    if (h.line !== undefined) {
      h.line.stopped = true;
      h.line.exited = true;
      h.line.ctrl.abort();
    }
    this.statusOwed = false; // the no-line status below, or none, is the end's status
    this.thinking = false;
    this.turn = undefined;
    h.resolve();
    if (opts.status) await this.statusLogged(this.noLineState());
  }

  /**
   * Halts the release in flight, if any: its queue is dropped and its stream aborted. Its drain closes the line with `cut` after any
   * publish in flight; a release still before its drain publishes nothing more. False when no release is in flight.
   */
  private haltRelease(cut: LineCut): boolean {
    const h = this.releasing;
    if (h === undefined || h.released || h.line === undefined) return false;
    const rl = h.line;
    rl.stopped = true;
    rl.haltCut = cut;
    h.queue.length = 0;
    rl.closed = rl.outClosed === true; // a closed mark set by a dropped output does not count
    rl.exited = true;
    rl.ctrl.abort();
    return true;
  }

  /** Ends a held think for a line of the cortex's own, or a pause or mute, which publish their own status (CTX-PROV-012, CTX-PROV-027). */
  private async dropHeld(status: boolean): Promise<void> {
    if (this.held !== undefined) await this.endHeld(this.held, { status });
  }

  // @spec CTX-PROV-019, CTX-PROV-020, CTX-PROV-022, CTX-PROV-035, CTX-PROV-036, CTX-PROV-037, CTX-PROV-038, CTX-INTJ-001, CTX-INTJ-005
  /**
   * Releases a held think by a confirmation: clears the hold limit, runs the mute and busy re-check and, when it fails, drops the reply
   * as an ordinary first-clause check does. When it passes, publishes `thinking` and the held clauses as an ordinary reply. A held
   * no-line result takes the no-line exit alone (CTX-PROV-022).
   */
  private async releaseHeld(h: Held, rel: { tail: Timing; flags: InjectionFlags; interjected?: true }): Promise<void> {
    if (this.held !== h) return;
    this.held = undefined;
    clearTimeout(h.timer);
    h.tail = rel.tail;
    h.flags = rel.flags;
    if (rel.interjected) h.interjected = true;
    this.lastReleased = { utteranceId: h.utteranceId, seq: h.seq };
    this.releasing = h;
    try {
      if (h.none && h.queue.length === 0) {
        h.released = true;
        this.statusOwed = false;
        await this.statusLogged(this.noLineState());
        return;
      }
      if (this.control.muted || this.control.paused || this.voiceBusy()) {
        if (!(this.control.muted || this.control.paused)) this.d.log.info({ reason: h.reason }, "dropped: something else spoke while thinking");
        // The reply is dropped and its reading stopped; a clause it had held is not published (CTX-PROV-036).
        h.ended = true;
        h.released = true;
        h.queue.length = 0;
        if (h.line !== undefined) { h.line.stopped = true; h.line.exited = true; h.line.ctrl.abort(); }
        this.statusOwed = false;
        await this.statusLogged(this.noLineState());
        return;
      }
      await this.status("thinking", h.reason); // CTX-PROV-037
      await h.drain();
    } catch (err) {
      // A publish that fails during the release ends the think: nothing more is held for it, and think() reports the failure.
      h.error = err;
      h.ended = true;
      h.released = true;
      h.queue.length = 0;
      const line = h.line;
      // A line already begun is closed `failed`, so its reply does not stay half-published (CTX-STREAM-024 to 026).
      if (line !== undefined && line.id !== undefined) {
        line.closed = line.outClosed === true; // a closed mark set by a dropped output does not count
        line.lastSeq = line.lastProduced = line.lastOut; // the line closes through what reached the bus
        await this.closeLine(line, "failed").catch(() => {});
      }
      if (line !== undefined) { line.stopped = true; line.exited = true; line.ctrl.abort(); }
      this.statusOwed = false;
    } finally {
      if (this.releasing === h) this.releasing = undefined;
      h.resolve();
    }
  }

  /** Whether a held think is ready for an interjected confirm: a clause held that passed its checks, and not parked (CTX-INTJ-001). */
  private ready(h: Held): boolean {
    return !h.parked && h.queue.length > 0 && !h.released && !h.ended;
  }

  // @spec CTX-PROV-011, CTX-PROV-023, CTX-PROV-024, CTX-PROV-019, CTX-INTJ-001, CTX-INTJ-002, CTX-INTJ-003, CTX-INTJ-006
  /**
   * An `attention.resolve`. A confirm or withdraw whose `utteranceId` and `seq` match the held think decides it; one that matches none
   * ends any held think first (as an ordinary focus does). A confirm with no held think is an ordinary focus; a withdraw changes nothing.
   */
  private async onResolve(d: Resolve, ts: number): Promise<void> {
    const h = this.held;
    const held = h !== undefined && h.utteranceId === d.utteranceId && h.seq === d.seq ? h : undefined;
    if (d.outcome === "withdraw") {
      if (held !== undefined) await this.endHeld(held, { status: true }); // CTX-PROV-011
      else if (h !== undefined) await this.endHeld(h, { status: false });
      return;
    }
    if (d.interjected === true) {
      // CTX-INTJ-001: released only when ready, after the unfinished line (CTX-INTJ-002).
      if (held !== undefined && this.ready(held)) {
        this.ctx.pushUnfinished(held.utteranceId ?? d.utteranceId, held.speaker, held.text, ts); // @spec CTX-INTJ-002
        await this.releaseHeld(held, { tail: finalTiming(d.timing), flags: propagatedFlags(d), interjected: true });
        return;
      }
      // CTX-INTJ-003: nothing is spoken and the think ends; CTX-INTJ-006: while an ordinary think is in flight its state is reported.
      const inFlight = h === undefined && this.thinking;
      if (h !== undefined) await this.endHeld(h, { status: false });
      if (inFlight) await this.statusLogged("thinking", d.reason);
      else await this.statusLogged(this.noLineState());
      return;
    }
    if (held !== undefined) {
      await this.releaseHeld(held, { tail: { ...finalTiming(d.timing), confirmedAt: Date.now() }, flags: propagatedFlags(d) }); // CTX-PROV-019
      return;
    }
    // A redelivered confirm of the held think just released is ignored: it must not start a second reply (CTX-PROV-023).
    if (this.lastReleased !== undefined && d.utteranceId === this.lastReleased.utteranceId && d.seq === this.lastReleased.seq) return;
    // CTX-PROV-023: an ordinary focus built from the resolve; think() ends any other held think.
    this.think(focusOf(d), ts).catch((err) => this.d.log.error({ err }, "think rejected"));
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
