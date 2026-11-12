import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { Voice, kokoroSynth } from "../src/voice.js";

const say = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });
const halfSecond = wavWrap(Buffer.alloc(12000 * 2), 24000, 1); // 500 ms of silence @ 24k mono

function setup(synth: (t: string) => Promise<Buffer> = async () => halfSecond) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  return { voice, bus, rec };
}

/** Hand a brain.say to the voice service and wait for its queued synthesis to finish. */
async function sayAndWait(voice: Voice, ev: ReturnType<typeof say>): Promise<void> {
  await voice.onEvent(ev);
  await voice.whenIdle();
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("brain.say → voice.utterance with duration, envelope and a fetchable URL", async () => { // @spec VOICE-UTT-001, VOICE-UTT-002
  const texts: string[] = [];
  const { voice, bus } = setup(async (t) => { texts.push(t); return halfSecond; });
  await sayAndWait(voice, say("u1"));
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

test("virtual sink: unclaimed after 1.5 s, voice times the line itself", async () => { // @spec VOICE-SINK-002, VOICE-SINK-003
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
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

test("virtual sink stands down when a real sink claims the line", async () => { // @spec VOICE-SINK-001, VOICE-SINK-004
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" }));
  await voice.onEvent(event("voice.playing", { id: "u2", sink: "virtual" })); // its own echo claims nothing
  mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bus.types(), ["voice.utterance"]);
});

test("a TTS failure still reports voice.done so the brain moves on", async () => { // @spec VOICE-UTT-003, VOICE-SINK-006
  const { voice, bus, rec } = setup(async () => { throw new Error("tts 500"); });
  await sayAndWait(voice, say("u1"));
  assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "u1", sink: "error" } }]);
  assert.deepEqual(rec.msgs("error"), ["tts failed"]);
  const garbage = setup(async () => Buffer.from("not audio"));
  await sayAndWait(garbage.voice, say("u2"));
  assert.deepEqual(garbage.bus.of("voice.done"), [{ id: "u2", sink: "error" }]);
});

test("HTTP: serves stored audio with CORS, 404s unknown ids, answers /health", async () => { // @spec VOICE-HTTP-002, VOICE-HTTP-003, VOICE-HTTP-004
  mock.timers.reset(); // real timers for the HTTP round-trips
  const { voice } = setup();
  await sayAndWait(voice, say("abc-123"));
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

test("only the newest 50 utterances are kept", async () => { // @spec VOICE-HTTP-001, VOICE-HTTP-003
  mock.timers.reset();
  const { voice } = setup();
  for (let i = 0; i < 51; i++) await sayAndWait(voice, say(`u${i}`));
  const status = (id: string) => {
    let code = 0;
    voice.handle({ method: "GET", url: `/audio/${id}.wav` } as never, { writeHead: (c: number) => { code = c; }, end() {} } as never);
    return code;
  };
  assert.equal(status("u0"), 404);
  assert.equal(status("u1"), 200);
  assert.equal(status("u50"), 200);
});

test("kokoroSynth asks the TTS container for a WAV in the configured voice and speed", async () => { // @spec VOICE-SYN-002, VOICE-SYN-003
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

const flush = () => new Promise((r) => setImmediate(r));
const httpStatus = (voice: Voice, id: string) => {
  let code = 0;
  voice.handle({ method: "GET", url: `/audio/${id}.wav` } as never, { writeHead: (c: number) => { code = c; }, end() {} } as never);
  return code;
};

// @spec VOICE-SINK-008
test("a real sink claiming after the virtual playing cancels the virtual done, leaving only the sink's own", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(200); // the line is mid-playback on the virtual clock
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" })); // a queued sink starts late
  mock.timers.tick(5000);
  await flush();
  assert.deepEqual(bus.of("voice.done"), []); // the sink's own voice.done is the only one the brain will see
});

// @spec VOICE-SINK-008
test("a late claim for one line leaves another line's pending virtual done alone", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("a"));
  await sayAndWait(voice, say("b"));
  mock.timers.tick(1500);
  await flush();
  await voice.onEvent(event("voice.playing", { id: "a", sink: "discord" }));
  mock.timers.tick(500);
  assert.deepEqual(bus.of("voice.done"), [{ id: "b", sink: "virtual" }]);
});

// @spec VOICE-SINK-008
test("a claim after the virtual done has been published changes nothing", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" }));
  mock.timers.tick(5000);
  assert.equal(bus.of("voice.done").length, 1);
});

// @spec VOICE-SINK-009
test("a failed virtual voice.playing or voice.done publish is logged and voice keeps running", async () => {
  const { voice, bus, rec } = setup();
  await sayAndWait(voice, say("u1"));
  bus.fail = (type) => type === "voice.playing" || type === "voice.done";
  const unhandled: unknown[] = [];
  const onRejection = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onRejection);
  try {
    mock.timers.tick(1500);
    await flush();
    mock.timers.tick(500);
    await flush();
    await flush();
  } finally { process.off("unhandledRejection", onRejection); }
  assert.deepEqual(unhandled, []);
  assert.equal(rec.msgs("warn").filter((m) => m === "virtual sink publish failed").length, 2);
  bus.fail = undefined;
  await sayAndWait(voice, say("u2")); // still alive
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["u1", "u2"]);
});

// @spec VOICE-SINK-003
test("the virtual done is timed from when the virtual playing publish resolves, not from when it began", async () => {
  const { voice, bus } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const publish = bus.publish.bind(bus) as (type: never, data: never) => Promise<string>;
  bus.publish = (async (type: never, data: never) => { if ((type as string) === "voice.playing") await gate; return publish(type, data); }) as typeof bus.publish;
  await sayAndWait(voice, say("u1")); // 500 ms line
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(5000); // far longer than the line, while the playing publish is still pending
  await flush();
  assert.deepEqual(bus.of("voice.done"), []);
  release();
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(499);
  assert.deepEqual(bus.of("voice.done"), []);
  mock.timers.tick(1);
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
});

// @spec VOICE-SINK-008
test("a real sink claiming while the virtual playing publish is pending leaves no virtual done", async () => {
  const { voice, bus } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const publish = bus.publish.bind(bus) as (type: never, data: never) => Promise<string>;
  bus.publish = (async (type: never, data: never) => { if ((type as string) === "voice.playing") await gate; return publish(type, data); }) as typeof bus.publish;
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "discord" })); // claims during the publish
  release();
  await flush();
  mock.timers.tick(5000);
  assert.deepEqual(bus.of("voice.done"), []);
});

// @spec VOICE-SINK-005
test("the voice service's own virtual voice.playing echo is not a claim, even for a re-used id", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "virtual" })); // the bus delivers voice's own publish back
  mock.timers.tick(500);
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
  bus.clear();
  await sayAndWait(voice, say("u1")); // the id is re-used
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]); // not suppressed by the echo
});

// @spec VOICE-SINK-007
test("claims are dropped when their audio is evicted, so the claimed set stays bounded", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("old"));
  await voice.onEvent(event("voice.playing", { id: "old", sink: "discord" }));
  for (let i = 0; i < 50; i++) await sayAndWait(voice, say(`n${i}`)); // evicts "old" (store holds 50)
  assert.equal(httpStatus(voice, "old"), 404);
  assert.equal(voice.claimCount, 0); // the evicted line's claim went with its audio
  // a claim for an id that was never synthesized (or already evicted) is not kept
  await voice.onEvent(event("voice.playing", { id: "ghost", sink: "discord" }));
  assert.equal(voice.claimCount, 0);
  // re-using the evicted id starts clean: nothing claims it, so the virtual sink times it
  bus.clear();
  await sayAndWait(voice, say("old"));
  mock.timers.tick(1500);
  await flush();
  assert.ok(bus.of("voice.playing").some((p) => p.id === "old" && p.sink === "virtual"));
});

// @spec VOICE-SYN-004
test("the WAV is stored and fetchable before voice.utterance is published", async () => {
  const { voice, bus } = setup();
  let statusAtPublish = 0;
  const publish = bus.publish.bind(bus);
  bus.publish = (async (type: never, data: never) => {
    if (type === ("voice.utterance" as never)) statusAtPublish = httpStatus(voice, "u1");
    return publish(type, data);
  }) as typeof bus.publish;
  await sayAndWait(voice, say("u1"));
  assert.equal(statusAtPublish, 200);
  assert.equal(bus.of("voice.utterance").length, 1);
});

// @spec VOICE-SYN-005
test("every brain.say is synthesized, whatever its reason, injected or remember fields", async () => {
  const { voice, bus } = setup();
  await voice.onEvent(event("brain.say", { id: "a", text: "operator line", emotion: "neutral", reason: "operator", injected: true, remember: false }));
  await voice.onEvent(event("brain.say", { id: "b", text: "idle chatter", emotion: "neutral", reason: "idle" }));
  await voice.whenIdle();
  assert.deepEqual(bus.of("voice.utterance").map((u) => u.id), ["a", "b"]);
});

// ---- voice.failed (the give-up report)

const failed = (id: string, extra: Record<string, unknown> = {}) => event("voice.failed", { id, sink: "discord", reason: "fetch audio 404", ...extra } as never);

// @spec VOICE-SINK-011
test("a voice.failed inside the claim window: the window runs in full, then the virtual done is published at once with no virtual playing", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  await voice.onEvent(failed("u1"));
  mock.timers.tick(1499);
  await flush();
  assert.deepEqual(bus.published.map((p) => p.type), ["voice.utterance"], "nothing before the window ends");
  mock.timers.tick(1);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), []);
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1, "no second done from the line's duration");
});

// @spec VOICE-SINK-011, VOICE-SINK-004
test("a claim inside the window still wins over a voice.failed: no virtual events at all", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  await voice.onEvent(failed("u1"));
  await voice.onEvent(event("voice.playing", { id: "u1", sink: "dashboard" }));
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(bus.types(), ["voice.utterance"]);
});

// @spec VOICE-SINK-012
test("a voice.failed after the virtual playing cancels the pending virtual done and publishes it at once", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(100);
  await voice.onEvent(failed("u1"));
  await flush();
  assert.deepEqual(bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1, "the cancelled timer does not publish a second done");
});

// @spec VOICE-SINK-012
test("a voice.failed that arrives while the virtual playing publish is pending releases right after that publish", async () => {
  const { voice, bus } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const publish = bus.publish.bind(bus) as (type: never, data: never) => Promise<string>;
  bus.publish = (async (type: never, data: never) => { if ((type as string) === "voice.playing") await gate; return publish(type, data); }) as typeof bus.publish;
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  await voice.onEvent(failed("u1"));
  release();
  await flush();
  assert.deepEqual(bus.types(), ["voice.utterance", "voice.playing", "voice.done"]);
  mock.timers.tick(10_000);
  await flush();
  assert.equal(bus.of("voice.done").length, 1);
});

// @spec VOICE-SINK-013
test("a voice.failed with a fallback, for a claimed id, or for an unknown id changes nothing", async () => {
  // with fallback: the line is virtual-timed exactly as without the report
  const a = setup();
  await sayAndWait(a.voice, say("u1"));
  await a.voice.onEvent(failed("u1", { fallback: { clip: "00-aaaaaaaa.wav", text: "Error: unable to play line." } }));
  mock.timers.tick(1500);
  await flush();
  assert.deepEqual(a.bus.of("voice.playing"), [{ id: "u1", sink: "virtual" }]);
  await a.voice.onEvent(failed("u1", { fallback: { clip: "00-aaaaaaaa.wav", text: "t" } }));
  assert.deepEqual(a.bus.of("voice.done"), [], "the virtual done still waits for the duration");
  mock.timers.tick(500);
  assert.deepEqual(a.bus.of("voice.done"), [{ id: "u1", sink: "virtual" }]);
  // already claimed by a real sink
  const b = setup();
  await sayAndWait(b.voice, say("u2"));
  await b.voice.onEvent(event("voice.playing", { id: "u2", sink: "dashboard" }));
  await b.voice.onEvent(failed("u2"));
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(b.bus.types(), ["voice.utterance"]);
  // an id voice does not hold
  const c = setup();
  await c.voice.onEvent(failed("nope"));
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(c.bus.published, []);
});

// @spec VOICE-SINK-013
test("a voice.failed for an id whose virtual done was already published changes nothing", async () => {
  const { voice, bus } = setup();
  await sayAndWait(voice, say("u1"));
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(500);
  assert.equal(bus.of("voice.done").length, 1);
  await voice.onEvent(failed("u1"));
  await flush();
  assert.equal(bus.of("voice.done").length, 1);
  assert.equal(bus.of("voice.playing").length, 1);
});
