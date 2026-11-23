import { test } from "node:test";
import assert from "node:assert/strict";
import { EventPayloads } from "../src/index.js";

const MEMBERS = ["audioEndedAt", "heardAt", "capturedAt", "describedAt", "focusedAt", "llmStartedAt", "llmEndedAt", "criticEndedAt", "toolStartedAt", "toolEndedAt"] as const;

const bases = {
  "vision.summary": { text: "t" },
  "speech.heard": { speaker: "s", text: "t", durationMs: 1 },
  "attention.focus": { reason: "mentioned", score: 1 },
  "brain.say": { id: "x", text: "t", emotion: "happy" },
} as const;

// @spec BUS-EVT-024
test("speech.heard, vision.summary, attention.focus and brain.say accept an optional timing object and stay valid without it", () => {
  for (const [type, base] of Object.entries(bases)) {
    const schema = EventPayloads[type as keyof typeof bases];
    assert.equal(schema.safeParse(base).success, true, `${type} without timing`);
    assert.equal(schema.safeParse({ ...base, timing: {} }).success, true, `${type} empty timing`);
    const full = Object.fromEntries(MEMBERS.map((m, i) => [m, 1_700_000_000_000 + i]));
    const parsed = schema.parse({ ...base, timing: full }) as { timing?: unknown };
    assert.deepEqual(parsed.timing, full, `${type} keeps every member`);
    for (const m of MEMBERS) {
      assert.equal(schema.safeParse({ ...base, timing: { [m]: 0 } }).success, true, `${type}.${m} accepts 0`);
    }
  }
});

const EARLY_MEMBERS = ["closedAt", "confirmedAt", "heldAt"] as const;
const earlyBases = {
  "speech.early": { speaker: "s", source: "discord", text: "t", utteranceId: "u-1", seq: 0, sttMs: 1 },
  "attention.resolve": { utteranceId: "u-1", seq: 0, outcome: "confirm" },
  "vision.summary": { text: "t" },
  "speech.heard": { speaker: "s", text: "t", durationMs: 1 },
  "attention.focus": { reason: "mentioned", score: 1 },
  "brain.say": { id: "x", text: "t", emotion: "happy" },
} as const;
type Loose = { safeParse(v: unknown): { success: boolean }; parse(v: unknown): unknown };

// @spec BUS-EVT-024
test("timing accepts closedAt, confirmedAt and heldAt on speech.early, attention.resolve and the existing carriers", () => {
  for (const [type, base] of Object.entries(earlyBases)) {
    const schema = (EventPayloads as Record<string, Loose | undefined>)[type];
    assert.ok(schema, `EventPayloads has ${type}`);
    const full = Object.fromEntries(EARLY_MEMBERS.map((m, i) => [m, 1_700_000_000_000 + i]));
    assert.equal(schema.safeParse(base).success, true, `${type} without timing`);
    assert.deepEqual((schema.parse({ ...base, timing: full }) as { timing?: unknown }).timing, full, `${type} keeps every new member`);
    for (const m of EARLY_MEMBERS) assert.equal(schema.safeParse({ ...base, timing: { [m]: 0 } }).success, true, `${type}.${m} accepts 0`);
  }
});

// @spec BUS-EVT-024
test("closedAt, confirmedAt and heldAt reject a negative, fractional or non-finite number and a non-number", () => {
  for (const [type, base] of Object.entries(earlyBases)) {
    const schema = (EventPayloads as Record<string, Loose | undefined>)[type];
    assert.ok(schema, `EventPayloads has ${type}`);
    for (const m of EARLY_MEMBERS) {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12", null]) {
        assert.equal(schema.safeParse({ ...base, timing: { [m]: bad } }).success, false, `${type}.${m}=${String(bad)}`);
      }
    }
  }
});

// @spec BUS-EVT-024
test("every timing member rejects a negative, fractional or non-finite number and a non-number", () => {
  for (const [type, base] of Object.entries(bases)) {
    const schema = EventPayloads[type as keyof typeof bases];
    for (const m of MEMBERS) {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12", null]) {
        assert.equal(schema.safeParse({ ...base, timing: { [m]: bad } }).success, false, `${type}.${m}=${String(bad)}`);
      }
    }
  }
});
