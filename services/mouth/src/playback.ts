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

export interface PlaybackDeps {
  bus: Publisher;
  log: Logger;
  /** The output's sink name, published as `sink` on every `voice.*` event this output sends (MOUTH-ROUTE-001). */
  sink: string;
  /** The output's `gain_db` (a function for the live value, MOUTH-LIVE-002), applied to every utterance and fallback clip before the player gets it (MOUTH-ROUTE-005). */
  gainDb: number | (() => number);
  /** Fetch the WAV a voice.utterance points at. */
  fetchAudio: (url: string) => Promise<Buffer>;
  /** Hand the prepared audio (48k stereo PCM, by default) to the output's audio player. */
  play: (pcm: Buffer, id: string) => void;
  /** Stop the output's audio player (the watchdog's way out of a stuck item). The player's Idle that causes ends no item. */
  stop?: () => void;
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
  private queue: { id: string; url: string }[] = [];
  private current: string | undefined;
  /** The current item is a fallback clip, whose failure is already reported. */
  private clipPlaying = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Set while the watchdog stops the player, so the Idle that causes ends no item. */
  private stopping = false;
  private closed = false;

  constructor(private d: PlaybackDeps) {}

  enqueue(id: string, url: string): Promise<void> {
    if (this.queue.length >= (this.d.maxQueue ?? MAX_QUEUE)) {
      const dropped = this.queue.shift()!;
      this.d.log.warn({ id: dropped.id, output: this.d.sink }, "queue full: dropped oldest queued utterance");
    }
    this.queue.push({ id, url });
    return this.pump();
  }

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
      this.d.stop?.();
    } catch (err) {
      this.d.log.warn({ err: String(err), output: this.d.sink }, "player stop failed");
    } finally {
      this.stopping = false;
    }
    if (this.clipPlaying) {
      this.current = undefined;
      this.clipPlaying = false;
      await this.publish("voice.done", { id, sink: this.d.sink });
    } else {
      if (await this.giveUp(id, `playback stuck: player not idle ${Math.round(ms)} ms after the audio started`)) return;
      this.current = undefined;
    }
    return this.pump();
  }

  /** The player went idle: whatever was playing has finished. */
  async onIdle(): Promise<void> {
    if (this.stopping) return;
    this.disarm();
    const id = this.current;
    this.current = undefined;
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
    try {
      const pcm = this.pcmOf(await this.fetchWav(next.url));
      this.d.play(pcm, next.id);
      this.arm(next.id, this.durationOf(pcm));
    } catch (err) {
      this.d.log.warn({ err: String(err) }, "playback failed");
      if (await this.giveUp(next.id, String(err))) return; // a fallback clip is playing: it stays current until the player is idle
      this.current = undefined;
      return this.pump();
    }
    await this.publish("voice.playing", { id: next.id, sink: this.d.sink });
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
          this.d.play(pcm, id);
          this.d.fallback!.started(clip);
          playing = clip;
          this.clipPlaying = true;
          this.arm(id, this.durationOf(pcm));
        } catch (err) {
          this.d.log.warn({ err: String(err), clip: clip.name }, "fallback clip play failed");
        }
      }
    }
    if (playing) await this.publish("voice.playing", { id, sink: this.d.sink });
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
