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

/** What the utterance said and its length, to estimate the spoken part of an interrupted line (MOUTH-STOP-005). */
export interface LineText { text: string; durationMs: number }

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
   * Hand the prepared audio (48k stereo PCM, by default) to the output's audio player. An output that writes the audio out
   * over time returns a promise that settles once the first of it has gone out: it resolving is "audio has started", it
   * rejecting is a give-up (MOUTH-PLAY-005).
   */
  play: (pcm: Buffer, id: string) => void | Promise<void>;
  /**
   * Stop the output's audio player for item `id`: the watchdog's way out of a stuck item and the way a `voice.stop` ends the
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
  /** The spoken fallback line; without it a give-up is a silent skip. */
  fallback?: { pick(id: string): FallbackClip | undefined; started(clip: FallbackClip): void; markBad(clip: FallbackClip): void };
}

// @spec MOUTH-PLAY-010
export async function httpAudio(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch audio ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// @spec MOUTH-PLAY-002, MOUTH-PLAY-003, MOUTH-PLAY-004, MOUTH-PLAY-005, MOUTH-PLAY-006, MOUTH-PLAY-009, MOUTH-PLAY-010, MOUTH-PLAY-011, MOUTH-PLAY-012, MOUTH-ROUTE-001, MOUTH-ROUTE-004
/** One output's queue: plays utterances one at a time and reports voice.playing / voice.done for each under the output's sink name. */
export class Playback {
  private queue: { id: string; url: string; utt?: LineText }[] = [];
  private current: string | undefined;
  private currentUtt: LineText | undefined;
  /** `voice.playing` has been published for the current item (so a `voice.stop` ends it with a `voice.done`). */
  private playing = false;
  private playingSince = 0;
  /** A `voice.stop` named the current item before it started playing: the pump drops it silently (MOUTH-STOP-010). */
  private abandoned: string | undefined;
  /** The current item is a fallback clip, whose failure is already reported. */
  private clipPlaying = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Set while the watchdog stops the player, so the Idle that causes ends no item. */
  private stopping = false;
  private closed = false;

  constructor(private d: PlaybackDeps) {}

  enqueue(id: string, url: string, utt?: LineText): Promise<void> {
    if (this.queue.length >= (this.d.maxQueue ?? MAX_QUEUE)) {
      const dropped = this.queue.shift()!;
      this.d.log.warn({ id: dropped.id, output: this.d.sink }, "queue full: dropped oldest queued utterance");
    }
    this.queue.push({ id, url, utt });
    return this.pump();
  }

  /**
   * Apply a `voice.stop`: drop the named queued items silently; stop the current item when it is named, publishing one `voice.done`
   * with `interrupted` (and the spoken estimate) when it had started playing, or abandoning it silently when it had not.
   * @spec MOUTH-STOP-002, MOUTH-STOP-003, MOUTH-STOP-006, MOUTH-STOP-007, MOUTH-STOP-008, MOUTH-STOP-009, MOUTH-STOP-010
   */
  async stop(order: StopOrder): Promise<void> {
    const named = (id: string): boolean => !order.ids || order.ids.includes(id);
    this.queue = this.queue.filter((q) => !named(q.id));
    const id = this.current;
    if (id === undefined || !named(id)) return;
    if (!this.playing) { this.abandoned = id; return; }
    const utt = this.currentUtt;
    const elapsed = this.nowMs() - this.playingSince;
    const clip = this.clipPlaying;
    this.disarm();
    this.current = undefined;
    this.currentUtt = undefined;
    this.playing = false;
    this.clipPlaying = false;
    this.stopping = true;
    try {
      await this.d.stop?.(id);
    } catch (err) {
      this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed");
    } finally {
      this.stopping = false;
    }
    const heard = this.d.spoken && !clip && utt ? spokenSplit(utt.text, elapsed / utt.durationMs) : undefined;
    await this.publish("voice.done", { id, sink: this.d.sink, interrupted: true, ...heard });
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
  private arm(id: string, durationMs: number): void {
    this.disarm();
    if (this.closed) return;
    const ms = durationMs + (this.d.watchdogGraceMs ?? STUCK_GRACE_MS);
    this.watchdog = setTimeout(() => void this.stuck(id, ms), ms);
    this.watchdog.unref();
  }

  /**
   * The watchdog fired: stop the player (its Idle is ignored), then end the item as the give-up path does: a stuck utterance
   * is given up (a clip in its place when eligible), a stuck clip is released with `voice.done`; then the next item.
   */
  private async stuck(id: string, ms: number): Promise<void> {
    if (this.current !== id) return;
    this.watchdog = undefined;
    this.d.log.warn({ id, output: this.d.sink }, "playback stuck");
    this.stopping = true;
    try {
      await this.d.stop?.(id);
    } catch (err) {
      this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed");
    } finally {
      this.stopping = false;
    }
    if (this.clipPlaying) {
      this.current = undefined;
      this.playing = false;
      this.clipPlaying = false;
      await this.publish("voice.done", { id, sink: this.d.sink });
    } else {
      if (await this.giveUp(id, `playback stuck: player not idle ${Math.round(ms)} ms after the audio started`)) return;
      this.current = undefined;
      this.playing = false;
    }
    return this.pump();
  }

  /** The player went idle: whatever was playing has finished. */
  async onIdle(): Promise<void> {
    if (this.stopping) return;
    this.disarm();
    const id = this.current;
    this.current = undefined;
    this.playing = false;
    this.clipPlaying = false;
    if (id) {
      try {
        await this.d.bus.publish("voice.done", { id, sink: this.d.sink });
      } catch (err) {
        this.d.log.warn({ err: String(err), id }, "voice.done publish failed");
      }
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
    if (this.closed || this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next.id;
    this.currentUtt = next.utt;
    this.playing = false;
    this.abandoned = undefined;
    try {
      const pcm = this.pcmOf(await this.fetchWav(next.url));
      if (this.abandoned === next.id) return this.drop(next.id, false);
      await this.d.play(pcm, next.id);
      if (this.abandoned === next.id) return this.drop(next.id, true);
      this.arm(next.id, this.durationOf(pcm));
    } catch (err) {
      if (this.abandoned === next.id) return this.drop(next.id, false);
      this.d.log.warn({ err: String(err) }, "playback failed");
      if (await this.giveUp(next.id, String(err))) return; // a fallback clip is playing: it stays current until the player is idle
      this.current = undefined;
      return this.pump();
    }
    this.playing = true;
    this.playingSince = this.nowMs();
    await this.publish("voice.playing", { id: next.id, sink: this.d.sink });
  }

  /** The current item was stopped before it started playing (MOUTH-STOP-010): forget it, stopping the player if it had begun. */
  private async drop(id: string, started: boolean): Promise<void> {
    this.abandoned = undefined;
    this.current = undefined;
    this.currentUtt = undefined;
    this.disarm();
    if (started) {
      this.stopping = true;
      try { await this.d.stop?.(id); } catch (err) { this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed"); } finally { this.stopping = false; }
    }
    return this.pump();
  }

  /**
   * This output gives up on `id`: say a fallback clip in its place when one is eligible, claim the id with `voice.playing` (first,
   * so it reaches voice early inside its claim window), then report `voice.failed`. Resolves true while a clip is playing.
   */
  // @spec MOUTH-PLAY-006, MOUTH-FALL-001, MOUTH-FALL-002, MOUTH-FALL-003, MOUTH-FALL-008, MOUTH-FALL-011
  private async giveUp(id: string, reason: string): Promise<boolean> {
    const clip = this.d.fallback?.pick(id);
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
          await this.d.play(pcm, id);
          this.d.fallback!.started(clip);
          playing = clip;
          this.clipPlaying = true;
          this.arm(id, this.durationOf(pcm));
        } catch (err) {
          this.d.log.warn({ err: String(err), clip: clip.name }, "fallback clip play failed");
        }
      }
    }
    if (playing) {
      this.playing = true;
      this.playingSince = this.nowMs();
      await this.publish("voice.playing", { id, sink: this.d.sink });
    }
    await this.publish("voice.failed", { id, sink: this.d.sink, reason, ...(playing ? { fallback: { clip: playing.name, text: playing.text } } : {}) });
    return playing !== undefined;
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
