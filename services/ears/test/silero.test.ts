import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { SILERO_MODEL_PATH, loadSilero } from "../src/vad.js";

const frame = (samples: (i: number) => number, n = 320): Buffer => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples(i))) * 32767), i * 2); return b; };
/** A synthetic vowel-like signal: a 120 Hz glottal-ish pulse train's harmonics shaped by two formants, with a syllable-rate envelope. */
const voiced = (t0: number) => (i: number) => {
  const t = (t0 + i) / 16000;
  let s = 0;
  for (let h = 1; h <= 30; h++) { const f = 120 * h; s += Math.sin(2 * Math.PI * f * t) * (Math.exp(-((f - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1200) ** 2) / 3e5)) / h ** 0.3; }
  return 0.35 * s * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
};

async function detectors(t: { skip(msg: string): void }) {
  if (!existsSync(SILERO_MODEL_PATH)) return void t.skip(`model missing: ${SILERO_MODEL_PATH}`);
  try { return await loadSilero(); } catch (err) { return void t.skip(`runtime or model did not load: ${String(err)}`); }
}
async function run(d: { probability(p: Buffer): number | Promise<number> }, make: (k: number) => Buffer, frames = 50) {
  const ps: number[] = [];
  for (let k = 0; k < frames; k++) ps.push(await d.probability(make(k)));
  return ps;
}
const max = (a: number[]) => Math.max(...a);

// @spec EARS-VAD-002
test("Silero (real model): silence stays low and a speech-like signal scores higher, from 20 ms frames", async (t) => {
  const make = await detectors(t);
  if (!make) return;
  const silence = await run(make(), () => Buffer.alloc(640));
  assert.ok(max(silence) < 0.2, `silence max ${max(silence)}`);
  const noise = await run(make(), () => frame(() => (Math.random() - 0.5) * 0.002));
  assert.ok(max(noise) < 0.3, `faint noise max ${max(noise)}`);
  const speech = await run(make(), (k) => frame(voiced(k * 320)));
  console.log(`silero probabilities: silence ${max(silence).toFixed(3)}, speech-like ${max(speech).toFixed(3)}`);
  assert.ok(max(speech) > max(silence) + 0.2, `speech-like max ${max(speech)} vs silence ${max(silence)}`);
});

// @spec EARS-VAD-007
test("Silero (real model): two detectors from one load keep independent state", async (t) => {
  const make = await detectors(t);
  if (!make) return;
  const a = make(), b = make();
  const speech = await run(a, (k) => frame(voiced(k * 320)));
  const silence = await run(b, () => Buffer.alloc(640));
  assert.ok(max(speech) > max(silence) + 0.2, "a's speech did not leak into b");
  const fresh = await run(make(), (k) => frame(voiced(k * 320)));
  assert.deepEqual(fresh, speech, "a new detector starts from the same state a did");
});

// @spec EARS-VAD-006
test("loadSilero rejects with the reason when the model cannot load", async () => {
  await assert.rejects(loadSilero("/nonexistent/silero_vad.onnx"), /Silero model .* did not load/);
});
