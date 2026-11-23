import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { parseWav } from "@cohost/shared";
import { envelope } from "./wav.js";
import type { ClipRoutes } from "./clips.js";
import type { Synth } from "./engine.js";

export const ENVELOPE_HZ = 30;

/** Clause WAVs held in memory, oldest evicted first (VOICE-HTTP-001). */
const AUDIO_LIMIT = 100;
/** Line records held, newest kept (VOICE-CLAUSE-001). */
const LINE_LIMIT = 50;
/** The claim window opened with a line's first clause (VOICE-SINK-002). */
const CLAIM_WINDOW_MS = 1500;
/** A line with no clause activity for this long ends (VOICE-CLAUSE-012); the sweep runs at this period. */
const IDLE_MS = 300_000;

export interface VoiceDeps {
  bus: Publisher;
  log: Logger;
  /** Text to a whole WAV, through the engine contract (`engine.ts`). */
  synth: Synth;
  /** Base URL sinks fetch audio from. */
  publicUrl: string;
  /** The fallback clip store behind `/fallback/*`; absent (the stub engine) means those routes answer 404. */
  clips?: ClipRoutes;
}

type Say = BusEvent<"brain.say">["data"];

/** The store key of one clause: `<id>-<seq>` names its WAV (VOICE-SYN-004). */
const keyOf = (id: string, seq: number): string => `${id}-${seq}`;

/** The path of a request target, without its query string; a target that does not parse matches no route. */
function pathOf(target: string | undefined): string {
  try { return new URL(target ?? "/", "http://voice.invalid").pathname; } catch { return ""; }
}

/** One published clause of a line. */
interface Clause { text: string; durationMs: number }

/** The inputs of a spoken/unsaid split (VOICE-CLAUSE-025): the clauses before the cut, the playing clause, the clauses after it. */
interface Split { before: string[]; playing?: Clause; after: string[] }

/** The clause the virtual player has started: its `voice.playing` in flight, or its `durationMs` running. */
interface Playing {
  seq: number;
  durationMs: number;
  publishing: boolean;
  startedAt: number;
  timer?: NodeJS.Timeout;
  /** A sink gave up on this clause while its `voice.playing` publish was in flight (VOICE-SINK-012). */
  givenUp?: boolean;
  /** A `voice.stop` arrived while its `voice.playing` publish was in flight; the split taken then (VOICE-STOP-010). */
  stopped?: Split;
}

/** A line's record (VOICE-CLAUSE-001): its clauses, its claim window, and its virtual player. */
interface Line {
  id: string;
  /** Opened by a `brain.say` carrying `more`; a line without it is one clause and never takes `brain.clause`. */
  streamed: boolean;
  emotion: Say["emotion"];
  gesture: Say["gesture"];
  route: Say["route"];
  /** The `seq` of the last clause accepted (VOICE-CLAUSE-013). */
  lastSeq: number;
  /** The closing clause has been read; `through` is then set. */
  closed: boolean;
  through?: number;
  /** No further clause is accepted or synthesized; clauses below `playLimit` may still play virtually. */
  ended: boolean;
  /** The record was evicted past LINE_LIMIT: its queued clauses are still synthesized and published, but it arms no timer. */
  evicted: boolean;
  playLimit: number;
  /** A real sink has claimed a clause of the line (VOICE-SINK-001). */
  claimed: boolean;
  /** Last clause activity, for the 300 s bound (VOICE-CLAUSE-012). */
  lastActive: number;
  /** Published clauses by seq. */
  clauses: Map<number, Clause>;
  /** The claim window's timer while it is open (VOICE-SINK-002). */
  window?: NodeJS.Timeout;
  /** The seq a sink gave up on while the window was open (VOICE-SINK-011). */
  givenUp?: number;
  /** The window ended with the line unclaimed: the virtual player runs (VOICE-CLAUSE-018). */
  virtual: boolean;
  /** The next seq the virtual player plays. */
  vNext: number;
  /** The last seq the virtual player finished (its virtual `voice.done` published). */
  vLast?: number;
  playing?: Playing;
  /** The previous virtual `voice.done` is being published; the next clause waits for it (VOICE-CLAUSE-019). */
  doneInFlight: boolean;
}

/** A clause on the synthesis queue, or in synthesis. */
interface Job { line: Line; seq: number; text: string; cancelled: boolean }

/** The spoken/unsaid split of one clause at `fraction` of its characters: the longest whole-word prefix, and the rest without leading whitespace (as mouth's spokenSplit, MOUTH-STOP-005). */
function spokenSplit(text: string, fraction: number): { spokenText: string; unsaidText: string } {
  const limit = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * text.length;
  let end = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const at = m.index! + m[0].length;
    if (at <= limit) end = at;
  }
  return { spokenText: text.slice(0, end), unsaidText: text.slice(end).replace(/^\s+/, "") };
}

/** The spoken and unsaid text of an interrupted virtual clause, `elapsedMs` into its playing clause (VOICE-CLAUSE-025). */
function splitText(s: Split, elapsedMs: number): { spokenText: string; unsaidText: string } {
  let prefix = "";
  let rest = "";
  if (s.playing) {
    const fraction = s.playing.durationMs > 0 ? elapsedMs / s.playing.durationMs : 1;
    ({ spokenText: prefix, unsaidText: rest } = spokenSplit(s.playing.text, fraction));
  }
  return {
    spokenText: [...s.before, prefix].filter((t) => t !== "").join(" "),
    unsaidText: [rest, ...s.after].filter((t) => t !== "").join(" "),
  };
}

/** Clears a line's window and virtual-done timers. */
function clearTimers(line: Line): void {
  if (line.window) clearTimeout(line.window);
  line.window = undefined;
  if (line.playing?.timer) clearTimeout(line.playing.timer);
  if (line.playing) line.playing.timer = undefined;
}

/** The voice region: clause-by-clause synthesis, the bounded audio store, line arbitration (the virtual sink) and the audio HTTP endpoint. */
export class Voice {
  // ---- audio store (in-memory, bounded by clauses)
  private store = new Map<string, Buffer>();
  private order: string[] = [];
  /** Keys of clauses a real sink has claimed; only stored clauses, so bounded by the store (VOICE-SINK-007). */
  private claimed = new Set<string>();
  // ---- line records (newest LINE_LIMIT)
  private lines = new Map<string, Line>();
  // ---- synthesis queue
  /** Clauses waiting for synthesis, oldest first, across every line; handled one at a time off the bus read loop. */
  private queue: Job[] = [];
  /** The clause being synthesized, or whose result is pending. */
  private current: Job | undefined;
  private draining: Promise<void> | undefined;
  private stopped = false;
  /** Aborted at shutdown only: a `voice.stop` never aborts an engine request (VOICE-ENG-014). */
  private abort = new AbortController();
  /** The 300 s line sweep; armed while lines exist (VOICE-CLAUSE-012). */
  private sweep: NodeJS.Timeout | undefined;

  constructor(private d: VoiceDeps) {}

  /** Resolves once every queued clause has been handled (and immediately when none is queued). */
  async whenIdle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Shut the region down: drop queued clauses, stop an in-flight clause from publishing or arming timers, and clear every
   * claim-window, virtual-done and sweep timer so nothing is published after the bus has stopped.
   */
  stop(): void { // @spec VOICE-SYN-008, VOICE-HLTH-005, VOICE-ENG-015
    this.stopped = true;
    this.abort.abort();
    this.queue.length = 0;
    for (const line of this.lines.values()) clearTimers(line);
    clearInterval(this.sweep);
    this.sweep = undefined;
  }

  /** Number of live real-sink claims (never more than the audio store holds). */
  get claimCount(): number { return this.claimed.size; }

  async onEvent(ev: BusEvent): Promise<void> {
    if (ev.type === "brain.say") this.say(ev as BusEvent<"brain.say">);
    else if (ev.type === "brain.clause") this.read(ev as BusEvent<"brain.clause">);
    else if (ev.type === "voice.failed") await this.failed(ev as BusEvent<"voice.failed">);
    else if (ev.type === "voice.stop") await this.stopLines(ev as BusEvent<"voice.stop">);
    else if (ev.type === "voice.playing") await this.playing(ev as BusEvent<"voice.playing">);
  }

  // ---- lines and the queue

  /** A `brain.say` opens the line's record (VOICE-CLAUSE-001) and queues its first clause (VOICE-SYN-007). */
  private say(ev: BusEvent<"brain.say">): void { // @spec VOICE-SYN-005, VOICE-SYN-007, VOICE-CLAUSE-001, VOICE-CLAUSE-002
    if (this.stopped) return;
    const d = ev.data;
    const streamed = d.more === true;
    const line: Line = {
      id: d.id, streamed, emotion: d.emotion, gesture: d.gesture, route: d.route,
      lastSeq: 0, closed: !streamed, through: streamed ? undefined : 0,
      ended: false, evicted: false, playLimit: Number.POSITIVE_INFINITY, claimed: false, lastActive: Date.now(),
      clauses: new Map(), virtual: false, vNext: 0, doneInFlight: false,
    };
    this.open(line);
    this.enqueue({ line, seq: 0, text: d.text, cancelled: false });
    this.armSweep();
  }

  /** A `brain.clause` for a streamed line: accepted in sequence, or dropped with a warning (VOICE-CLAUSE-002, 007..011, 013). */
  private read(ev: BusEvent<"brain.clause">): void { // @spec VOICE-CHUNK-002, VOICE-CLAUSE-002, VOICE-CLAUSE-007, VOICE-CLAUSE-008, VOICE-CLAUSE-009, VOICE-CLAUSE-010, VOICE-CLAUSE-011, VOICE-CLAUSE-013
    if (this.stopped) return;
    const d = ev.data;
    const line = this.lines.get(d.id);
    if (!line) { // VOICE-CLAUSE-010
      this.d.log.warn({ id: d.id, seq: d.seq }, "clause for a line voice holds no record of");
      return;
    }
    if (line.ended) return; // VOICE-CLAUSE-011
    const now = Date.now();
    if (now - line.lastActive >= IDLE_MS) { // VOICE-CLAUSE-012: a line idle for 300 s ends before this clause
      this.endLine(line, this.limitOf(line));
      this.d.log.warn({ id: d.id, seq: d.seq }, "line idle past 300 s: clause dropped");
      return;
    }
    line.lastActive = now;
    if (line.closed || d.seq !== line.lastSeq + 1) { // VOICE-CLAUSE-013
      this.d.log.warn({ id: d.id, seq: d.seq, expected: line.lastSeq + 1 }, "clause out of sequence or after the closing event");
      return;
    }
    line.lastSeq = d.seq;
    if (d.last) {
      const through = d.through ?? 0;
      line.closed = true;
      line.through = through;
      this.queue = this.queue.filter((j) => !(j.line === line && j.seq > through)); // VOICE-CLAUSE-009
      if (d.text !== "") this.enqueue({ line, seq: d.seq, text: d.text, cancelled: false }); // VOICE-CLAUSE-008
      this.playNext(line);
      return;
    }
    this.enqueue({ line, seq: d.seq, text: d.text, cancelled: false });
  }

  private enqueue(job: Job): void { // @spec VOICE-SYN-007, VOICE-CLAUSE-002
    if (this.stopped) return;
    this.queue.push(job);
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const job = this.queue.shift();
        if (!job) break;
        if (job.cancelled || job.line.ended) continue; // VOICE-CLAUSE-011, VOICE-STOP-003
        try {
          await this.synthesize(job);
        } catch (err) {
          this.d.log.error({ err, id: job.line.id }, "synthesis failed");
        }
      }
    } finally {
      this.draining = undefined;
    }
  }

  /**
   * Adds a line's record, replacing one with the same id. Past the limit an ended record goes first, else the oldest; an evicted
   * record keeps its timers, so its virtual done still arrives, but takes no new window or virtual clause (VOICE-CLAUSE-001).
   */
  private open(line: Line): void {
    const old = this.lines.get(line.id);
    if (old) this.retire(old);
    this.lines.delete(line.id);
    this.lines.set(line.id, line);
    while (this.lines.size > LINE_LIMIT) {
      const victim = this.evictable(line);
      if (!victim) break;
      this.lines.delete(victim.id);
      victim.evicted = true;
    }
  }

  /** The record to evict: the oldest ended one, else the oldest one; never the record just opened. */
  private evictable(keep: Line): Line | undefined {
    let oldest: Line | undefined;
    for (const line of this.lines.values()) {
      if (line === keep) continue;
      if (line.ended) return line;
      oldest ??= line;
    }
    return oldest;
  }

  /** A record replaced by a `brain.say` with the same id: it is ended, and its clause in synthesis is discarded (VOICE-STOP-004). */
  private retire(line: Line): void {
    this.silence(line);
    line.ended = true;
    line.playLimit = 0;
    if (this.current?.line === line) this.current.cancelled = true;
  }

  /** Clears a record's timers and virtual player; its queued clauses are left to the queue. */
  private silence(line: Line): void {
    clearTimers(line);
    line.virtual = false;
    line.playing = undefined;
  }

  /** Ends a line: no further clause is accepted, and virtual clauses below `limit` may still play. */
  private endLine(line: Line, limit: number): void { // @spec VOICE-CLAUSE-012
    line.ended = true;
    line.playLimit = limit;
  }

  private armSweep(): void { // @spec VOICE-CLAUSE-012
    this.sweep ??= setInterval(() => this.sweepLines(), IDLE_MS);
    this.sweep.unref?.();
  }

  /** Ends every open line with no clause activity for 300 s; clears the sweep once no line is open. */
  private sweepLines(): void { // @spec VOICE-CLAUSE-012
    const now = Date.now();
    let open = false;
    for (const line of this.lines.values()) {
      if (line.ended) continue;
      if (now - line.lastActive >= IDLE_MS) this.endLine(line, this.limitOf(line));
      else open = true;
    }
    if (!open) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
  }

  /** The seq below which a line's published clauses play: all published, and none above a closing clause's `through`. */
  private limitOf(line: Line): number {
    const published = line.clauses.size === 0 ? 0 : Math.max(...line.clauses.keys()) + 1;
    return line.closed ? Math.min(published, (line.through ?? 0) + 1) : published;
  }

  // ---- synthesis

  /** One clause: one engine request, store, publish, then arbitration (VOICE-CLAUSE-003, VOICE-CHUNK-001). */
  private async synthesize(job: Job): Promise<void> { // @spec VOICE-CHUNK-001, VOICE-SYN-004, VOICE-SYN-005, VOICE-CLAUSE-003, VOICE-CLAUSE-004, VOICE-CLAUSE-005, VOICE-CLAUSE-006, VOICE-UTT-001, VOICE-UTT-004
    const { line, seq, text } = job;
    const { bus, log } = this.d;
    const key = keyOf(line.id, seq);
    const t0 = Date.now();
    this.current = job;
    try {
      const wav = await this.d.synth(text, { priority: "line", signal: this.abort.signal, discarded: () => this.stopped || job.cancelled }); // @spec VOICE-ENG-001, VOICE-ENG-014
      if (this.stopped || job.cancelled) return; // VOICE-STOP-004
      const info = parseWav(wav); // @spec VOICE-ENV-005, VOICE-POC-005
      const env = envelope(wav, info, ENVELOPE_HZ);
      this.put(key, wav); // @spec VOICE-SYN-004
      log.info({ id: line.id, seq, ms: Date.now() - t0, durationMs: Math.round(info.durationMs), text }, "synthesized");
      await bus.publish("voice.utterance", {
        id: line.id, seq, text, emotion: line.emotion,
        ...(seq === 0 ? { gesture: line.gesture } : {}), // @spec VOICE-CLAUSE-006
        ...(seq === 0 && line.streamed ? { more: true as const } : {}), // @spec VOICE-CLAUSE-005
        ...(line.route ? { route: line.route } : {}), // @spec VOICE-UTT-004, VOICE-CLAUSE-006
        durationMs: Math.round(info.durationMs),
        envelopeHz: ENVELOPE_HZ,
        envelope: env,
        audioUrl: `${this.d.publicUrl}/audio/${key}.wav`, // @spec VOICE-UTT-002
        sampleRate: info.sampleRate,
      });
      line.clauses.set(seq, { text, durationMs: info.durationMs });
      if (line.ended || line.evicted) return; // a stop or the sweep ended the line during the publish: no window (VOICE-STOP-009)
      if (seq === 0) this.armWindow(line); // @spec VOICE-CLAUSE-017
      else this.playNext(line); // @spec VOICE-CLAUSE-019
    } catch (err) {
      if (job.cancelled || this.stopped) return; // VOICE-ERR-003
      log.error({ err, text }, "tts failed"); // @spec VOICE-UTT-003
      this.endLine(line, seq); // @spec VOICE-CLAUSE-014, VOICE-CLAUSE-015, VOICE-CLAUSE-016
      await bus.publish("voice.done", { id: line.id, seq, sink: "error", final: true }); // @spec VOICE-CLAUSE-014, VOICE-SINK-006
    } finally {
      if (this.current === job) this.current = undefined;
    }
  }

  /** Stores the clause's WAV under its key, evicting the oldest past the limit; a claim on an evicted clause goes with it (VOICE-SINK-007). */
  private put(key: string, wav: Buffer): void { // @spec VOICE-HTTP-001, VOICE-HTTP-008, VOICE-SINK-007
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1); // a re-used key is the newest entry, once
    this.claimed.delete(key);
    this.store.set(key, wav);
    this.order.push(key);
    while (this.order.length > AUDIO_LIMIT) {
      const evicted = this.order.shift()!;
      this.store.delete(evicted);
      this.claimed.delete(evicted); // @spec VOICE-SINK-007
    }
  }

  // ---- virtual sink

  /** Publish a virtual-sink event; a failure is logged and never escapes a timer callback (VOICE-SINK-009). */
  private async publishVirtual(type: "voice.playing" | "voice.done", data: { id: string; seq: number } & Record<string, unknown>): Promise<void> { // @spec VOICE-SINK-009
    try {
      await this.d.bus.publish(type, { sink: "virtual", ...data } as never);
    } catch (err) {
      this.d.log.warn({ err, id: data.id, type }, "virtual sink publish failed");
    }
  }

  /** The claim window ends: an unclaimed line turns virtual, unless a sink gave up on it meanwhile (VOICE-SINK-004, VOICE-SINK-011). */
  private windowEnded(line: Line): void { // @spec VOICE-SINK-004, VOICE-SINK-011, VOICE-CLAUSE-018
    if (this.stopped || line.claimed) return;
    if (line.givenUp !== undefined) {
      const seq = line.givenUp;
      line.givenUp = undefined;
      this.endLine(line, seq);
      void this.publishVirtual("voice.done", { id: line.id, seq, final: true }); // @spec VOICE-SINK-011
      return;
    }
    line.virtual = true;
    this.playNext(line);
  }

  private armWindow(line: Line): void { // @spec VOICE-SINK-002, VOICE-CLAUSE-017
    line.window = setTimeout(() => {
      line.window = undefined;
      this.windowEnded(line);
    }, CLAIM_WINDOW_MS);
  }

  /** The virtual player plays the next clause once the previous virtual done was published and that clause is published (VOICE-CLAUSE-019). */
  private playNext(line: Line): void { // @spec VOICE-CLAUSE-009, VOICE-CLAUSE-012, VOICE-CLAUSE-019
    if (this.stopped || !line.virtual || line.playing || line.doneInFlight) return;
    const limit = line.ended ? line.playLimit : line.closed ? (line.through ?? 0) + 1 : Number.POSITIVE_INFINITY;
    if (line.vNext >= limit) {
      if (!line.ended) this.endLine(line, limit); // closed and played through (VOICE-CLAUSE-012)
      return;
    }
    const clause = line.clauses.get(line.vNext);
    if (clause) void this.playClause(line, line.vNext, clause); // else the clause's utterance publish calls playNext
  }

  /** The virtual `voice.playing` of one clause, then its `voice.done` after `durationMs` from when that publish resolved (VOICE-SINK-003). */
  private async playClause(line: Line, seq: number, clause: Clause): Promise<void> { // @spec VOICE-SINK-002, VOICE-SINK-003, VOICE-CLAUSE-019, VOICE-CLAUSE-020, VOICE-STOP-010
    const p: Playing = { seq, durationMs: clause.durationMs, publishing: true, startedAt: 0 };
    line.playing = p;
    line.vNext = seq + 1;
    line.lastActive = Date.now();
    await this.publishVirtual("voice.playing", { id: line.id, seq });
    if (this.stopped || line.playing !== p) return;
    p.publishing = false;
    p.startedAt = Date.now();
    if (p.stopped) { // a voice.stop arrived during the publish (VOICE-STOP-010)
      line.playing = undefined;
      await this.publishVirtual("voice.done", { id: line.id, seq, interrupted: true, ...splitText(p.stopped, 0) });
      return;
    }
    if (p.givenUp) { // a sink gave up on it during the publish (VOICE-SINK-012)
      line.playing = undefined;
      line.virtual = false;
      this.endLine(line, seq);
      await this.publishVirtual("voice.done", { id: line.id, seq, final: true });
      return;
    }
    if (line.claimed) { // a real sink claimed the line during the publish (VOICE-SINK-008, VOICE-CLAUSE-021)
      line.playing = undefined;
      line.virtual = false;
      if (line.streamed) await this.publishVirtual("voice.done", { id: line.id, seq, interrupted: true });
      return;
    }
    p.timer = setTimeout(() => {
      p.timer = undefined;
      void this.virtualDone(line, p);
    }, clause.durationMs);
  }

  private async virtualDone(line: Line, p: Playing): Promise<void> { // @spec VOICE-SINK-003, VOICE-CLAUSE-019, VOICE-CLAUSE-020
    if (this.stopped || line.playing !== p) return;
    line.playing = undefined;
    line.vLast = p.seq;
    // A closed line that has played through its `through` is over at once, so a give-up reported meanwhile changes nothing.
    if (line.closed && line.vNext >= (line.through ?? 0) + 1) this.endLine(line, (line.through ?? 0) + 1); // @spec VOICE-CLAUSE-012
    line.lastActive = Date.now();
    line.doneInFlight = true;
    await this.publishVirtual("voice.done", { id: line.id, seq: p.seq });
    line.doneInFlight = false;
    this.playNext(line);
  }

  /** A real sink's claim of a stored clause (VOICE-SINK-001, VOICE-SINK-005, VOICE-SINK-007). */
  private async playing(ev: BusEvent<"voice.playing">): Promise<void> {
    const d = ev.data;
    if (d.sink === "virtual") return; // @spec VOICE-SINK-005
    const key = keyOf(d.id, d.seq);
    if (!this.store.has(key)) return; // @spec VOICE-SINK-001, VOICE-SINK-007
    this.claimed.add(key);
    const line = this.lines.get(d.id);
    if (line) await this.claimLine(line);
  }

  /** Marks the line claimed and ends whatever the virtual player was doing (VOICE-SINK-008, VOICE-CLAUSE-021). */
  private async claimLine(line: Line): Promise<void> { // @spec VOICE-SINK-004, VOICE-SINK-008, VOICE-CLAUSE-021
    line.claimed = true;
    const wasVirtual = line.virtual;
    line.virtual = false;
    const p = line.playing;
    if (!line.streamed) { // VOICE-SINK-008: cancel the pending virtual done; a claim during the publish leaves none (playClause)
      if (p && !p.publishing && p.timer) {
        clearTimeout(p.timer);
        p.timer = undefined;
        line.playing = undefined;
      }
      return;
    }
    if (p) {
      if (p.publishing) return; // playClause publishes the interrupted done once the publish settles
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = undefined;
        line.playing = undefined;
        await this.publishVirtual("voice.done", { id: line.id, seq: p.seq, interrupted: true });
      }
      return;
    }
    if (wasVirtual && !line.ended && line.vLast !== undefined) { // between two virtual clauses
      await this.publishVirtual("voice.done", { id: line.id, seq: line.vLast, interrupted: true });
    }
  }

  /** A sink gave up on a clause (VOICE-SINK-010 to VOICE-SINK-013). */
  private async failed(ev: BusEvent<"voice.failed">): Promise<void> { // @spec VOICE-SINK-010, VOICE-SINK-011, VOICE-SINK-012, VOICE-SINK-013
    const { id, seq, fallback } = ev.data;
    const line = this.lines.get(id);
    if (fallback || !line || line.claimed || line.ended || !this.store.has(keyOf(id, seq))) return; // VOICE-SINK-013
    if (line.window) { // acted on when the window ends (VOICE-SINK-011)
      line.givenUp = seq;
      return;
    }
    const p = line.playing;
    if (p) {
      if (p.publishing) {
        if (p.seq === seq) p.givenUp = true; // acted on when the publish settles (VOICE-SINK-012)
        return;
      }
      if (p.timer && p.seq === seq) { // VOICE-SINK-012: cancel the pending done and release at once
        clearTimeout(p.timer);
        p.timer = undefined;
        line.playing = undefined;
        line.virtual = false;
        this.endLine(line, seq);
        await this.publishVirtual("voice.done", { id, seq, final: true });
      }
      return; // another clause is playing: VOICE-SINK-013
    }
    if (line.virtual) { // VOICE-SINK-011: a virtual line with no clause playing
      line.virtual = false;
      this.endLine(line, seq);
      await this.publishVirtual("voice.done", { id, seq, final: true });
    }
  }

  // ---- stop

  /** The inputs of a split for a line, taken before a stop cuts its queue: `cut` is the playing clause, or the next one when none plays (VOICE-CLAUSE-025). */
  private snapshot(line: Line, cut: number, playing: boolean): Split {
    const from = playing ? cut + 1 : cut;
    const before: Array<[number, string]> = [];
    const after: Array<[number, string]> = [];
    for (const [seq, c] of line.clauses) {
      if (seq < cut) before.push([seq, c.text]);
      else if (seq >= from) after.push([seq, c.text]);
    }
    for (const j of this.current ? [...this.queue, this.current] : this.queue) {
      if (j.line === line && j.seq >= from) after.push([j.seq, j.text]);
    }
    const byseq = (a: [number, string], b: [number, string]) => a[0] - b[0];
    return {
      before: before.sort(byseq).map(([, t]) => t),
      playing: playing ? line.clauses.get(cut) : undefined,
      after: after.sort(byseq).map(([, t]) => t),
    };
  }

  /**
   * `voice.stop`: end the named lines (every line without `ids`). A virtual line that is playing gets an interrupted done for
   * the playing clause, or for the last clause played between two; its queued and in-flight clauses are dropped and the in-flight
   * one is discarded. A line a real sink claimed is ended without any virtual event (VOICE-STOP-007).
   */
  private async stopLines(ev: BusEvent<"voice.stop">): Promise<void> { // @spec VOICE-STOP-001, VOICE-STOP-002, VOICE-STOP-003, VOICE-STOP-004, VOICE-STOP-005, VOICE-STOP-006, VOICE-STOP-007, VOICE-STOP-008, VOICE-STOP-009, VOICE-STOP-010, VOICE-CLAUSE-024, VOICE-CLAUSE-026
    const ids = ev.data.ids ? new Set(ev.data.ids) : undefined;
    const named = (id: string): boolean => !ids || ids.has(id);
    const dones: Array<{ id: string; seq: number; split: Split; elapsedMs: number }> = [];
    for (const line of this.lines.values()) {
      if (!named(line.id)) continue;
      const p = line.playing;
      if (!line.claimed) {
        if (p?.publishing) {
          p.stopped = this.snapshot(line, p.seq, true); // published when the playing publish settles
        } else if (p?.timer) {
          clearTimeout(p.timer);
          p.timer = undefined;
          dones.push({ id: line.id, seq: p.seq, split: this.snapshot(line, p.seq, true), elapsedMs: Date.now() - p.startedAt });
        } else if (!p && line.virtual && !line.ended && line.vLast !== undefined) { // VOICE-CLAUSE-026
          dones.push({ id: line.id, seq: line.vLast, split: this.snapshot(line, line.vLast + 1, false), elapsedMs: 0 });
        }
      }
      if (line.window) clearTimeout(line.window); // VOICE-STOP-005
      line.window = undefined;
      line.virtual = false;
      line.ended = true; // VOICE-CLAUSE-024
      if (!p?.publishing) line.playing = undefined;
    }
    this.queue = this.queue.filter((j) => !named(j.line.id)); // VOICE-STOP-003, VOICE-CLAUSE-024
    if (this.current && named(this.current.line.id)) this.current.cancelled = true; // VOICE-STOP-004
    for (const d of dones) {
      await this.publishVirtual("voice.done", { id: d.id, seq: d.seq, interrupted: true, ...splitText(d.split, d.elapsedMs) }); // @spec VOICE-STOP-006, VOICE-CLAUSE-025
    }
  }

  // ---- HTTP

  /** HTTP, GET and HEAD only: GET /audio/<id>-<seq>.wav, GET /fallback/manifest.json, GET /fallback/<name>, GET /health */
  handle = (req: http.IncomingMessage, res: http.ServerResponse): void => { // @spec VOICE-HTTP-002, VOICE-HTTP-003, VOICE-HTTP-004, VOICE-CLIP-008, VOICE-CLIP-011, VOICE-CLIP-012
    if (req.method !== "GET" && req.method !== "HEAD") { // @spec VOICE-HTTP-006
      res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return;
    }
    const path = pathOf(req.url); // @spec VOICE-HTTP-007
    const m = /^\/audio\/([\w-]+)\.wav$/.exec(path);
    if (m) {
      const wav = this.store.get(m[1]!);
      if (!wav) { res.writeHead(404); res.end("gone"); return; }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "access-control-allow-origin": "*" });
      res.end(wav);
      return;
    }
    const clips = this.d.clips;
    if (clips && path === "/fallback/manifest.json") {
      const manifest = clips.manifest();
      if (!manifest) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const clip = clips ? /^\/fallback\/([\w][\w.-]*)$/.exec(path) : null;
    if (clips && clip) {
      void clips.clipBytes(clip[1]!).then((wav) => {
        if (!wav) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
        res.end(wav);
      });
      return;
    }
    if (path === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  };
}
