/** PCM helpers: a synthesized WAV of any rate becomes the 48 kHz stereo s16le Discord plays, and an output's gain scales it. */
import { parseWav } from "@cohost/shared";

// @spec MOUTH-AUD-001
/** Any-rate mono/stereo 16-bit WAV -> 48k stereo s16le raw PCM (for Discord playback). Linear interpolation. */
export function wavToDiscordPcm(wav: Buffer): Buffer {
  const { sampleRate, channels, dataOffset, dataLength } = readWavHeader(wav);
  const inFrames = Math.floor(dataLength / (channels * 2));
  const outFrames = Math.floor((inFrames * 48000) / sampleRate);
  const out = Buffer.alloc(outFrames * 4);
  const ratio = sampleRate / 48000;
  for (let o = 0; o < outFrames; o++) {
    const pos = o * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const frac = pos - i0;
    for (let c = 0; c < 2; c++) {
      const ch = Math.min(c, channels - 1);
      const a = wav.readInt16LE(dataOffset + (i0 * channels + ch) * 2);
      const b = wav.readInt16LE(dataOffset + (i1 * channels + ch) * 2);
      out.writeInt16LE(Math.round(a + (b - a) * frac), (o * 2 + c) * 2);
    }
  }
  return out;
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
