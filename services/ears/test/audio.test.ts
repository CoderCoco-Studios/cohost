import { test } from "node:test";
import assert from "node:assert/strict";
import { readWavHeader } from "../src/audio.js";
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
