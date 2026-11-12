import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameSequencer, type Frame } from "@cohost/bus";
import { writeUtterance } from "../src/utterance.js";

const SINK = { rate: 48000, channels: 2 };
const clock = () => {
  let t = 0;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits, at: () => t };
};

// @spec CONN-AUD-005
test("an utterance is converted to the sink format, tagged with utt, and the last frame is marked", async () => {
  const c = clock();
  const frames: Frame[] = [];
  // 100 ms of 24 kHz mono = 2400 samples
  const pcm = Buffer.alloc(2400 * 2, 1);
  const n = await writeUtterance(
    { write: async (f) => { frames.push(f); }, sequencer: new FrameSequencer(7), format: SINK, now: c.now, sleep: c.sleep },
    { utt: "u1", pcm, from: { rate: 24000, channels: 1 } },
  );
  assert.equal(n, 5, "100 ms is five 20 ms frames");
  assert.equal(frames.length, 5);
  for (const f of frames) { assert.equal(f.rate, 48000); assert.equal(f.ch, 2); assert.equal(f.utt, "u1"); assert.equal(f.pcm.length, 3840); assert.equal(f.epoch, 7); }
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(frames.map((f) => !!f.last), [false, false, false, false, true]);
});

// @spec CONN-AUD-005
test("a line shorter than one frame is one last frame; an empty line is one empty last frame", async () => {
  const frames: Frame[] = [];
  const o = { write: async (f: Frame) => { frames.push(f); }, sequencer: new FrameSequencer(1), format: SINK, sleep: async () => {} };
  await writeUtterance(o, { utt: "a", pcm: Buffer.alloc(100), from: SINK });
  await writeUtterance(o, { utt: "b", pcm: Buffer.alloc(0), from: SINK });
  assert.deepEqual(frames.map((f) => [f.utt, !!f.last, f.pcm.length]), [["a", true, 100], ["b", true, 0]]);
});

// @spec CONN-BP-004
test("frames are written no faster than real time plus a one second lead, not as a burst", async () => {
  const c = clock();
  const stamps: number[] = [];
  const pcm = Buffer.alloc(48000 * 2 * 2 * 3); // 3 s of 48 kHz stereo = 150 frames
  await writeUtterance(
    { write: async () => { stamps.push(c.at()); }, sequencer: new FrameSequencer(1), format: SINK, now: c.now, sleep: c.sleep },
    { utt: "u", pcm, from: SINK },
  );
  assert.equal(stamps.length, 150);
  // the first second plus one frame (51 frames) goes at once, then one frame every 20 ms
  assert.equal(stamps[50], 0);
  assert.equal(stamps[51], 20);
  assert.equal(stamps[149], 99 * 20);
  for (let i = 0; i < 150; i++) assert.ok(stamps[i]! >= i * 20 - 1000, `frame ${i} written ${stamps[i]} ms in`);
});

// @spec CONN-BP-004
test("a write that fails is skipped and the rest of the line is still paced out", async () => {
  const frames: Frame[] = [];
  let calls = 0;
  const n = await writeUtterance(
    { write: async (f) => { if (calls++ === 1) throw new Error("redis down"); frames.push(f); }, sequencer: new FrameSequencer(1), format: SINK, sleep: async () => {} },
    { utt: "u", pcm: Buffer.alloc(3840 * 3), from: SINK },
  );
  assert.equal(n, 2);
  assert.deepEqual(frames.map((f) => f.seq), [0, 2]);
});
