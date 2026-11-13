import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavWrap } from "@cohost/shared";
import { waitFor } from "@cohost/testing";
import { SILENCE, SPEECH, boot, connectorOffer, fakeVad, feed, frame, resetSeq, sleep } from "./rig.js";

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
/** Stub STT, 100 ms of silence closes an utterance, 100 ms is long enough to transcribe. The frame gap timer is long enough not to fire while frames are fed fast. */
const cfg = (over: Record<string, unknown> = {}) => ({ sources: ["discord"], stt_engine: "stub", silence_ms: 100, min_speech_ms: 100, ...over });
const durations = (r: Awaited<ReturnType<typeof boot>>) => r.heard().map((h) => h.durationMs);

// @spec EARS-VAD-001, EARS-VAD-002, EARS-VAD-003
test("silero (the default): silence closes an utterance, the trailing silence is not transcribed and the next speech opens a new one", async () => {
  resetSeq();
  const vad = fakeVad();
  const r = await boot(cfg(), { setup: reg, loadVad: vad.load });
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    await feed(r.bus, 15, { fill: SILENCE });
    await feed(r.bus, 10, { fill: SPEECH });
    await waitFor(() => r.heard().length === 2, "two utterances");
    // First: 10 speech frames, closing silence excluded. Second: 200 ms of pre-roll (the last 10 silence frames) + 10 speech frames.
    assert.deepEqual(durations(r), [200, 400]);
  } finally { await r.stop(); }
});

// @spec EARS-VAD-003
test("silero: frames with no open utterance are not buffered; an utterance starts with at most 200 ms of pre-roll", async () => {
  resetSeq();
  const vad = fakeVad();
  const r = await boot(cfg(), { setup: reg, loadVad: vad.load });
  try {
    await sleep(60);
    await feed(r.bus, 30, { fill: SILENCE });
    await feed(r.bus, 5, { fill: SPEECH });
    await waitFor(() => r.heard().length === 1, "utterance");
    assert.deepEqual(durations(r), [300], "200 ms pre-roll + 100 ms speech, none of the other 400 ms of silence");
  } finally { await r.stop(); }
});

// @spec EARS-VAD-003
test("silero: pre-roll is whatever arrived when less than 200 ms has", async () => {
  resetSeq();
  const vad = fakeVad();
  const r = await boot(cfg(), { setup: reg, loadVad: vad.load });
  try {
    await sleep(60);
    await feed(r.bus, 3, { fill: SILENCE });
    await feed(r.bus, 5, { fill: SPEECH });
    await feed(r.bus, 2, { fill: SILENCE }); // too short to close by silence: the gap rule closes it, still trimmed to the last speech frame
    await waitFor(() => r.heard().length === 1, "utterance");
    assert.deepEqual(durations(r), [160]);
  } finally { await r.stop(); }
});

// @spec EARS-VAD-002
test("silero: a frame is speech at or above ears.vad.threshold", async () => {
  resetSeq();
  for (const [threshold, fill, heard] of [[undefined, 50, true], [undefined, 49, false], [0.6, 55, false], [0.6, 60, true]] as const) {
    const r = await boot(cfg(threshold === undefined ? {} : { vad: { threshold } }), { setup: reg, loadVad: fakeVad().load });
    try {
      await sleep(60);
      await feed(r.bus, 10, { fill });
      await sleep(250);
      assert.equal(r.heard().length, heard ? 1 : 0, `threshold ${String(threshold ?? 0.5)}, probability ${fill / 100}`);
    } finally { await r.stop(); }
  }
});

// @spec EARS-VAD-001
test("gap engine: the detector is never consulted and every frame is part of the utterance", async () => {
  resetSeq();
  const vad = fakeVad();
  const r = await boot(cfg({ vad: { engine: "gap" } }), { setup: reg, loadVad: vad.load });
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SILENCE });
    await waitFor(() => r.heard().length === 1, "gap close");
    assert.deepEqual(durations(r), [200]);
    assert.equal(vad.state.created, 0);
  } finally { await r.stop(); }
});

// @spec EARS-VAD-004
test("silero: the frame-gap rule still closes an open utterance when its speaker's frames stop (passes today: the gap rule is all there is)", async () => {
  resetSeq();
  const r = await boot(cfg({ silence_ms: 150, vad: { engine: "silero" } }), { setup: reg, loadVad: fakeVad().load });
  try {
    await sleep(60);
    const { last } = await feed(r.bus, 5, { fill: SPEECH });
    await waitFor(() => r.heard().length === 1, "gap close");
    assert.ok(Date.now() - last >= 100, "closed by the gap timer, not by silence frames, which never came");
    assert.deepEqual(durations(r), [100]);
  } finally { await r.stop(); }
});

// @spec EARS-VAD-005
test("max_utterance_ms closes an utterance that reaches it and the next frame opens a new one, with new utteranceIds (gap engine)", async () => {
  resetSeq();
  const r = await boot(cfg({ vad: { engine: "gap" }, max_utterance_ms: 200 }), { setup: reg });
  try {
    await sleep(60);
    await feed(r.bus, 25, { fill: SPEECH });
    await waitFor(() => r.heard().length === 3, "three utterances");
    assert.deepEqual(durations(r), [200, 200, 100]);
    const ids = r.heard().map((h) => h.utteranceId);
    assert.ok(ids.every((i) => typeof i === "string" && i !== ""), "each has an utteranceId");
    assert.equal(new Set(ids).size, 3, "all distinct");
  } finally { await r.stop(); }
});

// @spec EARS-VAD-005
test("max_utterance_ms under silero: the new utterance opens at the next frame classified as speech", async () => {
  resetSeq();
  const r = await boot(cfg({ max_utterance_ms: 200 }), { setup: reg, loadVad: fakeVad().load });
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH }); // reaches the cap: closes
    await feed(r.bus, 2, { fill: SILENCE }); // no utterance open: pre-roll only
    await feed(r.bus, 4, { fill: SPEECH });
    await waitFor(() => r.heard().length === 2, "two utterances");
    assert.deepEqual(durations(r), [200, 120]);
    assert.notEqual(r.heard()[0]!.utteranceId, r.heard()[1]!.utteranceId);
  } finally { await r.stop(); }
});

// @spec EARS-VAD-006
test("a detector that cannot load marks that source down with `vad unavailable: <reason>`, keeps other sources running and does not fall back to gap", async () => {
  resetSeq();
  const dir = await mkdtemp(join(tmpdir(), "ears-vad-"));
  const r = await boot(cfg({ sources: ["discord", "dir"], dir: { path: dir, poll_ms: 20 } }), { setup: reg, loadVad: fakeVad({ reject: new Error("onnx runtime missing") }).load });
  try {
    await waitFor(() => r.lastHeartbeat()?.deps?.discord === "down", "discord down");
    const hb = r.lastHeartbeat()!;
    assert.match(String(hb.detail), /vad unavailable: onnx runtime missing/);
    await feed(r.bus, 10, { fill: SPEECH });
    await writeFile(join(dir, "a.wav"), wavWrap(Buffer.alloc(32000, 1), 16000, 1));
    await waitFor(() => r.heard().length === 1, "dir clip heard");
    assert.equal(r.heard()[0]!.speaker, "dir", "only the dir source heard anything");
    await sleep(250);
    assert.equal(r.heard().length, 1, "no gap-engine fallback for discord");
    assert.equal(r.lastHeartbeat()!.deps?.dir, "ok");
  } finally { await r.stop(); await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-VAD-007
test("each speaker has its own detector state and utterance: another speaker's silence neither closes nor joins it", async () => {
  resetSeq();
  const vad = fakeVad();
  const r = await boot(cfg(), { setup: reg, loadVad: vad.load });
  try {
    await sleep(60);
    // 10 rounds of (a speaks, b is silent): b's 200 ms of silence would close a's utterance if the state were shared.
    for (let i = 0; i < 10; i++) { r.bus.feed("in", "discord", frame("a", SPEECH)); r.bus.feed("in", "discord", frame("b", SILENCE)); }
    await feed(r.bus, 5, { spk: "b", fill: SPEECH });
    await waitFor(() => r.heard().length === 2, "two utterances");
    const by = Object.fromEntries(r.heard().map((h) => [h.speakerId, h]));
    assert.equal(by.a!.durationMs, 200, "a: one utterance of its own 10 frames");
    assert.equal(by.b!.durationMs, 300, "b: its own 200 ms pre-roll + 100 ms of speech");
    assert.notEqual(by.a!.utteranceId, by.b!.utteranceId);
    assert.equal(vad.state.created, 2, "one detector per speaker id");
  } finally { await r.stop(); }
});

// @spec EARS-VAD-008
test("a seq gap closes nothing and is not filled: the received frames are one utterance (passes today under the gap rule)", async () => {
  resetSeq();
  const r = await boot(cfg(), { setup: reg, loadVad: fakeVad().load });
  try {
    await sleep(60);
    await feed(r.bus, 5, { fill: SPEECH });
    r.bus.feed("in", "discord", frame("u1", SPEECH, 20, 4)); // 4 frames lost
    await feed(r.bus, 4, { fill: SPEECH });
    await waitFor(() => r.heard().length === 1, "one utterance");
    await sleep(150);
    assert.equal(r.heard().length, 1);
    assert.deepEqual(durations(r), [200], "10 received frames, the 4 missing ones not filled");
  } finally { await r.stop(); }
});
