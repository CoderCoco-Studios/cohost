import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, EventPayloads } from "../src/index.js";

// Early reply payloads (event-bus design, 3c, 3d, 6b and Other schema notes). Schemas are read through the catalogue so a
// missing type is a failed assertion, not an import error.
type Schema = { safeParse(v: unknown): { success: boolean }; parse(v: unknown): unknown };
const schema = (type: string): Schema => {
  const s = (EventPayloads as Record<string, Schema | undefined>)[type];
  assert.ok(s, `EventPayloads has ${type}`);
  return s;
};

const early = { speaker: "Chris", source: "discord", text: "so I was thinking", utteranceId: "u-1", seq: 0, sttMs: 120 };
const retracted = { speaker: "Chris", source: "discord", utteranceId: "u-1", seq: 0 };
const heard = { speaker: "Chris", text: "hi", durationMs: 100 };
const focus = { reason: "mentioned", score: 1 };
const resolve = { utteranceId: "u-1", seq: 0, outcome: "confirm" };
const say = { id: "x", text: "t", emotion: "happy" };

const EXPECTED = [
  "chat.message", "chat.removed", "vision.summary", "speech.heard", "speech.partial", "speech.early", "speech.retracted", "brain.say",
  "brain.clause", "brain.status", "attention.focus", "attention.resolve", "affect.state", "memory.recall.request", "memory.recall.reply",
  "memory.viewer", "memory.notes.request", "memory.notes.reply", "memory.viewers.request", "memory.viewers.reply", "voice.utterance",
  "voice.playing", "voice.done", "voice.stop", "voice.failed", "avatar.state", "control", "inject.request", "inject.result",
  "service.lifecycle", "tool.request", "tool.result", "tool.catalog", "tool.confirm", "tool.answer", "tool.timer", "service.heartbeat",
];

// @spec BUS-EVT-001
test("the catalogue is exactly the 37 payloads of BUS-EVT-001, exported as EVENT_TYPES", () => {
  assert.equal(EXPECTED.length, 37);
  assert.deepEqual([...EVENT_TYPES].sort(), [...EXPECTED].sort());
  assert.deepEqual(Object.keys(EventPayloads).sort(), [...EXPECTED].sort());
});

// @spec BUS-EVT-052
test("speech.early requires string speaker, source, text, utteranceId and non-negative integer seq and sttMs", () => {
  const s = schema("speech.early");
  assert.equal(s.safeParse(early).success, true);
  for (const k of Object.keys(early)) {
    const { [k as keyof typeof early]: _omit, ...rest } = early;
    assert.equal(s.safeParse(rest).success, false, `rejects a payload without ${k}`);
  }
  for (const k of ["speaker", "source", "text", "utteranceId"] as const) assert.equal(s.safeParse({ ...early, [k]: 5 }).success, false, `${k} must be a string`);
  for (const k of ["seq", "sttMs"] as const) {
    assert.equal(s.safeParse({ ...early, [k]: 0 }).success, true);
    for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...early, [k]: bad }).success, false, `${k}=${String(bad)}`);
  }
});

// @spec BUS-EVT-052
test("speech.early accepts an optional string speakerId and an optional timing", () => {
  const s = schema("speech.early");
  assert.equal(s.safeParse({ ...early, speakerId: "u9" }).success, true);
  assert.equal(s.safeParse({ ...early, speakerId: 9 }).success, false);
  assert.equal(s.safeParse({ ...early, timing: { audioEndedAt: 1_700_000_000_000, closedAt: 1_700_000_000_001 } }).success, true);
  assert.equal(s.safeParse({ ...early, timing: { audioEndedAt: -1 } }).success, false);
});

// @spec BUS-EVT-053
test("speech.retracted requires string speaker, source, utteranceId and a non-negative integer seq, with an optional speakerId", () => {
  const s = schema("speech.retracted");
  assert.equal(s.safeParse(retracted).success, true);
  assert.equal(s.safeParse({ ...retracted, speakerId: "u9" }).success, true);
  assert.equal(s.safeParse({ ...retracted, speakerId: 9 }).success, false);
  for (const k of Object.keys(retracted)) {
    const { [k as keyof typeof retracted]: _omit, ...rest } = retracted;
    assert.equal(s.safeParse(rest).success, false, `rejects a payload without ${k}`);
  }
  for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...retracted, seq: bad }).success, false, `seq=${String(bad)}`);
});

// @spec BUS-EVT-054
test("speech.heard accepts earlySeq, earlySttMs and a literal-true earlyLate, and stays valid without them", () => {
  const s = schema("speech.heard");
  assert.equal(s.safeParse(heard).success, true);
  const full = { ...heard, earlySeq: 1, earlySttMs: 150, earlyLate: true };
  assert.deepEqual(s.parse(full), full, "the members survive validation");
  assert.equal(s.safeParse({ ...heard, earlySeq: 0, earlySttMs: 0 }).success, true);
  for (const k of ["earlySeq", "earlySttMs"]) {
    for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...heard, [k]: bad }).success, false, `${k}=${String(bad)}`);
  }
  assert.equal(s.safeParse({ ...heard, earlyLate: false }).success, false);
  assert.equal(s.safeParse({ ...heard, earlyLate: "true" }).success, false);
});

// @spec BUS-EVT-055
test("attention.focus accepts a literal-true provisional, a non-negative integer seq and a string utteranceId", () => {
  const s = schema("attention.focus");
  assert.equal(s.safeParse(focus).success, true);
  const full = { ...focus, provisional: true, seq: 2, utteranceId: "u-1" };
  assert.deepEqual(s.parse(full), full, "the members survive validation");
  assert.equal(s.safeParse({ ...focus, provisional: false }).success, false);
  for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...focus, seq: bad }).success, false, `seq=${String(bad)}`);
  assert.equal(s.safeParse({ ...focus, utteranceId: 5 }).success, false);
});

// @spec BUS-EVT-056
test("attention.resolve requires a string utteranceId, a non-negative integer seq and an outcome of confirm or withdraw", () => {
  const s = schema("attention.resolve");
  assert.equal(s.safeParse(resolve).success, true);
  assert.equal(s.safeParse({ ...resolve, outcome: "withdraw" }).success, true);
  for (const k of Object.keys(resolve)) {
    const { [k as keyof typeof resolve]: _omit, ...rest } = resolve;
    assert.equal(s.safeParse(rest).success, false, `rejects a payload without ${k}`);
  }
  assert.equal(s.safeParse({ ...resolve, utteranceId: 5 }).success, false);
  for (const bad of [-1, 1.5, Number.NaN, "1", null]) assert.equal(s.safeParse({ ...resolve, seq: bad }).success, false, `seq=${String(bad)}`);
  for (const bad of ["resolve", "", "Confirm", 1, null]) assert.equal(s.safeParse({ ...resolve, outcome: bad }).success, false, `outcome=${String(bad)}`);
});

// @spec BUS-EVT-056
test("attention.resolve accepts an optional string reason and a literal-true interjected", () => {
  const s = schema("attention.resolve");
  assert.equal(s.safeParse({ ...resolve, reason: "mentioned" }).success, true, "a confirm carries the focus's own reason");
  assert.equal(s.safeParse({ ...resolve, reason: 5 }).success, false);
  assert.equal(s.safeParse({ ...resolve, interjected: true }).success, true);
  assert.equal(s.safeParse({ ...resolve, interjected: false }).success, false);
  assert.equal(s.safeParse({ ...resolve, outcome: "withdraw", interjected: false }).success, false);
});

// @spec BUS-EVT-057
test("attention.resolve confirm accepts score, focus, injected, remember and timing", () => {
  const s = schema("attention.resolve");
  const full = {
    ...resolve, reason: "mentioned", score: 0.9, focus: { kind: "speech", who: "Chris", text: "hello", mention: true },
    injected: true, remember: false, timing: { audioEndedAt: 1_700_000_000_000, closedAt: 1_700_000_000_001, heardAt: 1_700_000_000_002 },
  };
  assert.equal(s.safeParse(full).success, true);
  const out = s.parse(full) as Record<string, unknown>;
  for (const k of ["score", "focus", "injected", "remember", "timing"]) assert.ok(k in out, `${k} survives validation`);
  assert.equal(s.safeParse({ ...full, score: "high" }).success, false);
  assert.equal(s.safeParse({ ...full, focus: { kind: "dream", text: "x" } }).success, false);
  assert.equal(s.safeParse({ ...full, timing: { heardAt: -1 } }).success, false);
});

// @spec BUS-EVT-058
test("brain.say accepts a literal-true interjected, rejects false and stays valid without it", () => {
  const s = schema("brain.say");
  assert.equal(s.safeParse(say).success, true);
  assert.equal(s.safeParse({ ...say, interjected: true }).success, true);
  assert.deepEqual(s.parse({ ...say, interjected: true }), { ...say, interjected: true });
  assert.equal(s.safeParse({ ...say, interjected: false }).success, false);
});

// @spec BUS-EVT-059
test("speech.early and speech.retracted carry no injected or remember member", () => {
  for (const [type, base] of [["speech.early", early], ["speech.retracted", retracted]] as const) {
    const out = schema(type).parse({ ...base, injected: true, remember: true }) as Record<string, unknown>;
    assert.equal("injected" in out, false, `${type} has no injected`);
    assert.equal("remember" in out, false, `${type} has no remember`);
  }
});

// @spec BUS-EVT-060
test("attention.resolve withdraw accepts a reason only from the closed list", () => {
  const s = schema("attention.resolve");
  const withdraw = { ...resolve, outcome: "withdraw" };
  for (const reason of ["resumed", "muted", "paused", "forgotten", "superseded", "timeout"]) {
    assert.equal(s.safeParse({ ...withdraw, reason }).success, true, reason);
  }
  assert.equal(s.safeParse(withdraw).success, true, "a withdraw without a reason");
  for (const bad of ["mentioned", "Resumed", "", "cancelled"]) assert.equal(s.safeParse({ ...withdraw, reason: bad }).success, false, `reason=${bad}`);
});
