import { test } from "node:test";
import assert from "node:assert/strict";
import { EventPayloads } from "../src/index.js";

const MEMBERS = ["audioEndedAt", "heardAt", "focusedAt", "llmStartedAt", "llmEndedAt", "criticEndedAt"] as const;

const bases = {
  "speech.heard": { speaker: "s", text: "t", durationMs: 1 },
  "attention.focus": { reason: "mentioned", score: 1 },
  "brain.say": { id: "x", text: "t", emotion: "happy" },
} as const;

// @spec BUS-EVT-024
test("speech.heard, attention.focus and brain.say accept an optional timing object and stay valid without it", () => {
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
