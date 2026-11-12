import { PassThrough, type Readable } from "node:stream";
import { createAudioResource, StreamType, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import type { Frame } from "@cohost/bus";

/** The sink format of `audio.out.discord` (CONN-AUD-003). */
export const OUT_FORMAT = { rate: 48000, channels: 2 };

export interface PlayoutOptions {
  player: Pick<AudioPlayer, "play" | "stop">;
  /** Most PCM held for the player before frames are dropped, bytes (default 10 s of 48 kHz stereo). */
  maxBufferedBytes?: number;
  /** An utterance whose `last` frame never arrives is ended after this much silence, ms (default 2000). */
  idleMs?: number;
  /** Replacement for tests (default: a raw s16le resource, which is what Discord's player takes at 48 kHz stereo). */
  createResource?: (stream: Readable) => AudioResource;
}

/**
 * Turns `audio.out` frames into audio on one player: an utterance is one raw stream that frames are written to in `seq`
 * order and that `last` ends; a gap plays the frames present without stalling, a late or repeated frame is dropped.
 */
export class Playout {
  /** Frames not played: late, repeated, or over the buffer cap. */
  dropped = 0;
  private stream: PassThrough | undefined;
  private utt: string | undefined;
  private epoch: number | undefined;
  private lastSeq = -1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly max: number;
  private readonly idleMs: number;

  constructor(private readonly o: PlayoutOptions) {
    this.max = o.maxBufferedBytes ?? OUT_FORMAT.rate * OUT_FORMAT.channels * 2 * 10;
    this.idleMs = o.idleMs ?? 2000;
  }

  // @spec CONN-DISC-008
  push(f: Frame): void {
    if (f.epoch === this.epoch && f.seq <= this.lastSeq) { this.dropped++; return; }
    if (f.epoch !== this.epoch) { this.epoch = f.epoch; }
    this.lastSeq = f.seq;
    if (!this.stream || f.utt !== this.utt) this.begin(f.utt);
    const s = this.stream!;
    if (s.readableLength + s.writableLength + f.pcm.length > this.max) this.dropped++;
    else s.write(f.pcm);
    if (f.last) this.finish();
    else this.touch();
  }

  /** The connection went away: drop what is playing and what is queued. */
  close(): void {
    this.finish();
    this.o.player.stop();
    this.epoch = undefined;
    this.lastSeq = -1;
  }

  private begin(utt: string | undefined): void {
    this.finish();
    this.utt = utt;
    const stream = new PassThrough();
    this.stream = stream;
    this.o.player.play(this.o.createResource?.(stream) ?? createAudioResource(stream, { inputType: StreamType.Raw }));
  }

  private finish(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    this.stream?.end();
    this.stream = undefined;
    this.utt = undefined;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.finish(), this.idleMs);
    this.idle.unref?.();
  }
}
