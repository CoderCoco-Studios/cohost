import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "@cohost/config";
import { appraiseRules } from "../src/appraise.js";
import { Mood, label } from "../src/mood.js";

const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.shape.brain.shape.affect.parse(over);
const line = (text: string, over: Record<string, unknown> = {}) =>
  appraiseRules({ source: "chat", who: "u", text, mention: false, valence: 0, arousal: 0, ...over } as never);

test("appraiseRules: tone, mentions, speech and shouting move the right axis", () => {
  const plain = line("ok");
  assert.equal(plain.valence_delta, 0);
  assert.ok(plain.arousal_delta > 0 && plain.arousal_delta < 0.1);
  assert.ok(line("lol that was pog").valence_delta > 0);
  assert.ok(line("this is trash").valence_delta < 0);
  assert.ok(line("hi", { mention: true }).arousal_delta > plain.arousal_delta);
  assert.ok(line("hi", { source: "speech" }).arousal_delta > plain.arousal_delta);
  assert.ok(line("WHAT!!!").arousal_delta > plain.arousal_delta);
});

test("label maps the valence/arousal plane to canonical emotions", () => {
  assert.equal(label(0, 0), "neutral");
  assert.equal(label(0.8, 0.8), "laugh");
  assert.equal(label(-0.8, 0.8), "angry");
  assert.equal(label(0, 0.8), "surprised");
  assert.equal(label(0.5, 0.4), "happy");
  assert.equal(label(-0.5, 0.4), "confused");
  assert.equal(label(0, 0.4), "think");
  assert.equal(label(0.6, 0.1), "smug");
  assert.equal(label(-0.6, 0.1), "sad");
});

test("Mood: nudges clamp, decay halves the distance to baseline per half-life", () => {
  const m = new Mood(cfg({ half_life_ms: 1000, baseline_valence: 0 }));
  m.nudge(5, 5, "test");
  assert.equal(m.valence, 1);
  assert.equal(m.arousal, 1);
  assert.equal(m.cause, "test");
  const t0 = Date.now();
  m.tick(t0 + 1000);
  assert.ok(Math.abs(m.valence - 0.5) < 0.01, `valence ${m.valence}`);
  assert.ok(Math.abs(m.arousal - 0.55) < 0.01, `arousal ${m.arousal}`); // resting arousal is 0.1
  m.tick(t0 + 100_000);
  assert.ok(Math.abs(m.valence) < 0.001);
  assert.equal(m.state().mood, "neutral");
});

test("Mood.state rounds and labels", () => {
  const m = new Mood(cfg({ baseline_valence: 0.15 }));
  m.nudge(0.3, 0.3, "x");
  const s = m.state();
  assert.equal(s.valence, 0.45);
  assert.equal(s.arousal, 0.4);
  assert.equal(s.mood, "happy");
});

test("emoji: one emoji never hits both lists, and a bare VS16 is not positive", () => {
  assert.equal(line("🎉").valence_delta, 0); // shares a surrogate with 😡/💀 in a non-unicode class
  assert.equal(line("😀").valence_delta, 0);
  assert.equal(line("\ufe0f").valence_delta, 0);
  assert.ok(line("😂").valence_delta > 0);
  assert.ok(line("❤️").valence_delta > 0);
  assert.ok(line("💀").valence_delta < 0);
  assert.ok(line("👎").valence_delta < 0);
});
