import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, wavWrap } from "../src/index.js";

/** A PCM WAV with optional extra chunks before `data`. */
function wav(samples: number[], { sampleRate = 24000, channels = 1, bits = 16, before = [] as Buffer[] } = {}): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12); fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20); fmt.writeUInt16LE(bits, 22);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0); dataHdr.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, ...before, dataHdr, pcm]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
function chunk(id: string, size: number): Buffer {
  const b = Buffer.alloc(8 + size + (size & 1));
  b.write(id, 0); b.writeUInt32LE(size, 4);
  return b;
}

// @spec VOICE-ENV-001
test("parseWav reads the fmt chunk and computes the duration", () => {
  const info = parseWav(wav(new Array(24000).fill(0)));
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataOffset, 44);
  assert.equal(info.dataLength, 48000);
  assert.equal(info.durationMs, 1000);
  assert.equal(parseWav(wav(new Array(4800).fill(0), { channels: 2 })).durationMs, 100); // 2400 stereo frames
});

// @spec VOICE-ENV-001, EARS-AUD-003
test("parseWav skips unknown chunks, including odd-sized ones padded to even", () => {
  const info = parseWav(wav([1, 2, 3], { before: [chunk("LIST", 4), chunk("junk", 3)] }));
  assert.equal(info.dataOffset, 12 + 24 + 12 + 12 + 8);
  assert.equal(info.dataLength, 6);
});

// @spec VOICE-ENV-001, EARS-AUD-003
test("parseWav clamps a data chunk that claims more bytes than the buffer has", () => {
  const full = wav(new Array(100).fill(0));
  const info = parseWav(full.subarray(0, full.length - 50)); // e.g. a streamed/truncated TTS reply
  assert.equal(info.dataLength, 150);
});

// @spec VOICE-ENV-002
test("parseWav rejects non-WAV input and a WAV with no data chunk", () => {
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /not a RIFF\/WAVE file/);
  const headerOnly = wav([]).subarray(0, 36);
  assert.throws(() => parseWav(headerOnly), /no data chunk/);
});

// @spec EARS-AUD-003
test("parseWav with requireRiff:false walks chunks without the RIFF/WAVE check", () => {
  const w = wav([1, 2]);
  const bare = Buffer.concat([Buffer.alloc(12), w.subarray(12)]); // zeroed RIFF/WAVE header
  assert.throws(() => parseWav(bare), /not a RIFF\/WAVE file/);
  const info = parseWav(bare, { requireRiff: false });
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.dataLength, 4);
  assert.throws(() => parseWav(bare.subarray(0, 36), { requireRiff: false }), /no data chunk/);
});

// @spec EARS-AUD-004
test("wavWrap writes a canonical 44-byte PCM16 header that parseWav reads back", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const w = wavWrap(pcm, 16000, 1);
  assert.equal(w.length, 44 + 8);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(4), 36 + 8);
  assert.equal(w.toString("ascii", 8, 12), "WAVE");
  assert.equal(w.toString("ascii", 12, 16), "fmt ");
  assert.equal(w.readUInt32LE(16), 16);
  assert.equal(w.readUInt16LE(20), 1); // PCM
  assert.equal(w.readUInt32LE(28), 32000); // byte rate
  assert.equal(w.readUInt16LE(32), 2); // block align
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString("ascii", 36, 40), "data");
  assert.equal(w.readUInt32LE(40), 8);
  assert.deepEqual(w.subarray(44), pcm);
});

// @spec EARS-AUD-004
test("wavWrap then parseWav round-trips rate, channels, depth, data span and duration", () => {
  const w = wavWrap(Buffer.alloc(48000 * 2 * 2), 48000, 2); // 1 s stereo
  const info = parseWav(w);
  assert.deepEqual(info, { sampleRate: 48000, channels: 2, bitsPerSample: 16, dataOffset: 44, dataLength: 192000, durationMs: 1000 });
  assert.equal(w.readUInt32LE(28), 192000);
  assert.equal(w.readUInt16LE(32), 4);
  assert.equal(parseWav(wavWrap(Buffer.alloc(0), 24000, 1)).dataLength, 0);
});
