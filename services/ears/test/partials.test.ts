import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, event, silentLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { createInjectHandler } from "../src/inject.js";
import { SPEECH, boot, frame, connectorOffer, fakeStt, feed, resetSeq, sleep } from "./rig.js";

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
/** Real STT path (faked fetch), gap endpointing, a short step so a test needs ~0.5 s: 150 ms of silence closes an utterance. */
const cfg = (over: Record<string, unknown> = {}) => ({
  sources: ["discord"], stt_engine: "speaches", partials: "on", stt_gpu: true, partial_step_ms: 30,
  silence_ms: 150, min_speech_ms: 100, vad: { engine: "gap" }, ...over,
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
