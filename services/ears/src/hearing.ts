import { randomUUID } from "node:crypto";
import type { Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { resample, wavWrap } from "@cohost/shared";
import type { Clip, HearOutcome } from "./capture.js";
import type { EchoGate } from "./echo.js";
import { NO_BATCH_ENGINE } from "./engines.js";
import { hasWordCharacter, isDropPhrase } from "./transcript.js";

export interface HearingDeps {
  cfg: Config["ears"];
  bus: Publisher;
  log: Logger;
  /** 16k mono WAV → text through the batch engine; `fallback` marks a live utterance a streaming engine could not serve. */
  transcribe: (wav: Buffer, fallback: boolean) => Promise<string>;
  /** The echo gate and the sources it applies to (EARS-ECHO-008); absent means none. */
  echo?: { gate: EchoGate; sources: ReadonlySet<string> };
}

/** One clip or utterance's identity and speaker, as `speech.heard` carries them. */
export interface HeardMeta {
  speaker: string;
  speakerId?: string;
  source?: string;
  audioEndedAt?: number;
  utteranceId?: string;
  /** Epoch ms ears closed the utterance, when it did (EARS-EARLY-020). */
  closedAt?: number;
  /** Early reply: the `seq` and speech-to-text time of the early transcript this final reuses (EARS-EARLY-016). */
  earlySeq?: number;
  earlySttMs?: number;
  /** The final arrived after an early transcription it waited for at the close (EARS-EARLY-018). */
  earlyLate?: true;
}

// @spec EARS-HEAR-004, EARS-HEAR-005, EARS-HEAR-006, EARS-HEAR-007, EARS-HEAR-008, EARS-HEAR-011, EARS-HEAR-012
/** One clip or utterance → `speech.heard`: duration gate, 16 kHz mono WAV, STT, word check and drop-phrase filter. */
export class Hearing {
  constructor(private d: HearingDeps) {}

  // @spec EARS-CAP-001, EARS-SRC-006, EARS-SRC-007
  /**
   * One clip from a capture source (any rate and channel count) -> `speech.heard`, with the `speakerId` the source gave
   * (none for a clip source), through the one gate, STT, word check and drop-phrase filter. Says what happened.
   */
  async heardClip(clip: Clip, speaker: string, source?: string, speakerId?: string): Promise<HearOutcome> {
    const durationMs = (clip.pcm.length / (2 * clip.channels) / clip.rate) * 1000;
    if (durationMs < this.d.cfg.min_speech_ms) return { heard: false, reason: "too-short" };
    // @spec EARS-ECHO-004, EARS-ECHO-008
    if (source !== undefined && this.d.echo?.sources.has(source) && this.d.echo.gate.blocks(clip.audioEndedAt ?? Date.now())) return { heard: false, reason: "echo" };
    const wav = wavWrap(resample(clip.pcm, { from: { rate: clip.rate, channels: clip.channels }, to: { rate: 16000, channels: 1 } }), 16000, 1);
    const utteranceId = clip.utteranceId ?? randomUUID(); // @spec EARS-PART-003
    try {
      const text = await this.d.transcribe(wav, clip.fallback === true);
      return await this.publish(text, durationMs, { speaker, speakerId, source, audioEndedAt: clip.audioEndedAt, utteranceId, closedAt: clip.closedAt });
    } catch (err) {
      return this.failed(err);
    }
  }

  // @spec EARS-SES-004
  /** A final text of a streamed utterance (from its session's `finish()`) → `speech.heard` through the same checks as a clip. */
  async heardText(text: string, durationMs: number, meta: HeardMeta): Promise<HearOutcome> {
    try {
      return await this.publish(text, durationMs, meta);
    } catch (err) {
      return this.failed(err);
    }
  }

  private async publish(text: string, durationMs: number, m: HeardMeta): Promise<HearOutcome> {
    const { speaker, speakerId, source, audioEndedAt, utteranceId, closedAt, earlySeq, earlySttMs, earlyLate } = m;
    text = text.trim();
    if (!hasWordCharacter(text)) return { heard: false, reason: "empty" };
    // @spec EARS-HEAR-010
    if (isDropPhrase(text, this.d.cfg.drop_phrases)) {
      this.d.log.debug({ speaker, text }, "dropped (drop phrase)");
      return { heard: false, reason: "drop-phrase" };
    }
    this.d.log.info({ speaker, durationMs: Math.round(durationMs), text }, "heard");
    const timing = { ...(audioEndedAt === undefined ? {} : { audioEndedAt }), ...(closedAt === undefined ? {} : { closedAt }) };
    await this.d.bus.publish("speech.heard", { speaker, ...(speakerId === undefined ? {} : { speakerId }), text, durationMs: Math.round(durationMs), ...(source === undefined ? {} : { source }), ...(utteranceId === undefined ? {} : { utteranceId }), ...(Object.keys(timing).length === 0 ? {} : { timing }), ...(earlySeq === undefined ? {} : { earlySeq }), ...(earlySttMs === undefined ? {} : { earlySttMs }), ...(earlyLate ? { earlyLate: true as const } : {}) });
    return { heard: true, text };
  }

  // @spec EARS-SES-011, EARS-SES-013, EARS-ENG-005
  private failed(err: unknown): HearOutcome {
    const detail = err instanceof Error ? err.message : String(err);
    this.d.log.warn({ err: detail }, "transcription failed");
    return { heard: false, reason: detail === NO_BATCH_ENGINE ? "no-batch-engine" : "stt-error" };
  }
}
