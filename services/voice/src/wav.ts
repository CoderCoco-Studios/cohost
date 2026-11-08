/** Mouth-envelope extractor over `parseWav` (from `@cohost/shared`). PCM 16-bit only (what Kokoro emits). */
import type { WavInfo } from "@cohost/shared";

/**
 * RMS per window, normalised to 0..1 with a soft knee so normal speech reads
 * as ~0.3-0.8 mouth-open rather than hugging zero.
 */
export function envelope(buf: Buffer, info: WavInfo, hz = 30): number[] { // @spec VOICE-ENV-003, VOICE-ENV-004
  if (info.bitsPerSample !== 16) throw new Error(`unsupported bit depth ${info.bitsPerSample}`);
  const frameBytes = info.channels * 2;
  const totalFrames = Math.floor(info.dataLength / frameBytes);
  const win = Math.max(1, Math.floor(info.sampleRate / hz));
  const out: number[] = [];
  for (let start = 0; start < totalFrames; start += win) {
    const end = Math.min(totalFrames, start + win);
    let acc = 0;
    for (let f = start; f < end; f++) {
      const s = buf.readInt16LE(info.dataOffset + f * frameBytes) / 32768;
      acc += s * s;
    }
    const rms = Math.sqrt(acc / (end - start));
    out.push(Math.min(1, Math.pow(rms / 0.22, 0.8)));
  }
  // light smoothing so the mouth doesn't flicker
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i]!, out[i - 1]! * 0.6);
  return out.map((v) => Math.round(v * 100) / 100);
}
