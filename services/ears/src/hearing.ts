import type { Publisher } from "@cohost/bus";
import { urls, type Config, type Logger } from "@cohost/config";
import { discordPcmToWav16k } from "./audio.js";

export interface HearingDeps {
  cfg: Config["ears"];
  bus: Publisher;
  log: Logger;
  /** 16k mono WAV → text. */
  transcribe: (wav: Buffer) => Promise<string>;
}

const EXT: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "mp4",
};

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

/** One speaker's utterance (48k stereo PCM, ended by silence) → `speech.heard`. */
export class Hearing {
  constructor(private d: HearingDeps) {}

  async heard(pcm: Buffer, speaker: string, speakerId: string): Promise<void> {
    const durationMs = (pcm.length / 4 / 48000) * 1000;
    if (durationMs < this.d.cfg.min_speech_ms) return;
    try {
      const text = await this.d.transcribe(discordPcmToWav16k(pcm));
      if (!text || /^\W*$/.test(text)) return;
      this.d.log.info({ speaker, durationMs: Math.round(durationMs), text }, "heard");
      await this.d.bus.publish("speech.heard", { speaker, speakerId, text, durationMs: Math.round(durationMs) });
    } catch (err) {
      this.d.log.warn({ err: String(err) }, "transcription failed");
    }
  }
}
