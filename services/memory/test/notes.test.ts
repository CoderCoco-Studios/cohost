import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import {
  clamp01, cosine, defaultHint, effectiveStrength, reinforcedStrength, withDefaultHint,
} from "../src/notes.js";

const cfg = testConfig().brain.memory.notes;
const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const note = (layer: "core" | "recent", strength = 1) => ({ layer, strength, strengthAt: new Date(T0) });

// @spec MEM-NOTE-002
test("effective strength halves every half-life of the note's layer", () => {
  assert.equal(effectiveStrength(note("recent"), T0, cfg), 1);
  assert.equal(effectiveStrength(note("recent"), T0 + 7 * DAY, cfg), 0.5);
  assert.equal(effectiveStrength(note("recent"), T0 + 14 * DAY, cfg), 0.25);
  assert.equal(effectiveStrength(note("core"), T0 + 60 * DAY, cfg), 0.5);
  assert.ok(Math.abs(effectiveStrength(note("recent", 0.8), T0 + 3.5 * DAY, cfg) - 0.8 * Math.SQRT1_2) < 1e-12);
  const slow = { ...cfg, recent_half_life_days: 1 };
  assert.equal(effectiveStrength(note("recent"), T0 + DAY, slow), 0.5);
});

// @spec MEM-NOTE-003
test("effective strength is clamped to 0..1 and a non-finite result counts as 0", () => {
  assert.equal(effectiveStrength(note("recent"), T0 + 1e9 * DAY, cfg), 0); // underflow
  assert.equal(effectiveStrength(note("recent", 1), T0 - 7 * DAY, cfg), 1); // 2.0 clamps to 1
  assert.equal(effectiveStrength({ ...note("recent"), strength: NaN }, T0, cfg), 0);
  assert.equal(effectiveStrength({ ...note("recent"), strength: Infinity }, T0, cfg), 0);
  assert.equal(effectiveStrength({ ...note("recent"), strengthAt: new Date(NaN) }, T0, cfg), 0);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(7), 1);
  assert.equal(clamp01(-Infinity), 0);
  assert.equal(clamp01(0.4), 0.4);
});

// @spec MEM-NOTE-005
test("reinforcement closes `reinforce` of the gap to full strength", () => {
  assert.ok(Math.abs(reinforcedStrength(0.5, cfg) - 0.8) < 1e-12); // 0.5 + 0.5 * 0.6
  assert.equal(reinforcedStrength(1, cfg), 1);
  assert.equal(reinforcedStrength(0, { ...cfg, reinforce: 0.25 }), 0.25);
  assert.equal(reinforcedStrength(0.3, { ...cfg, reinforce: 0 }), 0.3);
});

// @spec MEM-NOTE-010
test("health and family notes always carry a handling hint, defaulting by category", () => {
  assert.equal(defaultHint("general"), undefined);
  assert.equal(defaultHint("health"), "only if they bring it up; never quote it");
  assert.equal(defaultHint("family"), "check in warmly and gently; never name or quote it");
  assert.equal(withDefaultHint("health", undefined), defaultHint("health"));
  assert.equal(withDefaultHint("family", "   "), defaultHint("family"));
  assert.equal(withDefaultHint("family", " ask about the move "), "ask about the move");
  assert.equal(withDefaultHint("general", undefined), undefined);
  assert.equal(withDefaultHint("general", " x "), "x");
});

test("cosine similarity of equal vectors is 1, orthogonal 0, zero vectors 0", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([1, 1], [1]), 0);
});
