/** PCM helpers: Discord gives us 48 kHz stereo s16le; Whisper wants 16 kHz mono. The conversion itself is the shared `resample`. */
import { parseWav, resample, wavWrap } from "@cohost/shared";

// @spec EARS-AUD-005
/** 48k stereo s16le -> 16k mono s16le WAV (for STT). */
export function discordPcmToWav16k(pcm: Buffer): Buffer {
  return wavWrap(resample(pcm, { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } }), 16000, 1);
}

/** Thin adapter over the shared `parseWav`: no RIFF/WAVE check, and any failure reads as `bad wav`. */
export function readWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataOffset: number; dataLength: number } {
  try {
    const { sampleRate, channels, dataOffset, dataLength } = parseWav(buf, { requireRiff: false });
    return { sampleRate, channels, dataOffset, dataLength };
  } catch {
    throw new Error("bad wav");
  }
}
