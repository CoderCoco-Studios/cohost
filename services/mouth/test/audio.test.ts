import { test } from "node:test";
import assert from "node:assert/strict";
import { wavToDiscordPcm, readWavHeader } from "../src/audio.js";
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

// @spec MOUTH-AUD-001
test("readWavHeader reads a wavWrap header back, skips extra chunks and throws without a data chunk", () => {
  assert.deepEqual(readWavHeader(wavWrap(pcm16([1, 2, 3, 4]), 16000, 1)), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 8 });
  const w = wavWrap(pcm16([7]), 24000, 2);
  const list = Buffer.alloc(8 + 3 + 1); list.write("LIST", 0); list.writeUInt32LE(3, 4); // odd size, padded
  const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)]);
  assert.deepEqual(readWavHeader(withList), { sampleRate: 24000, channels: 2, dataOffset: 56, dataLength: 2 });
  assert.throws(() => readWavHeader(w.subarray(0, 36)), /bad wav/);
});

// @spec MOUTH-AUD-001
test("wavToDiscordPcm: 48k stereo in is passed through unchanged", () => {
  const src = pcm16([1, -1, 2, -2, 3, -3]);
  assert.deepEqual(wavToDiscordPcm(wavWrap(src, 48000, 2)), src);
});

// @spec MOUTH-AUD-001
test("wavToDiscordPcm: 24k mono → 48k stereo, duplicating channels and interpolating between samples", () => {
  const out = wavToDiscordPcm(wavWrap(pcm16([0, 1000, 2000]), 24000, 1));
  // 3 input frames → 6 output frames; odd frames land halfway between inputs; the last holds.
  assert.deepEqual(samplesOf(out), [0, 0, 500, 500, 1000, 1000, 1500, 1500, 2000, 2000, 2000, 2000]);
});

// @spec MOUTH-AUD-001
test("wavToDiscordPcm keeps the duration when resampling Kokoro's 24k output", () => {
  const oneSecond = wavWrap(pcm16(new Array(24000).fill(0)), 24000, 1);
  assert.equal(wavToDiscordPcm(oneSecond).length, 48000 * 4);
});

// @spec MOUTH-AUD-001
test("wavToDiscordPcm rejects bytes that are not a WAV", () => {
  assert.throws(() => wavToDiscordPcm(Buffer.from("not a wav")), /bad wav/);
});
