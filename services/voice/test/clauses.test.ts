import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { collect, type Synth, type TtsEngine } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { Voice } from "../src/voice.js";
import { fakeServer, pcm, streamedHeader } from "./tts-helpers.js";

// Clause-by-clause synthesis and arbitration (VOICE-CLAUSE-*, VOICE-CHUNK-*, and the clause-aware parts of VOICE-SINK-*,
// VOICE-STOP-*, VOICE-HTTP-*, VOICE-UTT-*, VOICE-SYN-*). Fake timers cover setTimeout, setInterval and Date.

const sayMore = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  event("brain.say", { id, text, emotion: "happy", gesture: "wave", more: true, ...extra } as never);
const sayOne = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });
const clause = (id: string, seq: number, text: string) => event("brain.clause", { id, seq, text } as never);
const closing = (id: string, seq: number, through: number, text = "") => event("brain.clause", { id, seq, text, last: true, through } as never);
const playing = (id: string, seq: number, sink: string) => event("voice.playing", { id, seq, sink });
const failed = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
  event("voice.failed", { id, seq, sink: "discord", reason: "fetch audio 404", ...extra } as never);
const stop = (ids?: string[]) => event("voice.stop" as never, { reason: "barge-in", ...(ids ? { ids } : {}) } as never);

/** 24 kHz mono silence of the given length. */
const wavMs = (ms: number) => wavWrap(Buffer.alloc(Math.round(ms * 24) * 2), 24000, 1);

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };

/** The voice service over a scripted synth: durations by text (default 500 ms), gates that hold a text's synthesis, texts that fail. */
function rig(durations: Record<string, number> = {}, bus: FakeBus = new FakeBus()) {
  const rec = recordingLog();
  const calls: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const failing = new Set<string>();
  const synth: Synth = async (text) => {
    calls.push(text);
    const g = gates.get(text);
    if (g) await g.gate;
    if (failing.has(text)) throw new Error("tts 500");
    return wavMs(durations[text] ?? 500);
  };
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  const hold = (text: string) => { const g = deferred(); gates.set(text, g); return g; };
  return { voice, bus, rec, calls, hold, failing };
}

async function body(voice: Voice, path: string): Promise<{ status: number; text: string; bytes?: Buffer }> {
  let status = 0;
  let out = Buffer.alloc(0);
  voice.handle({ method: "GET", url: path } as never, { writeHead: (c: number) => { status = c; }, end: (b?: string | Buffer) => { if (b) out = Buffer.from(b); } } as never);
  return { status, text: out.toString(), bytes: out };
}
const status = async (voice: Voice, key: string) => (await body(voice, `/audio/${key}.wav`)).status;
const seqs = (bus: FakeBus, type: "voice.utterance" | "voice.playing" | "voice.done") => bus.of(type).map((e) => e.seq);

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
afterEach(() => mock.timers.reset());

// ---- synthesis, utterance fields, store

// @spec VOICE-CHUNK-001, VOICE-CHUNK-002, VOICE-CLAUSE-001, VOICE-CLAUSE-003, VOICE-CLAUSE-004, VOICE-UTT-001
test("each clause is its own engine request and its own utterance with its own seq, text, duration and envelope; clause 0 is out before any later clause exists", async () => {
  const { voice, bus, calls } = rig({ "first part": 500, "second part": 300 });
  await voice.onEvent(sayMore("L", "first part"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["first part"]);
  assert.deepEqual(seqs(bus, "voice.utterance"), [0], "clause 0 is published with no brain.clause read yet");
  await voice.onEvent(clause("L", 1, "second part"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["first part", "second part"], "one request per clause");
  const [a, b] = bus.of("voice.utterance");
  assert.deepEqual([a!.seq, a!.text, a!.durationMs, a!.envelope.length], [0, "first part", 500, 15]);
  assert.deepEqual([b!.seq, b!.text, b!.durationMs, b!.envelope.length], [1, "second part", 300, 9]);
  assert.equal(b!.envelopeHz, 30);
  assert.equal(b!.sampleRate, 24000);
});

// @spec VOICE-CLAUSE-005, VOICE-CLAUSE-006, VOICE-UTT-001
test("more is on clause 0 of a streamed line only; emotion and route ride every clause; gesture is on clause 0 only", async () => {
  const { voice, bus } = rig();
  await voice.onEvent(sayMore("L", "one", { route: ["file"], emotion: "sad" }));
  await voice.onEvent(clause("L", 1, "two"));
  await voice.onEvent(closing("L", 2, 2, "three"));
  await voice.whenIdle();
  const [a, b, c] = bus.of("voice.utterance");
  assert.equal(a!.more, true);
  assert.equal("more" in b!, false);
  assert.equal("more" in c!, false);
  assert.deepEqual([a!.emotion, b!.emotion, c!.emotion], ["sad", "sad", "sad"]);
  assert.deepEqual([a!.route, b!.route, c!.route], [["file"], ["file"], ["file"]]);
  assert.equal(a!.gesture, "wave");
  assert.equal("gesture" in b!, false);
  assert.equal("gesture" in c!, false);
});

// @spec VOICE-CLAUSE-005, VOICE-CLAUSE-006
test("a line without more carries no more, and no route when its brain.say had none", async () => {
  const { voice, bus } = rig();
  await voice.onEvent(sayOne("L"));
  await voice.whenIdle();
  const [u] = bus.of("voice.utterance");
  assert.equal("more" in u!, false);
  assert.equal("route" in u!, false);
  assert.equal(u!.gesture, "wave");
});

// @spec VOICE-SYN-004, VOICE-UTT-002, VOICE-HTTP-002
test("a clause is stored under <id>-<seq> before its utterance, and its audioUrl is <publicUrl>/audio/<id>-<seq>.wav", async () => {
  const { voice, bus } = rig();
  const at: Record<string, number> = {};
  const publish = bus.publish.bind(bus) as (type: never, data: never) => Promise<string>;
  bus.publish = (async (type: never, data: never) => {
    if ((type as string) === "voice.utterance") { const u = data as { id: string; seq: number }; at[`${u.id}-${u.seq}`] = await status(voice, `${u.id}-${u.seq}`); }
    return publish(type, data);
  }) as typeof bus.publish;
  await voice.onEvent(sayMore("L", "one"));
  await voice.onEvent(clause("L", 1, "two"));
  await voice.whenIdle();
  assert.deepEqual(at, { "L-0": 200, "L-1": 200 });
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.audioUrl), ["http://voice:8700/audio/L-0.wav", "http://voice:8700/audio/L-1.wav"]);
});

// @spec VOICE-CLAUSE-002
test("a brain.clause goes on the one FIFO queue: the read returns at once and clauses synthesize one at a time in arrival order across lines", async () => {
  const { voice, bus, calls, hold } = rig();
  const g = hold("a0");
  await voice.onEvent(sayMore("a", "a0"));
  await voice.onEvent(sayOne("b", "b0"));
  const returned = await Promise.race([voice.onEvent(clause("a", 1, "a1")).then(() => "returned"), flush().then(() => "blocked")]);
  assert.equal(returned, "returned", "the loop that reads the bus is not held by synthesis");
  assert.deepEqual(calls, ["a0"]);
  g.release();
  await voice.whenIdle();
  assert.deepEqual(calls, ["a0", "b0", "a1"]);
  assert.deepEqual(bus.of("voice.utterance").map((u) => `${u.id}-${u.seq}`), ["a-0", "b-0", "a-1"]);
});

// @spec VOICE-CLAUSE-001, VOICE-CLAUSE-010
test("the newest 50 line records are kept: a clause for the 51st-oldest line is dropped with a warning, one for a retained line is spoken", async () => {
  const { voice, bus, rec, calls } = rig();
  for (let i = 0; i <= 50; i++) await voice.onEvent(sayMore(`l${i}`, `c${i}`));
  await voice.whenIdle();
  bus.clear();
  calls.length = 0;
  await voice.onEvent(clause("l0", 1, "late zero"));
  await voice.whenIdle();
  assert.deepEqual(calls, [], "l0's record was evicted");
  assert.ok(rec.msgs("warn").length >= 1);
  assert.deepEqual(bus.published, []);
  await voice.onEvent(clause("l1", 1, "late one"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["late one"]);
  assert.deepEqual(bus.of("voice.utterance").map((u) => `${u.id}-${u.seq}`), ["l1-1"]);
});

// @spec VOICE-CLAUSE-010
test("a clause for a line voice holds no record of is dropped, logged and publishes nothing", async () => {
  const { voice, bus, rec, calls } = rig();
  await voice.onEvent(clause("ghost", 1, "who am I"));
  await voice.whenIdle();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(bus.published, []);
  assert.ok(rec.msgs("warn").length >= 1);
});

// @spec VOICE-CLAUSE-013
test("only the exact next seq is accepted: a gap, a duplicate and a clause after the closing event are dropped with a warning", async () => {
  const { voice, bus, rec, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 2, "c2 early")); // gap
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 1, "c1 again")); // duplicate
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.onEvent(closing("L", 3, 2));
  await voice.onEvent(clause("L", 4, "c4 after close")); // follows the closing event
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1", "c2"]);
  assert.deepEqual(seqs(bus, "voice.utterance"), [0, 1, 2]);
  assert.equal(rec.msgs("warn").length, 3);
});

// @spec VOICE-CLAUSE-007, VOICE-CLAUSE-013
test("a closing clause with empty text synthesizes nothing, publishes nothing and closes the line", async () => {
  const { voice, bus, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  bus.clear();
  await voice.onEvent(closing("L", 2, 1));
  await voice.onEvent(clause("L", 3, "after close"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1"]);
  assert.deepEqual(bus.published, []);
});

// @spec VOICE-CLAUSE-008, VOICE-CLAUSE-013
test("a closing clause with text is synthesized as a clause and closes the line after it", async () => {
  const { voice, bus, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(closing("L", 1, 1, "bye"));
  await voice.onEvent(clause("L", 2, "after close"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "bye"]);
  assert.deepEqual(bus.of("voice.utterance").map((u) => [u.seq, u.text]), [[0, "c0"], [1, "bye"]]);
});

// @spec VOICE-CLAUSE-009
test("a closing clause drops the clauses above through that are still queued for synthesis", async () => {
  const { voice, bus, calls, hold } = rig();
  const g = hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.onEvent(closing("L", 3, 1));
  await flush();
  g.release();
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1"]);
  assert.deepEqual(seqs(bus, "voice.utterance"), [0, 1]);
});

// ---- store and HTTP

// @spec VOICE-HTTP-001, VOICE-HTTP-003
test("the store keeps the newest 100 clause WAVs, whatever line they belong to", async () => {
  const { voice } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  for (let i = 1; i <= 100; i++) await voice.onEvent(clause("L", i, `c${i}`));
  await voice.whenIdle();
  assert.equal(await status(voice, "L-0"), 404, "the 101st clause evicted the oldest");
  assert.equal(await status(voice, "L-1"), 200);
  assert.equal(await status(voice, "L-100"), 200);
});

// @spec VOICE-HTTP-002, VOICE-HTTP-003, VOICE-HTTP-007
test("GET /audio/<id>-<seq>.wav answers 200 for a stored clause and 404 gone otherwise, with the query string ignored", async () => {
  const { voice } = rig({ one: 500 });
  await voice.onEvent(sayOne("u1", "one"));
  await voice.whenIdle();
  const ok = await body(voice, "/audio/u1-0.wav?t=1");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.bytes, wavMs(500));
  for (const key of ["u1", "u1-1", "u2-0"]) {
    const miss = await body(voice, `/audio/${key}.wav`);
    assert.deepEqual([miss.status, miss.text], [404, "gone"], key);
  }
});

// @spec VOICE-HTTP-008
test("storing a key again replaces its WAV", async () => {
  const durations: Record<string, number> = { first: 500, second: 300 };
  const { voice } = rig(durations);
  await voice.onEvent(sayOne("u1", "first"));
  await voice.whenIdle();
  await voice.onEvent(sayOne("u1", "second"));
  await voice.whenIdle();
  assert.deepEqual((await body(voice, "/audio/u1-0.wav")).bytes, wavMs(300));
});

// ---- failure

// @spec VOICE-CLAUSE-014, VOICE-CLAUSE-015, VOICE-CLAUSE-016, VOICE-CLAUSE-011, VOICE-UTT-003, VOICE-SINK-006
test("a clause that fails to synthesize publishes a final error done for its seq, ends the line, keeps earlier clauses and arms no timer for itself or later clauses", async () => {
  const { voice, bus, rec, calls, failing } = rig();
  failing.add("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1"], "the later clause of an ended line is never synthesized");
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 1, sink: "error", final: true }]);
  assert.deepEqual(seqs(bus, "voice.utterance"), [0]);
  assert.deepEqual(rec.msgs("error"), ["tts failed"]);
  assert.equal(await status(voice, "L-0"), 200, "the earlier clause is kept");
  assert.equal(await status(voice, "L-1"), 404);
  // the earlier clause still plays out virtually, in its own window; nothing is timed for clause 1 or 2
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }]);
  mock.timers.tick(500);
  await flush();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 1, sink: "error", final: true }, { id: "L", seq: 0, sink: "virtual" }]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }]);
});

// @spec VOICE-CLAUSE-014, VOICE-CLAUSE-016, VOICE-UTT-003, VOICE-SINK-006
test("clause 0 failing publishes a final error done for seq 0 and nothing else, ever, and drops the rest of the line", async () => {
  const { voice, bus, calls, failing } = rig();
  failing.add("c0");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, ["c0"]);
  assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "L", seq: 0, sink: "error", final: true } }]);
});

// @spec VOICE-CLAUSE-014, VOICE-UTT-003
test("a failed utterance publish for a later clause is a clause failure: final error done for that seq", async () => {
  const bus = new FakeBus();
  let utterances = 0;
  bus.fail = (type) => type === "voice.utterance" && ++utterances === 2;
  const { voice, rec } = rig({}, bus);
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 1, sink: "error", final: true }]);
  assert.deepEqual(rec.msgs("error"), ["tts failed"]);
});

// @spec VOICE-ENG-005, VOICE-CLAUSE-014, VOICE-UTT-003
test("a connection that ends before the engine's audio ends fails the clause and none of its audio is used", async () => {
  mock.timers.reset(); // real sockets and timers
  const s = await fakeServer((_req, res, n) => {
    res.writeHead(200);
    res.write(streamedHeader());
    if (n === 1) { res.end(pcm(2400)); return; }
    res.write(pcm(1200), () => res.destroy());
  });
  const engine: TtsEngine = createEngine(testConfig({ voice: { engine: "openai", voice: "nova", openai: { base_url: `${s.url}/v1`, model: "m" } } }).voice);
  const synth: Synth = async (text, o) => collect(await engine.synthesize(text, { signal: o?.signal ?? new AbortController().signal, ...(o?.priority ? { priority: o.priority } : {}) }));
  const bus = new FakeBus();
  const voice = new Voice({ bus, log: recordingLog().log, synth, publicUrl: "http://voice:8700" });
  try {
    await voice.onEvent(sayMore("L", "whole"));
    await voice.onEvent(clause("L", 1, "cut off"));
    await voice.whenIdle();
    assert.deepEqual(seqs(bus, "voice.utterance"), [0]);
    assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 1, sink: "error", final: true }]);
    assert.equal(await status(voice, "L-1"), 404, "the audio received before the cut was not stored");
  } finally { voice.stop(); await s.close(); }
});

// @spec VOICE-ENG-005
test("an engine whose connection is cut mid-audio rejects its audio instead of delivering the part that arrived", async () => {
  mock.timers.reset(); // real sockets and timers
  const s = await fakeServer((_req, res) => { res.writeHead(200); res.write(streamedHeader()); res.write(pcm(1200), () => res.destroy()); });
  try {
    const engine = createEngine(testConfig({ voice: { engine: "openai", voice: "nova", openai: { base_url: `${s.url}/v1`, model: "m" } } }).voice);
    await assert.rejects(async () => collect(await engine.synthesize("cut off", { signal: new AbortController().signal })));
  } finally { await s.close(); }
});

// ---- claim window and virtual player

// @spec VOICE-CLAUSE-017, VOICE-CLAUSE-018, VOICE-CLAUSE-019, VOICE-CLAUSE-020, VOICE-SINK-002, VOICE-SINK-003
test("the window opens with clause 0 only; the virtual player then plays each published clause in order with its seq, with no new window", async () => {
  const { voice, bus, hold } = rig({ c0: 500, c1: 300, c2: 200 });
  const g = hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await flush();
  mock.timers.tick(1000);
  g.release(); // clause 1 is published at t=1000, inside the window
  await voice.whenIdle();
  mock.timers.tick(499);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [], "clause 1 did not move or extend the window");
  mock.timers.tick(1);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }]);
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }, { id: "L", seq: 1, sink: "virtual" }], "clause 1 follows at once");
  mock.timers.tick(300);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }, { id: "L", seq: 1, sink: "virtual" }]);
  // a clause published after the player went idle is played when it is published, not after another window
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.whenIdle();
  await flush();
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1, 2]);
  mock.timers.tick(200);
  await flush();
  assert.deepEqual(bus.of("voice.done").map((d) => d.seq), [0, 1, 2]);
});

// @spec VOICE-CLAUSE-009, VOICE-CLAUSE-012
test("a closed virtual line plays its clauses only up to through, and then the line is over: a later voice.stop publishes nothing", async () => {
  const { voice, bus } = rig({ c0: 500, c1: 300, c2: 200 });
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.onEvent(closing("L", 3, 1));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  mock.timers.tick(300);
  await flush();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1]);
  assert.deepEqual(bus.of("voice.done").map((d) => d.seq), [0, 1]);
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done").map((d) => d.seq), [0, 1], "nothing more for a finished line");
});

// ---- claims

// @spec VOICE-SINK-001, VOICE-SINK-004
test("a real sink's voice.playing for any stored clause claims the line: no virtual events follow", async () => {
  const { voice, bus } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 1, "discord"));
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), []);
  assert.deepEqual(bus.of("voice.done"), []);
});

// @spec VOICE-SINK-001
test("a claim for a clause whose audio is not held claims nothing", async () => {
  const { voice, bus } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 7, "discord"));
  await voice.onEvent(playing("ghost", 0, "discord"));
  assert.equal(voice.claimCount, 0);
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }]);
});

// @spec VOICE-SINK-007
test("a claim dies with its clause's audio when the store evicts it", async () => {
  const { voice } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 0, "discord"));
  assert.equal(voice.claimCount, 1);
  for (let i = 0; i < 100; i++) await voice.onEvent(sayOne(`n${i}`));
  await voice.whenIdle();
  assert.equal(await status(voice, "L-0"), 404);
  assert.equal(voice.claimCount, 0);
});

// ---- late claim

// @spec VOICE-CLAUSE-021
test("a real sink's claim while a virtual clause is playing ends it with an interrupted virtual done for that clause and cancels the rest of the line", async () => {
  const { voice, bus } = rig({ c0: 500, c1: 300 });
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(100);
  await voice.onEvent(playing("L", 0, "discord"));
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual", interrupted: true }]);
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual", interrupted: true }]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }], "clause 1 never plays virtually");
});

// @spec VOICE-CLAUSE-021
test("a real sink's claim between two virtual clauses interrupts the last clause played, and later clauses play no virtual events", async () => {
  const { voice, bus, hold } = rig({ c0: 500, c1: 300 });
  const g = hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }]);
  await voice.onEvent(playing("L", 0, "dashboard"));
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }, { id: "L", seq: 0, sink: "virtual", interrupted: true }]);
  g.release();
  await voice.whenIdle();
  await flush();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(seqs(bus, "voice.utterance"), [0, 1], "clause 1 is still produced for the real sink");
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }]);
  assert.equal(bus.of("voice.done").length, 2);
});

// @spec VOICE-CLAUSE-021
test("a claim after the virtual player finished every clause of a closed line changes nothing", async () => {
  const { voice, bus } = rig({ c0: 500 });
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(closing("L", 1, 0));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  const before = bus.published.length;
  await voice.onEvent(playing("L", 0, "discord"));
  await flush();
  assert.equal(bus.published.length, before);
});

// @spec VOICE-SINK-008, VOICE-CLAUSE-021
test("a line without more keeps the cancel rule: the pending virtual done is cancelled, with no interrupted done", async () => {
  const { voice, bus } = rig({ one: 500 });
  await voice.onEvent(sayOne("U", "one"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  await voice.onEvent(playing("U", 0, "discord"));
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(bus.of("voice.done"), []);
});

// ---- voice.failed

// @spec VOICE-SINK-011, VOICE-CLAUSE-012, VOICE-CLAUSE-011
test("a voice.failed for clause k inside the window: at its end a final virtual done for that seq, no virtual playing, and the line is ended", async () => {
  const { voice, bus, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  await voice.onEvent(failed("L", 1));
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), []);
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 1, sink: "virtual", final: true }]);
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.whenIdle();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, ["c0", "c1"], "a clause for the ended line is dropped");
  assert.equal(bus.of("voice.done").length, 1);
});

// @spec VOICE-SINK-011, VOICE-CLAUSE-012
test("a voice.failed for a virtual line with no clause playing publishes the final virtual done for the failed seq at once and ends the line", async () => {
  const { voice, bus, hold } = rig({ c0: 500 });
  hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  await voice.onEvent(failed("L", 0));
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }, { id: "L", seq: 0, sink: "virtual", final: true }]);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 2);
  await voice.onEvent(stop());
  await flush();
  assert.equal(bus.of("voice.done").length, 2, "an ended line gets nothing from a stop");
});

// @spec VOICE-SINK-012, VOICE-CLAUSE-012
test("a voice.failed for a virtual clause that is playing cancels its timer and publishes the final virtual done for that seq at once", async () => {
  const { voice, bus } = rig({ c0: 500, c1: 300, c2: 200 });
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1]);
  await voice.onEvent(failed("L", 1));
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }, { id: "L", seq: 1, sink: "virtual", final: true }]);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 2, "no timed done and no clause 2");
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0, 1]);
});

// @spec VOICE-SINK-013
test("a voice.failed for a clause whose audio voice does not hold, with a fallback, or for a claimed line changes nothing", async () => {
  const { voice, bus } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(failed("L", 5));
  await voice.onEvent(failed("L", 0, { fallback: { clip: "00-aaaaaaaa.wav", text: "Error." } }));
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "L", seq: 0, sink: "virtual" }], "timed exactly as if never reported");
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual" }]);
  const b = rig();
  await b.voice.onEvent(sayMore("M", "c0"));
  await b.voice.whenIdle();
  await b.voice.onEvent(playing("M", 0, "discord"));
  await b.voice.onEvent(failed("M", 0));
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(b.bus.types(), ["voice.utterance"]);
});

// ---- stop

// @spec VOICE-STOP-006, VOICE-CLAUSE-025
test("a stop mid-clause on a virtual line: spokenText is the played clauses plus the word-boundary prefix of the playing one, unsaidText the rest and every unplayed clause, published or still being synthesized", async () => {
  const { voice, bus, hold } = rig({ "alpha beta gamma delta": 1000, "epsilon zeta": 400 });
  hold("eta");
  await voice.onEvent(sayMore("L", "alpha beta gamma delta"));
  await voice.onEvent(clause("L", 1, "epsilon zeta"));
  await voice.onEvent(clause("L", 2, "eta"));
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500); // half of 1000 ms: 11 of 22 characters, so "alpha beta"
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{
    id: "L", seq: 0, sink: "virtual", interrupted: true,
    spokenText: "alpha beta", unsaidText: "gamma delta epsilon zeta eta",
  }]);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1);
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0]);
});

// @spec VOICE-STOP-006, VOICE-CLAUSE-025
test("a stop during a later virtual clause carries the earlier clauses in spokenText", async () => {
  const { voice, bus, hold } = rig({ "alpha beta gamma delta": 1000, "epsilon zeta": 400 });
  hold("eta");
  await voice.onEvent(sayMore("L", "alpha beta gamma delta"));
  await voice.onEvent(clause("L", 1, "epsilon zeta"));
  await voice.onEvent(clause("L", 2, "eta"));
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(1000);
  await flush();
  mock.timers.tick(300); // three quarters of 400 ms: 9 of 12 characters, so "epsilon"
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done").at(-1), {
    id: "L", seq: 1, sink: "virtual", interrupted: true,
    spokenText: "alpha beta gamma delta epsilon", unsaidText: "zeta eta",
  });
});

// @spec VOICE-CLAUSE-026, VOICE-CLAUSE-025, VOICE-CLAUSE-012
test("a stop on an open virtual line between clauses publishes one interrupted done for the last clause played, and a second stop nothing", async () => {
  const { voice, bus, calls, hold } = rig({ "One two.": 500 });
  const g = hold("Three four.");
  await voice.onEvent(sayMore("L", "One two."));
  await voice.onEvent(clause("L", 1, "Three four."));
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  await flush();
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done").at(-1), { id: "L", seq: 0, sink: "virtual", interrupted: true, spokenText: "One two.", unsaidText: "Three four." });
  assert.equal(bus.of("voice.done").length, 2);
  await voice.onEvent(stop());
  await flush();
  assert.equal(bus.of("voice.done").length, 2, "an ended line gets nothing");
  g.release();
  await voice.whenIdle();
  await flush();
  assert.deepEqual(seqs(bus, "voice.utterance"), [0], "the clause being synthesized when the stop arrived is discarded");
  assert.deepEqual(calls, ["One two.", "Three four."]);
});

// @spec VOICE-STOP-010, VOICE-STOP-006, VOICE-CLAUSE-025
test("a stop while a virtual playing publish is in flight publishes the interrupted done, with the split, as soon as it settles, and arms no timer", async () => {
  class HoldBus extends FakeBus {
    private g = deferred();
    held = 0;
    release() { this.g.release(); }
    override async publish(type: never, data: never): Promise<string> {
      if ((type as string) === "voice.playing") { this.held++; await this.g.gate; }
      return super.publish(type, data);
    }
  }
  const bus = new HoldBus();
  const { voice } = rig({ "alpha beta": 500, "gamma": 300 }, bus);
  await voice.onEvent(sayMore("L", "alpha beta"));
  await voice.onEvent(clause("L", 1, "gamma"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  assert.equal(bus.held, 1);
  await voice.onEvent(stop(["L"]));
  bus.release();
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "L", seq: 0, sink: "virtual", interrupted: true, spokenText: "", unsaidText: "alpha beta gamma" }]);
  mock.timers.tick(60_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1);
  assert.deepEqual(bus.of("voice.playing").map((p) => p.seq), [0]);
});

// @spec VOICE-CLAUSE-024, VOICE-STOP-003, VOICE-STOP-004, VOICE-CLAUSE-011
test("a stop covers every clause of the line: queued ones are dropped, the one in synthesis is discarded, and a later clause is dropped", async () => {
  const { voice, bus, calls, hold } = rig();
  const g = hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(sayOne("other", "other line"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await flush();
  await voice.onEvent(stop(["L"]));
  await voice.onEvent(clause("L", 3, "c3"));
  g.release();
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "other line", "c1"], "c2 and c3 were never synthesized");
  assert.deepEqual(bus.of("voice.utterance").map((u) => `${u.id}-${u.seq}`), ["L-0", "other-0"]);
  assert.equal(await status(voice, "L-1"), 404, "the discarded clause is not stored");
});

// @spec VOICE-CLAUSE-024, VOICE-STOP-005
test("a stop inside the claim window of a streamed line clears it: no virtual events, and clauses that arrive afterwards are dropped", async () => {
  const { voice, bus, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(stop(["L"]));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, ["c0"]);
  assert.deepEqual(bus.types().filter((t) => t !== ("voice.stop" as never)), ["voice.utterance"]);
});

// @spec VOICE-SYN-008
test("when the service stops it drops every queued brain.clause, publishes nothing for the one in synthesis and takes no later clause", async () => {
  const { voice, bus, calls, hold } = rig();
  const g = hold("c1");
  await voice.onEvent(sayMore("L", "c0"));
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.onEvent(clause("L", 2, "c2"));
  await flush();
  bus.clear();
  voice.stop();
  g.release();
  await voice.whenIdle();
  await voice.onEvent(clause("L", 3, "c3"));
  await voice.whenIdle();
  mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(calls, ["c0", "c1"]);
  assert.deepEqual(bus.published, []);
});

// ---- line end by silence

// @spec VOICE-CLAUSE-012, VOICE-CLAUSE-011
test("a line ends after 300 s with no clause activity, and any clause activity restarts that bound", async () => {
  const { voice, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 0, "discord")); // a claimed line has no virtual timers to keep it alive
  for (let seq = 1; seq <= 3; seq++) {
    mock.timers.tick(200_000);
    await voice.onEvent(clause("L", seq, `c${seq}`));
    await voice.whenIdle();
  }
  assert.deepEqual(calls, ["c0", "c1", "c2", "c3"], "a clause every 200 s keeps the line open past 300 s in all");
  mock.timers.tick(900_000);
  await voice.onEvent(clause("L", 4, "c4"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1", "c2", "c3"], "after 900 s of silence the line is over");
});

// ---- review round 1

/** A bus that holds the publish of one event type while `hold` is set, until released. */
class GatedBus extends FakeBus {
  hold = false;
  private g = deferred();
  constructor(private gated: string) { super(); }
  release() { this.g.release(); }
  override async publish(type: never, data: never): Promise<string> {
    if (this.hold && (type as string) === this.gated) await this.g.gate;
    return super.publish(type, data);
  }
}

// @spec VOICE-CLAUSE-012
test("a clause arriving 300 s after the line's last activity is dropped and the line ends", async () => {
  const { voice, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 0, "discord")); // claimed: no virtual clause play refreshes the bound
  mock.timers.tick(300_001);
  await voice.onEvent(clause("L", 1, "late"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0"]);
});

// @spec VOICE-CLAUSE-012
test("a clause 299 s after the line's last activity is accepted and refreshes the bound", async () => {
  const { voice, calls } = rig();
  await voice.onEvent(sayMore("L", "c0"));
  await voice.whenIdle();
  await voice.onEvent(playing("L", 0, "discord"));
  mock.timers.tick(299_000);
  await voice.onEvent(clause("L", 1, "c1"));
  await voice.whenIdle();
  assert.deepEqual(calls, ["c0", "c1"]);
});

// @spec VOICE-CLAUSE-025, VOICE-STOP-006
test("a stop while a clause's utterance publish is in flight counts that clause as unsaid", async () => {
  const bus = new GatedBus("voice.utterance");
  const { voice } = rig({ one: 500, two: 300 }, bus);
  await voice.onEvent(sayMore("L", "one"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  bus.hold = true;
  await voice.onEvent(clause("L", 1, "two"));
  await flush();
  await voice.onEvent(stop());
  await flush();
  assert.deepEqual(bus.of("voice.done").at(-1), { id: "L", seq: 0, sink: "virtual", interrupted: true, spokenText: "", unsaidText: "one two" });
  bus.release();
  await flush();
  assert.deepEqual(seqs(bus, "voice.playing"), [0], "clause 1 never plays virtually");
});

// @spec VOICE-CLAUSE-001
test("a line with a live virtual timer is not lost to newer lines: its virtual done still arrives", async () => {
  const { voice, bus } = rig({ a0: 500 });
  await voice.onEvent(sayMore("A", "a0"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  for (let i = 0; i < 60; i++) await voice.onEvent(sayOne(`n${i}`, "x"));
  await voice.whenIdle();
  await flush();
  mock.timers.tick(500);
  await flush();
  assert.deepEqual(bus.of("voice.done").filter((d) => d.id === "A"), [{ id: "A", seq: 0, sink: "virtual" }]);
});

// @spec VOICE-CLAUSE-019
test("the next clause's virtual voice.playing waits until the previous virtual voice.done has resolved", async () => {
  const bus = new GatedBus("voice.done");
  const { voice } = rig({ one: 500, two: 300, three: 200 }, bus);
  await voice.onEvent(sayMore("L", "one"));
  await voice.onEvent(clause("L", 1, "two"));
  await voice.whenIdle();
  mock.timers.tick(1500);
  await flush();
  bus.hold = true;
  mock.timers.tick(500); // virtual done 0 is published but held
  await flush();
  await voice.onEvent(clause("L", 2, "three")); // a publish that would start clause 1
  await voice.whenIdle();
  await flush();
  assert.deepEqual(seqs(bus, "voice.playing"), [0], "clause 1 waits for the done of clause 0");
  bus.release();
  await flush();
  assert.deepEqual(seqs(bus, "voice.playing"), [0, 1]);
});

// @spec VOICE-CLAUSE-010, VOICE-STOP-004
test("a re-used id discards the clause still in synthesis for the replaced line: nothing of it is stored or published", async () => {
  const { voice, bus, calls, hold } = rig();
  const g = hold("old");
  await voice.onEvent(sayOne("u1", "old"));
  await flush();
  await voice.onEvent(sayOne("u1", "new"));
  g.release();
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.text), ["new"]);
  assert.deepEqual((await body(voice, "/audio/u1-0.wav")).bytes, wavMs(500));
  assert.deepEqual(calls, ["old", "new"]);
});
