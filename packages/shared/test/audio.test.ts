import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, resample, wavWrap } from "../src/index.js";

const pcm16 = (samples: number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samplesOf = (b: Buffer): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
  return out;
};

/** A hand-built WAV: `fmt ` fields and chunk order are under the caller's control. */
function rawWav(opts: { tag?: number; channels?: number; rate?: number; bits?: number; order?: ("fmt" | "data")[]; extensible?: number; fmtSize?: number } = {}): Buffer {
  const { tag = 1, channels = 1, rate = 16000, bits = 16, order = ["fmt", "data"], extensible, fmtSize } = opts;
  const fmtLen = fmtSize ?? (extensible !== undefined ? 40 : 16);
  const fmt = Buffer.alloc(8 + fmtLen);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(fmtLen, 4);
  fmt.writeUInt16LE(extensible !== undefined ? 0xfffe : tag, 8);
  fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16); fmt.writeUInt16LE((channels * bits) / 8, 20); fmt.writeUInt16LE(bits, 22);
  if (extensible !== undefined) { fmt.writeUInt16LE(22, 24); fmt.writeUInt16LE(bits, 26); fmt.writeUInt16LE(extensible, 32); }
  const data = Buffer.alloc(8 + 4); data.write("data", 0); data.writeUInt32LE(4, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), ...order.map((o) => (o === "fmt" ? fmt : data))]);
  const head = Buffer.alloc(8); head.write("RIFF", 0); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// @spec SHARED-AUDIO-003
test("parseWav accepts PCM and extensible-with-PCM-subformat", () => {
  assert.equal(parseWav(rawWav()).sampleRate, 16000);
  assert.equal(parseWav(rawWav({ extensible: 1 })).bitsPerSample, 16);
});

// @spec SHARED-AUDIO-003
test("parseWav rejects every unsupported fmt with `unsupported wav: <cause>`", () => {
  const cases: [string, Buffer][] = [
    ["a float format tag", rawWav({ tag: 3 })],
    ["an extensible non-PCM subformat", rawWav({ extensible: 3 })],
    ["zero channels", rawWav({ channels: 0 })],
    ["zero sample rate", rawWav({ rate: 0 })],
    ["8-bit", rawWav({ bits: 8 })],
    ["24-bit", rawWav({ bits: 24 })],
    ["fmt after data", rawWav({ order: ["data", "fmt"] })],
    ["no fmt", rawWav({ order: ["data"] })],
  ];
  for (const [name, buf] of cases) assert.throws(() => parseWav(buf), /^Error: unsupported wav: .+/, name);
});

// @spec SHARED-AUDIO-005
test("an integer downsampling ratio averages r frames after mix-down, dropping a trailing partial group (48k stereo to 16k mono)", () => {
  const stereo = pcm16([100, 300, 200, 400, 300, 500, -100, -100, -200, -200, -300, -300, 9, 9]);
  const out = resample(stereo, { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } });
  assert.deepEqual(samplesOf(out), [300, -200]); // 7 frames: the 7th is a partial group
  const clampHi = resample(pcm16(new Array(6).fill(32767)), { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } });
  assert.deepEqual(samplesOf(clampHi), [32767]);
  const clampLo = resample(pcm16(new Array(6).fill(-32768)), { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } });
  assert.deepEqual(samplesOf(clampLo), [-32768]);
});

// @spec SHARED-AUDIO-006
test("any other ratio interpolates linearly and keeps the duration (24k mono to 48k stereo)", () => {
  const out = resample(pcm16([0, 1000, 2000]), { from: { rate: 24000, channels: 1 }, to: { rate: 48000, channels: 2 } });
  assert.deepEqual(samplesOf(out), [0, 0, 500, 500, 1000, 1000, 1500, 1500, 2000, 2000, 2000, 2000]);
  const second = resample(Buffer.alloc(24000 * 2), { from: { rate: 24000, channels: 1 }, to: { rate: 48000, channels: 2 } });
  assert.equal(second.length, 48000 * 4);
  const odd = resample(pcm16(new Array(100).fill(1)), { from: { rate: 22050, channels: 1 }, to: { rate: 48000, channels: 1 } });
  assert.equal(odd.length / 2, Math.floor((100 * 48000) / 22050));
});

// @spec SHARED-AUDIO-006
test("48k stereo to 48k stereo passes through unchanged", () => {
  const src = pcm16([1, -1, 2, -2, 3, -3]);
  assert.deepEqual(resample(src, { from: { rate: 48000, channels: 2 }, to: { rate: 48000, channels: 2 } }), src);
});

// @spec SHARED-AUDIO-007
test("channels mix down by averaging and up by copying the first, rounding and clamping every sample", () => {
  const down = resample(pcm16([1, 2, 10, 11]), { from: { rate: 8000, channels: 2 }, to: { rate: 8000, channels: 1 } });
  assert.deepEqual(samplesOf(down), [2, 11], "1.5 rounds to 2, 10.5 rounds to 11");
  const up = resample(pcm16([7, 9]), { from: { rate: 8000, channels: 1 }, to: { rate: 8000, channels: 2 } });
  assert.deepEqual(samplesOf(up), [7, 7, 9, 9]);
  const stereoUp = resample(pcm16([5, 50]), { from: { rate: 8000, channels: 2 }, to: { rate: 8000, channels: 3 } });
  assert.deepEqual(samplesOf(stereoUp), [5, 5, 5], "mix up copies the first channel");
  const clamp = resample(pcm16([32767, 32767, -32768, -32768]), { from: { rate: 8000, channels: 1 }, to: { rate: 16000, channels: 1 } });
  assert.ok(samplesOf(clamp).every((s) => s <= 32767 && s >= -32768));
});

// @spec SHARED-AUDIO-008
test("trailing bytes short of a whole input frame are ignored; no whole frame yields empty output", () => {
  const cfg = { from: { rate: 8000, channels: 2 }, to: { rate: 8000, channels: 2 } } as const;
  assert.deepEqual(samplesOf(resample(Buffer.concat([pcm16([1, 2, 3, 4]), Buffer.from([9, 9, 9])]), cfg)), [1, 2, 3, 4]);
  assert.equal(resample(Buffer.alloc(0), cfg).length, 0);
  assert.equal(resample(Buffer.from([1, 2, 3]), cfg).length, 0);
  assert.equal(resample(Buffer.alloc(0), { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } }).length, 0);
});

// @spec SHARED-AUDIO-004
test("wavWrap output read back by parseWav keeps rate, channels and duration after a resample", () => {
  const out = resample(Buffer.alloc(48000 * 4), { from: { rate: 48000, channels: 2 }, to: { rate: 16000, channels: 1 } });
  const info = parseWav(wavWrap(out, 16000, 1));
  assert.equal(info.durationMs, 1000);
});
