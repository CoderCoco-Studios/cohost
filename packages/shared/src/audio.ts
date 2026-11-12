/** WAV parsing and writing and PCM resampling, shared by voice, ears and mouth (SHARED-AUDIO). */

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

// @spec SHARED-AUDIO-001, SHARED-AUDIO-002, SHARED-AUDIO-003
/**
 * Walks the RIFF chunks (odd sizes padded) and returns the `fmt ` fields plus the `data` chunk's offset
 * and length, clamped to the bytes present. Accepts only 16-bit PCM (format tag 1, or extensible with a PCM subformat).
 * Throws `not a RIFF/WAVE file`, `no data chunk` or `unsupported wav: <cause>`.
 */
export function parseWav(buf: Buffer, opts: ParseWavOptions = {}): WavInfo {
  if (opts.requireRiff !== false && (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")) {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (body + 16 > buf.length) throw new Error("unsupported wav: truncated fmt chunk");
      const tag = buf.readUInt16LE(body);
      const pcm = tag === 1 || (tag === 0xfffe && size >= 40 && body + 26 <= buf.length && buf.readUInt16LE(body + 24) === 1);
      if (!pcm) throw new Error(`unsupported wav: format tag ${tag} is not PCM`);
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
      if (!fmt.channels) throw new Error("unsupported wav: zero channels");
      if (!fmt.sampleRate) throw new Error("unsupported wav: zero sample rate");
      if (fmt.bitsPerSample !== 16) throw new Error(`unsupported wav: ${fmt.bitsPerSample}-bit samples (only 16-bit)`);
    } else if (id === "data") {
      if (!fmt) throw new Error("unsupported wav: fmt chunk missing or after the data chunk");
      const dataLength = Math.min(size, buf.length - body);
      const frames = dataLength / (fmt.channels * (fmt.bitsPerSample / 8));
      return { ...fmt, dataOffset: body, dataLength, durationMs: (frames / fmt.sampleRate) * 1000 };
    }
    off = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

// @spec SHARED-AUDIO-004
/** Wraps raw s16le PCM in a canonical 44-byte PCM16 WAV header. */
export function wavWrap(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export interface PcmFormat { rate: number; channels: number }

const clamp16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

/** One input frame's channels as the output's channel count: per channel when equal, averaged down, the first channel copied up. */
function mixFrame(frame: number[], channels: number): number[] {
  if (frame.length === channels) return frame;
  if (channels < frame.length) return new Array<number>(channels).fill(frame.reduce((a, b) => a + b, 0) / frame.length);
  return new Array<number>(channels).fill(frame[0]!);
}

/**
 * Convert signed 16-bit little-endian PCM between sample rates and channel counts. An integer downsampling ratio
 * averages each group of input frames (a low-pass: 48 kHz stereo to 16 kHz mono for speech-to-text); any other
 * ratio interpolates linearly (any rate to 48 kHz stereo for Discord playback). Samples are rounded and clamped;
 * bytes short of a whole input frame are ignored.
 */
// @spec SHARED-AUDIO-005, SHARED-AUDIO-006, SHARED-AUDIO-007, SHARED-AUDIO-008
export function resample(pcm: Buffer, { from, to }: { from: PcmFormat; to: PcmFormat }): Buffer {
  const inFrames = Math.floor(pcm.length / (2 * from.channels));
  const frame = (i: number): number[] => {
    const f: number[] = [];
    for (let c = 0; c < from.channels; c++) f.push(pcm.readInt16LE((i * from.channels + c) * 2));
    return mixFrame(f, to.channels);
  };
  const integerDown = from.rate > to.rate && from.rate % to.rate === 0;
  const group = from.rate / to.rate;
  const outFrames = integerDown ? Math.floor(inFrames / group) : Math.floor((inFrames * to.rate) / from.rate);
  const out = Buffer.alloc(outFrames * to.channels * 2);
  for (let o = 0; o < outFrames; o++) {
    const lo = integerDown ? undefined : (() => { const pos = o * (from.rate / to.rate); const i0 = Math.floor(pos); return { i0, i1: Math.min(inFrames - 1, i0 + 1), frac: pos - i0 }; })();
    for (let c = 0; c < to.channels; c++) {
      let v: number;
      if (!lo) {
        let acc = 0;
        for (let k = 0; k < group; k++) acc += frame(o * group + k)[c]!;
        v = acc / group;
      } else {
        const a = frame(lo.i0)[c]!;
        v = a + (frame(lo.i1)[c]! - a) * lo.frac;
      }
      out.writeInt16LE(clamp16(v), (o * to.channels + c) * 2);
    }
  }
  return out;
}
