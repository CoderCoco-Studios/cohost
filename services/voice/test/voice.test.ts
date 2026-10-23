import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { wavWrap } from "../../ears/src/audio.js";
import { Voice, kokoroSynth } from "../src/voice.js";

const say = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });
const halfSecond = wavWrap(Buffer.alloc(12000 * 2), 24000, 1); // 500 ms of silence @ 24k mono

function setup(synth: (t: string) => Promise<Buffer> = async () => halfSecond) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  return { voice, bus, rec };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("brain.say → voice.utterance with duration, envelope and a fetchable URL", async () => {
  const texts: string[] = [];
  const { voice, bus } = setup(async (t) => { texts.push(t); return halfSecond; });
  await voice.onEvent(say("u1"));
  assert.deepEqual(texts, ["hello chat"]);
  const [u] = bus.of("voice.utterance");
  assert.equal(u!.id, "u1");
  assert.equal(u!.emotion, "happy");
  assert.equal(u!.gesture, "wave");
  assert.equal(u!.durationMs, 500);
  assert.equal(u!.envelopeHz, 30);
  assert.equal(u!.envelope.length, 15);
  assert.equal(u!.sampleRate, 24000);
  assert.equal(u!.audioUrl, "http://voice:8700/audio/u1.wav");
});

test("virtual sink: unclaimed after 1.5 s, voice times the line itself", async () => {
  const { voice, bus } = setup();
  await voice.onEvent(say("u1"));
  mock.timers.tick(1499);
  assert.equal(bus.of("voice.playing").length, 0);
  mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(499);
  assert.equal(bus.of("voice.done").length, 0);
  mock.timers.tick(1);
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
});

test("virtual sink stands down when a real sink claims the line", async () => {
  const { voice, bus } = setup();
  await voice.onEvent(say("u1"));
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" }));
  await voice.onEvent(event("voice.playing", { id: "u2", sink: "virtual" })); // its own echo claims nothing
  mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bus.types(), ["voice.utterance"]);
});

test("a TTS failure still reports voice.done so the brain moves on", async () => {
  const { voice, bus, rec } = setup(async () => { throw new Error("tts 500"); });
  await voice.onEvent(say("u1"));
  assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "u1", sink: "error" } }]);
  assert.deepEqual(rec.msgs("error"), ["tts failed"]);
  const garbage = setup(async () => Buffer.from("not audio"));
  await garbage.voice.onEvent(say("u2"));
  assert.deepEqual(garbage.bus.of("voice.done"), [{ id: "u2", sink: "error" }]);
});

test("HTTP: serves stored audio with CORS, 404s unknown ids, answers /health", async () => {
  mock.timers.reset(); // real timers for the HTTP round-trips
  const { voice } = setup();
  await voice.onEvent(say("abc-123"));
  const server = http.createServer(voice.handle);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ok = await fetch(`${base}/audio/abc-123.wav`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "audio/wav");
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), halfSecond);
    assert.equal((await fetch(`${base}/audio/nope.wav`)).status, 404);
    assert.equal((await fetch(`${base}/audio/../etc.wav`)).status, 404);
    assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally { server.close(); }
});

test("only the newest 50 utterances are kept", async () => {
  mock.timers.reset();
  const { voice } = setup();
  for (let i = 0; i < 51; i++) await voice.onEvent(say(`u${i}`));
  const status = (id: string) => {
    let code = 0;
    voice.handle({ url: `/audio/${id}.wav` } as never, { writeHead: (c: number) => { code = c; }, end() {} } as never);
    return code;
  };
  assert.equal(status("u0"), 404);
  assert.equal(status("u1"), 200);
  assert.equal(status("u50"), 200);
});

test("kokoroSynth asks the TTS container for a WAV in the configured voice and speed", async () => {
  mock.timers.reset();
  let body: Record<string, unknown> = {};
  let status = 200;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.statusCode = status;
    res.end(status === 200 ? halfSecond : "model not loaded");
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.TTS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const synth = kokoroSynth(testConfig({ voice: { voice: "af_bella", speed: 1.2 } }).voice);
    assert.deepEqual(await synth("hi chat"), halfSecond);
    assert.deepEqual(body, { model: "kokoro", input: "hi chat", voice: "af_bella", speed: 1.2, response_format: "wav" });
    status = 503;
    await assert.rejects(synth("hi"), /tts 503: model not loaded/);
  } finally { server.close(); }
});
