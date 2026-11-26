import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, EventPayloads } from "../src/index.js";

// Streamed lines (event-bus design, Streamed lines): brain.clause, `more`, required `seq`, `final` on voice.done.

const ok = (type: keyof typeof EventPayloads, v: unknown) => EventPayloads[type].safeParse(v).success;
const utt = { id: "u1", seq: 0, text: "hi", emotion: "neutral", durationMs: 1, envelopeHz: 50, envelope: [0], sampleRate: 24000, audioUrl: "/audio/u1-0.wav" };

// @spec BUS-EVT-016
test("voice.utterance requires an integer seq that is not negative and takes more only as the literal true", () => {
  assert.equal(ok("voice.utterance", utt), true);
  const { seq: _seq, ...noSeq } = utt;
  assert.equal(ok("voice.utterance", noSeq), false, "missing seq");
  for (const bad of [-1, 1.5, "0", null]) assert.equal(ok("voice.utterance", { ...utt, seq: bad }), false, `seq ${String(bad)}`);
  assert.equal(ok("voice.utterance", { ...utt, seq: 3 }), true);
  assert.equal(ok("voice.utterance", { ...utt, more: true }), true);
  assert.equal(ok("voice.utterance", { ...utt, more: false }), false, "more:false is rejected");
  assert.equal(ok("voice.utterance", { ...utt, more: "true" }), false);
});

// @spec BUS-EVT-017
test("voice.playing and voice.done reject a missing or negative seq; voice.playing takes no BUS-EVT-031 member", () => {
  for (const type of ["voice.playing", "voice.done"] as const) {
    assert.equal(ok(type, { id: "u", sink: "s", seq: 0 }), true, type);
    assert.equal(ok(type, { id: "u", sink: "s", seq: 4 }), true, type);
    assert.equal(ok(type, { id: "u", sink: "s" }), false, `${type} without seq`);
    for (const bad of [-1, 0.5, "1"]) assert.equal(ok(type, { id: "u", sink: "s", seq: bad }), false, `${type} seq ${String(bad)}`);
  }
  const playing = EventPayloads["voice.playing"].safeParse({ id: "u", sink: "s", seq: 1, interrupted: true });
  assert.ok(!playing.success || !("interrupted" in (playing.data as object)), "voice.playing accepts none of the BUS-EVT-031 members");
});

// @spec BUS-EVT-022
test("voice.failed requires an integer seq that is not negative and keeps the optional fallback", () => {
  const f = { id: "u", sink: "s", reason: "boom", seq: 2 };
  assert.equal(ok("voice.failed", f), true);
  assert.equal(ok("voice.failed", { ...f, fallback: { clip: "c", text: "t" } }), true);
  const { seq: _s, ...noSeq } = f;
  assert.equal(ok("voice.failed", noSeq), false);
  for (const bad of [-1, 1.2, "2"]) assert.equal(ok("voice.failed", { ...f, seq: bad }), false, String(bad));
});

// @spec BUS-EVT-031
test("voice.done accepts final only as the literal true, and the texts only with interrupted", () => {
  const base = { id: "u", sink: "s", seq: 1 };
  assert.equal(ok("voice.done", { ...base, final: true }), true);
  assert.equal(ok("voice.done", { ...base, final: false }), false, "final:false is rejected");
  assert.equal(ok("voice.done", { ...base, final: "true" }), false);
  assert.equal(ok("voice.done", { ...base, interrupted: true, final: true, spokenText: "a", unsaidText: "b" }), true);
  assert.equal(ok("voice.done", { ...base, interrupted: false }), false);
  assert.equal(ok("voice.done", { ...base, spokenText: "a" }), false, "spokenText needs interrupted");
  assert.equal(ok("voice.done", { ...base, unsaidText: "b" }), false, "unsaidText needs interrupted");
  assert.equal(ok("voice.done", { ...base, final: true, spokenText: "a" }), false, "final is not interrupted");
});

// @spec BUS-EVT-037
test("brain.say accepts more only as the literal true", () => {
  const say = { id: "1", text: "hi", emotion: "neutral" };
  assert.equal(ok("brain.say", say), true);
  assert.equal(ok("brain.say", { ...say, more: true }), true);
  assert.equal(EventPayloads["brain.say"].parse({ ...say, more: true }).more, true);
  assert.equal(ok("brain.say", { ...say, more: false }), false);
  assert.equal(ok("brain.say", { ...say, more: 1 }), false);
});

// @spec BUS-EVT-038
test("brain.clause requires id, seq of at least 1 and text, and takes last only as the literal true", () => {
  assert.ok(EVENT_TYPES.includes("brain.clause" as never), "brain.clause is catalogued");
  assert.deepEqual([...EVENT_TYPES].toSorted(), Object.keys(EventPayloads).toSorted());
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 1, text: "and then" }), true);
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 7, text: "x" }), true);
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 0, text: "x" }), false, "seq 0 is the brain.say");
  for (const bad of [-1, 1.5, "1"]) assert.equal(ok("brain.clause" as never, { id: "1", seq: bad, text: "x" }), false, `seq ${String(bad)}`);
  assert.equal(ok("brain.clause" as never, { seq: 1, text: "x" }), false, "no id");
  assert.equal(ok("brain.clause" as never, { id: "1", text: "x" }), false, "no seq");
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 1 }), false, "no text");
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 1, text: "x", last: true, through: 1 }), true);
  assert.equal(ok("brain.clause" as never, { id: "1", seq: 1, text: "x", last: false, through: 1 }), false, "last:false is rejected");
});

// @spec BUS-EVT-039
test("brain.clause requires through (0 up to its seq) with last and rejects it without last", () => {
  const c = { id: "1", seq: 3, text: "x" };
  const clause = (v: unknown) => ok("brain.clause" as never, v);
  assert.equal(clause({ ...c, last: true }), false, "last without through");
  assert.equal(clause({ ...c, last: true, through: 0 }), true);
  assert.equal(clause({ ...c, last: true, through: 3 }), true, "through may equal seq");
  assert.equal(clause({ ...c, last: true, through: 4 }), false, "through above seq");
  assert.equal(clause({ ...c, last: true, through: -1 }), false);
  assert.equal(clause({ ...c, last: true, through: 1.5 }), false);
  assert.equal(clause({ ...c, through: 1 }), false, "through without last");
});

// @spec BUS-EVT-040
test("brain.clause accepts cut only with one of the nine reasons, and only together with last", () => {
  const clause = (v: unknown) => ok("brain.clause" as never, v);
  const cuts = ["repeat", "muted", "busy", "failed", "length", "stopped", "timeout", "vetoed", "tools"];
  for (const cut of cuts) assert.equal(clause({ id: "1", seq: 2, text: "x", last: true, through: 1, cut }), true, `cut ${cut}`);
  assert.equal(clause({ id: "1", seq: 2, text: "x", last: true, through: 1, cut: "bogus" }), false, "an unknown cut is rejected");
  assert.equal(clause({ id: "1", seq: 2, text: "x", cut: "repeat" }), false, "cut without last is rejected");
});

// @spec BUS-EVT-041
test("brain.clause accepts empty text only on the closing event", () => {
  const clause = (v: unknown) => ok("brain.clause" as never, v);
  assert.equal(clause({ id: "1", seq: 2, text: "" }), false);
  assert.equal(clause({ id: "1", seq: 2, text: "", last: true, through: 1 }), true);
});

// @spec BUS-EVT-042
test("brain.clause rejects a timing, injected or remember member", () => {
  const c = { id: "1", seq: 1, text: "x" };
  const clause = (v: unknown) => ok("brain.clause" as never, v);
  assert.equal(clause(c), true);
  assert.equal(clause({ ...c, timing: { heardAt: 1 } }), false, "timing");
  assert.equal(clause({ ...c, injected: true }), false, "injected");
  assert.equal(clause({ ...c, remember: false }), false, "remember");
});
