/** PCM helpers: a synthesized WAV of any rate becomes the 48 kHz stereo s16le Discord plays, and an output's gain scales it. */
import { parseWav, resample } from "@cohost/shared";

// @spec MOUTH-AUD-002
/** Any-rate mono/stereo 16-bit WAV -> 48k stereo s16le raw PCM (for Discord playback), by the shared `resample`. */
export function wavToDiscordPcm(wav: Buffer): Buffer {
  const { sampleRate, channels, dataOffset, dataLength } = readWavHeader(wav);
  return resample(wav.subarray(dataOffset, dataOffset + dataLength), { from: { rate: sampleRate, channels }, to: { rate: 48000, channels: 2 } });
}

// @spec MOUTH-ROUTE-005
/**
 * Scale s16le PCM by 10^(gainDb/20), rounding and clamping every sample to the signed 16-bit range. A gain of 0 returns
 * the input itself, so the default path is bit-identical to no gain. The input is never modified.
 */
export function applyGain(pcm: Buffer, gainDb: number): Buffer {
  if (gainDb === 0) return pcm;
  const factor = 10 ** (gainDb / 20);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor))), i);
  }
  return out;
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
