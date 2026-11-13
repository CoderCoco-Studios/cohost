import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, brain: {},
});
const parse = (ears: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), ears });
// The new keys as the code phase will expose them; read loosely so a missing key is a failed assertion, not a type error.
const ok = (ears: Record<string, unknown>) => { const r = parse(ears); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data.ears as unknown as Record<string, unknown> & { vad: { engine?: string; threshold?: number } }; };
const rejects = (ears: Record<string, unknown>, key: string) => {
  const r = parse(ears);
  assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".").startsWith(key)), `${JSON.stringify(ears)} fails naming ${key}`);
};

// @spec CFG-SCH-033
test("ears VAD, utterance cap and partial keys default to silero, 0.5, 15000, off, false and 1000", () => {
  const e = ok({});
  assert.equal(e.vad.engine, "silero");
  assert.equal(e.vad.threshold, 0.5);
  assert.equal(e.max_utterance_ms, 15000);
  assert.equal(e.partials, "off");
  assert.equal(e.stt_gpu, false);
  assert.equal(e.partial_step_ms, 1000);
});

// @spec CFG-SCH-033
test("ears.vad.engine is silero or gap, blank means silero, anything else fails the load", () => {
  assert.equal(ok({ vad: { engine: "gap" } }).vad.engine, "gap");
  assert.equal(ok({ vad: { engine: "silero" } }).vad.engine, "silero");
  assert.equal(ok({ vad: { engine: "" } }).vad.engine, "silero");
  rejects({ vad: { engine: "webrtc" } }, "ears.vad.engine");
});

// @spec CFG-SCH-033
test("ears.vad.threshold is a number from 0 to 1 inclusive", () => {
  for (const good of [0, 0.3, 1]) assert.equal(ok({ vad: { threshold: good } }).vad.threshold, good);
  for (const bad of [-0.1, 1.1, "0.5", Number.NaN]) rejects({ vad: { threshold: bad } }, "ears.vad.threshold");
});

// @spec CFG-SCH-033
test("ears.max_utterance_ms and ears.partial_step_ms are positive integers", () => {
  assert.equal(ok({ max_utterance_ms: 8000 }).max_utterance_ms, 8000);
  assert.equal(ok({ partial_step_ms: 500 }).partial_step_ms, 500);
  for (const bad of [0, -1, 1.5, "1000"]) {
    rejects({ max_utterance_ms: bad }, "ears.max_utterance_ms");
    rejects({ partial_step_ms: bad }, "ears.partial_step_ms");
  }
});

// @spec CFG-SCH-033
test("ears.partials is on or off with blank meaning off, and ears.stt_gpu is a boolean", () => {
  assert.equal(ok({ partials: "on" }).partials, "on");
  assert.equal(ok({ partials: "off" }).partials, "off");
  assert.equal(ok({ partials: "" }).partials, "off");
  rejects({ partials: "auto" }, "ears.partials");
  assert.equal(ok({ stt_gpu: true }).stt_gpu, true);
  rejects({ stt_gpu: "yes" }, "ears.stt_gpu");
});
