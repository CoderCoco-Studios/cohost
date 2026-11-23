import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { buildEngines, createBatchEngine } from "../src/engines.js";
import { SttStatus, boot, connectorOffer, fakeStreaming, fakeStt, resetSeq, sleep } from "./rig.js";

// The STT engine contract and its selection (EARS-ENG-*). Test seams the code phase must provide (src/engines.ts, the module of
// the LLD's SttEngine / BatchSttEngine / StreamingSttEngine / SttSession interfaces):
//  - `createBatchEngine(name: "speaches" | "openai" | "stub", cfg: Config["ears"]): BatchSttEngine`: the batch engine for a name,
//    every call bounded by `cfg.stt_timeout_ms`; `transcribe` rejects on a failed call.
//  - `buildEngines(cfg: Config["ears"], o?: { streaming?: StreamingSttEngine }): { selected: SttEngine; batch?: BatchSttEngine; gap?: string }`:
//    `selected` is the engine `ears.stt_engine` names (a streaming one is the `o.streaming` engine, #188 builds the real ones),
//    `batch` is the batch engine of EARS-ENG-003 (absent with no fallback), `gap` the reason of EARS-ENG-010 when the batch
//    engine's configuration is incomplete.

const cfgOf = (ears: Record<string, unknown> = {}) => testConfig({ ears }).ears;
const wav = (ms = 1000) => wavWrap(Buffer.alloc((ms / 1000) * 32000), 16000, 1);
const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
// CFG-SCH-105: ears.early.after_ms (default 250) must sit below silence_ms, so it is set here.
const cfg = (over: Record<string, unknown> = {}) => ({ sources: ["discord"], stt_engine: "speaches", partials: "off", vad: { engine: "gap" }, silence_ms: 150, early: { after_ms: 100 }, min_speech_ms: 100, ...over });
const oneFile = async (dir: string) => (await readdir(dir)).filter((n) => n.startsWith("a.wav"));
const freePort = (): Promise<number> => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

async function run<T>(stt: ReturnType<typeof fakeStt>, ears: Record<string, unknown>, body: (r: Awaited<ReturnType<typeof boot>>) => Promise<T>, o: Parameters<typeof boot>[1] = { setup: reg }): Promise<T> {
  resetSeq();
  const r = await boot(ears, o);
  try { await sleep(60); return await body(r); } finally { await r.stop(); stt.restore(); }
}

// @spec EARS-ENG-001
test("the engine ears.stt_engine names is built: speaches, openai and stub are batch engines, nemotron and kyutai streaming ones", () => {
  for (const name of ["speaches", "openai", "stub"] as const) {
    const e = buildEngines(cfgOf({ stt_engine: name, openai: { base_url: "https://api.example.com/v1" } }));
    assert.deepEqual([e.selected.kind, e.selected.name], ["batch", name]);
  }
  for (const name of ["nemotron", "kyutai"] as const) {
    const s = fakeStreaming({ name }).engine;
    const e = buildEngines(cfgOf({ stt_engine: name }), { streaming: s });
    assert.deepEqual([e.selected.kind, e.selected.name], ["streaming", name]);
  }
  assert.equal(buildEngines(cfgOf({ stt_engine: "" })).selected.name, "speaches", "blank is speaches");
});

// @spec EARS-ENG-002, EARS-ENG-003
test("the batch engine is the selected engine when it is batch (the fallback is not used), otherwise ears.stt_fallback_engine (default speaches)", () => {
  const openai = { base_url: "https://api.example.com/v1" };
  assert.equal(buildEngines(cfgOf({ stt_engine: "openai", stt_fallback_engine: "speaches", openai })).batch?.name, "openai");
  assert.equal(buildEngines(cfgOf({ stt_engine: "speaches", stt_fallback_engine: "openai", openai })).batch?.name, "speaches");
  assert.equal(buildEngines(cfgOf({ stt_engine: "stub", stt_fallback_engine: "openai", openai })).batch?.name, "stub");
  const stream = fakeStreaming().engine;
  assert.equal(buildEngines(cfgOf({ stt_engine: "nemotron" }), { streaming: stream }).batch?.name, "speaches", "a blank fallback is speaches");
  assert.equal(buildEngines(cfgOf({ stt_engine: "nemotron", stt_fallback_engine: "openai", openai }), { streaming: stream }).batch?.name, "openai");
  assert.equal(buildEngines(cfgOf({ stt_engine: "nemotron", stt_fallback_engine: "none" }), { streaming: stream }).batch, undefined, "none is no batch engine");
});

// @spec EARS-HEAR-005
test("speaches batch request: multipart POST to <STT_URL>/v1/audio/transcriptions with file, model, language en and response_format json", async () => {
  const stt = fakeStt(() => " hello there ");
  try {
    const e = createBatchEngine("speaches", cfgOf({ stt_model: "Systran/faster-whisper-small" }));
    assert.equal(await e.transcribe(wav()), "hello there");
    const c = stt.calls[0]!;
    assert.match(c.url, /\/v1\/audio\/transcriptions$/);
    assert.deepEqual(c.fields, { model: "Systran/faster-whisper-small", language: "en", response_format: "json" });
    assert.equal(c.ms, 1000, "the clip is sent as the WAV");
    assert.equal(c.auth, undefined);
  } finally { stt.restore(); }
});

// @spec EARS-ENG-006
test("openai batch request: the same fields to <ears.openai.base_url>/audio/transcriptions, a bearer only when the key is non-empty", async () => {
  const stt = fakeStt(() => "hi");
  try {
    const keyed = createBatchEngine("openai", cfgOf({ stt_model: "whisper-1", openai: { base_url: "https://api.example.com/v1", api_key: "sk-test-1" } }));
    assert.equal(await keyed.transcribe(wav()), "hi");
    const open = createBatchEngine("openai", cfgOf({ openai: { base_url: "http://10.0.0.5:9000/v1/", api_key: "" } }));
    await open.transcribe(wav());
    assert.equal(stt.calls[0]!.url, "https://api.example.com/v1/audio/transcriptions");
    assert.deepEqual(stt.calls[0]!.fields, { model: "whisper-1", language: "en", response_format: "json" });
    assert.equal(stt.calls[0]!.auth, "Bearer sk-test-1");
    assert.equal(stt.calls[1]!.url, "http://10.0.0.5:9000/v1/audio/transcriptions", "the trailing slash is dropped");
    assert.equal(stt.calls[1]!.auth, undefined, "no key, no Authorization header");
  } finally { stt.restore(); }
});

// @spec EARS-ENG-007
test("every batch call is bounded by ears.stt_timeout_ms: a server that never answers fails the call at the bound", async () => {
  const stt = fakeStt(() => new Promise<string>(() => {}));
  try {
    for (const name of ["speaches", "openai"] as const) {
      const e = createBatchEngine(name, cfgOf({ stt_timeout_ms: 60, openai: { base_url: "https://api.example.com/v1" } }));
      const t0 = Date.now();
      await assert.rejects(e.transcribe(wav()));
      const took = Date.now() - t0;
      assert.ok(took >= 50 && took < 1000, `${name} gave up after ${took} ms`);
    }
  } finally { stt.restore(); }
});

// @spec EARS-ENG-012, EARS-STUB-001
test("stub batch engine: fixed text carrying the clip's duration, no request to any server whatever the fallback and keys hold", async () => {
  const stt = fakeStt(() => "from a server");
  try {
    const e = buildEngines(cfgOf({ stt_engine: "stub", stt_fallback_engine: "openai", openai: { base_url: "https://api.example.com/v1", api_key: "k" } }));
    assert.equal(await e.batch!.transcribe(wav(1000)), "stub transcript (1000 ms)");
    assert.equal(stt.calls.length, 0);
  } finally { stt.restore(); }
});

// @spec EARS-ENG-012
test("stub selected: live utterances and injected clips are stub transcripts and no engine server is contacted", async () => {
  const stt = fakeStt(() => "from a server");
  const streaming = fakeStreaming();
  await run(stt, cfg({ stt_engine: "stub", stt_fallback_engine: "openai", openai: { base_url: "https://api.example.com/v1", api_key: "k" } }), async (r) => {
    assert.deepEqual(await r.inject("s1"), { id: "s1", ok: true, detail: "stub transcript (1000 ms)" });
    assert.equal(stt.calls.length, 0);
    assert.equal(streaming.stats.opens, 0);
  }, { setup: reg, streaming: streaming.engine });
});

// @spec EARS-ENG-004
test("streaming engine selected: a dir clip and an injected clip go to the batch engine and open no streaming session", async () => {
  const stt = fakeStt(() => "from the batch engine");
  const streaming = fakeStreaming();
  const dir = await mkdtemp(join(tmpdir(), "ears-eng-"));
  try {
    await run(stt, cfg({ sources: ["dir", "discord"], stt_engine: "nemotron", dir: { path: dir, poll_ms: 20 } }), async (r) => {
      await writeFile(join(dir, "a.wav"), wav());
      await waitFor(() => r.heard().length === 1, "dir clip heard");
      assert.equal(r.heard()[0]!.text, "from the batch engine");
      assert.deepEqual(await r.inject("b1"), { id: "b1", ok: true, detail: "from the batch engine" });
      assert.equal(streaming.stats.opens, 0, "no streaming session for a whole clip");
      assert.match(stt.calls[0]!.url, /\/v1\/audio\/transcriptions$/, "the default fallback is speaches");
    }, { setup: reg, streaming: streaming.engine });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-ENG-005
test("streaming engine with no fallback: a dir clip is renamed .failed, an http clip answers 502, an injection answers ok false 'no batch STT engine'", async () => {
  const stt = fakeStt(() => "never");
  const streaming = fakeStreaming();
  const dir = await mkdtemp(join(tmpdir(), "ears-eng-"));
  const port = await freePort();
  try {
    await run(stt, cfg({ sources: ["dir", "http", "discord"], stt_engine: "nemotron", stt_fallback_engine: "none", dir: { path: dir, poll_ms: 20 }, http: { host: "127.0.0.1", port } }), async (r) => {
      await writeFile(join(dir, "a.wav"), wav());
      for (let i = 0; i < 100 && (await oneFile(dir))[0] !== "a.wav.failed"; i++) await sleep(20);
      const res = await fetch(`http://127.0.0.1:${port}/audio`, { method: "POST", body: wav(), headers: { "content-type": "audio/wav" } });
      assert.equal(res.status, 502);
      assert.match(await res.text(), /no batch STT engine/);
      const inj = await r.inject("c1");
      assert.equal(inj.ok, false);
      assert.match(inj.detail ?? "", /no batch STT engine/);
      assert.deepEqual(await oneFile(dir), ["a.wav.failed"]);
      assert.equal(stt.calls.length, 0);
      assert.equal(r.heard().length, 0);
    }, { setup: reg, streaming: streaming.engine });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// @spec EARS-ENG-008
test("an engine key is in no log line, heartbeat detail or inject result, even while the engine fails", async () => {
  const SECRET = "sk-SECRET-key-0123456789";
  const stt = fakeStt(() => { throw new SttStatus(401, "unauthorized"); });
  await run(stt, cfg({ stt_engine: "openai", openai: { base_url: "https://api.example.com/v1", api_key: SECRET } }), async (r) => {
    const res = await r.inject("k1");
    assert.equal(res.ok, false);
    assert.equal(stt.calls[0]!.auth, `Bearer ${SECRET}`, "the key is sent to the engine");
    await sleep(100);
    const seen = JSON.stringify([r.log.lines, r.bus.health, res]);
    assert.ok(!seen.includes(SECRET), "the key appears nowhere ears reports");
  });
});

// @spec EARS-ENG-010
test("a blank engine URL is a gap, not an exit: ears starts, deps.stt is down with 'ears.<engine>.<key> is not set'", async () => {
  const cases: { ears: Record<string, unknown>; streaming?: boolean; detail: string }[] = [
    { ears: { stt_engine: "openai", openai: { base_url: "" } }, detail: "ears.openai.base_url is not set" },
    { ears: { stt_engine: "nemotron", nemotron: { url: "" } }, streaming: true, detail: "ears.nemotron.url is not set" },
    { ears: { stt_engine: "kyutai", kyutai: { url: "" } }, streaming: true, detail: "ears.kyutai.url is not set" },
    { ears: { stt_engine: "nemotron", stt_fallback_engine: "openai", openai: { base_url: "" } }, streaming: true, detail: "ears.openai.base_url is not set" },
  ];
  for (const c of cases) {
    const stt = fakeStt(() => "x");
    const fake = c.streaming ? fakeStreaming({ name: c.ears.stt_engine as "nemotron" | "kyutai" }) : undefined;
    await run(stt, cfg(c.ears), async (r) => {
      await waitFor(() => r.lastHeartbeat()?.deps.stt === "down" && (r.lastHeartbeat()?.detail ?? "").includes(c.detail), `stt down: ${c.detail}`, 4000);
      assert.notEqual(r.lastHeartbeat()?.state, "stopping", "ears did not exit");
    }, { setup: reg, ...(fake ? { streaming: fake.engine } : {}) });
  }
});

// @spec EARS-ENG-011
test("an injected clip answers ok false with the reason when the batch engine's configuration is incomplete; a blank streaming URL alone does not stop whole clips", async () => {
  const stt = fakeStt(() => "x");
  await run(stt, cfg({ stt_engine: "openai", openai: { base_url: "" } }), async (r) => {
    const res = await r.inject("g1");
    assert.equal(res.ok, false);
    assert.match(res.detail ?? "", /ears\.openai\.base_url is not set/);
    assert.equal(stt.calls.length, 0);
  });
  const stt2 = fakeStt(() => "still heard");
  await run(stt2, cfg({ stt_engine: "nemotron", nemotron: { url: "" } }), async (r) => {
    assert.deepEqual(await r.inject("g2"), { id: "g2", ok: true, detail: "still heard" });
  }, { setup: reg, streaming: fakeStreaming().engine });
});
