import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav } from "@cohost/shared";
import { TtsError, TtsGate, classifyFailure, collect } from "../src/engine.js";
import { audioOf, pcm } from "./tts-helpers.js";

// ---- collect

// @spec VOICE-ENG-001, VOICE-ENG-002
test("collect gathers the PCM chunks in order and wraps them as a 16-bit mono WAV at the engine's rate, with computed size fields", async () => {
  const all = pcm(3000);
  const wav = await collect(audioOf([all.subarray(0, 100), all.subarray(100, 2000), all.subarray(2000)], 22050));
  const info = parseWav(wav);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(wav.readUInt32LE(4), 36 + all.length, "RIFF size");
  assert.equal(wav.readUInt32LE(40), all.length, "data size");
  assert.deepEqual(wav.subarray(info.dataOffset), all);
  assert.equal(Math.round(info.durationMs), Math.round((3000 / 22050) * 1000));
});

// @spec VOICE-ENG-003
test("audio of zero frames is rejected by collect, as a line-specific failure", async () => {
  for (const parts of [[], [Buffer.alloc(0)]]) {
    const err = await collect(audioOf(parts)).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof Error, "rejects");
    assert.equal(classifyFailure(err), "line");
  }
});

// @spec VOICE-ENG-001
test("a connection failure in the middle of the stream rejects collect and uses none of the audio", async () => {
  async function* broken(): AsyncIterable<Buffer> { yield pcm(100); throw new Error("socket hang up"); }
  await assert.rejects(collect({ format: { sampleRate: 24000, channels: 1, bitDepth: 16 }, chunks: broken() }), /socket hang up/);
});

// ---- errors

// @spec VOICE-ERR-001, VOICE-ERR-002
test("a TtsError reads `tts <status>: <body>`; 400 and 422 are about the line, every other failure is an outage", () => {
  const e = new TtsError(422, '{"detail":"bad"}');
  assert.equal(e.message, 'tts 422: {"detail":"bad"}');
  assert.equal(e.status, 422);
  for (const status of [400, 422]) assert.equal(classifyFailure(new TtsError(status, "x")), "line", String(status));
  for (const status of [401, 403, 404, 429, 500, 502, 503, 418, 413, 301]) assert.equal(classifyFailure(new TtsError(status, "x")), "outage", String(status));
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  for (const err of [timeout, refused, new Error("socket hang up"), new Error("tts audio: not a WAV file"), new Error("tts audio: unsupported bit depth 8"), new Error("tts not configured: voice.pocket.url is not set")]) {
    assert.equal(classifyFailure(err), "outage", err.message);
  }
});

// ---- the concurrency gate

const tick = () => new Promise<void>((r) => setImmediate(r));

// @spec VOICE-ENG-011
test("the gate lets no more places be held than its limit, and a freed place goes to the next waiter", async () => {
  const gate = new TtsGate(2);
  const a = await gate.acquire("line");
  const b = await gate.acquire("clip");
  let third = false;
  const c = gate.acquire("line").then((release) => { third = true; return release; });
  await tick();
  assert.equal(third, false, "two places held, the third waits");
  a();
  const releaseC = await c;
  assert.equal(third, true);
  b(); releaseC();
});

// @spec VOICE-ENG-012
test("waiting lines go before waiting clip phrases, whatever the order they asked in", async () => {
  const gate = new TtsGate(1);
  const hold = await gate.acquire("line");
  const order: string[] = [];
  const ask = (name: string, priority: "line" | "clip") => gate.acquire(priority).then((release) => { order.push(name); release(); });
  const all = [ask("clip1", "clip"), ask("clip2", "clip"), ask("line1", "line"), ask("line2", "line")];
  hold();
  await Promise.all(all);
  assert.deepEqual(order, ["line1", "line2", "clip1", "clip2"]);
});

// @spec VOICE-ENG-013
test("a place is held until its release is called, and releasing twice frees only one place", async () => {
  const gate = new TtsGate(1);
  const release = await gate.acquire("line");
  let second = false;
  const waiting = gate.acquire("line").then((r) => { second = true; return r; });
  await tick(); await tick();
  assert.equal(second, false, "nothing but a release frees the place");
  release(); release();
  const r2 = await waiting;
  let third = false;
  void gate.acquire("line").then(() => { third = true; });
  await tick();
  assert.equal(third, false, "the second release did not free a place that was never held");
  r2();
  await tick();
  assert.equal(third, true);
});
