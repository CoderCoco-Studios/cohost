import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { wavToDiscordPcm } from "./audio.js";

export interface PlaybackDeps {
  bus: Publisher;
  log: Logger;
  /** Fetch the WAV a voice.utterance points at. */
  fetchAudio: (url: string) => Promise<Buffer>;
  /** Hand 48k stereo PCM to the Discord audio player. */
  play: (pcm: Buffer) => void;
}

export async function httpAudio(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch audio ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// @spec EARS-PLAY-002, EARS-PLAY-003, EARS-PLAY-004, EARS-PLAY-005, EARS-PLAY-009
/** Plays utterances one at a time and reports voice.playing / voice.done for each. */
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
        await this.d.bus.publish("voice.done", { id, sink: "discord" });
      } catch (err) {
        this.d.log.warn({ err: String(err), id }, "voice.done publish failed");
      }
    }
    return this.pump();
  }

  private async pump(): Promise<void> {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next.id;
    try {
      const pcm = wavToDiscordPcm(await this.d.fetchAudio(next.url));
      this.d.play(pcm);
      await this.d.bus.publish("voice.playing", { id: next.id, sink: "discord" });
    } catch (err) {
      this.d.log.warn({ err: String(err) }, "playback failed");
      this.current = undefined;
      await this.pump();
    }
  }
}
