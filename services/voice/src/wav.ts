/** Tiny WAV reader + mouth-envelope extractor. PCM 16-bit only (what Kokoro emits). */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
}

export function parseWav(buf: Buffer): WavInfo {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let sampleRate = 0, channels = 0, bitsPerSample = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      const dataLength = Math.min(size, buf.length - body);
      const frames = dataLength / (channels * (bitsPerSample / 8));
      return { sampleRate, channels, bitsPerSample, dataOffset: body, dataLength, durationMs: (frames / sampleRate) * 1000 };
    }
    off = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/**
 * RMS per window, normalised to 0..1 with a soft knee so normal speech reads
 * as ~0.3-0.8 mouth-open rather than hugging zero.
 */
export function envelope(buf: Buffer, info: WavInfo, hz = 30): number[] {
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
