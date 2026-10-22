import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, envelope } from "../src/wav.js";

/** A 16-bit PCM WAV with optional extra chunks before `data`. */
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

test("parseWav skips unknown chunks, including odd-sized ones padded to even", () => {
  const info = parseWav(wav([1, 2, 3], { before: [chunk("LIST", 4), chunk("junk", 3)] }));
  assert.equal(info.dataOffset, 44 + 12 + 12);
  assert.equal(info.dataLength, 6);
});

test("parseWav clamps a data chunk that claims more bytes than the buffer has", () => {
  const full = wav(new Array(100).fill(0));
  const info = parseWav(full.subarray(0, full.length - 50)); // e.g. a streamed/truncated TTS reply
  assert.equal(info.dataLength, 150);
});

test("parseWav rejects non-WAV input and a WAV with no data chunk", () => {
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /RIFF\/WAVE/);
  const headerOnly = wav([]).subarray(0, 36); // RIFF + fmt, no data chunk
  assert.throws(() => parseWav(headerOnly), /no data chunk/);
});

test("envelope: silence is closed, full-scale is open, one value per window", () => {
  const silent = wav(new Array(2400).fill(0)); // 100ms @ 24k
  assert.deepEqual(envelope(silent, parseWav(silent), 30), [0, 0, 0]); // 800-sample windows
  const loud = wav(new Array(2400).fill(32767));
  const e = envelope(loud, parseWav(loud), 30);
  assert.equal(e.length, 3);
  assert.ok(e.every((v) => v === 1));
});

test("envelope: a partial last window still yields a value", () => {
  const w = wav(new Array(2500).fill(0));
  assert.equal(envelope(w, parseWav(w), 30).length, 4); // 3 full windows of 800 + 100 left over
});

test("envelope: the mouth closes gradually (x0.6 per window), not instantly", () => {
  const w = wav([...new Array(800).fill(32767), ...new Array(2400).fill(0)]);
  assert.deepEqual(envelope(w, parseWav(w), 30), [1, 0.6, 0.36, 0.22]);
});

test("envelope: normal speech levels land mid-range thanks to the soft knee", () => {
  // RMS 0.1 of full scale → (0.1/0.22)^0.8 ≈ 0.53
  const w = wav(new Array(800).fill(Math.round(0.1 * 32768)));
  const [v] = envelope(w, parseWav(w), 30);
  assert.ok(v! > 0.45 && v! < 0.6, `got ${v}`);
});

test("envelope: only the first channel of stereo is read", () => {
  const frames = 800;
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) samples.push(0, 32767); // left silent, right loud
  const w = wav(samples, { channels: 2 });
  assert.deepEqual(envelope(w, parseWav(w), 30), [0]);
});

test("envelope rejects anything but 16-bit", () => {
  const w = wav([0, 0]);
  assert.throws(() => envelope(w, { ...parseWav(w), bitsPerSample: 8 }), /unsupported bit depth 8/);
});
