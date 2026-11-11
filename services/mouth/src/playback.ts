import type { EventInput, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { applyGain, wavToDiscordPcm } from "./audio.js";
import type { FallbackClip } from "./fallback.js";

export interface PlaybackDeps {
  bus: Publisher;
  log: Logger;
  /** The output's sink name, published as `sink` on every `voice.*` event this output sends (MOUTH-ROUTE-001). */
  sink: string;
  /** The output's `gain_db`, applied to every utterance and fallback clip before the player gets it (MOUTH-ROUTE-005). */
  gainDb: number;
  /** Fetch the WAV a voice.utterance points at. */
  fetchAudio: (url: string) => Promise<Buffer>;
  /** Hand 48k stereo PCM to the output's audio player. */
  play: (pcm: Buffer) => void;
  /** The spoken fallback line; without it a give-up is a silent skip. */
  fallback?: { pick(id: string): FallbackClip | undefined; started(clip: FallbackClip): void; markBad(clip: FallbackClip): void };
}

export async function httpAudio(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch audio ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// @spec MOUTH-PLAY-002, MOUTH-PLAY-003, MOUTH-PLAY-004, MOUTH-PLAY-005, MOUTH-PLAY-006, MOUTH-PLAY-009, MOUTH-ROUTE-001, MOUTH-ROUTE-004
/** One output's queue: plays utterances one at a time and reports voice.playing / voice.done for each under the output's sink name. */
export class Playback {
  private queue: { id: string; url: string }[] = [];
  private current: string | undefined;

  constructor(private d: PlaybackDeps) {}

  enqueue(id: string, url: string): Promise<void> {
    this.queue.push({ id, url });
    return this.pump();
  }

  /** The player went idle: whatever was playing has finished. */
  async onIdle(): Promise<void> {
    const id = this.current;
    this.current = undefined;
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
    return applyGain(wavToDiscordPcm(wav), this.d.gainDb);
  }

  private async pump(): Promise<void> {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next.id;
    try {
      const pcm = this.pcmOf(await this.d.fetchAudio(next.url));
      this.d.play(pcm);
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
          this.d.play(pcm);
          this.d.fallback!.started(clip);
          playing = clip;
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
  private async publish<T extends "voice.playing" | "voice.failed">(type: T, data: EventInput<T>): Promise<void> {
    try {
      await this.d.bus.publish(type, data);
    } catch (err) {
      this.d.log.warn({ err: String(err), id: data.id }, `${type} publish failed`);
    }
  }
}
