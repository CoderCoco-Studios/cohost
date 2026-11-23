import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat, testConfig } from "@cohost/testing";
import { TtsError } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { VoiceHealth } from "../src/health.js";
import { fakeEngine } from "./tts-helpers.js";

const kokoro = () => createEngine(testConfig({ voice: { engine: "kokoro" } }).voice);

test("kokoro ok by default; shutdown sends one stopping", async () => { // @spec VOICE-HLTH-001, VOICE-HLTH-004
  const hbs = await runHeartbeat(new VoiceHealth(kokoro()).spec);
  assert.deepEqual(hbs.map((h) => h.state), ["starting", "ready", "stopping"]);
  assert.deepEqual(hbs[1]!.deps, { tts: "ok" });
  assert.equal(hbs[1]!.service, "voice");
});

test("a failed synthesis marks tts down (degraded), the next success marks it ok", async () => { // @spec VOICE-HLTH-002
  const engine = kokoro();
  const h = new VoiceHealth(engine);
  let fail = true;
  const synth = h.track(fakeEngine({ audio: () => { if (fail) throw new TtsError(500, "tts 500"); return { format: { sampleRate: 24000, channels: 1, bitDepth: 16 }, chunks: (async function* () { yield Buffer.alloc(2); })() }; } }));
  await assert.rejects(synth("hi"));
  let hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { tts: "down" });
  assert.equal(hbs[1]!.state, "degraded");
  fail = false;
  await synth("hi");
  hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { tts: "ok" });
  assert.equal(hbs[1]!.state, "ready");
});
