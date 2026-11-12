import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "@cohost/bus";
import { ConnectorFakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createConnectorOutput } from "../src/connector-output.js";
import { ClipCache, type FallbackClip } from "../src/clips.js";
import { ClaimMemory, FallbackLine } from "../src/fallback.js";

const OUT = { rate: 48000, channels: 2 };
const sink = (over: Record<string, unknown> = {}) => [{ cap: "audio-out" as const, tag: "discord", format: OUT, ready: true, transport: "stream" as const, ...over }];
/** A mono 24 kHz WAV of `ms` milliseconds of a constant tone. */
const wavMs = (ms: number, level = 1000) => {
  const pcm = Buffer.alloc(Math.round((ms / 1000) * 24000) * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(level, i);
  return wavWrap(pcm, 24000, 1);
};

async function rig(over: { ms?: number; registered?: boolean; gain?: number; fallback?: FallbackLine; clock?: { now(): number; sleep(ms: number): Promise<void> } } = {}) {
  const bus = new ConnectorFakeBus();
  if (over.registered !== false) bus.register("discord", sink());
  const registry = new ConnectorRegistry(bus as never, 10);
  await registry.start();
  const rec = recordingLog();
  const out = createConnectorOutput({
    bus: bus as never, registry, log: rec.log, tag: "discord", gainDb: () => over.gain ?? 0,
    fetchAudio: async () => wavMs(over.ms ?? 100), fallback: over.fallback, clock: over.clock,
  });
  const at = (type: string) => bus.published.filter((p) => p.type === type).map((p) => p.data as Record<string, unknown>);
  return { bus, registry, out, rec, at, stop: () => { out.close(); registry.stop(); } };
}

// @spec MOUTH-CONN-002, MOUTH-CONN-004, CONN-AUD-005
test("a line is written to audio.out.discord in the sink's format: 20 ms frames tagged utt, the last marked, playing after the first frame, done after the line's play time", async () => {
  const r = await rig({ ms: 100 });
  try {
    const t0 = Date.now();
    await r.out.playback.enqueue("u1", "http://voice/u1.wav");
    assert.equal(r.bus.frames.length > 0, true, "frames are written before voice.playing");
    assert.deepEqual(r.at("voice.playing"), [{ id: "u1", sink: "discord" }]);
    assert.equal(r.at("voice.done").length, 0, "not done before its play time");
    await waitFor(() => r.at("voice.done").length === 1, "voice.done");
    assert.ok(Date.now() - t0 >= 90, `done at ${Date.now() - t0} ms for a 100 ms line`);
    assert.deepEqual(r.at("voice.done"), [{ id: "u1", sink: "discord" }]);
    const frames = r.bus.frames;
    assert.equal(frames.length, 5);
    assert.ok(frames.every((f) => f.dir === "out" && f.tag === "discord" && f.frame.rate === 48000 && f.frame.ch === 2 && f.frame.utt === "u1" && f.frame.pcm.length === 3840));
    assert.deepEqual(frames.map((f) => f.frame.last === true), [false, false, false, false, true]);
    assert.deepEqual(frames.map((f) => f.frame.seq), [0, 1, 2, 3, 4]);
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-004, CONN-BP-004, MOUTH-ROUTE-005
test("frames are paced at real time with a lead of one second, and the output's gain is applied before they are written", async () => {
  let t = 0;
  const sleeps: number[] = [];
  const r = await rig({ ms: 3000, gain: -6.0206, clock: { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } } });
  try {
    await r.out.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => r.at("voice.done").length === 1, "voice.done");
    assert.equal(r.bus.frames.length, 150);
    assert.ok(sleeps.length > 0, "a 3 s line is not a burst");
    assert.ok(t >= 2999 && t <= 3001, `the write schedule covers the line: ${t}`);
    const first = r.bus.frames[0]!.frame.pcm.readInt16LE(0);
    assert.ok(Math.abs(first - 500) <= 1, `1000 at -6 dB is about 500, got ${first}`);
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-003, MOUTH-ROUTE-003, CONN-BP-005, CONN-ISO-001
test("the output is ready only while a live registration offers the sink with ready true, and follows it without a restart", async () => {
  const r = await rig({ registered: false });
  try {
    assert.equal(r.out.isReady(), false);
    r.bus.register("discord", sink());
    await waitFor(() => r.out.isReady(), "ready once registered");
    r.bus.register("discord", sink({ ready: false }));
    await waitFor(() => !r.out.isReady(), "not ready while the sink is not ready");
    r.bus.register("discord", sink());
    await waitFor(() => r.out.isReady(), "ready again");
    r.bus.regs.delete("discord");
    await waitFor(() => !r.out.isReady(), "not ready once the registration lapses");
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-004, MOUTH-PLAY-005, MOUTH-PLAY-006
test("a frame write that throws before the first frame is written is a give-up: one voice.failed, no playing, nothing more written", async () => {
  const r = await rig({ ms: 100 });
  try {
    r.bus.failFrames = true;
    await r.out.playback.enqueue("u1", "http://voice/u1.wav");
    assert.equal(r.at("voice.playing").length, 0);
    assert.equal(r.at("voice.failed").length, 1);
    assert.match(String(r.at("voice.failed")[0]!.reason), /redis down/);
    assert.equal(r.at("voice.done").length, 0);
    r.bus.failFrames = false;
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(r.bus.frames.length, 0, "the abandoned line wrote no frame afterwards");
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-004, MOUTH-FALL-001
test("a give-up plays a fallback clip through the same sink writer, tagged with the line's utt", async () => {
  const cache = new ClipCache();
  const wav = wavMs(40);
  const clip: FallbackClip = { name: "c1", text: "one sec", durationMs: 40, bytes: wav.length, sha256: "x", wav };
  cache.replace({ fingerprint: "fp", clips: [clip] });
  const r = await rig({ ms: 100, fallback: new FallbackLine({ cache, claims: new ClaimMemory(), sink: "discord", minIntervalMs: 0, random: () => 0 }) });
  try {
    // the line's own first write fails, then the clip's writes succeed
    const orig = r.bus.publishFrame.bind(r.bus);
    let n = 0;
    r.bus.publishFrame = async (d: string, t: string, f: never) => { if (++n === 1) throw new Error("boom"); return orig(d, t, f); };
    await r.out.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => r.at("voice.done").length === 1, "the clip finished");
    assert.deepEqual(r.at("voice.failed").map((f) => f.fallback), [{ clip: "c1", text: "one sec" }]);
    assert.ok(r.bus.frames.every((f) => f.frame.utt === "u1"));
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-005
test("if the sink stops being ready while a line is being written, the line's schedule still finishes with voice.done: no give-up, no fallback", async () => {
  const r = await rig({ ms: 200 });
  try {
    const orig = r.bus.publishFrame.bind(r.bus);
    r.bus.publishFrame = async (d: string, t: string, f: never) => { const id = await orig(d, t, f); r.bus.regs.delete("discord"); return id; };
    await r.out.playback.enqueue("u1", "http://voice/u1.wav");
    await waitFor(() => !r.out.isReady(), "sink gone");
    await waitFor(() => r.at("voice.done").length === 1, "done on schedule");
    assert.equal(r.at("voice.failed").length, 0);
    assert.deepEqual(r.at("voice.done"), [{ id: "u1", sink: "discord" }]);
  } finally { r.stop(); }
});

// @spec MOUTH-CONN-004, MOUTH-PLAY-004
test("lines play one at a time: the second line's frames start after the first's done", async () => {
  const r = await rig({ ms: 60 });
  try {
    void r.out.playback.enqueue("a", "http://voice/a.wav");
    void r.out.playback.enqueue("b", "http://voice/b.wav");
    await waitFor(() => r.at("voice.done").length === 2, "both done");
    assert.deepEqual(r.bus.published.filter((p) => p.type === "voice.done" || p.type === "voice.playing").map((p) => `${p.type}:${(p.data as { id: string }).id}`),
      ["voice.playing:a", "voice.done:a", "voice.playing:b", "voice.done:b"]);
  } finally { r.stop(); }
});
