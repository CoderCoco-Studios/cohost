import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, event, silentLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createInjectHandler } from "../src/inject.js";
import { SPEECH, boot, frame, connectorOffer, fakeStreaming, fakeStt, feed, resetSeq, sleep } from "./rig.js";

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
/** Real STT path (faked fetch), gap endpointing, a short step so a test needs ~0.5 s: 150 ms of silence closes an utterance. */
const cfg = (over: Record<string, unknown> = {}) => ({
  sources: ["discord"], stt_engine: "speaches", partials: "on", stt_gpu: true, partial_step_ms: 30,
  // CFG-SCH-105: ears.early.after_ms (default 250) must sit below silence_ms, so it is set here.
  silence_ms: 150, early: { after_ms: 100 }, min_speech_ms: 100, vad: { engine: "gap" }, ...over,
});
/** Scripted answers by call order; the last one repeats (so the final transcription gets it too). */
const script = (...texts: string[]) => (c: { n: number }) => texts[Math.min(c.n, texts.length - 1)]!;
const AGREE = script("hello there", "hello there my friend", "HELLO THERE MY FRIENDS", "HELLO THERE MY FRIENDS");

async function run<T>(stt: ReturnType<typeof fakeStt>, ears: Record<string, unknown>, body: (r: Awaited<ReturnType<typeof boot>>) => Promise<T>, o: Parameters<typeof boot>[1] = { setup: reg }): Promise<T> {
  resetSeq();
  const r = await boot(ears, o);
  try { await sleep(60); return await body(r); } finally { await r.stop(); stt.restore(); }
}

// @spec EARS-PART-001
test("ears.partials off (the default) publishes no partial and makes only the final transcription call", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ partials: "off" }), async (r) => {
    await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(r.partials().length, 0);
    assert.equal(stt.calls.length, 1, "the final alone");
  });
});

// @spec EARS-PART-002
test("a dir clip with partials on publishes no partial and its speech.heard carries a unique utteranceId (EARS-PART-003)", async () => {
  const stt = fakeStt(script("one two three"));
  const dir = await mkdtemp(join(tmpdir(), "ears-part-"));
  try {
    await run(stt, cfg({ sources: ["dir"], dir: { path: dir, poll_ms: 20 } }), async (r) => {
      await writeFile(join(dir, "a.wav"), wavWrap(Buffer.alloc(32000, 1), 16000, 1));
      await writeFile(join(dir, "b.wav"), wavWrap(Buffer.alloc(32000, 1), 16000, 1));
      await waitFor(() => r.heard().length === 2, "two clips");
      await sleep(100);
      assert.equal(r.partials().length, 0);
      const ids = r.heard().map((h) => h.utteranceId);
      assert.ok(ids.every((i) => typeof i === "string" && i !== ""), "every whole clip has an utteranceId");
      assert.notEqual(ids[0], ids[1]);
    }, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-PART-003
test("injected audio: its speech.heard carries an utteranceId, a different one per injection", async () => {
  const bus = new FakeBus();
  const UP = "0123456789abcdef0123456789abcdef";
  bus.takeUpload = async () => wavWrap(Buffer.alloc(32000), 16000, 1);
  const handle = createInjectHandler({ bus, log: silentLog, transcribe: async () => "hello there" });
  for (const id of ["a1", "a2"]) handle(event("inject.request", { id, target: "ears", kind: "audio", uploadId: UP, contentType: "audio/wav", remember: false }) as never);
  await handle.drain();
  const ids = bus.of("speech.heard").map((h) => (h as { utteranceId?: string }).utteranceId);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((i) => typeof i === "string" && i !== ""));
  assert.notEqual(ids[0], ids[1]);
});

// @spec EARS-PART-003, EARS-PART-006
test("partials and the final of one utterance share one utteranceId, a new utterance gets another; partials carry speaker, speakerId, source and audioEndedAt", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg(), async (r) => {
    const t = await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1 && r.partials().length >= 1, "partial and final");
    const p = r.partials()[0]!;
    const h = r.heard()[0]!;
    assert.deepEqual([p.speaker, p.speakerId, p.source], [h.speaker, h.speakerId, h.source]);
    assert.deepEqual([p.speaker, p.speakerId, p.source], ["U1", "u1", "discord"]);
    assert.equal(typeof p.utteranceId, "string");
    assert.ok(p.utteranceId !== "");
    assert.ok(r.partials().every((x) => x.utteranceId === h.utteranceId), "every partial and the final share the id");
    const at = p.timing?.audioEndedAt;
    assert.ok(at !== undefined && at >= t.first && at <= t.last + 5, "audioEndedAt is when the last transcribed frame arrived");
    await feed(r.bus, 20, { gapMs: 15 });
    await waitFor(() => r.heard().length === 2, "second final");
    assert.notEqual(r.heard()[1]!.utteranceId, h.utteranceId);
  });
});

// @spec EARS-PART-004
test("every step the whole utterance so far goes to the STT endpoint as one 16 kHz WAV with the request of EARS-HEAR-005", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ stt_model: "m-small" }), async (r) => {
    await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    const partialCalls = stt.calls.slice(0, -1);
    assert.ok(partialCalls.length >= 4, `steps ran (${partialCalls.length} calls)`);
    assert.ok(partialCalls[0]!.ms >= 100, "not before min_speech_ms of audio");
    for (let i = 1; i < partialCalls.length; i++) assert.ok(partialCalls[i]!.ms >= partialCalls[i - 1]!.ms, "the window only grows: all audio so far");
    assert.deepEqual(stt.calls.map((c) => [c.fields.model, c.fields.language, c.fields.response_format]).filter((x) => x[0] !== "m-small" || x[1] !== "en" || x[2] !== "json"), []);
    assert.equal(stt.calls.at(-1)!.ms, 500, "the final is the whole clip");
  });
});

// @spec EARS-PART-005, EARS-PART-006
test("the committed text is the common word prefix of two consecutive transcriptions in the later wording, published only when it grows; seq counts from 0", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 30, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.deepEqual(r.partials().map((p) => [p.seq, p.text]), [[0, "hello there"], [1, "HELLO THERE MY"], [2, "HELLO THERE MY FRIENDS"]], "later calls repeat the same text: no growth, no partial");
  });
});

// @spec EARS-PART-007
test("a committed text that is a drop phrase or has no word character publishes no partial", async () => {
  for (const [text, extra] of [["okay", { drop_phrases: ["Okay."] }], ["... ...", {}]] as const) {
    const stt = fakeStt(script(text));
    await run(stt, cfg(extra), async (r) => {
      await feed(r.bus, 25, { gapMs: 15 });
      await sleep(250);
      assert.equal(r.partials().length, 0, text);
    });
  }
});

// @spec EARS-PART-007
test("an utterance shorter than ears.min_speech_ms causes no transcription and no partial (passes today)", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ min_speech_ms: 400 }), async (r) => {
    await feed(r.bus, 5, { gapMs: 10 });
    await sleep(400);
    assert.equal(stt.calls.length, 0);
    assert.equal(r.partials().length, 0);
    assert.equal(r.heard().length, 0);
  });
});

// @spec EARS-PART-008
test("at most one partial transcription of an utterance is in flight and a step due meanwhile is skipped, not queued", async () => {
  const stt = fakeStt(async () => { await sleep(120); return "hello there"; });
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.ok(stt.calls.length >= 2, "partial calls ran");
    const partialCalls = stt.calls.slice(0, -1);
    for (let i = 1; i < partialCalls.length; i++) assert.ok(partialCalls[i]!.startedAt - partialCalls[i - 1]!.startedAt >= 110, "no overlap: the next starts after the previous returned");
    assert.ok(partialCalls.length <= 5, `skipped steps were not queued (${partialCalls.length} partial calls in ~375 ms at 30 ms steps)`);
  });
});

// @spec EARS-PART-009
test("closing does not wait for a partial in flight, and that partial's late result is discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stt = fakeStt(async (c) => {
    if (c.n === 0) return "hello there";
    if (c.n === 1) { await gate; return "hello there my friend"; } // would commit and publish if it were not discarded
    return "hello there my friend"; // the final
  });
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 8, { gapMs: 15 });
    await waitFor(() => stt.calls.length >= 2, "second partial call in flight");
    await waitFor(() => r.heard().length === 1, "speech.heard while the partial is still in flight");
    assert.equal(stt.stats.inflight(), 1, "the partial has not returned");
    release();
    await sleep(150);
    assert.equal(r.partials().length, 0, "late partial result discarded");
    assert.equal(r.heard()[0]!.text, "hello there my friend");
  });
});

// @spec EARS-PART-010
test("a failed partial call publishes nothing, restarts agreement and leaves the final to proceed", async () => {
  const stt = fakeStt(async (c) => {
    if (c.n === 1) throw new Error("stt 500");
    return ["a b", "x", "a b c", "a b c d", "a b c d"][Math.min(c.n, 4)]!;
  });
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 30, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.ok(r.partials().length >= 1);
    // Without forgetting, call 0 and call 2 would agree on "a b" and publish it; with it, call 2 and 3 agree on "a b c".
    assert.deepEqual([r.partials()[0]!.seq, r.partials()[0]!.text], [0, "a b c"]);
    assert.ok(r.log.msgs("warn").concat(r.log.msgs("error")).length >= 1, "the failure is logged");
  });
});

// @spec EARS-PART-010
test("a failed partial call leaves deps.stt ok", async () => {
  const stt = fakeStt(async (c) => { if (c.n < 100 && c.n !== 99) throw new Error("stt 500"); return "x"; });
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 15, { gapMs: 15 });
    await sleep(100);
    assert.ok(stt.calls.length >= 2, "partial calls failed");
    assert.notEqual(r.lastHeartbeat()?.deps?.stt, "down", "only a final or injected transcription moves deps.stt");
  });
});

// @spec EARS-PART-011
test("stub engine: no partial whatever ears.partials says, and a startup warning when it is on", async () => {
  const stt = fakeStt(script("x"));
  await run(stt, cfg({ stt_engine: "stub" }), async (r) => {
    assert.ok(r.log.msgs("warn").some((m) => /partials/i.test(String(m))), "warns that partials are not produced with the stub engine");
    await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.equal(r.partials().length, 0);
  });
});

// @spec EARS-PART-012
test("partials on without ears.stt_gpu: partials are published and a startup warning says transcription may not keep up", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ stt_gpu: false }), async (r) => {
    assert.ok(r.log.msgs("warn").some((m) => /gpu/i.test(String(m)) && /partial/i.test(String(m))), "GPU warning");
    await feed(r.bus, 30, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.ok(r.partials().length >= 1);
  });
});

// @spec EARS-PART-012
test("with ears.stt_gpu true there is no GPU warning (passes today)", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ stt_gpu: true }), async (r) => {
    assert.ok(!r.log.msgs("warn").some((m) => /gpu/i.test(String(m))));
  });
});

// @spec EARS-PART-013
test("stopping the source cancels the partial steps and discards a partial transcription still in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stt = fakeStt(async (c) => { if (c.n === 0) return "hello there"; await gate; return "hello there my friend"; });
  resetSeq();
  const r = await boot(cfg({ silence_ms: 2000 }), { setup: reg });
  try {
    await sleep(60);
    await feed(r.bus, 8, { gapMs: 15 });
    await waitFor(() => stt.calls.length >= 2, "second partial call in flight");
    const stopping = r.stop();
    release();
    await stopping;
    const calls = stt.calls.length;
    await sleep(200);
    assert.equal(stt.calls.length, calls, "no further step after the stop");
    assert.equal(r.partials().length, 0);
  } finally { stt.restore(); }
});

// @spec EARS-PART-014
test("a failed speech.partial publish is logged, does not consume its seq and the final proceeds", async () => {
  const stt = fakeStt(AGREE);
  resetSeq();
  let failed = 0;
  const r = await boot(cfg(), { setup: (b) => { reg(b); b.fail = (t) => String(t) === "speech.partial" && failed++ === 0; } });
  try {
    await sleep(60);
    await feed(r.bus, 30, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.ok(failed >= 1, "a publish was attempted and failed");
    assert.ok(r.partials().length >= 1, "later partials went out");
    assert.equal(r.partials()[0]!.seq, 0, "the failed publish's seq was not consumed");
    assert.deepEqual(r.partials().map((p) => p.seq), r.partials().map((_, i) => i), "no gap in seq");
    assert.ok(r.log.msgs("warn").concat(r.log.msgs("error")).length >= 1, "logged");
  } finally { await r.stop(); stt.restore(); }
});

// @spec EARS-PART-013
test("an utterance closed because its connector disappeared publishes no partial afterwards and its final proceeds", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stt = fakeStt(async (c) => { if (c.n === 0) return "hello there"; if (c.n === 1) { await gate; return "hello there my friend"; } return "hello there my friend"; });
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 8, { gapMs: 15 });
    await waitFor(() => stt.calls.length >= 2, "partial in flight");
    r.bus.regs.delete("discord"); // the connector disappears; the frame gap closes the utterance
    await waitFor(() => r.heard().length === 1, "final");
    release();
    const calls = stt.calls.length;
    await sleep(200);
    assert.equal(r.partials().length, 0);
    assert.equal(stt.calls.length, calls, "no step after the close");
  });
});

// @spec EARS-VAD-008
test("a seq gap does not reset the partial state: agreement carries across it and seq stays continuous", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg(), async (r) => {
    await feed(r.bus, 10, { gapMs: 15 });
    r.bus.feed("in", "discord", frame("u1", SPEECH, 20, 5)); // 5 frames lost
    await feed(r.bus, 15, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1, "final");
    assert.equal(r.heard().length, 1, "one utterance across the gap");
    assert.deepEqual(r.partials().map((p) => [p.seq, p.text]), [[0, "hello there"], [1, "HELLO THERE MY"], [2, "HELLO THERE MY FRIENDS"]]);
    assert.equal(new Set(r.partials().map((p) => p.utteranceId)).size, 1);
    assert.equal(stt.calls.at(-1)!.ms, 520, "the 26 received frames, the lost ones not filled");
  });
});

// ---- streaming engines (EARS-PART-016 to 022) and batch engines other than speaches
// A scripted streaming session (rig.ts `fakeStreaming`) supplies the hypotheses; the test pulls them when it wants.

const scfg = (over: Record<string, unknown> = {}) => cfg({ stt_engine: "nemotron", stt_gpu: false, partial_step_ms: 30, stt_timeout_ms: 300, ...over });
const sreg = (streaming: ReturnType<typeof fakeStreaming>, extra?: (b: Parameters<typeof reg>[0]) => void) => ({ setup: (b: Parameters<typeof reg>[0]) => { reg(b); extra?.(b); }, streaming: streaming.engine });
const audioMs = (s: { audio(): Buffer }) => s.audio().length / 32;
/** Feed in the background; resolves when the last frame was fed. */
const speak = (r: Awaited<ReturnType<typeof boot>>, n = 25) => feed(r.bus, n, { gapMs: 15 });
/** Wait until the session of the utterance holds at least `ms` ms of audio, past `ears.min_speech_ms`. */
const pastMin = async (s: ReturnType<typeof fakeStreaming>, ms = 140) => { await waitFor(() => s.sessions.length === 1 && audioMs(s.sessions[0]!) >= ms, "session with audio"); };

// @spec EARS-PART-016, EARS-PART-006, EARS-PART-017
test("streaming: each changed hypothesis becomes a speech.partial with the speaker fields, a rising seq and the id of the final; filtered like a final", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "hello there my friend" });
  await run(stt, scfg({ drop_phrases: ["thanks for watching"] }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    const h = s.sessions[0]!;
    h.hypothesis("hello"); await sleep(60);
    h.hypothesis("hello there"); await sleep(60);
    h.hypothesis("..."); await sleep(60);
    h.hypothesis("Thanks for watching"); await sleep(60);
    const t = await speaking;
    await waitFor(() => r.heard().length === 1, "final");
    assert.deepEqual(r.partials().map((p) => [p.seq, p.text]), [[0, "hello"], [1, "hello there"]]);
    for (const p of r.partials()) {
      assert.deepEqual([p.speaker, p.speakerId, p.source, p.utteranceId], ["U1", "u1", "discord", r.heard()[0]!.utteranceId]);
      assert.ok(p.timing!.audioEndedAt! >= t.first && p.timing!.audioEndedAt! <= Date.now(), "audioEndedAt is when the last sent frame arrived");
    }
  }, sreg(s));
});

// @spec EARS-PART-017, EARS-PART-001
test("streaming pacing: the first change at once, then at most one per ears.partial_step_ms, the latest unpublished change when the window ends", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "a b c" });
  const times: number[] = [];
  await run(stt, scfg({ partial_step_ms: 250 }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    const h = s.sessions[0]!;
    const t0 = Date.now();
    h.hypothesis("a");
    await waitFor(() => r.partials().length === 1, "first at once");
    assert.ok(times[0]! - t0 < 100, "no wait for the first change");
    await sleep(20); h.hypothesis("a b");
    await sleep(20); h.hypothesis("a b c");
    await sleep(80);
    assert.equal(r.partials().length, 1, "inside the window nothing more is published");
    await waitFor(() => r.partials().length === 2, "trailing publish", 1500);
    assert.deepEqual(r.partials().map((p) => p.text), ["a", "a b c"], "the latest change, not the one in between");
    assert.ok(times[1]! - times[0]! >= 200, `one window apart (${times[1]! - times[0]!} ms)`);
    await speaking;
  }, sreg(s, (bus) => { const pub = bus.publish.bind(bus); (bus as unknown as { publish: unknown }).publish = async (t: string, d: unknown) => { if (t === "speech.partial") times.push(Date.now()); return (pub as (t: string, d: unknown) => Promise<string>)(t, d); }; }));
});

// @spec EARS-PART-018
test("streaming: no speech.partial before the utterance has ears.min_speech_ms of audio", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "early words here" });
  await run(stt, scfg({ min_speech_ms: 200 }), async (r) => {
    const speaking = speak(r);
    await waitFor(() => s.sessions.length === 1, "session");
    s.sessions[0]!.hypothesis("early");
    await sleep(50);
    assert.ok(audioMs(s.sessions[0]!) < 200, "still under the minimum");
    assert.equal(r.partials().length, 0);
    await waitFor(() => audioMs(s.sessions[0]!) >= 260, "past the minimum");
    s.sessions[0]!.hypothesis("early words");
    await waitFor(() => r.partials().length >= 1, "partial after the minimum");
    assert.equal(r.partials().at(-1)!.text, "early words");
    await speaking;
  }, sreg(s));
});

// @spec EARS-PART-019
test("streaming: a partial only when the hypothesis differs from the last one published, and a hypothesis with fewer words is published", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "one two" });
  await run(stt, scfg(), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    const h = s.sessions[0]!;
    for (const t of ["one two three", "one two three", "one two"]) { h.hypothesis(t); await sleep(70); }
    assert.deepEqual(r.partials().map((p) => p.text), ["one two three", "one two"]);
    await speaking;
  }, sreg(s));
});

// @spec EARS-PART-020, EARS-PART-009
test("streaming: nothing is published for an utterance after its close, neither a hypothesis that arrives late nor a pending trailing publish", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "a b c" });
  await run(stt, scfg({ partial_step_ms: 400 }), async (r) => {
    const speaking = speak(r, 10);
    await pastMin(s, 120);
    const h = s.sessions[0]!;
    h.hypothesis("a");
    await waitFor(() => r.partials().length === 1, "first");
    h.hypothesis("a b"); // waits for the end of the 400 ms window
    await speaking;
    await waitFor(() => r.heard().length === 1, "final");
    h.hypothesis("a b c"); // after the close
    await sleep(700);
    assert.deepEqual(r.partials().map((p) => p.text), ["a"], "the pending change and the late hypothesis are discarded");
  }, sreg(s));
});

// @spec EARS-PART-021, EARS-SES-010
test("streaming: an utterance that has no session (the connect failed) publishes no partial, and its final comes from the batch engine", async () => {
  const stt = fakeStt(() => "batch final");
  const s = fakeStreaming({ open: () => { throw new Error("connect ECONNREFUSED"); } });
  await run(stt, scfg(), async (r) => {
    await speak(r);
    await waitFor(() => r.heard().length === 1, "final");
    assert.equal(r.heard()[0]!.text, "batch final");
    assert.equal(r.partials().length, 0);
  }, sreg(s));
});

// @spec EARS-PART-022, EARS-PART-012
test("streaming: partials cost no extra STT call and ears.stt_gpu false logs no GPU warning", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "hello there" });
  await run(stt, scfg({ stt_gpu: false }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    s.sessions[0]!.hypothesis("hello"); await sleep(60);
    s.sessions[0]!.hypothesis("hello there"); await sleep(60);
    await speaking;
    await waitFor(() => r.heard().length === 1, "final");
    assert.ok(r.partials().length >= 1);
    assert.equal(stt.calls.length, 0, "no batch call for a partial or the final");
    assert.ok(!r.log.msgs("warn").some((m) => /gpu/i.test(String(m))), "no GPU warning");
  }, sreg(s));
});

// @spec EARS-PART-001
test("streaming with ears.partials off: hypotheses publish no speech.partial", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "hello there" });
  await run(stt, scfg({ partials: "off" }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    s.sessions[0]!.hypothesis("hello"); await sleep(60);
    s.sessions[0]!.hypothesis("hello there"); await sleep(60);
    await speaking;
    await waitFor(() => r.heard().length === 1, "final");
    assert.equal(r.partials().length, 0);
  }, sreg(s));
});

// @spec EARS-PART-004, EARS-PART-005, EARS-PART-006, EARS-ENG-006
test("batch engine openai: partials re-read the utterance through the openai request with LocalAgreement", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ stt_engine: "openai", openai: { base_url: "https://api.example.com/v1", api_key: "sk-test" } }), async (r) => {
    await feed(r.bus, 25, { gapMs: 15 });
    await waitFor(() => r.heard().length === 1 && r.partials().length >= 1, "partial and final");
    assert.deepEqual(r.partials().map((p) => p.text).slice(0, 2), ["hello there", "HELLO THERE MY"], "committed on two agreeing reads, in the later wording");
    assert.ok(stt.calls.length >= 3);
    assert.ok(stt.calls.every((c) => c.url === "https://api.example.com/v1/audio/transcriptions" && c.auth === "Bearer sk-test"));
  });
});

// @spec EARS-PART-012
test("a batch engine other than stub with ears.stt_gpu false logs the startup GPU warning; with the engine openai too", async () => {
  const stt = fakeStt(AGREE);
  await run(stt, cfg({ stt_engine: "openai", stt_gpu: false, openai: { base_url: "https://api.example.com/v1" } }), async (r) => {
    assert.ok(r.log.msgs("warn").some((m) => /gpu/i.test(String(m)) && /partial/i.test(String(m))));
  });
});

// @spec EARS-PART-018
test("a hypothesis that arrives before ears.min_speech_ms is published once the minimum is reached, without a new hypothesis", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "early words here" });
  await run(stt, scfg({ min_speech_ms: 200 }), async (r) => {
    const speaking = speak(r);
    await waitFor(() => s.sessions.length === 1, "session");
    s.sessions[0]!.hypothesis("early words");
    await speaking;
    await waitFor(() => r.partials().length === 1, "held hypothesis published", 1000);
    assert.equal(r.partials()[0]!.text, "early words");
  }, sreg(s));
});

// @spec EARS-PART-016, EARS-PART-017
test("a filtered hypothesis does not start the pacing window: the next change is published at once", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "hello" });
  await run(stt, scfg({ partial_step_ms: 2000 }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    const h = s.sessions[0]!;
    h.hypothesis("...");
    await sleep(50);
    h.hypothesis("hello");
    await waitFor(() => r.partials().length === 1, "hello at once", 800);
    assert.equal(r.partials()[0]!.text, "hello");
    await speaking;
  }, sreg(s));
});

// @spec EARS-PART-006, EARS-PART-014
test("streamed partials are published one at a time, and seq rises by one for each one published", async () => {
  const stt = fakeStt(() => "unused");
  const s = fakeStreaming({ finish: () => "a b c d" });
  let inflight = 0;
  let maxInflight = 0;
  await run(stt, scfg({ partial_step_ms: 20 }), async (r) => {
    const speaking = speak(r, 40);
    await pastMin(s);
    const h = s.sessions[0]!;
    for (const t of ["a", "a b", "a b c", "a b c d"]) { h.hypothesis(t); await sleep(25); }
    await speaking;
    await waitFor(() => r.heard().length === 1, "final");
    await sleep(300);
    assert.equal(maxInflight, 1, "a publish never overlaps the one before it");
    assert.deepEqual(r.partials().map((p) => p.seq), r.partials().map((_, i) => i));
  }, sreg(s, (bus) => {
    const pub = bus.publish.bind(bus);
    (bus as unknown as { publish: unknown }).publish = async (t: string, d: { seq: number }) => {
      if (t !== "speech.partial") return pub(t, d);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(40);
      inflight--;
      return pub(t, d);
    };
  }));
});

// @spec EARS-PART-009, EARS-EARLY-016
test("a reused early transcript is the final even with a partial in flight: nothing waits for the partial, and its late result publishes nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let lastFrameAt = Infinity;
  let earlyTaken = false;
  const stt = fakeStt(async (c) => {
    if (!earlyTaken && c.startedAt >= lastFrameAt + 80) { earlyTaken = true; return "hello there"; } // the early snapshot
    await gate; // every partial step
    return "hello there my friend";
  });
  await run(stt, cfg({ silence_ms: 700, partial_step_ms: 150, stt_timeout_ms: 5000, early: { enabled: true, after_ms: 100 } }), async (r) => {
    await feed(r.bus, 10, { gapMs: 15 });
    lastFrameAt = Date.now();
    await waitFor(() => r.heard().length === 1, "speech.heard while a partial is in flight", 3000);
    const h = r.heard()[0]!;
    assert.equal(stt.stats.inflight() >= 1, true, "a partial is still in flight");
    assert.deepEqual([h.text, h.earlySeq], ["hello there", 0]);
    release();
    await sleep(150);
    assert.equal(r.partials().length, 0, "no partial after the final");
  });
});
