import { test } from "node:test";
import assert from "node:assert/strict";
import { event, waitFor } from "@cohost/testing";
import { SttCapacityError } from "../src/engines.js";
import { createKyutaiEngine } from "../src/kyutai.js";
import { earsCfg, kyutaiServer, until, word } from "./stt-servers.js";
import { SILENCE, SPEECH, boot, connectorOffer, fakeStreaming, fakeStt, fakeVad, frame, resetSeq, sleep } from "./rig.js";

// The streaming session lifecycle (EARS-SES-*) against the scripted `fakeStreaming` engine of rig.ts, with the real ears service
// on a fake bus and the gap endpointing (150 ms of silence closes an utterance). Test seams the code phase must provide, besides
// those of rig.ts: `SttCapacityError` exported by src/engines.ts: an engine's `open()` rejects with it when the server answers
// that it has no free channel (EARS-SES-009); any other rejection is an outage-class failure (EARS-ENG-009).
process.env.HEARTBEAT_INTERVAL_MS = "40";

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
const cfg = (over: Record<string, unknown> = {}) => ({
  // CFG-SCH-105: ears.early.after_ms (default 250) must sit below silence_ms, so it is set here.
  sources: ["discord"], stt_engine: "nemotron", partials: "off", vad: { engine: "gap" }, silence_ms: 150, early: { after_ms: 100 }, min_speech_ms: 100, stt_timeout_ms: 300, ...over,
});
const FRAME_BYTES = 640;

type Rig = Awaited<ReturnType<typeof boot>>;
async function run<T>(ears: Record<string, unknown>, streaming: ReturnType<typeof fakeStreaming>, stt: ReturnType<typeof fakeStt>, body: (r: Rig) => Promise<T>, o: Parameters<typeof boot>[1] = {}): Promise<T> {
  resetSeq();
  const r = await boot(ears, { setup: reg, streaming: streaming.engine, ...o });
  try { await sleep(60); return await body(r); } finally { await r.stop(); stt.restore(); }
}
/** `n` speech frames of one speaker, 15 ms apart (the gap endpointing closes it 150 ms later). */
const say = async (r: Rig, spk = "u1", n = 10) => { for (let i = 0; i < n; i++) { r.bus.feed("in", "discord", frame(spk, SPEECH)); await sleep(15); } };
const fills = (b: Buffer) => { const out: number[] = []; for (let i = 0; i < b.length; i += FRAME_BYTES) out.push(b[i]!); return out; };
const warns = (r: Rig) => r.log.msgs("warn").length;
const neverDown = (r: Rig) => r.bus.health.every((h) => h.deps.stt !== "down");

// @spec EARS-SES-001, EARS-SES-004
test("an utterance of a connector source opens one session; at close the final is finish()'s text, with the utterance's id and audio-end time, and no batch call", async () => {
  const stt = fakeStt(() => "from the batch engine");
  const s = fakeStreaming({ finish: () => "  hello from the session " });
  await run(cfg(), s, stt, async (r) => {
    const t0 = Date.now();
    await say(r);
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(s.stats.opens, 1);
    assert.equal(s.sessions[0]!.finishCalls, 1);
    const h = r.heard()[0]!;
    assert.deepEqual([h.speaker, h.speakerId, h.source, h.text], ["U1", "u1", "discord", "hello from the session"]);
    assert.equal(typeof h.utteranceId, "string");
    assert.ok(h.timing!.audioEndedAt! >= t0 && h.timing!.audioEndedAt! <= Date.now(), "audioEndedAt is when the last frame arrived");
    assert.equal(stt.calls.length, 0, "the batch engine is not used");
    assert.ok(!s.sessions[0]!.aborted);
  });
});

// @spec EARS-SES-004
test("the final goes through the word-character and drop-phrase filters", async () => {
  const stt = fakeStt(() => "unused");
  for (const text of ["...", "Thanks for watching!"]) {
    const s = fakeStreaming({ finish: () => text });
    await run(cfg({ drop_phrases: ["thanks for watching"] }), s, stt, async (r) => {
      await say(r);
      await waitFor(() => s.sessions[0]?.finishCalls === 1, "finish");
      await sleep(80);
      assert.equal(r.heard().length, 0, text);
    });
  }
});

// @spec EARS-SES-001
test("one session per speaker id: two speakers on one source hold one session each, with only their own audio", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: (x) => `speaker ${x.n}` });
  await run(cfg(), s, stt, async (r) => {
    for (let i = 0; i < 10; i++) { r.bus.feed("in", "discord", frame("u1", SPEECH)); r.bus.feed("in", "discord", frame("u2", SPEECH)); await sleep(15); }
    await waitFor(() => r.heard().length === 2, "two finals");
    assert.equal(s.sessions.length, 2);
    assert.deepEqual(s.sessions.map((x) => x.audio().length), [10 * FRAME_BYTES, 10 * FRAME_BYTES]);
    assert.deepEqual(new Set(r.heard().map((h) => h.speakerId)), new Set(["u1", "u2"]));
  });
});

// @spec EARS-SES-002, EARS-VAD-003
test("the pre-roll (up to 200 ms) and the frames buffered while the session connects are pushed first and in order, then every frame, silence included", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ open: () => sleep(80), finish: () => "ok words" });
  const vad = fakeVad();
  await run(cfg({ vad: { engine: "silero", threshold: 0.5 } }), s, stt, async (r) => {
    for (let i = 0; i < 15; i++) { r.bus.feed("in", "discord", frame("u1", SILENCE)); await sleep(4); } // 300 ms before the speech: only 200 ms is kept
    for (let i = 0; i < 6; i++) { r.bus.feed("in", "discord", frame("u1", SPEECH)); await sleep(10); }
    for (let i = 0; i < 2; i++) { r.bus.feed("in", "discord", frame("u1", SILENCE)); await sleep(10); }
    await waitFor(() => r.heard().length === 1, "final", 3000);
    const sess = s.sessions[0]!;
    assert.deepEqual(fills(sess.audio()), [...Array(10).fill(SILENCE), ...Array(6).fill(SPEECH), ...Array(2).fill(SILENCE)], "pre-roll, speech, trailing silence of the open utterance, in order");
    assert.ok(sess.pushAt.every((t) => t >= sess.openedAt), "nothing is pushed before the connection is ready");
    assert.equal(sess.finishCalls, 1);
  }, { loadVad: vad.load });
});

// @spec EARS-SES-003, EARS-SES-010, EARS-ENG-007
test("a buffered start the server does not accept within ears.stt_timeout_ms fails the session: the retained clip goes to the batch engine, and deps.stt says so", async () => {
  const stt = fakeStt(() => "batch after a stuck start");
  const s = fakeStreaming({ open: () => sleep(50), push: (_n, index) => (index === 0 ? new Promise<void>(() => {}) : undefined), finish: () => "unused" });
  await run(cfg({ stt_timeout_ms: 100 }), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "heard", 3000);
    assert.equal(r.heard()[0]!.text, "batch after a stuck start");
    assert.equal(stt.calls.length, 1, "one batch attempt");
    assert.equal(s.sessions[0]!.finishCalls, 0);
    assert.ok(s.sessions[0]!.aborted, "the stuck session is aborted");
    await waitFor(() => r.lastHeartbeat()?.deps.stt === "down" && /buffered start not accepted after 100 ms/.test(r.lastHeartbeat()?.detail ?? ""), "outage recorded", 2000);
  });
});

// @spec EARS-SES-003, EARS-SES-002
test("a buffered start the server accepts is pushed in order and awaited frame by frame; the session then serves the utterance", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ open: () => sleep(50), push: () => sleep(5), finish: () => "accepted in order" });
  await run(cfg({ stt_timeout_ms: 1000 }), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "heard", 3000);
    assert.equal(r.heard()[0]!.text, "accepted in order");
    assert.equal(s.sessions[0]!.audio().length, 10 * FRAME_BYTES, "every frame reached the session");
    assert.equal(stt.calls.length, 0);
  });
});

// @spec EARS-SES-005, EARS-ECHO-004
test("an echo-suppressed source opens no session and sends no audio to a streaming engine: a clip the gate lets through goes to the batch engine, one the gate blocks is dropped", async () => {
  const stt = fakeStt(() => "echo suppressed, batch");
  const s = fakeStreaming();
  await run(cfg({ echo_suppress_sources: ["discord"], echo_tail_ms: 300, silence_ms: 120 }), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "batch final");
    assert.equal(r.heard()[0]!.text, "echo suppressed, batch");
    assert.equal(stt.calls.length, 1);
    assert.equal(s.stats.opens, 0, "no streaming session");
    await r.deliver(event("voice.playing", { id: "l1", seq: 0, sink: "discord" }));
    await say(r);
    await sleep(400);
    assert.equal(r.heard().length, 1, "the gate decides at close: nothing more heard while a line plays");
    assert.equal(stt.calls.length, 1, "and no STT request");
    assert.equal(s.stats.opens, 0);
  });
});

// @spec EARS-SES-006
test("an utterance shorter than ears.min_speech_ms aborts its session without finish() and publishes nothing", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "should not be asked" });
  await run(cfg(), s, stt, async (r) => {
    await say(r, "u1", 3); // 60 ms of audio against 100 ms
    await waitFor(() => s.sessions[0]?.aborted === true, "session aborted");
    assert.equal(s.sessions[0]!.finishCalls, 0);
    await sleep(100);
    assert.equal(r.heard().length, 0);
    assert.equal(stt.calls.length, 0);
    assert.ok(neverDown(r));
  });
});

// @spec EARS-SES-007
test("when the source stops, the open session is aborted: a session does not outlive its utterance", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "late" });
  resetSeq();
  const r = await boot(cfg({ silence_ms: 5000 }), { setup: reg, streaming: s.engine });
  try {
    await sleep(60);
    await say(r, "u1", 6);
    await waitFor(() => s.sessions.length === 1, "session");
    assert.ok(!s.sessions[0]!.aborted);
  } finally { await r.stop(); stt.restore(); }
  assert.ok(s.sessions[0]!.aborted, "aborted at stop");
  assert.equal(s.sessions[0]!.finishCalls, 0);
  assert.equal(r.heard().length, 0);
});

// @spec EARS-SES-008
test("at most ears.max_stt_sessions sessions are open at once: the utterance beyond the limit runs unstreamed and goes to the batch engine at close; a freed slot is reused", async () => {
  const stt = fakeStt(() => "batch for the second");
  const s = fakeStreaming({ finish: () => "session for the first" });
  await run(cfg({ max_stt_sessions: 1 }), s, stt, async (r) => {
    for (let i = 0; i < 10; i++) { r.bus.feed("in", "discord", frame("u1", SPEECH)); r.bus.feed("in", "discord", frame("u2", SPEECH)); await sleep(15); }
    await waitFor(() => r.heard().length === 2, "two finals");
    assert.equal(s.sessions.length, 1, "one session only");
    assert.equal(r.heard().find((h) => h.speakerId === "u1")!.text, "session for the first");
    assert.equal(r.heard().find((h) => h.speakerId === "u2")!.text, "batch for the second");
    assert.equal(stt.calls.length, 1);
    assert.equal(stt.calls[0]!.ms, 200, "the whole retained clip");
    await say(r, "u3");
    await waitFor(() => r.heard().length === 3, "third");
    assert.equal(s.sessions.length, 2, "the slot was free again");
    assert.ok(neverDown(r), "a refusal for capacity leaves deps.stt alone (EARS-HLTH-004)");
  });
});

// @spec EARS-SES-009, EARS-SES-010
test("a server with no free channel is a capacity refusal: the utterance falls back to the batch engine and deps.stt stays ok", async () => {
  const stt = fakeStt(() => "batch after refusal");
  const s = fakeStreaming({ open: () => { throw new SttCapacityError("no free channel"); } });
  await run(cfg(), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "heard");
    assert.equal(r.heard()[0]!.text, "batch after refusal");
    assert.equal(s.stats.opens, 1);
    await sleep(120);
    assert.ok(neverDown(r));
  });
});

type Fail = { name: string; script: Parameters<typeof fakeStreaming>[0]; after?: (s: ReturnType<typeof fakeStreaming>) => Promise<void> };
const failures: Fail[] = [
  { name: "the session cannot be opened", script: { open: () => { throw new Error("connect ECONNREFUSED"); } } },
  { name: "the connection takes longer than ears.stt_timeout_ms", script: { open: () => sleep(1500) } },
  { name: "the session drops before the close", script: {}, after: async (s) => { await waitFor(() => s.sessions.length === 1, "session"); s.sessions[0]!.fail(new Error("server closed")); } },
  { name: "finish() fails", script: { finish: () => { throw new Error("no final"); } } },
  { name: "the final does not arrive within ears.stt_timeout_ms", script: { finish: () => new Promise<string>(() => {}) } },
];
// @spec EARS-SES-010
for (const f of failures) {
  test(`a session that cannot serve (${f.name}): the retained clip goes to the batch engine and its text is the final speech.heard, same utteranceId, only partials lost`, async () => {
    const stt = fakeStt(() => "batch rescued");
    const s = fakeStreaming(f.script);
    await run(cfg({ partials: "on", partial_step_ms: 30, stt_gpu: true }), s, stt, async (r) => {
      const run1 = say(r, "u1", 12);
      if (f.after) await f.after(s);
      await run1;
      await waitFor(() => r.heard().length === 1, "heard", 4000);
      assert.equal(r.heard()[0]!.text, "batch rescued");
      assert.equal(typeof r.heard()[0]!.utteranceId, "string");
      assert.equal(stt.calls.length, 1, "one batch attempt");
      assert.equal(stt.calls[0]!.ms, 240, "the whole utterance, 12 frames of 20 ms");
      for (const p of r.partials()) assert.equal(p.utteranceId, r.heard()[0]!.utteranceId);
    });
  });
}

// @spec EARS-SES-010
test("a fallback keeps the id the partials carried: a hypothesis published before the session failed and the final share one utteranceId", async () => {
  const stt = fakeStt(() => "batch rescued after partial");
  const s = fakeStreaming({ finish: () => { throw new Error("no final"); } });
  await run(cfg({ partials: "on", partial_step_ms: 30, stt_gpu: true }), s, stt, async (r) => {
    const speaking = say(r, "u1", 12);
    await waitFor(() => s.sessions.length === 1, "session");
    await sleep(120); // past min_speech_ms of audio
    s.sessions[0]!.hypothesis("partial words");
    await speaking;
    await waitFor(() => r.heard().length === 1, "heard", 4000);
    assert.equal(r.partials().length, 1);
    assert.equal(r.partials()[0]!.utteranceId, r.heard()[0]!.utteranceId);
  });
});

// @spec EARS-SES-011, EARS-HLTH-006
test("an outage-class session failure with no batch engine drops the utterance with a warning and deps.stt says no fallback engine", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ open: () => { throw new Error("connect ECONNREFUSED"); } });
  await run(cfg({ stt_fallback_engine: "none" }), s, stt, async (r) => {
    const before = warns(r);
    await say(r);
    await sleep(300);
    assert.equal(r.heard().length, 0);
    assert.equal(stt.calls.length, 0);
    assert.ok(warns(r) > before, "a warning");
    await waitFor(() => r.lastHeartbeat()?.deps.stt === "down" && /no fallback engine, utterances dropped$/.test(r.lastHeartbeat()?.detail ?? ""), "stt down, no fallback engine", 4000);
  });
});

// @spec EARS-SES-012, EARS-HLTH-011
test("one attempt per utterance: a failed connect is not retried and queues nothing; the next utterance tries again", async () => {
  const stt = fakeStt(() => "batch");
  const s = fakeStreaming({ open: () => { throw new Error("connect ECONNREFUSED"); } });
  await run(cfg(), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "first heard");
    await sleep(500);
    assert.equal(s.stats.opens, 1, "no reconnection loop");
    assert.equal(stt.calls.length, 1, "no queue of failed audio");
    await say(r);
    await waitFor(() => r.heard().length === 2, "second heard");
    assert.equal(s.stats.opens, 2, "a new utterance tries a session even while down");
  });
});

// @spec EARS-SES-013
test("with no batch engine, an utterance refused a session for capacity, and one of an echo-suppressed source that passes the gate, are dropped with a warning and deps.stt is left alone", async () => {
  const stt = fakeStt(() => "unused");
  const full = fakeStreaming({ open: () => { throw new SttCapacityError("no free channel"); } });
  await run(cfg({ stt_fallback_engine: "none" }), full, stt, async (r) => {
    const before = warns(r);
    await say(r);
    await sleep(350);
    assert.equal(r.heard().length, 0);
    assert.ok(warns(r) > before, "capacity drop warns");
    assert.ok(neverDown(r));
  });
  const idle = fakeStreaming();
  await run(cfg({ stt_fallback_engine: "none", echo_suppress_sources: ["discord"], echo_tail_ms: 300 }), idle, stt, async (r) => {
    const before = warns(r);
    await say(r);
    await sleep(350);
    assert.equal(r.heard().length, 0);
    assert.equal(idle.stats.opens, 0);
    assert.ok(warns(r) > before, "echo-suppressed drop warns");
    assert.ok(neverDown(r));
  });
});

// @spec EARS-SES-002, EARS-SES-004
test("an utterance that closes while its connect is pending waits for the connect: its held frames are pushed, then its final comes from the session", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ open: () => sleep(400), finish: () => "waited for the connect" });
  await run(cfg({ stt_timeout_ms: 1000 }), s, stt, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "heard", 3000);
    assert.equal(r.heard()[0]!.text, "waited for the connect");
    assert.equal(stt.calls.length, 0, "no batch call while the connect was pending");
    assert.equal(s.sessions[0]!.finishCalls, 1);
    assert.equal(s.sessions[0]!.audio().length, 10 * FRAME_BYTES, "every frame held while connecting was pushed");
  });
});

// @spec EARS-SES-007, EARS-ENG-007
test("a connect still pending when its source stops is aborted, and one that never answers is aborted at ears.stt_timeout_ms", async () => {
  const stt = fakeStt(() => "unused");
  const seen: AbortSignal[] = [];
  const s = fakeStreaming({ open: (_n, { signal }) => { seen.push(signal); return new Promise<void>(() => {}); } });
  resetSeq();
  const r = await boot(cfg({ silence_ms: 5000, stt_timeout_ms: 5000 }), { setup: reg, streaming: s.engine });
  try {
    await sleep(60);
    await say(r);
    await waitFor(() => seen.length === 1, "connect started");
    assert.ok(!seen[0]!.aborted);
  } finally { await r.stop(); stt.restore(); }
  assert.ok(seen[0]!.aborted, "aborted at source stop");

  const timedOut: AbortSignal[] = [];
  const t = fakeStreaming({ open: (_n, { signal }) => { timedOut.push(signal); return new Promise<void>(() => {}); } });
  await run(cfg({ silence_ms: 5000, stt_timeout_ms: 100 }), t, stt, async (r2) => {
    await say(r2);
    await waitFor(() => timedOut.length === 1, "connect started");
    await waitFor(() => timedOut[0]!.aborted, "aborted at the bound", 1000);
    await waitFor(() => r2.lastHeartbeat()?.deps.stt === "down" && /session did not connect after 100 ms/.test(r2.lastHeartbeat()?.detail ?? ""), "outage recorded", 2000);
  });
});

// @spec EARS-KYU-007
test("kyutai: an unechoed Marker is not a failure: speech.heard carries the words so far, deps.stt stays ok, the batch engine is not called", async () => {
  const srv = await kyutaiServer({ echo: false });
  const stt = fakeStt(() => "from the batch engine");
  const ears = cfg({ stt_engine: "kyutai", stt_timeout_ms: 300, kyutai: { url: srv.url } });
  resetSeq();
  const r = await boot(ears, { setup: reg, streaming: createKyutaiEngine(earsCfg(ears)) });
  try {
    await sleep(60);
    await say(r);
    await until(() => srv.messages.length > 0, "the first audio at the server");
    srv.send(word("so"));
    srv.send(word("far", 0.3));
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    assert.equal(r.heard()[0]!.text, "so far");
    assert.equal(stt.calls.length, 0, "the batch engine is not used");
    assert.ok(neverDown(r), "a flush timeout leaves deps.stt alone");
    assert.equal(srv.markers().length, 1, "the Marker was sent and never echoed");
  } finally { await r.stop(); stt.restore(); await srv.close(); }
});
