import type { EventInput, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { applyGain, wavToDiscordPcm } from "./audio.js";
import type { FallbackClip } from "./clips.js";

/** How long a WAV fetch may take (MOUTH-PLAY-010). */
export const FETCH_TIMEOUT_MS = 15_000;
/** How long past the audio's own duration the player may take to go idle (MOUTH-PLAY-011). */
export const STUCK_GRACE_MS = 10_000;
/** Queued utterances an output holds besides its current one (MOUTH-PLAY-012). */
export const MAX_QUEUE = 20;
/** Lines an output keeps a record of (MOUTH-CLAUSE-001). */
export const REMEMBERED_LINES = 50;
/** Time without clause activity after which an open line has ended (MOUTH-CLAUSE-005). */
export const LINE_IDLE_MS = 300_000;

/**
 * One clause of a line as an output takes it (MOUTH-PLAY-003): what the utterance said and its length, and its `seq` (0 for a line
 * that is not streamed). `more` is set on clause 0 of a streamed line (MOUTH-CLAUSE-002).
 */
export interface LineText { text: string; durationMs: number; seq?: number; more?: true }

/** `voice.stop` as an output reads it: the named lines, or every line without `ids` (MOUTH-STOP-002). */
export interface StopOrder { ids?: string[] }

export interface PlaybackDeps {
  bus: Publisher;
  log: Logger;
  /** The output's sink name, published as `sink` on every `voice.*` event this output sends (MOUTH-ROUTE-001). */
  sink: string;
  /** The output's `gain_db` (a function for the live value, MOUTH-LIVE-002), applied to every utterance and fallback clip before the player gets it (MOUTH-ROUTE-005). */
  gainDb: number | (() => number);
  /** Fetch the WAV a voice.utterance points at. */
  fetchAudio: (url: string) => Promise<Buffer>;
  /**
   * Hand the prepared audio (48k stereo PCM, by default) to the output's audio player, with the clause it is (`id`, `seq`). An output
   * that writes the audio out over time returns a promise that settles once the first of it has gone out: it resolving is "audio has
   * started", it rejecting is a give-up (MOUTH-PLAY-005).
   */
  play: (pcm: Buffer, id: string, seq: number) => void | Promise<void>;
  /**
   * Stop the output's audio player for line `id`: the watchdog's way out of a stuck item and the way a `voice.stop` ends the
   * current one (MOUTH-STOP-003). The player's Idle that causes ends no item.
   */
  stop?: (id: string) => void | Promise<void>;
  /** Millisecond clock for the spoken-portion estimate (default `performance.now`). */
  now?: () => number;
  /** Whether an interrupted `voice.done` carries `spokenText` / `unsaidText` (the `discord` and `dryrun` outputs, MOUTH-STOP-005). */
  spoken?: boolean;
  /** Turn a fetched WAV into what `play` takes; default: 48k stereo s16le PCM with the output's gain. */
  prepare?: (wav: Buffer) => Buffer;
  /** Playing time of what `prepare` returned, ms; default: its length read as 48k stereo s16le. */
  durationOf?: (audio: Buffer) => number;
  /** Test knobs; the defaults are the constants above. */
  fetchTimeoutMs?: number;
  watchdogGraceMs?: number;
  maxQueue?: number;
  lineIdleMs?: number;
  /** The spoken fallback line; without it a give-up is a silent skip. */
  fallback?: { pick(id: string, seq: number): FallbackClip | undefined; started(clip: FallbackClip): void; markBad(clip: FallbackClip): void };
}

// @spec MOUTH-PLAY-010
export async function httpAudio(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch audio ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** One clause as the output holds it. `queued` until it is taken up, `current` from its fetch, `done` once it has finished. */
interface Clause { seq: number; text: string; durationMs: number; state: "queued" | "current" | "done" | "dropped" }

/** The output's record of one line (MOUTH-CLAUSE-001): its clauses in order, and whether it is open and ended here. */
interface LineRec {
  id: string;
  /** Clause 0 has published `voice.playing` on this output. */
  open: boolean;
  /** Clause 0 was a streamed line's (`more`): only a streamed line's give-up or clip is reported `final` (MOUTH-CLAUSE-009, 010). */
  streamed: boolean;
  ended: boolean;
  /** The closing `brain.clause`'s `through`, or 0 for a line that is not streamed. */
  through?: number;
  clauses: Clause[];
  lastActivity: number;
}

/** A queued or current clause with the line it belongs to. */
interface Item { id: string; seq: number; url: string; line: LineRec; clause: Clause }

// @spec MOUTH-CLAUSE-001, MOUTH-CLAUSE-002, MOUTH-CLAUSE-003, MOUTH-CLAUSE-004, MOUTH-CLAUSE-005, MOUTH-CLAUSE-006, MOUTH-CLAUSE-007, MOUTH-CLAUSE-008, MOUTH-CLAUSE-009, MOUTH-CLAUSE-010, MOUTH-CLAUSE-011, MOUTH-CLAUSE-012, MOUTH-CLAUSE-013, MOUTH-CLAUSE-014, MOUTH-CLAUSE-015, MOUTH-CLAUSE-016, MOUTH-CLAUSE-017, MOUTH-STOP-003, MOUTH-STOP-005, MOUTH-STOP-007, MOUTH-STOP-008
/**
 * One output's queue: plays utterances (clauses of lines) one at a time and reports `voice.playing` / `voice.done` for each clause
 * under the output's sink name, keeping the per-line record that open, skip, end, stop and final rules need.
 * @spec MOUTH-PLAY-002, MOUTH-PLAY-003, MOUTH-PLAY-004, MOUTH-PLAY-005, MOUTH-PLAY-006, MOUTH-PLAY-009, MOUTH-PLAY-010, MOUTH-PLAY-011, MOUTH-PLAY-012, MOUTH-ROUTE-001, MOUTH-ROUTE-004
 */
export class Playback {
  private queue: Item[] = [];
  private lines = new Map<string, LineRec>();
  /** A closing `through` that arrived before its line's clause 0 (newest `REMEMBERED_LINES` ids), applied when clause 0 arrives (MOUTH-CLAUSE-005). */
  private pendingThrough = new Map<string, number>();
  private current: Item | undefined;
  /** `voice.playing` has been published for the current item (so a `voice.stop` ends it with a `voice.done`). */
  private playing = false;
  private playingSince = 0;
  /** A `voice.stop` named the current item before it started playing: the pump drops it silently (MOUTH-STOP-010). */
  private abandoned: Item | undefined;
  /** The current item is a fallback clip, whose failure is already reported. */
  private clipPlaying = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Set while the watchdog stops the player, so the Idle that causes ends nothing. */
  private stopping = false;
  private closed = false;

  constructor(private d: PlaybackDeps) {}

  /**
   * Queue clause `seq` (0 when absent) of line `id`. Clause 0 starts a line record. A later clause is taken only for a line that
   * has not ended, is within its `through` and has had clause activity within the idle bound; anything else is skipped without an event
   * (MOUTH-CLAUSE-004, 005, 007). A full queue first drops the oldest queued line not open, whole, or, when every queued line is open,
   * the oldest queued clause's line (MOUTH-PLAY-012, MOUTH-CLAUSE-012).
   * @spec MOUTH-PLAY-012, MOUTH-CLAUSE-002, MOUTH-CLAUSE-004, MOUTH-CLAUSE-005, MOUTH-CLAUSE-007, MOUTH-CLAUSE-012
   */
  enqueue(id: string, url: string, utt?: LineText): Promise<void> {
    const seq = utt?.seq ?? 0;
    const now = this.nowMs();
    let line: LineRec | undefined;
    if (seq === 0) {
      line = this.newLine(id, utt?.more === true);
      const pending = this.pendingThrough.get(id);
      if (pending !== undefined) { line.through = pending; this.pendingThrough.delete(id); }
    } else {
      line = this.lines.get(id);
      if (!line || line.ended) return Promise.resolve();
      if (this.expired(line)) { this.endLine(line); return Promise.resolve(); }
      if (line.through !== undefined && seq > line.through) return Promise.resolve();
    }
    line.lastActivity = now;
    const clause: Clause = { seq, text: utt?.text ?? "", durationMs: utt?.durationMs ?? 0, state: "queued" };
    line.clauses.push(clause);
    if (this.queue.length >= (this.d.maxQueue ?? MAX_QUEUE)) {
      this.makeRoom();
      if (line.ended) return Promise.resolve();
    }
    this.queue.push({ id, seq, url, line, clause });
    return this.pump();
  }

  /**
   * The closing `brain.clause` of line `id` reached this output: drop its queued clauses above `through` without events, and end the
   * line at once when clause `through` has already finished (MOUTH-CLAUSE-005, 006). Otherwise the line ends when that clause finishes.
   * @spec MOUTH-CLAUSE-005, MOUTH-CLAUSE-006
   */
  closeLine(id: string, through: number): void {
    const line = this.lines.get(id);
    if (!line) {
      // The closing event beat clause 0: keep it for the line (MOUTH-CLAUSE-005).
      this.pendingThrough.delete(id);
      this.pendingThrough.set(id, through);
      while (this.pendingThrough.size > REMEMBERED_LINES) this.pendingThrough.delete(this.pendingThrough.keys().next().value!);
      return;
    }
    if (line.ended) return;
    if (this.expired(line)) { this.endLine(line); return; }
    line.through = through;
    for (const q of this.queue) if (q.line === line && q.seq > through) q.clause.state = "dropped";
    this.queue = this.queue.filter((q) => q.line !== line || q.seq <= through);
    if (line.clauses.some((c) => c.seq === through && c.state === "done")) this.endLine(line);
  }

  /**
   * This output cannot take clause `seq` of line `id` (not ready, or switched off live). An open line publishes `voice.done` for that
   * clause with `final` and ends; a line never opened here ends silently (MOUTH-CLAUSE-008).
   * @spec MOUTH-CLAUSE-008, MOUTH-CLAUSE-004
   */
  async refuse(id: string, seq: number): Promise<void> {
    const line = this.lines.get(id);
    if (!line || line.ended) return;
    if (this.expired(line)) { this.endLine(line); return; }
    const wasOpen = line.open && line.streamed;
    this.endLine(line);
    if (wasOpen) await this.publish("voice.done", { id, seq, sink: this.d.sink, final: true });
  }

  /**
   * Apply a `voice.stop`: drop the queued clauses of the named lines silently and end them; stop the current clause when it is named,
   * publishing one `voice.done` with `interrupted` (and the spoken estimate) when it had started playing, or abandoning it silently when it
   * had not; for a named open line with no clause current, publish one interrupted `voice.done` for its last played clause.
   * @spec MOUTH-STOP-002, MOUTH-STOP-003, MOUTH-STOP-005, MOUTH-STOP-006, MOUTH-STOP-007, MOUTH-STOP-008, MOUTH-STOP-009, MOUTH-STOP-010, MOUTH-CLAUSE-013, MOUTH-CLAUSE-014, MOUTH-CLAUSE-015, MOUTH-CLAUSE-016, MOUTH-CLAUSE-017
   */
  async stop(order: StopOrder): Promise<void> {
    const named = (id: string): boolean => !order.ids || order.ids.includes(id);
    const cur = this.current;
    const curNamed = cur !== undefined && named(cur.id);
    // A line idle past the bound ends here without a report (MOUTH-CLAUSE-005); the current clause's line keeps its clock.
    for (const line of this.lines.values()) if (!line.ended && line !== cur?.line && this.expired(line)) this.endLine(line);
    const targets = new Set<LineRec>();
    for (const line of this.lines.values()) if (!line.ended && named(line.id)) targets.add(line);
    if (curNamed) targets.add(cur!.line);

    const elapsed = this.playing ? this.nowMs() - this.playingSince : 0;
    const reports: { id: string; seq: number; split?: { spokenText: string; unsaidText: string } }[] = [];
    for (const line of targets) {
      const playingHere = curNamed && this.playing && cur!.line === line;
      if (playingHere) {
        const split = this.d.spoken && !this.clipPlaying ? this.split(line, cur, elapsed) : undefined;
        reports.push({ id: line.id, seq: cur!.seq, ...(split ? { split } : {}) });
        continue;
      }
      // No clause is playing: an open line with a played clause is between clauses (MOUTH-CLAUSE-014). A clause still being
      // fetched is not current, so it is unsaid text, not a reason to report nothing.
      if (line.ended || !line.open) continue;
      const done = line.clauses.filter((c) => c.state === "done");
      if (done.length === 0) continue;
      const split = this.d.spoken ? this.split(line, undefined, elapsed) : undefined;
      reports.push({ id: line.id, seq: done[done.length - 1]!.seq, ...(split ? { split } : {}) });
    }
    for (const line of targets) this.endLine(line);

    if (curNamed) {
      if (!this.playing) {
        this.abandoned = cur;
      } else {
        this.disarm();
        this.current = undefined;
        this.playing = false;
        this.clipPlaying = false;
        this.stopping = true;
        try {
          await this.d.stop?.(cur!.id);
        } catch (err) {
          this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed");
        } finally {
          this.stopping = false;
        }
      }
    }
    for (const r of reports) {
      await this.publish("voice.done", { id: r.id, seq: r.seq, sink: this.d.sink, interrupted: true, ...(r.split ?? {}) });
    }
    void this.pump(); // the stop itself does not wait for the next item to start
  }

  private nowMs(): number { return this.d.now ? this.d.now() : performance.now(); }

  /** Cancel the watchdog and start nothing more; for shutdown. */
  close(): void {
    this.closed = true;
    this.disarm();
  }

  private disarm(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  /** The player has audio of `durationMs`: it must go idle within that plus the grace, or the item is stuck. */
  private arm(item: Item, durationMs: number): void {
    this.disarm();
    if (this.closed) return;
    const ms = durationMs + (this.d.watchdogGraceMs ?? STUCK_GRACE_MS);
    this.watchdog = setTimeout(() => void this.stuck(item, ms), ms);
    this.watchdog.unref();
  }

  /**
   * The watchdog fired: stop the player (its Idle is ignored), then end the item as the give-up path does: a stuck clause is given up (a
   * clip in its place when eligible), a stuck clip is released with a `final` `voice.done`; then the next item.
   */
  private async stuck(item: Item, ms: number): Promise<void> {
    if (this.current !== item) return;
    this.watchdog = undefined;
    this.d.log.warn({ id: item.id, output: this.d.sink }, "playback stuck");
    this.stopping = true;
    try {
      await this.d.stop?.(item.id);
    } catch (err) {
      this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed");
    } finally {
      this.stopping = false;
    }
    if (this.clipPlaying) {
      this.current = undefined;
      this.playing = false;
      this.clipPlaying = false;
      await this.publish("voice.done", { id: item.id, seq: item.seq, sink: this.d.sink, ...(item.line.streamed ? { final: true as const } : {}) });
    } else {
      if (await this.giveUp(item, `playback stuck: player not idle ${Math.round(ms)} ms after the audio started`)) return;
      this.current = undefined;
      this.playing = false;
    }
    return this.pump();
  }

  /** The player went idle: whatever was playing has finished. */
  async onIdle(): Promise<void> {
    if (this.stopping) return;
    this.disarm();
    const item = this.current;
    const clip = this.clipPlaying;
    this.current = undefined;
    this.playing = false;
    this.clipPlaying = false;
    if (item) {
      item.clause.state = "done";
      item.line.lastActivity = this.nowMs();
      if (!clip && item.line.through === item.seq) this.endLine(item.line); // the closing clause has finished (MOUTH-CLAUSE-005)
      await this.publish("voice.done", { id: item.id, seq: item.seq, sink: this.d.sink, ...(clip && item.line.streamed ? { final: true as const } : {}) });
    }
    return this.pump();
  }

  /** Convert as an utterance and apply the output's gain. */
  private pcmOf(wav: Buffer): Buffer {
    return this.d.prepare ? this.d.prepare(wav) : applyGain(wavToDiscordPcm(wav), typeof this.d.gainDb === "function" ? this.d.gainDb() : this.d.gainDb);
  }

  private durationOf(audio: Buffer): number {
    return this.d.durationOf ? this.d.durationOf(audio) : (audio.length / (48_000 * 4)) * 1000;
  }

  /** The fetch, abandoned after the timeout. */
  private async fetchWav(url: string): Promise<Buffer> {
    const ms = this.d.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.d.fetchAudio(url),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fetch audio timed out after ${ms} ms`)), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async pump(): Promise<void> {
    if (this.closed || this.current) return;
    let next: Item | undefined;
    while (this.queue.length > 0) {
      const cand = this.queue.shift()!;
      if (!cand.line.ended && this.expired(cand.line)) this.endLine(cand.line);
      if (!this.takes(cand)) { cand.clause.state = "dropped"; continue; }
      next = cand;
      break;
    }
    if (!next) return;
    next.clause.state = "current";
    this.current = next;
    this.playing = false;
    this.abandoned = undefined;
    try {
      const pcm = this.pcmOf(await this.fetchWav(next.url));
      if (this.abandoned === next || !this.takes(next)) return this.drop(next, false);
      await this.d.play(pcm, next.id, next.seq);
      if (this.abandoned === next) return this.drop(next, true);
      this.arm(next, this.durationOf(pcm));
    } catch (err) {
      if (this.abandoned === next) return this.drop(next, false);
      this.d.log.warn({ err: String(err) }, "playback failed");
      if (await this.giveUp(next, String(err))) return; // a fallback clip is playing: it stays current until the player is idle
      this.current = undefined;
      return this.pump();
    }
    this.playing = true;
    this.playingSince = this.nowMs();
    next.line.lastActivity = this.playingSince;
    if (next.seq === 0) next.line.open = true;
    await this.publish("voice.playing", { id: next.id, seq: next.seq, sink: this.d.sink });
  }

  /** No clause activity on the line for the idle bound (MOUTH-CLAUSE-005). */
  private expired(line: LineRec): boolean {
    return this.nowMs() - line.lastActivity >= (this.d.lineIdleMs ?? LINE_IDLE_MS);
  }

  /** Whether a queued or fetched clause may still play: its line has not ended and it is within the closing `through`. */
  private takes(item: Item): boolean {
    return !item.line.ended && (item.line.through === undefined || item.seq <= item.line.through);
  }

  /** A new line record, replacing any earlier record of the same id; the newest `REMEMBERED_LINES` are kept. A line that is not streamed closes at clause 0 (`through` 0). */
  private newLine(id: string, streamed: boolean): LineRec {
    const line: LineRec = { id, open: false, streamed, ended: false, ...(streamed ? {} : { through: 0 }), clauses: [], lastActivity: this.nowMs() };
    this.lines.delete(id);
    this.lines.set(id, line);
    while (this.lines.size > REMEMBERED_LINES) this.lines.delete(this.lines.keys().next().value!);
    return line;
  }

  /** End a line on this output: its queued clauses are dropped without events and later clauses are skipped (MOUTH-CLAUSE-007). */
  private endLine(line: LineRec): void {
    line.ended = true;
    this.queue = this.queue.filter((q) => {
      if (q.line !== line) return true;
      q.clause.state = "dropped";
      return false;
    });
    line.clauses = line.clauses.filter((c) => c.state !== "dropped");
  }

  /** A full queue: drop the oldest queued line not open on this output, whole; else the oldest queued clause's line (MOUTH-PLAY-012). */
  private makeRoom(): void {
    const victim = this.queue.find((q) => !q.line.open) ?? this.queue[0];
    if (!victim) return;
    const wasOpen = victim.line.open;
    this.endLine(victim.line);
    this.d.log.warn({ id: victim.id, output: this.d.sink }, "queue full: dropped oldest queued utterance");
    // An open line that loses its oldest queued clause ends here: `final` releases its claim promptly (MOUTH-CLAUSE-012).
    if (wasOpen) void this.publish("voice.done", { id: victim.id, seq: victim.seq, sink: this.d.sink, final: true });
  }

  /** The current item was stopped before it started playing (MOUTH-STOP-010), or its line ended while it was fetched: forget it, stopping the player if it had begun. */
  private async drop(item: Item, started: boolean): Promise<void> {
    this.abandoned = undefined;
    this.current = undefined;
    this.disarm();
    if (started) {
      this.stopping = true;
      try { await this.d.stop?.(item.id); } catch (err) { this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed"); } finally { this.stopping = false; }
    }
    return this.pump();
  }

  /**
   * This output gives up on `item`: its line ends here; say a fallback clip in its place when one is eligible, claim the clause with
   * `voice.playing` (first, so it reaches voice early inside its claim window), then report `voice.failed`. With no clip, an open line
   * gets a `final` `voice.done` after the failure. Resolves true while a clip is playing.
   */
  // @spec MOUTH-PLAY-006, MOUTH-FALL-001, MOUTH-FALL-002, MOUTH-FALL-003, MOUTH-FALL-008, MOUTH-FALL-011, MOUTH-CLAUSE-009, MOUTH-CLAUSE-010
  private async giveUp(item: Item, reason: string): Promise<boolean> {
    const wasOpen = item.line.open && item.line.streamed;
    this.endLine(item.line);
    const clip = this.d.fallback?.pick(item.id, item.seq);
    let playing: FallbackClip | undefined;
    if (clip) {
      let pcm: Buffer | undefined;
      try {
        pcm = this.pcmOf(clip.wav);
      } catch (err) {
        this.d.fallback!.markBad(clip);
        this.d.log.warn({ err: String(err), clip: clip.name }, "fallback clip failed conversion");
      }
      if (pcm) {
        try {
          await this.d.play(pcm, item.id, item.seq);
          this.d.fallback!.started(clip);
          playing = clip;
          this.clipPlaying = true;
          this.arm(item, this.durationOf(pcm));
        } catch (err) {
          this.d.log.warn({ err: String(err), clip: clip.name }, "fallback clip play failed");
        }
      }
    }
    if (playing) {
      this.playing = true;
      this.playingSince = this.nowMs();
      await this.publish("voice.playing", { id: item.id, seq: item.seq, sink: this.d.sink });
    }
    await this.publish("voice.failed", { id: item.id, seq: item.seq, sink: this.d.sink, reason, ...(playing ? { fallback: { clip: playing.name, text: playing.text } } : {}) });
    if (!playing && wasOpen) await this.publish("voice.done", { id: item.id, seq: item.seq, sink: this.d.sink, final: true });
    return playing !== undefined;
  }

  /**
   * The spoken and unsaid split of line `line` (MOUTH-CLAUSE-016): the texts of its finished clauses and the spoken prefix of the
   * current clause, and the rest of the current clause with the queued clauses of the line.
   */
  private split(line: LineRec, cur: Item | undefined, elapsed: number): { spokenText: string; unsaidText: string } {
    const played = line.clauses.filter((c) => c.state === "done").map((c) => c.text);
    let prefix = "";
    let rest = "";
    if (cur) {
      const fraction = cur.clause.durationMs > 0 ? elapsed / cur.clause.durationMs : 1;
      ({ spokenText: prefix, unsaidText: rest } = spokenSplit(cur.clause.text, fraction));
    }
    const queued = line.clauses.filter((c) => c.state === "queued" || (c.state === "current" && c !== cur?.clause)).map((c) => c.text);
    return {
      spokenText: [...played, prefix].filter((s) => s !== "").join(" "),
      unsaidText: [rest, ...queued].filter((s) => s !== "").join(" "),
    };
  }

  /** Publish; a failure is logged and never escapes (MOUTH-PLAY-009). */
  private async publish<T extends "voice.playing" | "voice.failed" | "voice.done">(type: T, data: EventInput<T>): Promise<void> {
    try {
      await this.d.bus.publish(type, data);
    } catch (err) {
      this.d.log.warn({ err: String(err), id: data.id }, `${type} publish failed`);
    }
  }
}

/**
 * The longest prefix of `text` that ends at a word boundary at or before `fraction` of its characters (clamped to 0..1), and the rest
 * without leading whitespace (MOUTH-STOP-005).
 */
export function spokenSplit(text: string, fraction: number): { spokenText: string; unsaidText: string } {
  const limit = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * text.length;
  let end = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const at = m.index! + m[0].length;
    if (at <= limit) end = at;
  }
  return { spokenText: text.slice(0, end), unsaidText: text.slice(end).replace(/^\s+/, "") };
}
