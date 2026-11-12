import { test } from "node:test";
import assert from "node:assert/strict";
import { discordPcmToWav16k, readWavHeader } from "../src/audio.js";
import { wavWrap } from "@cohost/shared";

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

// @spec SHARED-AUDIO-001
test("readWavHeader reads a wavWrap header back", () => {
  assert.deepEqual(readWavHeader(wavWrap(pcm16([1, 2, 3, 4]), 16000, 1)), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 8 });
});

// @spec SHARED-AUDIO-001
test("readWavHeader skips extra chunks and throws without a data chunk", () => {
  const w = wavWrap(pcm16([7]), 24000, 2);
  const list = Buffer.alloc(8 + 3 + 1); list.write("LIST", 0); list.writeUInt32LE(3, 4); // odd size, padded
  const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)]);
  assert.deepEqual(readWavHeader(withList), { sampleRate: 24000, channels: 2, dataOffset: 56, dataLength: 2 });
  assert.throws(() => readWavHeader(w.subarray(0, 36)), /bad wav/);
});

// @spec EARS-AUD-005
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

// @spec EARS-AUD-005
test("discordPcmToWav16k drops a trailing partial group and survives empty input", () => {
  assert.equal(discordPcmToWav16k(pcm16(new Array(2 * 7).fill(0))).length, 44 + 2 * 2); // 7 frames → 2
  assert.equal(discordPcmToWav16k(Buffer.alloc(0)).length, 44);
});

// @spec EARS-AUD-005
test("discordPcmToWav16k clamps rather than wrapping at full scale", () => {
  const w = discordPcmToWav16k(pcm16(new Array(6).fill(32767)));
  assert.deepEqual(samplesOf(w, 44), [32767]);
  const n = discordPcmToWav16k(pcm16(new Array(6).fill(-32768)));
  assert.deepEqual(samplesOf(n, 44), [-32768]);
});
