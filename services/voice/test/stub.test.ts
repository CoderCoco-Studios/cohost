import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog } from "@cohost/testing";
import { runHeartbeat } from "@cohost/testing";
import { Voice, stubSynth, ENVELOPE_HZ } from "../src/voice.js";
import { VoiceHealth } from "../src/health.js";
import { parseWav, envelope } from "../src/wav.js";

const synth = stubSynth({ sample_rate: 24000 });

test("stub: valid mono 16-bit WAV at the configured rate, 60 ms per character", async () => {
  const wav = await synth("x".repeat(100));
  const info = parseWav(wav);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.sampleRate, 24000);
  assert.equal(Math.round(info.durationMs), 6000);
  assert.ok(wav.subarray(info.dataOffset).every((b) => b === 0));
});

test("stub: short text is padded to at least 400 ms; the envelope is all zeros at 30 Hz", async () => {
  const wav = await synth("hi");
  const info = parseWav(wav);
  assert.equal(Math.round(info.durationMs), 400);
  const env = envelope(wav, info, ENVELOPE_HZ);
  assert.equal(env.length, 12);
  assert.ok(env.every((v) => v === 0));
});

test("stub: brain.say publishes a real voice.utterance and never calls fetch", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network"); }) as typeof fetch;
  try {
    const bus = new FakeBus();
    const voice = new Voice({ bus, log: recordingLog().log, synth, publicUrl: "http://voice:8700" });
    await voice.onEvent(event("brain.say", { id: "s1", text: "x".repeat(50), emotion: "happy" }));
    const [u] = bus.of("voice.utterance");
    assert.equal(u!.durationMs, 3000);
    assert.equal(u!.sampleRate, 24000);
    assert.equal(u!.audioUrl, "http://voice:8700/audio/s1.wav");
    assert.ok(u!.envelope.every((v) => v === 0));
    assert.equal(u!.envelope.length, 90);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    mock.timers.reset();
  }
});

test("stub health: mode mock, kokoro n/a, still ready", async () => {
  const hbs = await runHeartbeat(new VoiceHealth("stub").spec);
  assert.equal(hbs[1]!.mode, "mock");
  assert.deepEqual(hbs[1]!.deps, { kokoro: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
  assert.equal((await runHeartbeat(new VoiceHealth().spec))[1]!.mode, "live");
});
