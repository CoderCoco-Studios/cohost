import { test } from "node:test";
import assert from "node:assert/strict";
import { discordPcmToWav16k, wavToDiscordPcm, readWavHeader, wavWrap } from "../src/audio.js";

const pcm16 = (samples: number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samplesOf = (b: Buffer, from = 0): number[] => {
  const out: number[] = [];
  for (let i = from; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
  return out;
};

test("wavWrap writes a canonical 44-byte PCM header that readWavHeader reads back", () => {
  const w = wavWrap(pcm16([1, 2, 3, 4]), 16000, 1);
  assert.equal(w.length, 44 + 8);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(4), 36 + 8);
  assert.equal(w.toString("ascii", 8, 12), "WAVE");
  assert.equal(w.readUInt16LE(20), 1); // PCM
  assert.equal(w.readUInt32LE(28), 32000); // byte rate
  assert.equal(w.readUInt16LE(32), 2); // block align
  assert.equal(w.readUInt16LE(34), 16);
  assert.deepEqual(readWavHeader(w), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 8 });
});

test("readWavHeader skips extra chunks and throws without a data chunk", () => {
  const w = wavWrap(pcm16([7]), 24000, 2);
  const list = Buffer.alloc(8 + 3 + 1); list.write("LIST", 0); list.writeUInt32LE(3, 4); // odd size, padded
  const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)]);
  assert.deepEqual(readWavHeader(withList), { sampleRate: 24000, channels: 2, dataOffset: 56, dataLength: 2 });
  assert.throws(() => readWavHeader(w.subarray(0, 36)), /bad wav/);
});

test("discordPcmToWav16k: 48k stereo → 16k mono, averaging channels and each group of 3 frames", () => {
  // 6 stereo frames → 2 mono frames
  const pcm = pcm16([
    100, 300, 200, 400, 300, 500, // avg L/R: 200, 300, 400 → 300
    -100, -100, -200, -200, -300, -300, // → -200
  ]);
  const w = discordPcmToWav16k(pcm);
  assert.deepEqual(readWavHeader(w), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 4 });
  assert.deepEqual(samplesOf(w, 44), [300, -200]);
});

test("discordPcmToWav16k drops a trailing partial group and survives empty input", () => {
  assert.equal(discordPcmToWav16k(pcm16(new Array(2 * 7).fill(0))).length, 44 + 2 * 2); // 7 frames → 2
  assert.equal(discordPcmToWav16k(Buffer.alloc(0)).length, 44);
});

test("discordPcmToWav16k clamps rather than wrapping at full scale", () => {
  const w = discordPcmToWav16k(pcm16(new Array(6).fill(32767)));
  assert.deepEqual(samplesOf(w, 44), [32767]);
  const n = discordPcmToWav16k(pcm16(new Array(6).fill(-32768)));
  assert.deepEqual(samplesOf(n, 44), [-32768]);
});

test("wavToDiscordPcm: 48k stereo in is passed through unchanged", () => {
  const src = pcm16([1, -1, 2, -2, 3, -3]);
  assert.deepEqual(wavToDiscordPcm(wavWrap(src, 48000, 2)), src);
});

test("wavToDiscordPcm: 24k mono → 48k stereo, duplicating channels and interpolating between samples", () => {
  const out = wavToDiscordPcm(wavWrap(pcm16([0, 1000, 2000]), 24000, 1));
  // 3 input frames → 6 output frames; odd frames land halfway between inputs; the last holds.
  assert.deepEqual(samplesOf(out), [0, 0, 500, 500, 1000, 1000, 1500, 1500, 2000, 2000, 2000, 2000]);
});

test("wavToDiscordPcm keeps the duration when resampling Kokoro's 24k output", () => {
  const oneSecond = wavWrap(pcm16(new Array(24000).fill(0)), 24000, 1);
  assert.equal(wavToDiscordPcm(oneSecond).length, 48000 * 4);
});

test("round trip: Discord audio → STT WAV → back to Discord keeps the length and the signal", () => {
  const frames = 4800; // 100 ms
  const tone: number[] = [];
  for (let i = 0; i < frames; i++) { const s = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / 48000)); tone.push(s, s); }
  const back = wavToDiscordPcm(discordPcmToWav16k(pcm16(tone)));
  assert.equal(back.length, frames * 4);
  const orig = tone.filter((_, i) => i % 2 === 0);
  const got = samplesOf(back).filter((_, i) => i % 2 === 0);
  const maxErr = Math.max(...orig.map((s, i) => Math.abs(s - got[i]!)));
  assert.ok(maxErr < 400, `max error ${maxErr}`); // a 200 Hz tone survives 3:1 decimation nearly intact
});
