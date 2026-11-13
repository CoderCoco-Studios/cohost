import type { Transform, Readable } from "node:stream";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { VoiceBasedChannel, Client } from "discord.js";
import prism from "prism-media";
import type { Frame, FrameSequencer } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { resample } from "@cohost/shared";

/** What the decoder emits: 48 kHz stereo, 20 ms per Opus packet. */
const DECODED = { rate: 48000, channels: 2 };
/** The source format of `audio.in.discord` (CONN-AUD-003). */
export const IN_FORMAT = { rate: 16000, channels: 1 };
const FRAME_MS = 20;
const DECODED_FRAME_BYTES = (DECODED.rate * FRAME_MS / 1000) * DECODED.channels * 2;
/** A speaker's Opus stream ends after this much silence, which only frees the capture slot (ears owns where an utterance ends). */
const SPEAKER_SILENCE_MS = 500;

export interface CaptureOptions {
  /** Appends one frame to `audio.in.discord`. */
  write(frame: Frame): Promise<unknown>;
  sequencer: FrameSequencer;
  log: Pick<Logger, "warn">;
  /** Replacement for tests: the Opus decoder (default prism-media's, 48 kHz stereo). */
  createDecoder?: () => Transform;
}

/** The slice of `client.users` that bot filtering needs. */
interface UserLookup {
  cache: { get(id: string): { bot: boolean } | undefined };
  fetch(id: string): Promise<{ bot: boolean }>;
}

/**
 * Per-speaker capture on the one voice connection: each human speaker's Opus stream is decoded, converted to 16 kHz mono
 * and written as 20 ms frames tagged with the speaker. Bots (including this one) are never read.
 */
export class SpeakerCapture {
  /** Frames dropped because the stream write failed. */
  dropped = 0;
  private connection: VoiceConnection | undefined;
  private readonly capturing = new Set<string>();
  private readonly streams = new Set<Readable>();
  private generation = 0;

  constructor(private readonly o: CaptureOptions) {}

  get running(): boolean { return this.connection !== undefined; }

  /** Start listening on a Ready connection. */
  // @spec CONN-DISC-006, CONN-DISC-007
  attach(conn: VoiceConnection, ctx: { client: Client; channel: VoiceBasedChannel }): void {
    this.detach();
    this.connection = conn;
    const gen = this.generation;
    conn.receiver.speaking.on("start", (userId: string) => {
      if (gen !== this.generation || this.capturing.has(userId) || userId === ctx.client.user?.id) return;
      // Claimed before the (possibly fetching) bot check, so a second "start" cannot open a second subscription.
      this.capturing.add(userId);
      void this.isHuman(userId, ctx.client.users as unknown as UserLookup).then((human) => {
        if (!human || gen !== this.generation) { this.capturing.delete(userId); return; }
        this.listenTo(conn, userId, ctx.channel);
      });
    });
  }

  /** Stop listening (the connection went away): open subscriptions are destroyed and the capture set emptied. */
  detach(): void {
    this.generation++;
    this.connection = undefined;
    for (const s of this.streams) s.destroy();
    this.streams.clear();
    this.capturing.clear();
  }

  private async isHuman(userId: string, users: UserLookup): Promise<boolean> {
    try {
      const user = users.cache.get(userId) ?? (await users.fetch(userId));
      return !user.bot;
    } catch {
      return false;
    }
  }

  private listenTo(conn: VoiceConnection, userId: string, channel: VoiceBasedChannel): void {
    const name = channel.guild.members.cache.get(userId)?.displayName ?? userId;
    const opus = conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SPEAKER_SILENCE_MS } });
    const decoder = this.o.createDecoder?.() ?? new prism.opus.Decoder({ rate: DECODED.rate, channels: DECODED.channels, frameSize: 960 });
    this.streams.add(opus);
    this.streams.add(decoder);
    const release = () => { this.capturing.delete(userId); this.streams.delete(opus); this.streams.delete(decoder); };
    let pending: Buffer = Buffer.alloc(0);
    opus.pipe(decoder);
    decoder.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= DECODED_FRAME_BYTES) {
        const pcm = resample(pending.subarray(0, DECODED_FRAME_BYTES), { from: DECODED, to: IN_FORMAT });
        pending = pending.subarray(DECODED_FRAME_BYTES);
        const frame: Frame = { epoch: this.o.sequencer.epoch, seq: this.o.sequencer.next(), rate: IN_FORMAT.rate, ch: IN_FORMAT.channels, pcm, spk: userId, name };
        void this.o.write(frame).catch(() => { this.dropped++; });
      }
    });
    decoder.on("end", release);
    // @spec CONN-DISC-007
    decoder.on("error", (err: Error) => { release(); this.o.log.warn({ err: err.message }, "decoder error"); });
    opus.on("error", (err: Error) => { release(); this.o.log.warn({ err: err.message }, "decoder error"); });
  }
}
