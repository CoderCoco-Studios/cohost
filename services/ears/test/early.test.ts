import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { SILENCE, SPEECH, boot, connectorOffer, fakeStreaming, fakeStt, fakeVad, feed, resetSeq, sleep } from "./rig.js";

// Early transcripts (EARS-EARLY-*): the real ears service on a fake bus, a scripted batch STT endpoint, real clocks.
// Timeline of the default fixture (gap engine): frames arrive fast, the pause starts at the last frame, an early snapshot is
// due 100 ms later (early.after_ms) and the close 300 ms after the last frame (silence_ms). CFG-SCH-105: after_ms < silence_ms.

type Rig = Awaited<ReturnType<typeof boot>>;
const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
const cfg = (over: Record<string, unknown> = {}, early: Record<string, unknown> = {}) => ({
  sources: ["discord"], stt_engine: "speaches", partials: "off", vad: { engine: "gap" }, silence_ms: 300, min_speech_ms: 100, stt_timeout_ms: 2000,
  ...over, early: { enabled: true, after_ms: 100, max_per_utterance: 2, ...early },
});
async function run<T>(stt: ReturnType<typeof fakeStt>, ears: Record<string, unknown>, body: (r: Rig) => Promise<T>, o: Parameters<typeof boot>[1] = {}): Promise<T> {
  resetSeq();
  const r = await boot(ears, { setup: reg, ...o });
  try { await sleep(60); return await body(r); } finally { await r.stop(); stt.restore(); }
}
const say = (r: Rig, n = 10, o: { fill?: number; gapMs?: number } = {}) => feed(r.bus, n, o);
const detail = (r: Rig) => r.lastHeartbeat()?.detail ?? "";
const types = (r: Rig) => r.bus.published.map((p) => p.type as string);
const snapshotTaken = (stt: ReturnType<typeof fakeStt>) => waitFor(() => stt.calls.length >= 1, "an early snapshot call within the pause, before the close", 250);
const COUNTS = (p: number, x: number, u: number, l: number) => `early: ${p} published, ${x} retracted, ${u} reused, ${l} late`;

// @spec EARS-EARLY-001, EARS-EARLY-005, EARS-EARLY-012, EARS-EARLY-024
test("a pause of after_ms in an open utterance publishes one speech.early before the close: the clip so far, the final's utteranceId, seq 0, sttMs, audioEndedAt, no injection flags", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg(), async (r) => {
    const t = await say(r);
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    assert.equal(r.heard().length, 0, "published while the utterance is still open");
    const e = r.early()[0]!;
    assert.deepEqual([e.speaker, e.speakerId, e.source, e.text, e.seq], ["U1", "u1", "discord", "hello there", 0]);
    assert.ok(Number.isInteger(e.sttMs) && e.sttMs >= 0);
    assert.ok(e.timing?.audioEndedAt !== undefined && e.timing.audioEndedAt >= t.first && e.timing.audioEndedAt <= t.last + 5, "audioEndedAt is the last frame's arrival");
    assert.equal(stt.calls.length, 1);
    assert.equal(stt.calls[0]!.ms, 200, "the whole clip so far");
    for (const k of ["injected", "remember", "earlySeq"]) assert.ok(!(k in e), `no ${k}`);
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(r.heard()[0]!.utteranceId, e.utteranceId);
  });
});

// @spec EARS-EARLY-001, EARS-EARLY-005, EARS-EARLY-021
test("silero: the pause is measured in received audio since the last speech frame, the clip ends at that frame, and the reused final carries its arrival as audioEndedAt", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({ vad: { engine: "silero" } }), async (r) => {
    await say(r, 10, { fill: SPEECH });
    const lastSpeechAt = Date.now();
    await say(r, 3, { fill: SILENCE }); // 60 ms of silence audio, below after_ms
    await sleep(80);
    assert.equal(r.early().length, 0, "less than after_ms of audio has passed");
    assert.equal(stt.calls.length, 0);
    await say(r, 2, { fill: SILENCE }); // 100 ms
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    assert.equal(stt.calls[0]!.ms, 200, "up to the last speech frame, not the silence after it");
    await say(r, 10, { fill: SILENCE, gapMs: 5 });
    await waitFor(() => r.heard().length === 1, "speech.heard");
    const at = r.heard()[0]!.timing!.audioEndedAt!;
    assert.ok(at <= lastSpeechAt + 5, "the last speech frame, not a later silence frame");
    assert.equal(r.early()[0]!.timing!.audioEndedAt, at);
  }, { loadVad: fakeVad().load });
});

// @spec EARS-EARLY-001
test("early reply off (the default) takes no snapshot, publishes no early event and the heartbeat has no early counts", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({}, { enabled: false }), async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "speech.heard");
    await sleep(120);
    assert.equal(stt.calls.length, 1, "the final alone");
    assert.deepEqual([r.early().length, r.retracted().length], [0, 0]);
    assert.equal(r.heard()[0]!.earlySeq, undefined);
    assert.doesNotMatch(detail(r), /early:/);
  });
});

// @spec EARS-EARLY-002
test("an utterance of less than min_speech_ms takes no early snapshot", async () => {
  const stt = fakeStt(() => "hello");
  await run(stt, cfg(), async (r) => {
    await say(r, 4); // 80 ms
    await sleep(450);
    assert.equal(stt.calls.length, 0, "no early call and no final for 80 ms");
    assert.equal(r.early().length, 0);
  });
});

// @spec EARS-EARLY-003
test("while a published early transcript is unresolved no further snapshot is taken, and silence frames do not retract it (silero)", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({ vad: { engine: "silero" }, silence_ms: 600 }, { max_per_utterance: 5 }), async (r) => {
    await say(r, 10, { fill: SPEECH });
    await say(r, 5, { fill: SILENCE });
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    await say(r, 5, { fill: SILENCE });
    await sleep(100);
    assert.equal(stt.calls.length, 1);
    assert.equal(r.retracted().length, 0, "a silence frame is not resumption");
    await say(r, 20, { fill: SILENCE, gapMs: 3 });
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(stt.calls.length, 1, "reused: no second call");
    assert.equal(r.heard()[0]!.earlySeq, 0);
  }, { loadVad: fakeVad().load });
});

// @spec EARS-EARLY-026, EARS-EARLY-006
test("one snapshot per pause: a filtered snapshot is not retried until speech resumes, and publishes nothing", async () => {
  const stt = fakeStt((c) => (c.n === 0 ? "" : "final words"));
  await run(stt, cfg({}, { max_per_utterance: 5 }), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    assert.equal(stt.calls.length, 2, "one early call for the whole pause, then the final");
    assert.equal(r.early().length, 0);
    assert.equal(r.heard()[0]!.text, "final words");
    assert.deepEqual([r.heard()[0]!.earlySeq, r.heard()[0]!.earlyLate], [undefined, undefined]);
  });
});

// @spec EARS-EARLY-004, EARS-EARLY-006, EARS-EARLY-015, EARS-EARLY-026
test("at most max_per_utterance snapshots are taken, counting a filtered one; seq counts published transcripts from 0; the capped rest closes in the ordinary way", async () => {
  const stt = fakeStt((c) => (c.n === 0 ? "" : `words ${c.n}`));
  await run(stt, cfg({ silence_ms: 400 }, { max_per_utterance: 2 }), async (r) => {
    await say(r);
    await sleep(160); // snapshot 1 (filtered)
    await say(r, 5);
    await sleep(160); // snapshot 2 (published as seq 0)
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    assert.equal(r.early()[0]!.seq, 0, "a filtered snapshot takes no seq");
    await say(r, 5);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2500);
    assert.equal(stt.calls.length, 3, "two snapshots and the final: none for the third pause");
    assert.equal(r.retracted().length, 1);
    assert.equal(r.heard()[0]!.text, "words 2");
    assert.deepEqual([r.heard()[0]!.earlySeq, r.heard()[0]!.earlyLate], [undefined, undefined]);
  });
});

// @spec EARS-EARLY-006
test("an early result that is empty, has no word character or is a drop phrase publishes nothing and the utterance closes in the ordinary way", async () => {
  for (const text of ["", "... ...", "Thank you."]) {
    const stt = fakeStt((c) => (c.n === 0 ? text : "real words"));
    await run(stt, cfg({ drop_phrases: ["thank you"] }), async (r) => {
      await say(r);
    await snapshotTaken(stt);
      await waitFor(() => r.heard().length === 1, `speech.heard after "${text}"`, 2000);
      assert.deepEqual([r.early().length, r.retracted().length], [0, 0], text);
      assert.equal(r.heard()[0]!.text, "real words");
      assert.equal(r.heard()[0]!.earlySeq, undefined);
    });
  }
});

// @spec EARS-EARLY-006, EARS-EARLY-007
test("a failed early transcription publishes nothing, never moves deps.stt, and the final is transcribed in the ordinary way", async () => {
  const stt = fakeStt((c) => { if (c.n === 0) throw new Error("stt 500"); return "real words"; });
  await run(stt, cfg(), async (r) => {
    await sleep(100); // heartbeats run every 40 ms
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    await sleep(120);
    assert.equal(r.early().length, 0);
    assert.equal(r.heard()[0]!.text, "real words");
    assert.ok(r.bus.health.length > 0 && r.bus.health.every((h) => h.deps.stt === "ok"), "deps.stt stayed ok");
  });
});

// @spec EARS-EARLY-008
test("an echo-suppressed source and injected audio take no early snapshot", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({ echo_suppress_sources: ["discord"] }), async (r) => {
    await say(r);
    await sleep(220); // past after_ms, before the close
    assert.equal(stt.calls.length, 0, "held until the close");
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(stt.calls.length, 1);
    assert.deepEqual([r.early().length, r.heard()[0]!.earlySeq], [0, undefined]);
    const res = await r.inject("a1", 1000);
    assert.equal(res.ok, true);
    assert.equal(r.early().length, 0);
    assert.equal(r.heard().length, 2);
  });
});

// @spec EARS-EARLY-008
test("a dir clip takes no early snapshot: one transcription, a plain final", async () => {
  const stt = fakeStt(() => "hello there");
  const dir = await mkdtemp(join(tmpdir(), "ears-early-"));
  try {
    await run(stt, cfg({ sources: ["dir"], dir: { path: dir, poll_ms: 20 } }), async (r) => {
      await writeFile(join(dir, "a.wav"), wavWrap(Buffer.alloc(32000, 1), 16000, 1));
      await waitFor(() => r.heard().length === 1, "dir clip heard");
      await sleep(150);
      assert.equal(stt.calls.length, 1);
      assert.deepEqual([r.early().length, r.heard()[0]!.earlySeq], [0, undefined]);
    }, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-EARLY-009, EARS-EARLY-010, EARS-EARLY-011
test("a streaming engine with early reply on: no snapshot or early event, the load does not fail, one start warning, and the heartbeat says early reply is off", async () => {
  for (const name of ["nemotron", "kyutai"] as const) {
    const stt = fakeStt(() => "unused");
    const s = fakeStreaming({ name, finish: () => "hello there" });
    await run(stt, cfg({ stt_engine: name }), async (r) => {
      await say(r);
      await waitFor(() => r.heard().length === 1, `speech.heard (${name})`, 2000);
      await sleep(100);
      assert.deepEqual([r.early().length, r.retracted().length, stt.calls.length], [0, 0, 0], name);
      assert.equal(r.heard()[0]!.earlySeq, undefined);
      const warns = r.log.lines.filter((l) => l.level === "warn").map((l) => `${l.msg ?? ""} ${JSON.stringify(l.obj)}`).filter((w) => /early/i.test(w));
      assert.equal(warns.length, 1, "one warning");
      assert.ok(warns[0]!.includes("ears.early.enabled") && warns[0]!.includes(name) && /streaming/i.test(warns[0]!), warns[0]!);
      assert.match(detail(r), /early reply off: streaming engine/);
      assert.doesNotMatch(detail(r), /early: \d/);
    }, { streaming: s.engine });
  }
});

// @spec EARS-EARLY-010, EARS-EARLY-011, EARS-EARLY-022
test("a batch engine with early reply on neither warns nor says early reply is off, and its heartbeat carries the four counts at zero", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg(), async (r) => {
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 0)), "zero counts in the heartbeat");
    assert.doesNotMatch(detail(r), /early reply off/);
    assert.equal(r.log.lines.filter((l) => l.level === "warn" && /early/i.test(`${l.msg ?? ""} ${JSON.stringify(l.obj)}`)).length, 0);
  });
});

// @spec EARS-EARLY-013, EARS-EARLY-015, EARS-EARLY-012
test("resumed speech retracts the published early transcript once, before any later event of the utterance; the utterance stays one, and the retracted transcript is never the final", async () => {
  const stt = fakeStt((c) => (c.ms <= 200 ? "hello there" : "hello there my friend there"));
  await run(stt, cfg({ partials: "on", partial_step_ms: 30 }, { max_per_utterance: 1 }), async (r) => {
    await say(r);
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    await say(r, 5); // the same speaker resumes
    await waitFor(() => r.heard().length === 1, "speech.heard", 2500);
    assert.equal(r.retracted().length, 1, "exactly one retraction");
    const e = r.early()[0]!;
    const x = r.retracted()[0]!;
    assert.deepEqual([x.speaker, x.speakerId, x.source, x.utteranceId, x.seq], [e.speaker, e.speakerId, e.source, e.utteranceId, e.seq]);
    const seen = r.bus.published.map((p, i) => ({ i, type: p.type as string, data: p.data as { text?: string } })).filter((p) => ["speech.early", "speech.retracted", "speech.partial", "speech.heard"].includes(p.type));
    const after = seen.filter((p) => p.i > types(r).indexOf("speech.early"));
    assert.equal(after[0]!.type, "speech.retracted", "the retraction precedes every later event");
    assert.equal(r.heard()[0]!.utteranceId, e.utteranceId, "one utterance");
    assert.equal(r.heard()[0]!.text, "hello there my friend there", "transcribed anew from the whole clip");
    assert.deepEqual([r.heard()[0]!.earlySeq, r.heard()[0]!.earlyLate], [undefined, undefined]);
    assert.ok(r.partials().length >= 1 && r.partials().every((p) => p.utteranceId === e.utteranceId));
  });
});

// @spec EARS-EARLY-015, EARS-EARLY-016, EARS-EARLY-017, EARS-EARLY-021, EARS-EARLY-022, EARS-EARLY-023
test("after a retraction a later pause takes a further snapshot (seq 1, the whole clip); it is reused as the final with earlySeq, earlySttMs, its stamps and no second transcription; the heartbeat counts it", async () => {
  const stt = fakeStt((c) => (c.ms <= 200 ? "first words" : "first words and more"));
  await run(stt, cfg(), async (r) => {
    await say(r);
    await waitFor(() => r.early().length === 1, "first early", 1500);
    await say(r, 5);
    await waitFor(() => r.early().length === 2, "second early", 1500);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    const [e0, e1] = r.early() as [ReturnType<typeof r.early>[number], ReturnType<typeof r.early>[number]];
    assert.deepEqual([e0.seq, e1.seq, e1.text], [0, 1, "first words and more"]);
    assert.deepEqual([r.retracted().length, r.retracted()[0]!.seq], [1, 0]);
    assert.equal(new Set([e0.utteranceId, e1.utteranceId, r.retracted()[0]!.utteranceId, r.heard()[0]!.utteranceId]).size, 1, "one utteranceId throughout");
    assert.equal(stt.calls.length, 2, "no transcription for the final");
    assert.ok(e1.sttMs >= 0 && stt.calls[1]!.ms === 300, "the second snapshot covers the whole clip so far");
    const h = r.heard()[0]!;
    assert.deepEqual([h.text, h.earlySeq, h.earlySttMs, h.earlyLate], [e1.text, 1, e1.sttMs, undefined]);
    assert.equal(h.timing!.audioEndedAt, e1.timing!.audioEndedAt);
    const closed = h.timing!.closedAt!;
    assert.ok(closed >= h.timing!.audioEndedAt! + 290 && closed <= Date.now(), "closedAt is the close, one silence_ms after the last frame");
    await waitFor(() => detail(r).includes(COUNTS(2, 1, 1, 0)), "counts in the heartbeat");
  });
});

// @spec EARS-EARLY-014
test("speech that resumes while the early transcription is in flight discards its result: no early, no retracted, no final from it", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(250); return "stale words"; } return "final words"; });
  await run(stt, cfg({}, { max_per_utterance: 1 }), async (r) => {
    await say(r);
    await sleep(140); // the snapshot is in flight
    assert.equal(stt.calls.length, 1, "the snapshot call is in flight");
    await say(r, 5);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2500);
    await sleep(250);
    assert.deepEqual([r.early().length, r.retracted().length], [0, 0]);
    assert.equal(r.heard().length, 1);
    assert.equal(r.heard()[0]!.text, "final words");
    assert.deepEqual([r.heard()[0]!.earlySeq, r.heard()[0]!.earlyLate], [undefined, undefined]);
  });
});

// @spec EARS-EARLY-018, EARS-EARLY-023, EARS-EARLY-020
test("an utterance that closes while its early transcription is in flight waits for it and publishes it as the final with earlyLate, no earlySeq, no speech.early and no second transcription; the heartbeat counts it late", async () => {
  const stt = fakeStt(async () => { await sleep(450); return "early words"; });
  await run(stt, cfg(), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => r.heard().length === 1, "speech.heard", 3000);
    const seenAt = Date.now();
    const h = r.heard()[0]!;
    assert.deepEqual([h.text, h.earlyLate, h.earlySeq, h.earlySttMs], ["early words", true, undefined, undefined]);
    assert.equal(r.early().length, 0);
    assert.equal(stt.calls.length, 1);
    assert.ok(seenAt - h.timing!.closedAt! >= 100, "closedAt is the close, not the later publish");
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 1)), "late counted");
  });
});

// @spec EARS-EARLY-018, EARS-EARLY-023
test("an early transcription in flight at the close whose result is filtered publishes nothing and makes no second call, yet counts as late", async () => {
  const stt = fakeStt(async () => { await sleep(450); return "..."; });
  await run(stt, cfg(), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 1)), "late counted", 3000);
    await sleep(300);
    assert.equal(r.heard().length, 0);
    assert.equal(r.early().length, 0);
    assert.equal(stt.calls.length, 1);
  });
});

// @spec EARS-EARLY-019
test("an early transcription waited for at the close that fails: the clip is transcribed once more and published as an ordinary final", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(450); throw new Error("stt 500"); } return "final words"; });
  await run(stt, cfg(), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => r.heard().length === 1, "speech.heard", 3000);
    const h = r.heard()[0]!;
    assert.deepEqual([h.text, h.earlyLate, h.earlySeq], ["final words", undefined, undefined]);
    assert.equal(stt.calls.length, 2, "the early call and one transcription");
  });
});

// @spec EARS-EARLY-018, EARS-EARLY-019
test("the wait at the close is bounded by stt_timeout_ms, then the clip is transcribed once as an ordinary final", async () => {
  const stt = fakeStt((c) => (c.n === 0 ? new Promise<string>(() => {}) : "final words"));
  await run(stt, cfg({ stt_timeout_ms: 500 }), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await waitFor(() => r.heard().length === 1, "speech.heard", 3000);
    const h = r.heard()[0]!;
    assert.deepEqual([h.text, h.earlyLate, h.earlySeq], ["final words", undefined, undefined]);
    assert.equal(stt.calls.length, 2);
  });
});

// @spec EARS-EARLY-025
test("a close by max_utterance_ms transcribes the whole clip anew with neither earlySeq nor earlyLate", async () => {
  const stt = fakeStt((c) => (c.ms < 400 ? "early words" : "full words"));
  await run(stt, cfg({ max_utterance_ms: 400, silence_ms: 600 }), async (r) => {
    await say(r);
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    await say(r, 12); // resumes: 200 ms + 240 ms reaches the 400 ms cap
    await waitFor(() => r.heard().length >= 1, "speech.heard", 2500);
    const h = r.heard()[0]!;
    assert.equal(r.retracted().length, 1, "the early transcript was retracted by the continued speech");
    assert.deepEqual([h.text, h.durationMs, h.earlySeq, h.earlyLate], ["full words", 400, undefined, undefined]);
    assert.equal(stt.calls.at(-1)!.ms, 400, "the whole clip");
  });
});

const wrapPublish = (r: Rig, fn: (type: string, data: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
  const bus = r.bus as unknown as { publish: (t: string, d: unknown) => Promise<unknown> };
  const orig = bus.publish.bind(bus);
  bus.publish = (t, d) => fn(t, d, () => orig(t, d));
};

// @spec EARS-EARLY-001
test("silero: when the frames stop after speech, the pause is still measured in wall-clock time from the last speech frame and the snapshot is taken", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({ vad: { engine: "silero" } }), async (r) => {
    await say(r, 10, { fill: SPEECH });
    await waitFor(() => r.early().length === 1, "speech.early with no frame after the speech", 1500);
    assert.equal(stt.calls[0]!.ms, 200);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    assert.equal(r.heard()[0]!.earlySeq, 0);
  }, { loadVad: fakeVad().load });
});

// @spec EARS-EARLY-025
test("silero cap with an unresolved early transcript: the cap reached on silence frames publishes speech.retracted first, then transcribes the clip anew", async () => {
  const stt = fakeStt((c) => (c.n === 0 ? "early words" : "full words"));
  await run(stt, cfg({ vad: { engine: "silero" }, max_utterance_ms: 400, silence_ms: 600 }), async (r) => {
    await say(r, 10, { fill: SPEECH });
    await waitFor(() => r.early().length === 1, "speech.early", 1500);
    await say(r, 10, { fill: SILENCE }); // 200 ms of silence: the buffer reaches the 400 ms cap
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    const h = r.heard()[0]!;
    assert.equal(r.retracted().length, 1);
    assert.deepEqual([h.text, h.durationMs, h.earlySeq, h.earlyLate], ["full words", 200, undefined, undefined]);
    assert.equal(stt.calls.at(-1)!.ms, 200, "the clip up to the last speech frame, transcribed anew");
    assert.ok(types(r).indexOf("speech.retracted") < types(r).indexOf("speech.heard"), "retracted before the final");
  }, { loadVad: fakeVad().load });
});

// @spec EARS-EARLY-025, EARS-EARLY-023, EARS-EARLY-014
test("silero cap with an early call in flight: the cap discards it without waiting, transcribes the clip anew, counts it late and never publishes its result", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(450); return "early words"; } return "full words"; });
  await run(stt, cfg({ vad: { engine: "silero" }, max_utterance_ms: 400, silence_ms: 600 }), async (r) => {
    await say(r, 10, { fill: SPEECH });
    await snapshotTaken(stt);
    await say(r, 10, { fill: SILENCE });
    await waitFor(() => r.heard().length === 1, "speech.heard without waiting for the call", 300);
    assert.equal(r.heard()[0]!.text, "full words");
    assert.equal(stt.calls.length, 2);
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 1)), "late counted");
    await sleep(400);
    assert.equal(r.early().length, 0, "the discarded result is never published");
    assert.equal(r.heard().length, 1);
  }, { loadVad: fakeVad().load });
});

// @spec EARS-ENG-001, EARS-EARLY-001
test("stub is a batch engine: early reply publishes the stub transcript of the snapshot, with no network call", async () => {
  const stt = fakeStt(() => "unused");
  await run(stt, cfg({ stt_engine: "stub" }), async (r) => {
    await say(r);
    await waitFor(() => r.early().length === 1, "speech.early under the stub engine", 1500);
    assert.equal(r.early()[0]!.text, "stub transcript (200 ms)");
    await waitFor(() => r.heard().length === 1, "speech.heard");
    assert.equal(r.heard()[0]!.earlySeq, 0);
    assert.equal(stt.calls.length, 0);
  });
});

// @spec EARS-EARLY-013, EARS-PART-014
test("a speech.partial is published through the utterance's publish chain: a slow partial publish is published before the early transcript and its retraction", async () => {
  const stt = fakeStt(() => "hello there");
  await run(stt, cfg({ partials: "on", partial_step_ms: 30, silence_ms: 1000 }, { max_per_utterance: 1 }), async (r) => {
    wrapPublish(r, async (t, d, next) => { if (t === "speech.partial") await sleep(150); return next(); });
    await say(r);
    await waitFor(() => r.early().length === 1, "speech.early", 2000);
    await sleep(300);
    await say(r, 5); // the speaker resumes
    await waitFor(() => r.retracted().length === 1, "speech.retracted", 2000);
    const order = types(r);
    const iE = order.indexOf("speech.early"), iR = order.indexOf("speech.retracted");
    assert.ok(iE < iR);
    assert.ok(order.slice(iE, iR).every((t) => t !== "speech.partial"), "no partial between the early transcript and its retraction");
  });
});

// @spec EARS-EARLY-012, EARS-EARLY-016
test("an early transcript whose speech.early publish fails is not reused: no earlySeq, no published count, and the final is transcribed anew", async () => {
  const stt = fakeStt((c) => (c.n === 0 ? "early words" : "final words"));
  await run(stt, cfg(), async (r) => {
    let failed = false;
    wrapPublish(r, async (t, _d, next) => { if (t === "speech.early" && !failed) { failed = true; throw new Error("bus down"); } return next(); });
    await say(r);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    assert.deepEqual([r.heard()[0]!.text, r.heard()[0]!.earlySeq], ["final words", undefined]);
    assert.equal(stt.calls.length, 2);
    assert.equal(r.early().length, 0);
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 0)), "no count for the failed publish");
  });
});

// @spec EARS-EARLY-023, EARS-EARLY-014
test("speech resumes while the early call is in flight and the utterance closes before it settles: the close transcribes anew without waiting and counts late", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(450); return "stale words"; } return "final words"; });
  await run(stt, cfg({}, { max_per_utterance: 1 }), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await sleep(100);
    await say(r, 5); // discards the call in flight
    await waitFor(() => r.heard().length === 1, "speech.heard", 1500);
    assert.equal(r.heard()[0]!.text, "final words");
    assert.equal(stt.calls.length, 2);
    assert.equal(r.early().length, 0);
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 1)), "late counted");
  });
});

// @spec EARS-EARLY-026, EARS-EARLY-001
test("a discarded early call that settles while the utterance is open takes the snapshot the pause still owes, because the gap timer fired while it ran", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(300); return "stale words"; } return "fresh words"; });
  await run(stt, cfg({ silence_ms: 500 }, { max_per_utterance: 2 }), async (r) => {
    await say(r);
    await snapshotTaken(stt);
    await sleep(50);
    await say(r, 5); // resumes while call 0 runs
    await waitFor(() => r.early().length === 1, "speech.early after the discarded call settles", 1500);
    assert.equal(r.early()[0]!.text, "fresh words");
    assert.equal(r.early()[0]!.seq, 0);
    await waitFor(() => r.heard().length === 1, "speech.heard", 2000);
    assert.equal(r.heard()[0]!.earlySeq, 0);
    assert.equal(stt.calls.length, 2);
  });
});

// @spec EARS-EARLY-019
test("stop waits for a fallback final started by a close that was waiting for an early call: the final is published before stop returns", async () => {
  const stt = fakeStt(async (c) => { if (c.n === 0) { await sleep(450); throw new Error("stt 500"); } return "final words"; });
  resetSeq();
  const r = await boot(cfg(), { setup: reg });
  try {
    await sleep(60);
    await say(r);
    await snapshotTaken(stt);
    await sleep(350); // the utterance has closed and waits for the early call, which has not failed yet
    await r.stop();
    assert.equal(r.heard().length, 1, "the fallback final was published before stop returned");
    assert.equal(r.heard()[0]!.text, "final words");
  } finally { stt.restore(); }
});

// @spec EARS-EARLY-011, EARS-EARLY-022
test("the early counts are in the heartbeat detail while the source is down too", async () => {
  resetSeq();
  const r = await boot(cfg(), {});
  try {
    await sleep(60);
    await waitFor(() => detail(r).includes(COUNTS(0, 0, 0, 0)), "counts in the degraded detail", 1000);
    assert.match(detail(r), /connector not connected/);
  } finally { await r.stop(); }
});
