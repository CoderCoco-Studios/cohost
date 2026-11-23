import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat, testConfig } from "@cohost/testing";
import { TtsError } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { VoiceHealth } from "../src/health.js";
import { audioOf, fakeEngine, fakeServer, pcm } from "./tts-helpers.js";

afterEach(() => mock.timers.reset());

const deps = (h: VoiceHealth) => (typeof h.spec.deps === "function" ? h.spec.deps() : h.spec.deps);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };
const failing = (err: Error) => fakeEngine({ synthesize: async () => { throw err; } });
const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });

// @spec VOICE-HLTH-001
test("every engine but stub reports mode live and the dependency tts, ok from start, and ready only after the server and the group", async () => {
  for (const name of ["kokoro", "openai"] as const) {
    const h = new VoiceHealth(fakeEngine({ name }));
    assert.equal(h.spec.service, "voice");
    assert.equal(h.spec.mode, "live");
    assert.deepEqual(deps(h), { tts: "ok" });
    const hbs = await runHeartbeat(h.spec);
    assert.deepEqual(hbs.map((b) => b.state), ["starting", "ready", "stopping"]);
    assert.deepEqual(hbs[1]!.deps, { tts: "ok" });
  }
});

// @spec VOICE-HLTH-003
test("the stub engine reports mode mock with tts n/a and state ready", async () => {
  const h = new VoiceHealth(fakeEngine({ name: "stub", concurrency: Infinity }));
  assert.equal(h.spec.mode, "mock");
  assert.deepEqual(deps(h), { tts: "n/a" });
  const hbs = await runHeartbeat(h.spec);
  assert.equal(hbs[1]!.state, "ready");
});

// @spec VOICE-HLTH-009
test("an engine without a probe and with complete configuration is ok from start and judged by its last synthesis", async () => {
  const h = new VoiceHealth(fakeEngine({ name: "openai" }));
  assert.deepEqual(deps(h), { tts: "ok" });
  const tracked = h.track(failing(new TtsError(503, "busy")));
  await assert.rejects(tracked("x"));
  assert.deepEqual(deps(h), { tts: "down" });
});

// @spec VOICE-HLTH-002, VOICE-ERR-001
test("an outage-class failure of a line sets tts down (heartbeat degraded) and the next success sets it back to ok", async () => {
  const outages: Error[] = [
    new TtsError(500, "x"), new TtsError(401, "x"), new TtsError(403, "x"), new TtsError(404, "x"), new TtsError(429, "x"), new TtsError(418, "x"),
    timeout, new Error("socket hang up"), new Error("tts audio: not a WAV file"), new Error("tts not configured: voice.pocket.url is not set"),
  ];
  for (const err of outages) {
    const h = new VoiceHealth(fakeEngine());
    await assert.rejects(h.track(failing(err))("hi", { priority: "line" }));
    assert.deepEqual(deps(h), { tts: "down" }, err.message);
    const hbs = await runHeartbeat(h.spec);
    assert.equal(hbs[1]!.state, "degraded", err.message);
    await h.track(fakeEngine())("hi", { priority: "line" });
    assert.deepEqual(deps(h), { tts: "ok" }, err.message);
  }
});

// @spec VOICE-HLTH-002
test("a failure or success of a fallback clip phrase moves tts the same way as a line's", async () => {
  const h = new VoiceHealth(fakeEngine());
  await assert.rejects(h.track(failing(new TtsError(502, "x")))("phrase", { priority: "clip" }));
  assert.deepEqual(deps(h), { tts: "down" });
  await h.track(fakeEngine())("phrase", { priority: "clip" });
  assert.deepEqual(deps(h), { tts: "ok" });
});

// @spec VOICE-HLTH-006, VOICE-ERR-002
test("a 400 or 422 for one line leaves tts unchanged, whether it was ok or down", async () => {
  for (const status of [400, 422]) {
    const h = new VoiceHealth(fakeEngine());
    await assert.rejects(h.track(failing(new TtsError(status, "bad text")))("x", { priority: "line" }));
    assert.deepEqual(deps(h), { tts: "ok" }, `${status} while ok`);
    await assert.rejects(h.track(failing(new TtsError(500, "x")))("x"));
    await assert.rejects(h.track(failing(new TtsError(status, "bad text")))("x", { priority: "line" }));
    assert.deepEqual(deps(h), { tts: "down" }, `${status} while down`);
  }
});

// @spec VOICE-HLTH-006
test("audio of zero frames leaves tts unchanged, whether it was ok or down", async () => {
  const empty = fakeEngine({ audio: () => audioOf([]) });
  const h = new VoiceHealth(fakeEngine());
  await assert.rejects(h.track(empty)("x"));
  assert.deepEqual(deps(h), { tts: "ok" });
  await assert.rejects(h.track(failing(new TtsError(500, "x")))("x"));
  await assert.rejects(h.track(empty)("x"));
  assert.deepEqual(deps(h), { tts: "down" }, "an empty clip is no proof the server is back");
});

// @spec VOICE-HLTH-006, VOICE-ERR-003
test("the outcome of a line voice.stop ended, failure or success, is discarded and leaves tts unchanged", async () => {
  const discarded = { priority: "line" as const, discarded: () => true };
  const h = new VoiceHealth(fakeEngine());
  await assert.rejects(h.track(failing(new TtsError(500, "x")))("x", discarded));
  assert.deepEqual(deps(h), { tts: "ok" }, "a failure of a stopped line does not take tts down");
  await assert.rejects(h.track(failing(new TtsError(500, "x")))("x"));
  assert.deepEqual(deps(h), { tts: "down" });
  await h.track(fakeEngine())("x", discarded);
  assert.deepEqual(deps(h), { tts: "down" }, "a success of a stopped line does not bring it back");
});

// ---- the readiness probe

// @spec VOICE-HLTH-007, VOICE-HLTH-008
test("an engine with a probe starts down, probes at start and every 10 s while down, and a successful probe sets tts ok", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let healthy = false;
  let pings = 0;
  const engine = fakeEngine({ name: "pocket", concurrency: 1, ping: async () => { pings++; return healthy; } });
  const h = new VoiceHealth(engine);
  assert.deepEqual(deps(h), { tts: "down" }, "down from start, before any probe");
  h.startProbe(engine);
  await flush();
  assert.equal(pings, 1, "probes at start");
  assert.deepEqual(deps(h), { tts: "down" });
  mock.timers.tick(9_999); await flush();
  assert.equal(pings, 1, "not before 10 s");
  mock.timers.tick(1); await flush();
  assert.equal(pings, 2);
  mock.timers.tick(10_000); await flush();
  assert.equal(pings, 3);
  healthy = true;
  mock.timers.tick(10_000); await flush();
  assert.equal(pings, 4);
  assert.deepEqual(deps(h), { tts: "ok" });
  mock.timers.tick(60_000); await flush();
  assert.equal(pings, 4, "no probing while ok");
  h.stop();
});

// @spec VOICE-HLTH-007
test("probing resumes when tts goes down again after a synthesis failure", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let pings = 0;
  const probe = fakeEngine({ name: "pocket", ping: async () => { pings++; return true; } });
  const h = new VoiceHealth(probe);
  h.startProbe(probe);
  await flush();
  assert.deepEqual(deps(h), { tts: "ok" });
  const before = pings;
  await assert.rejects(h.track(failing(new TtsError(503, "x")))("x"));
  assert.deepEqual(deps(h), { tts: "down" });
  mock.timers.tick(10_000); await flush();
  assert.ok(pings > before, "probed again within 10 s");
  assert.deepEqual(deps(h), { tts: "ok" });
  h.stop();
});

// @spec VOICE-HLTH-008
test("a failing or throwing probe leaves tts down and does not stop the probing", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let pings = 0;
  const probe = fakeEngine({ name: "pocket", ping: async () => { pings++; throw new Error("connect ECONNREFUSED"); } });
  const h = new VoiceHealth(probe);
  h.startProbe(probe);
  await flush();
  mock.timers.tick(10_000); await flush();
  assert.equal(pings, 2);
  assert.deepEqual(deps(h), { tts: "down" });
  h.stop();
});

const realSleep = async (ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) await new Promise<void>((r) => setImmediate(r)); };
const realUntil = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise<void>((r) => setImmediate(r)); } };

// @spec VOICE-HLTH-008
test("a probe that hangs counts as failed after the engine's timeout, and probing goes on every 10 s", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const s = await fakeServer(() => { /* /health never answers */ });
  try {
    const engine = createEngine(testConfig({ voice: { engine: "pocket", timeout_ms: 100, pocket: { url: s.url } } }).voice);
    const h = new VoiceHealth(engine);
    h.startProbe(engine);
    await realUntil(() => s.requests.length === 1);
    await realSleep(200); // the probe times out in real time
    assert.deepEqual(deps(h), { tts: "down" });
    mock.timers.tick(10_000);
    await realUntil(() => s.requests.length === 2);
    await realSleep(200);
    mock.timers.tick(10_000);
    await realUntil(() => s.requests.length === 3);
    assert.deepEqual(s.requests.map((r) => `${r.method} ${r.url}`), ["GET /health", "GET /health", "GET /health"]);
    h.stop();
  } finally { await s.close(); }
});
