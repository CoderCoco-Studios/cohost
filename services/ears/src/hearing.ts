import { randomUUID } from "node:crypto";
import type { Publisher } from "@cohost/bus";
import { urls, type Config, type Logger } from "@cohost/config";
import { resample, wavWrap } from "@cohost/shared";
import { wavDurationMs } from "./audio.js";
import type { Clip, HearOutcome } from "./capture.js";
import type { EchoGate } from "./echo.js";
import { hasWordCharacter, isDropPhrase } from "./transcript.js";

export interface HearingDeps {
  cfg: Config["ears"];
  bus: Publisher;
  log: Logger;
  /** 16k mono WAV → text. */
  transcribe: (wav: Buffer) => Promise<string>;
  /** The echo gate and the sources it applies to (EARS-ECHO-008); absent means none. */
  echo?: { gate: EchoGate; sources: ReadonlySet<string> };
}

const EXT: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "mp4",
};

// @spec EARS-HEAR-005
/** The STT container (speaches / faster-whisper, OpenAI-compatible). */
export function sttTranscriber(cfg: Config["ears"]): (audio: Buffer, hint?: { contentType: string }) => Promise<string> {
  return async (wav, hint) => {
    const type = hint?.contentType.split(";")[0]?.trim() || "audio/wav";
    const form = new FormData();
    form.append("file", new Blob([wav], { type }), `speech.${EXT[type] ?? "wav"}`);
    form.append("model", cfg.stt_model);
    form.append("language", "en");
    form.append("response_format", "json");
    const res = await fetch(`${urls.stt()}/v1/audio/transcriptions`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  };
}

// @spec EARS-STUB-001
/** The stub engine: no network, fixed text carrying the clip's duration (0 when the bytes are not a WAV). */
export function stubTranscriber(): (audio: Buffer, hint?: { contentType: string }) => Promise<string> {
  return async (audio) => `stub transcript (${wavDurationMs(audio)} ms)`;
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
    return this.finish(wav, durationMs, speaker, speakerId, source, clip.audioEndedAt, clip.utteranceId ?? randomUUID()); // @spec EARS-PART-003
  }

  private async finish(wav: Buffer, durationMs: number, speaker: string, speakerId?: string, source?: string, audioEndedAt?: number, utteranceId?: string): Promise<HearOutcome> {
    try {
      const text = await this.d.transcribe(wav);
      if (!hasWordCharacter(text)) return { heard: false, reason: "empty" };
      // @spec EARS-HEAR-010
      if (isDropPhrase(text, this.d.cfg.drop_phrases)) {
        this.d.log.debug({ speaker, text }, "dropped (drop phrase)");
        return { heard: false, reason: "drop-phrase" };
      }
      this.d.log.info({ speaker, durationMs: Math.round(durationMs), text }, "heard");
      await this.d.bus.publish("speech.heard", { speaker, ...(speakerId === undefined ? {} : { speakerId }), text, durationMs: Math.round(durationMs), ...(source === undefined ? {} : { source }), ...(utteranceId === undefined ? {} : { utteranceId }), ...(audioEndedAt === undefined ? {} : { timing: { audioEndedAt } }) });
      return { heard: true, text };
    } catch (err) {
      this.d.log.warn({ err: String(err) }, "transcription failed");
      return { heard: false, reason: "stt-error" };
    }
  }
}
