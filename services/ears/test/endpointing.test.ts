import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavWrap } from "@cohost/shared";
import { waitFor } from "@cohost/testing";
import { SILENCE, SPEECH, boot, connectorOffer, fakeStreaming, fakeVad, feed, frame, resetSeq, sleep } from "./rig.js";

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
/** Stub STT, 101 ms of silence closes an utterance, 100 ms is long enough to transcribe. The frame gap timer is long enough not to fire while frames are fed fast. */
// CFG-SCH-105 with CFG-SCH-103: silence_ms 100 cannot load (after_ms is at least 100 and must be below silence_ms), so the default is 101 with after_ms 100.
const cfg = (over: Record<string, unknown> = {}) => ({ sources: ["discord"], stt_engine: "stub", silence_ms: 101, early: { after_ms: 100 }, min_speech_ms: 100, ...over });
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
    // First: 10 speech frames (200 ms), closing silence excluded. Second: 180 ms of pre-roll + 10 speech frames (200 ms).
    // CFG-SCH-105: silence_ms is 101 (100 cannot load), so it closes on the 6th of the 15 silence frames; the last 9 silence frames (180 ms) are the second utterance's pre-roll, so 180 + 200 = 380.
    assert.deepEqual(durations(r), [200, 380]);
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

// ---------------------------------------------------------------------------------------- Kyutai end of turn (#188)
// The adapter decides when to signal (kyutai.test.ts); these cases pin what ears does with a signal. A scripted kyutai session
// fires it through `FakeSession.endOfTurn()` (rig.ts). The silence rule is 150 ms so a signal always beats it by design.
// CFG-SCH-105: ears.early.after_ms (default 250) must sit below silence_ms, so it is set here.
const eotCfg = (over: Record<string, unknown> = {}) => ({ sources: ["discord"], stt_engine: "kyutai", silence_ms: 150, early: { after_ms: 100 }, min_speech_ms: 100, stt_timeout_ms: 300, ...over });
const eotRig = (over: Record<string, unknown> = {}) => {
  const s = fakeStreaming({ name: "kyutai", finish: () => "closed early" });
  return { s, boot: () => boot(eotCfg(over), { setup: reg, loadVad: fakeVad().load, streaming: s.engine }) };
};

// @spec EARS-KYU-010, EARS-VAD-003, EARS-HEAR-012
test("an end-of-turn signal closes the utterance at once: the clip ends at the last frame received, audioEndedAt is that frame's arrival", async () => {
  resetSeq();
  const { s, boot: go } = eotRig({ silence_ms: 2000 });
  const r = await go();
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    await feed(r.bus, 4, { fill: SILENCE });
    await sleep(100);
    const t = Date.now();
    r.bus.feed("in", "discord", frame("u1", SILENCE)); // the last frame received: a silence frame after the last speech frame
    await waitFor(() => s.sessions[0]?.pushed.length === 15, "all 15 frames at the session");
    const arrived = Date.now();
    await sleep(150); // the signal comes well after the last frame
    const signalAt = Date.now();
    s.sessions[0]!.endOfTurn();
    await waitFor(() => r.heard().length === 1, "speech.heard", 1000);
    assert.ok(Date.now() - signalAt < 500, "closed by the signal, not by the 2000 ms silence rule");
    assert.equal(r.heard()[0]!.text, "closed early");
    assert.equal(r.heard()[0]!.durationMs, 300, "10 speech + 5 silence frames: through the last frame received, not just the last speech frame");
    assert.equal(s.sessions[0]!.finishCalls, 1);
    const at = r.heard()[0]!.timing!.audioEndedAt!;
    assert.ok(at >= t && at <= arrived, `audioEndedAt is the last frame's arrival (${at - t} ms after the mark), not the close at +${signalAt - t}`);
  } finally { await r.stop(); }
});

// @spec EARS-KYU-011
test("a frame after an end-of-turn close starts a new utterance whose pre-roll holds only later frames and whose session gets no audio already sent", async () => {
  resetSeq();
  const { s, boot: go } = eotRig({ silence_ms: 2000 }); // only a signal closes an utterance within the test
  const r = await go();
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    await waitFor(() => s.sessions[0]?.pushed.length === 10, "the first utterance's frames");
    s.sessions[0]!.endOfTurn();
    await waitFor(() => r.heard().length === 1, "first speech.heard");
    await feed(r.bus, 3, { fill: SILENCE });
    await feed(r.bus, 10, { fill: 81 });
    await waitFor(() => s.sessions[1]?.pushed.length === 13, "the second utterance's frames at its own session");
    s.sessions[1]!.endOfTurn();
    await waitFor(() => r.heard().length === 2, "second speech.heard");
    assert.equal(s.stats.opens, 2, "a new session for the new utterance");
    const second = s.sessions[1]!.audio();
    assert.ok(![...second].includes(SPEECH), "no byte of the first utterance's audio is sent again");
    assert.equal(r.heard()[1]!.durationMs, 260, "3 silence frames that arrived after the close + 10 speech frames (the pre-roll holds no earlier frame)");
    assert.notEqual(r.heard()[0]!.utteranceId, r.heard()[1]!.utteranceId);
  } finally { await r.stop(); }
});

// @spec EARS-KYU-012
test("ears.max_utterance_ms reached first: the max-length close wins and a later signal does nothing", async () => {
  resetSeq();
  const { s, boot: go } = eotRig({ max_utterance_ms: 200, silence_ms: 2000 });
  const r = await go();
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH }); // 200 ms: the length cap closes it
    await waitFor(() => r.heard().length === 1, "the max-length close");
    assert.equal(s.sessions[0]!.finishCalls, 1);
    s.sessions[0]!.endOfTurn(); // too late
    await feed(r.bus, 5, { fill: SPEECH }); // a new utterance; the stale signal must not close it
    await sleep(120);
    assert.equal(r.heard().length, 1, "the stale signal closed nothing");
    assert.equal(s.sessions[0]!.finishCalls, 1, "no second finish()");
    assert.equal(s.sessions[1]?.finishCalls ?? 0, 0, "the new utterance is still open");
  } finally { await r.stop(); }
});

// @spec EARS-KYU-010
test("a signal after the utterance closed by silence does nothing", async () => {
  resetSeq();
  const { s, boot: go } = eotRig();
  const r = await go();
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    await feed(r.bus, 10, { fill: SILENCE });
    await waitFor(() => r.heard().length === 1, "the silence close");
    s.sessions[0]!.endOfTurn();
    await sleep(80);
    assert.equal(r.heard().length, 1);
    assert.equal(s.sessions[0]!.finishCalls, 1);
  } finally { await r.stop(); }
});

// ---- closedAt (EARS-EARLY-020) and audioEndedAt (EARS-EARLY-021, EARS-HEAR-012) of a connector utterance

// @spec EARS-EARLY-020, EARS-EARLY-021, EARS-HEAR-012
test("silero: audioEndedAt is the last speech frame's arrival and closedAt is when the silence rule closed the utterance, whatever ears.early.enabled says", async () => {
  resetSeq();
  const r = await boot(cfg({ silence_ms: 300 }), { setup: reg, loadVad: fakeVad().load });
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    const lastSpeechAt = Date.now();
    await feed(r.bus, 15, { fill: SILENCE, gapMs: 15 }); // 300 ms of silence audio, 225 ms of wall clock
    await waitFor(() => r.heard().length === 1, "speech.heard");
    const published = Date.now();
    const t = r.heard()[0]!.timing!;
    assert.ok(t.audioEndedAt! <= lastSpeechAt + 5, "the last speech frame, not a later silence frame");
    assert.ok(t.closedAt !== undefined && t.closedAt >= lastSpeechAt + 150 && t.closedAt <= published, `closedAt ${String(t.closedAt)} is the close`);
  } finally { await r.stop(); }
});

// @spec EARS-EARLY-020
test("gap: the frame-gap close stamps closedAt one silence_ms after the last frame", async () => {
  resetSeq();
  const r = await boot(cfg({ vad: { engine: "gap" }, silence_ms: 300 }), { setup: reg });
  try {
    await sleep(60);
    const t = await feed(r.bus, 10, { fill: SPEECH });
    await waitFor(() => r.heard().length === 1, "speech.heard");
    const ts = r.heard()[0]!.timing!;
    assert.ok(ts.closedAt! >= t.last + 290 && ts.closedAt! <= Date.now(), `closedAt ${String(ts.closedAt)}`);
    assert.ok(ts.audioEndedAt! <= t.last + 5);
  } finally { await r.stop(); }
});

// @spec EARS-EARLY-020
test("the length cap stamps closedAt on each utterance it closes", async () => {
  resetSeq();
  const r = await boot(cfg({ vad: { engine: "gap" }, max_utterance_ms: 200 }), { setup: reg });
  try {
    await sleep(60);
    const before = Date.now();
    await feed(r.bus, 25, { fill: SPEECH });
    await waitFor(() => r.heard().length === 3, "three utterances");
    for (const h of r.heard()) assert.ok(h.timing!.closedAt !== undefined && h.timing!.closedAt >= before && h.timing!.closedAt <= Date.now(), "closedAt");
  } finally { await r.stop(); }
});

// @spec EARS-EARLY-020, EARS-KYU-010
test("a Kyutai end of turn stamps closedAt at the signal while audioEndedAt stays the last frame received", async () => {
  resetSeq();
  const { s, boot: go } = eotRig({ silence_ms: 2000 });
  const r = await go();
  try {
    await sleep(60);
    await feed(r.bus, 10, { fill: SPEECH });
    const lastFrameAt = Date.now();
    await sleep(200);
    const signalAt = Date.now();
    s.sessions[0]!.endOfTurn();
    await waitFor(() => r.heard().length === 1, "speech.heard", 1000);
    const t = r.heard()[0]!.timing!;
    assert.ok(t.audioEndedAt! <= lastFrameAt + 5);
    assert.ok(t.closedAt! >= signalAt && t.closedAt! <= Date.now(), `closedAt ${String(t.closedAt)} is the signal (${signalAt})`);
  } finally { await r.stop(); }
});
