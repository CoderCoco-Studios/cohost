import { test } from "node:test";
import assert from "node:assert/strict";
import { readWavStream } from "../src/wav-reader.js";
import { chunk, iter, pcm, pieces, streamedHeader, wavBytes } from "./tts-helpers.js";

/** Read a body fully: the format the reader reports and every PCM chunk it yields. */
async function read(parts: Buffer[]) {
  const audio = await readWavStream(iter(parts));
  const out: Buffer[] = [];
  for await (const c of audio.chunks) out.push(c);
  return { format: audio.format, chunks: out, pcm: Buffer.concat(out) };
}

// @spec VOICE-WAV-001
test("the reader walks chunks to `data`, rounding odd chunk sizes up to even, and never reads the RIFF or data size", async () => {
  const data = pcm(1000);
  const odd = chunk("LIST", Buffer.from("abcde")); // 5 bytes + a pad byte
  const bodies = [
    wavBytes(data, { before: [odd] }),
    wavBytes(data, { before: [odd], riffSize: 0, dataSize: 0 }), // placeholders: too small
    wavBytes(data, { before: [odd], riffSize: 0xffffffff, dataSize: 0xffffffff }), // placeholders: too large
    wavBytes(data, { before: [odd], riffSize: 12, dataSize: 2 }), // plausible but wrong
  ];
  for (const body of bodies) assert.deepEqual((await read([body])).pcm, data);
});

// @spec VOICE-WAV-001, VOICE-WAV-006
test("a header split across response chunks (down to one byte each) reads the same as one whole", async () => {
  const data = pcm(500);
  const body = wavBytes(data, { before: [chunk("LIST", Buffer.from("abc"))], riffSize: 0xffffffff, dataSize: 0xffffffff });
  for (const size of [1, 2, 3, 7, 13, 44]) assert.deepEqual((await read(pieces(body, [size]))).pcm, data, `chunks of ${size}`);
});

// @spec VOICE-WAV-006
test("the reader reports the header's format and takes every byte after `data` as PCM, however many the data size claims", async () => {
  const data = pcm(2000);
  const r = await read([streamedHeader({ rate: 22050 }), data]);
  assert.deepEqual(r.format, { sampleRate: 22050, channels: 1, bitDepth: 16 });
  assert.deepEqual(r.pcm, data);
  // a data size smaller than the bytes that follow does not cut the audio
  assert.deepEqual((await read([wavBytes(data, { dataSize: 4 })])).pcm, data);
});

// @spec VOICE-WAV-006, VOICE-ENG-004
test("a trailing partial frame is dropped and every delivered chunk holds whole frames, in order", async () => {
  const data = pcm(1001);
  const body = Buffer.concat([streamedHeader(), data, Buffer.from([0x7f])]); // one stray byte at the end
  for (const size of [1, 3, 5, 101]) {
    const r = await read(pieces(body, [size]));
    assert.ok(r.chunks.every((c) => c.length > 0 && c.length % 2 === 0), `whole frames only (chunks of ${size})`);
    assert.deepEqual(r.pcm, data, `chunks of ${size}`);
  }
});

// @spec VOICE-WAV-002, VOICE-WAV-003, VOICE-WAV-004, VOICE-WAV-005
test("audio that is not 16-bit mono PCM at 8 to 48 kHz fails with a named error", async () => {
  const bad = (o: Parameters<typeof streamedHeader>[0]) => read([streamedHeader(o), pcm(100)]);
  await assert.rejects(bad({ tag: 3 }), /^Error: tts audio: unsupported format tag 3$/);
  await assert.rejects(bad({ bits: 8 }), /^Error: tts audio: unsupported bit depth 8$/);
  await assert.rejects(bad({ bits: 24 }), /^Error: tts audio: unsupported bit depth 24$/);
  await assert.rejects(bad({ channels: 2 }), /^Error: tts audio: unsupported channel count 2$/);
  await assert.rejects(bad({ rate: 7999 }), /^Error: tts audio: unsupported sample rate 7999$/);
  await assert.rejects(bad({ rate: 48001 }), /^Error: tts audio: unsupported sample rate 48001$/);
  for (const rate of [8000, 16000, 48000]) assert.equal((await read([streamedHeader({ rate }), pcm(10)])).format.sampleRate, rate);
});

// @spec VOICE-WAV-007
test("a body that is not a WAV file fails with `tts audio: not a WAV file`", async () => {
  await assert.rejects(read([Buffer.from('{"detail":"nope"}')]), /^Error: tts audio: not a WAV file$/);
  await assert.rejects(read([Buffer.from("RIFF....AVI LIST")]), /^Error: tts audio: not a WAV file$/);
  await assert.rejects(read([Buffer.from("hi")]), /^Error: tts audio: not a WAV file$/);
  await assert.rejects(read([]), /^Error: tts audio: not a WAV file$/);
});

// @spec VOICE-WAV-008
test("a WAV with no `data` chunk fails with `tts audio: no data chunk`", async () => {
  const noData = wavBytes(Buffer.alloc(0), { before: [] }).subarray(0, 12 + 8 + 16); // RIFF header and the fmt chunk, no data header
  await assert.rejects(read([noData]), /^Error: tts audio: no data chunk$/);
  const listOnly = Buffer.concat([noData, chunk("LIST", Buffer.from("tail"))]);
  await assert.rejects(read([listOnly]), /^Error: tts audio: no data chunk$/);
});
