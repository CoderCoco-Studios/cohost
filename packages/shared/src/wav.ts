/** WAV parser and writer shared by voice (envelope, duration, stub synth) and ears (resampling, injected-clip duration, STT wav). */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
}

export interface ParseWavOptions {
  /** Require the `RIFF`/`WAVE` header (default true). `false` starts the chunk walk at offset 12 unchecked. */
  requireRiff?: boolean;
}

// @spec VOICE-ENV-001, VOICE-ENV-002, EARS-AUD-003
/**
 * Walks the RIFF chunks (odd sizes padded) and returns the `fmt ` fields plus the `data` chunk's offset
 * and length, clamped to the bytes present. Does not check the format tag.
 * Throws `not a RIFF/WAVE file` or `no data chunk`.
 */
export function parseWav(buf: Buffer, opts: ParseWavOptions = {}): WavInfo {
  if (opts.requireRiff !== false && (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")) {
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

// @spec EARS-AUD-004
/** Wraps raw s16le PCM in a canonical 44-byte PCM16 WAV header. */
export function wavWrap(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
