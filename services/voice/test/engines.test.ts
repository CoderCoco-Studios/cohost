import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav } from "@cohost/shared";
import { testConfig, waitFor } from "@cohost/testing";
import { collect, TtsError, type TtsEngine } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { fakeServer, pcm, sendWav, sleep, streamedHeader, wavBytes, type FakeServer } from "./tts-helpers.js";

const voiceCfg = (voice: Record<string, unknown>) => testConfig({ voice }).voice;
const openai = (server: FakeServer, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  createEngine(voiceCfg({ engine: "openai", voice: "nova", openai: { base_url: `${server.url}/v1`, model: "tts-1", ...over }, ...extra }));
const pocket = (server: FakeServer, extra: Record<string, unknown> = {}) => createEngine(voiceCfg({ engine: "pocket", pocket: { url: server.url }, ...extra }));
const opts = (priority?: "line" | "clip") => ({ signal: new AbortController().signal, ...(priority ? { priority } : {}) });
const say = async (e: TtsEngine, text = "hello", priority?: "line" | "clip") => collect(await e.synthesize(text, opts(priority)));
async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[key];
  process.env[key] = value;
  try { return await fn(); } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
}
const streamed = (res: import("node:http").ServerResponse, frames: number) => { res.writeHead(200); res.write(streamedHeader()); res.end(pcm(frames)); };

// ---- kokoro

// @spec VOICE-SYN-002, VOICE-ENG-016, VOICE-ENG-001
test("kokoro: POST JSON to <TTS_URL>/v1/audio/speech, and the audio is read from the body with the shared reader (placeholder sizes included)", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 2400));
  try {
    const wav = await withEnv("TTS_URL", s.url, () => say(createEngine(voiceCfg({ engine: "kokoro" })), "hi chat"));
    const [r] = s.requests;
    assert.equal(r!.method, "POST");
    assert.equal(r!.url, "/v1/audio/speech");
    assert.match(String(r!.headers["content-type"]), /^application\/json/);
    assert.deepEqual(JSON.parse(r!.body.toString()), { model: "kokoro", input: "hi chat", voice: "af_heart", speed: 1.05, response_format: "wav" });
    assert.equal(parseWav(wav).durationMs, 100);
  } finally { await s.close(); }
});

// @spec VOICE-KOK-001
test("kokoro: a blank voice is sent as af_heart", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 100));
  try {
    await withEnv("TTS_URL", s.url, () => say(createEngine(voiceCfg({ engine: "kokoro", voice: "" }))));
    assert.equal(JSON.parse(s.requests[0]!.body.toString()).voice, "af_heart");
  } finally { await s.close(); }
});

// ---- openai

// @spec VOICE-OAI-001, VOICE-ENG-016, VOICE-ENG-001
test("openai: POST JSON {model, input, voice, speed, response_format: wav} to <base_url>/audio/speech", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 480));
  try {
    const wav = await say(openai(s, {}, { speed: 1.2 }), "good evening");
    const [r] = s.requests;
    assert.equal(r!.method, "POST");
    assert.equal(r!.url, "/v1/audio/speech");
    assert.deepEqual(JSON.parse(r!.body.toString()), { model: "tts-1", input: "good evening", voice: "nova", speed: 1.2, response_format: "wav" });
    assert.equal(parseWav(wav).durationMs, 20);
  } finally { await s.close(); }
});

// @spec VOICE-OAI-002
test("openai: Authorization: Bearer <key> is sent only when an api_key is set", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 100));
  try {
    await say(openai(s, { api_key: "sk-test-123" }));
    await say(openai(s, { api_key: "" }));
    assert.equal(s.requests[0]!.headers.authorization, "Bearer sk-test-123");
    assert.equal("authorization" in s.requests[1]!.headers, false);
  } finally { await s.close(); }
});

// @spec VOICE-OAI-003
test("openai: requests go to the host of base_url and the engine names that host as its destination", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 100));
  const other = await fakeServer((_req, res) => streamed(res, 100));
  try {
    const e = openai(s);
    await withEnv("TTS_URL", other.url, () => say(e));
    assert.equal(s.requests.length, 1);
    assert.equal(other.requests.length, 0, "no request to any other address, the Kokoro URL included");
    assert.equal(e.destination, new URL(s.url).host);
  } finally { await s.close(); await other.close(); }
});

// ---- pocket

/** The text and filename-less fields of a multipart/form-data body. */
function fields(body: Buffer, contentType: string): Record<string, string> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  assert.ok(boundary, `multipart boundary in ${contentType}`);
  const out: Record<string, string> = {};
  for (const part of body.toString("utf8").split(`--${boundary![1] ?? boundary![2]}`)) {
    const m = /name="([^"]+)"\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n$/.exec(part);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

// @spec VOICE-POC-001, VOICE-POC-002, VOICE-POC-003, VOICE-ENG-016
test("pocket: POST multipart/form-data with text and voice_url (alba when blank) to <url>/tts, with no voice_wav and no speed", async () => {
  const s = await fakeServer((_req, res) => streamed(res, 100));
  try {
    await say(pocket(s, { voice: "marius", speed: 1.5 }), "hello there");
    await say(pocket(s), "second");
    const [a, b] = s.requests;
    assert.equal(a!.method, "POST");
    assert.equal(a!.url, "/tts");
    assert.match(String(a!.headers["content-type"]), /^multipart\/form-data; boundary=/);
    assert.deepEqual(fields(a!.body, String(a!.headers["content-type"])), { text: "hello there", voice_url: "marius" });
    assert.deepEqual(fields(b!.body, String(b!.headers["content-type"])), { text: "second", voice_url: "alba" });
    assert.ok(!a!.body.toString().includes("voice_wav"));
    assert.ok(!a!.body.toString().includes("speed"));
  } finally { await s.close(); }
});

// @spec VOICE-POC-004
test("pocket: every byte after the header is kept, the appended 200 ms of silence included, so the duration counts it", async () => {
  const speech = pcm(7200, 9000); // 300 ms at 24 kHz
  const tail = Buffer.alloc(4800 * 2); // 200 ms of silence
  const s = await fakeServer((_req, res) => { res.writeHead(200); res.write(streamedHeader()); res.write(speech); res.end(tail); });
  try {
    const wav = await say(pocket(s));
    const info = parseWav(wav);
    assert.equal(info.durationMs, 500);
    assert.deepEqual(wav.subarray(info.dataOffset), Buffer.concat([speech, tail]));
  } finally { await s.close(); }
});

// @spec VOICE-POC-006
test("pocket: a non-2xx answer with a JSON {detail} body raises `tts <status>: <body>` with that body", async () => {
  const body = '{"detail":[{"msg":"text too long"}]}';
  const s = await fakeServer((_req, res) => { res.writeHead(422, { "content-type": "application/json" }); res.end(body); });
  try {
    const err = await say(pocket(s)).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof TtsError);
    assert.equal((err as TtsError).status, 422);
    assert.equal((err as TtsError).message, `tts 422: ${body}`);
  } finally { await s.close(); }
});

// @spec VOICE-HLTH-007
test("pocket: ping is GET /health, true only for a 2xx, false for a failure or a refused connection", async () => {
  let status = 503;
  const s = await fakeServer((_req, res) => { res.writeHead(status); res.end('{"status":"healthy"}'); });
  const e = pocket(s);
  try {
    assert.equal(typeof e.ping, "function");
    assert.equal(await e.ping!(new AbortController().signal), false);
    status = 200;
    assert.equal(await e.ping!(new AbortController().signal), true);
    assert.deepEqual(s.requests.map((r) => `${r.method} ${r.url}`), ["GET /health", "GET /health"]);
  } finally { await s.close(); }
  assert.equal(await e.ping!(new AbortController().signal), false, "refused");
  assert.equal(createEngine(voiceCfg({ engine: "kokoro" })).ping, undefined);
  assert.equal(createEngine(voiceCfg({ engine: "openai", openai: { base_url: "http://x/v1", model: "m" }, voice: "v" })).ping, undefined);
});

// ---- stub

// @spec VOICE-ENG-001
test("stub: zero-filled PCM at voice.sample_rate lasting max(400, 60 ms per character), with no request", async () => {
  const e = createEngine(voiceCfg({ engine: "stub", sample_rate: 16000 }));
  assert.equal(e.name, "stub");
  const short = await collect(await e.synthesize("hi", opts()));
  assert.equal(parseWav(short).sampleRate, 16000);
  assert.equal(parseWav(short).durationMs, 400);
  const long = await collect(await e.synthesize("x".repeat(20), opts()));
  assert.equal(parseWav(long).durationMs, 1200);
  assert.ok(long.subarray(44).every((b) => b === 0));
});

// ---- bounds (real sockets, short real timeouts)

const TIMEOUT = 150;
const timeoutName = (e: unknown) => (e as Error).name;

// @spec VOICE-ENG-006
test("no audio byte within timeout_ms: the request is aborted, its connection is closed and the line fails with a TimeoutError", async () => {
  const s = await fakeServer(() => { /* accepts and never answers */ });
  try {
    const t0 = Date.now();
    const err = await say(openai(s, {}, { timeout_ms: TIMEOUT })).then(() => undefined, (e: unknown) => e);
    assert.equal(timeoutName(err), "TimeoutError");
    assert.ok(Date.now() - t0 < TIMEOUT * 6, "bounded");
    await waitFor(() => s.events.includes("close:1"), "the server sees the connection close");
  } finally { await s.close(); }
});

// @spec VOICE-ENG-009
test("the bytes of the WAV header do not count as audio: a header with no PCM after it still times out", async () => {
  const s = await fakeServer((_req, res) => { res.writeHead(200); res.write(streamedHeader()); /* then silence */ });
  try {
    const err = await say(openai(s, {}, { timeout_ms: TIMEOUT })).then(() => undefined, (e: unknown) => e);
    assert.equal(timeoutName(err), "TimeoutError");
    await waitFor(() => s.events.includes("close:1"), "connection closed");
  } finally { await s.close(); }
});

// @spec VOICE-ENG-007
test("a gap between audio chunks longer than timeout_ms aborts the request and fails the line with a TimeoutError", async () => {
  const s = await fakeServer(async (_req, res) => { res.writeHead(200); res.write(streamedHeader()); res.write(pcm(100)); await sleep(TIMEOUT * 4); res.end(pcm(100)); });
  try {
    const err = await say(openai(s, {}, { timeout_ms: TIMEOUT })).then(() => undefined, (e: unknown) => e);
    assert.equal(timeoutName(err), "TimeoutError");
    await waitFor(() => s.events.includes("close:1"), "connection closed");
  } finally { await s.close(); }
});

// @spec VOICE-ENG-010
test("chunks that keep arriving within timeout_ms are never cut for the response's total length", async () => {
  const gap = Math.round(TIMEOUT / 3);
  const s = await fakeServer(async (_req, res) => {
    res.writeHead(200); res.write(streamedHeader());
    for (let i = 0; i < 12; i++) { res.write(pcm(10)); await sleep(gap); } // far longer in total than timeout_ms
    res.end();
  });
  try {
    const t0 = Date.now();
    const wav = await say(openai(s, {}, { timeout_ms: TIMEOUT }));
    assert.ok(Date.now() - t0 > TIMEOUT * 1.5, "the response outlasted timeout_ms");
    assert.equal(wav.length - 44, 12 * 10 * 2);
  } finally { await s.close(); }
});

// @spec VOICE-ENG-008
test("time spent waiting for the concurrency gate does not count toward timeout_ms", async () => {
  const serverDelay = Math.round(TIMEOUT * 0.7);
  const s = await fakeServer(async (_req, res) => { await sleep(serverDelay); streamed(res, 100); });
  try {
    const e = pocket(s, { timeout_ms: TIMEOUT }); // concurrency 1: the second request waits for the first
    const [a, b] = await Promise.all([say(e, "a"), say(e, "b")]);
    assert.ok(a.length > 44 && b.length > 44);
    assert.equal(s.maxInflight, 1);
  } finally { await s.close(); }
});

// ---- the gate through the engines

// @spec VOICE-ENG-011
test("concurrency: kokoro and openai take two requests at once, pocket one", async () => {
  const answer = async (_req: unknown, res: import("node:http").ServerResponse) => { await sleep(60); streamed(res, 100); };
  const s = await fakeServer(answer);
  try {
    const engines: [TtsEngine, number][] = [
      [createEngine(voiceCfg({ engine: "kokoro" })), 2],
      [openai(s), 2],
      [pocket(s), 1],
    ];
    await withEnv("TTS_URL", s.url, async () => {
      for (const [e, limit] of engines) {
        assert.equal(e.concurrency, limit, `${e.name} declares ${limit}`);
        s.maxInflight = 0;
        await Promise.all([1, 2, 3, 4].map((i) => say(e, `line ${i}`)));
        assert.equal(s.maxInflight, limit, `${e.name} never sends more than ${limit} at once`);
      }
    });
  } finally { await s.close(); }
});

// @spec VOICE-ENG-012
test("a waiting line is sent before a waiting clip phrase", async () => {
  const s = await fakeServer(async (_req, res, n, body) => { await sleep(n === 1 ? 80 : 10); streamed(res, 100); void body; });
  try {
    const e = pocket(s);
    const first = say(e, "first", "clip");
    await waitFor(() => s.requests.length === 1, "the first request");
    const clip = say(e, "a clip phrase", "clip");
    const line = say(e, "a live line", "line");
    await Promise.all([first, clip, line]);
    const texts = s.requests.map((r) => /name="text"\r\n\r\n([^\r]*)/.exec(r.body.toString())?.[1]);
    assert.deepEqual(texts, ["first", "a live line", "a clip phrase"]);
  } finally { await s.close(); }
});

// @spec VOICE-ENG-013
test("a request holds its place until its response has ended", async () => {
  const s = await fakeServer(async (_req, res) => { res.writeHead(200); res.write(streamedHeader()); res.write(pcm(10)); await sleep(120); res.end(pcm(10)); });
  try {
    const e = pocket(s);
    await Promise.all([say(e, "a"), say(e, "b")]);
    assert.deepEqual(s.events.filter((x) => !x.startsWith("close")), ["start:1", "end:1", "start:2", "end:2"], "the second request is not sent before the first response ended");
  } finally { await s.close(); }
});

// @spec VOICE-ENG-006, VOICE-ENG-007, VOICE-ENG-013
test("a request that timed out frees its place once its connection has closed, so the next request is served", async () => {
  const s = await fakeServer(async (_req, res, n) => { if (n === 1) return; /* hangs */ streamed(res, 100); });
  try {
    const e = pocket(s, { timeout_ms: TIMEOUT });
    const first = say(e, "hangs").then(() => undefined, (err: unknown) => err);
    await waitFor(() => s.requests.length === 1, "the first request");
    const second = say(e, "after");
    assert.equal(timeoutName(await first), "TimeoutError");
    assert.ok((await second).length > 44);
    assert.ok(s.events.indexOf("close:1") < s.events.indexOf("start:2"), `connection 1 closed before request 2 was sent: ${s.events.join(" ")}`);
  } finally { await s.close(); }
});

// ---- incomplete configuration

// @spec VOICE-GAP-001
test("openai with a blank base_url, model or voice rejects every synthesis at once, naming the blank key, and sends nothing", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ engine: "openai", voice: "nova", openai: { base_url: "", model: "m" } }, "voice.openai.base_url"],
    [{ engine: "openai", voice: "nova", openai: { base_url: "http://127.0.0.1:1/v1", model: "" } }, "voice.openai.model"],
    [{ engine: "openai", voice: "", openai: { base_url: "http://127.0.0.1:1/v1", model: "m" } }, "voice.voice"],
  ];
  for (const [voice, key] of cases) {
    const e = createEngine(voiceCfg(voice));
    for (const text of ["one", "two"]) {
      const err = await e.synthesize(text, opts()).then(() => undefined, (x: unknown) => x);
      assert.equal((err as Error).message, `tts not configured: ${key} is not set`);
    }
  }
});

// @spec VOICE-GAP-002
test("pocket with a blank url rejects every synthesis at once with `tts not configured: voice.pocket.url is not set`", async () => {
  const e = createEngine(voiceCfg({ engine: "pocket", pocket: { url: "" } }));
  for (const text of ["one", "two"]) {
    const err = await e.synthesize(text, opts()).then(() => undefined, (x: unknown) => x);
    assert.equal((err as Error).message, "tts not configured: voice.pocket.url is not set");
  }
});

// ---- the fingerprint

// @spec VOICE-CLIP-013
test("the fingerprint holds the engine name, server URL, resolved voice, model and every request setting sent, defaults resolved", () => {
  const k = createEngine(voiceCfg({ engine: "kokoro" })).fingerprint();
  assert.equal(k.name, "kokoro");
  assert.equal(k.voice, "af_heart");
  assert.equal(k.model, "kokoro");
  assert.equal(k.speed, 1.05);
  assert.equal(typeof k.url, "string");
  const o = createEngine(voiceCfg({ engine: "openai", voice: "nova", speed: 1.3, openai: { base_url: "https://speech.example.com/v1", model: "tts-1" } })).fingerprint();
  assert.deepEqual({ name: o.name, url: o.url, voice: o.voice, model: o.model, speed: o.speed }, { name: "openai", url: "https://speech.example.com/v1", voice: "nova", model: "tts-1", speed: 1.3 });
  const p = createEngine(voiceCfg({ engine: "pocket", pocket: { url: "http://tts-pocket:8000" } })).fingerprint();
  assert.deepEqual({ name: p.name, url: p.url, voice: p.voice }, { name: "pocket", url: "http://tts-pocket:8000", voice: "alba" });
  assert.equal(JSON.stringify(p).includes("speed"), false, "pocket sends no speed");
  const changed = createEngine(voiceCfg({ engine: "openai", voice: "nova", speed: 1.4, openai: { base_url: "https://speech.example.com/v1", model: "tts-1" } })).fingerprint();
  assert.notDeepEqual(changed, o);
});

// @spec VOICE-CLIP-014
test("no credential is in the fingerprint", () => {
  const o = createEngine(voiceCfg({ engine: "openai", voice: "nova", openai: { base_url: "https://speech.example.com/v1", model: "m", api_key: "sk-very-secret" } })).fingerprint();
  const p = createEngine(voiceCfg({ engine: "pocket", pocket: { url: "http://tts-pocket:8000", hf_token: "hf_very_secret" } })).fingerprint();
  assert.equal(JSON.stringify(o).includes("very-secret"), false);
  assert.equal(JSON.stringify(p).includes("very_secret"), false);
  assert.deepEqual(createEngine(voiceCfg({ engine: "openai", voice: "nova", openai: { base_url: "https://speech.example.com/v1", model: "m", api_key: "another" } })).fingerprint(), o);
});

// @spec VOICE-CLIP-015
test("an unset Kokoro tuning knob is left out of the fingerprint, as it is left out of the request; a set one is in", () => {
  const bare = createEngine(voiceCfg({ engine: "kokoro" })).fingerprint();
  for (const key of ["lang_code", "volume_multiplier", "normalization_options", "normalization"]) assert.equal(key in bare, false, key);
  const tuned = createEngine(voiceCfg({ engine: "kokoro", lang_code: "b", volume_multiplier: 1.5, normalization: { remove_emoji: true } })).fingerprint();
  assert.equal(tuned.lang_code, "b");
  assert.equal(tuned.volume_multiplier, 1.5);
  assert.deepEqual(tuned.normalization_options, { remove_emoji: true });
});

// @spec VOICE-CLIP-014
test("the openai fingerprint carries no user info or credential-named query parameter, and a rotated one does not change it", () => {
  const cfg = (base_url: string) => createEngine(voiceCfg({ engine: "openai", voice: "nova", openai: { base_url, model: "tts-1" } })).fingerprint();
  const clean = cfg("https://speech.example.com/v1");
  const dirty = cfg("https://svc:hunter2@speech.example.com/v1?token=abc&model=x");
  assert.equal(dirty.url, "https://speech.example.com/v1?model=x");
  assert.equal(JSON.stringify(dirty).includes("hunter2"), false);
  assert.equal(JSON.stringify(dirty).includes("abc"), false);
  assert.deepEqual(cfg("https://other:pw@speech.example.com/v1").url, clean.url);
});

// @spec VOICE-ENG-011
test("rejected audio closes its connection before the place is freed: the next request is sent only after that close", async () => {
  const s = await fakeServer((_req, res, n) => {
    if (n === 1) { res.writeHead(200); res.write(wavBytes(Buffer.alloc(0), { bits: 8 })); return; } // a reply that is not 16-bit, left open
    streamed(res, 100);
  });
  try {
    const e = pocket(s);
    const first = await say(e, "bad").then(() => undefined, (err: unknown) => err);
    assert.equal((first as Error).message, "tts audio: unsupported bit depth 8");
    await say(e, "good");
    assert.ok(s.events.indexOf("close:1") >= 0 && s.events.indexOf("close:1") < s.events.indexOf("start:2"), s.events.join(" "));
    assert.equal(s.maxInflight, 1);
  } finally { await s.close(); }
});
