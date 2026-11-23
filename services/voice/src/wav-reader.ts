/**
 * The streaming WAV reader shared by the kokoro, openai and pocket adapters (VOICE-WAV-*). It walks the chunks from the
 * RIFF header to `data`, never trusts the RIFF or data size (a streamed header cannot know them), requires 16-bit PCM,
 * one channel and a sample rate from 8000 to 48000, and yields the PCM after `data` as whole frames.
 */
import type { TtsAudio } from "./engine.js";

export interface WavReadOpts {
  /** Called when PCM bytes arrive from the body after the `data` chunk header (header bytes do not count). */
  onPcm?: () => void;
}

const MIN_RATE = 8000;
const MAX_RATE = 48000;

const fail = (what: string) => new Error(`tts audio: ${what}`);

/** Read the header of a WAV body and return its format with the PCM as the chunks (VOICE-WAV-001 to VOICE-WAV-008). */
export async function readWavStream(body: AsyncIterable<Uint8Array>, opts: WavReadOpts = {}): Promise<TtsAudio> { // @spec VOICE-WAV-001, VOICE-WAV-002, VOICE-WAV-003, VOICE-WAV-004, VOICE-WAV-005, VOICE-WAV-006, VOICE-WAV-007, VOICE-WAV-008, VOICE-ENG-004
  const it = body[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let ended = false;

  /** Ensure `n` bytes are buffered if the body has them; false when it ends first. */
  const fill = async (n: number): Promise<boolean> => {
    while (pending.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else pending = Buffer.concat([pending, toBuffer(r.value)]);
    }
    return pending.length >= n;
  };
  const take = (n: number): Buffer => {
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };
  const skip = async (n: number): Promise<void> => {
    let left = n;
    while (left > 0) {
      if (!(await fill(1))) throw fail("no data chunk");
      const k = Math.min(left, pending.length);
      take(k);
      left -= k;
    }
  };

  if (!(await fill(12)) || take(4).toString("latin1") !== "RIFF") throw fail("not a WAV file");
  take(4);
  if (take(4).toString("latin1") !== "WAVE") throw fail("not a WAV file");

  let format: { tag: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  for (;;) {
    if (!(await fill(8))) throw fail("no data chunk");
    const id = take(4).toString("latin1");
    const size = take(4).readUInt32LE(0);
    if (id === "data") break;
    const padded = size + (size % 2);
    if (id === "fmt ") {
      if (size < 16 || !(await fill(size))) throw fail("unsupported format: fmt chunk truncated");
      const f = take(size);
      format = { tag: f.readUInt16LE(0), channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), bitsPerSample: f.readUInt16LE(14) };
      if (size % 2) await skip(1);
      validate(format);
    } else {
      await skip(padded);
    }
  }
  if (!format) throw fail("no fmt chunk");

  // The data chunk header is consumed; everything after it is PCM.
  const onPcm = opts.onPcm;
  const frame = format.channels * 2;
  async function* pcm(): AsyncIterable<Buffer> {
    let carry: Buffer = pending;
    pending = Buffer.alloc(0);
    if (carry.length > 0) onPcm?.();
    for (;;) {
      const whole = carry.length - (carry.length % frame);
      if (whole > 0) {
        yield carry.subarray(0, whole);
        carry = carry.subarray(whole);
      }
      if (ended) break;
      const r = await it.next();
      if (r.done) { ended = true; break; }
      onPcm?.();
      carry = carry.length ? Buffer.concat([carry, toBuffer(r.value)]) : toBuffer(r.value);
    }
  }
  return { format: { sampleRate: format.sampleRate, channels: 1, bitDepth: 16 }, chunks: pcm() };
}

function validate(f: { tag: number; channels: number; sampleRate: number; bitsPerSample: number }): void { // @spec VOICE-WAV-002, VOICE-WAV-003, VOICE-WAV-004, VOICE-WAV-005
  if (f.tag !== 1) throw fail(`unsupported format tag ${f.tag}`);
  if (f.bitsPerSample !== 16) throw fail(`unsupported bit depth ${f.bitsPerSample}`);
  if (f.channels !== 1) throw fail(`unsupported channel count ${f.channels}`);
  if (f.sampleRate < MIN_RATE || f.sampleRate > MAX_RATE) throw fail(`unsupported sample rate ${f.sampleRate}`);
}

function toBuffer(v: Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
