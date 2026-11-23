import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLog, testConfig, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipService, clipFingerprint } from "../src/clips.js";
import { TtsError, collect, type Synth, type TtsEngine } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { audioOf, fakeServer, pcm, sleep, streamedHeader } from "./tts-helpers.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "voice-clips-engine-")); dirs.push(d); return d; };
afterEach(() => { mock.timers.reset(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const goodWav = (ms = 300) => wavWrap(pcm((24000 * ms) / 1000, 5000), 24000, 1);
const openaiEngine = (over: Record<string, unknown> = {}, voice: Record<string, unknown> = {}) =>
  createEngine(testConfig({ voice: { engine: "openai", voice: "nova", openai: { base_url: "https://speech.example.com/v1", model: "tts-1", ...over }, ...voice } }).voice);
const service = (engine: TtsEngine, synth: Synth, lines = ["One.", "Two.", "Three."]) => {
  const rec = recordingLog();
  const dir = tmp();
  const svc = new ClipService({ dir, lines, engine, synth, log: rec.log });
  return { svc, rec, dir };
};
const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const tick = async (ms: number, svc: ClipService) => { mock.timers.tick(ms); await svc.idle(); };

// @spec VOICE-CLIP-001, VOICE-CLIP-013
test("the clip fingerprint hashes the phrases, the engine name and the engine's own fingerprint() object", () => {
  const engine = openaiEngine();
  const { svc } = service(engine, async () => goodWav());
  assert.equal(svc.fingerprint, clipFingerprint({ lines: ["One.", "Two.", "Three."], engine: "openai", settings: engine.fingerprint() }));
  const other = service(openaiEngine({ model: "tts-2" }), async () => goodWav());
  assert.notEqual(other.svc.fingerprint, svc.fingerprint, "a changed model regenerates the clips");
  const otherUrl = service(openaiEngine({ base_url: "https://elsewhere.example.com/v1" }), async () => goodWav());
  assert.notEqual(otherUrl.svc.fingerprint, svc.fingerprint, "a changed server regenerates the clips");
  const otherVoice = service(openaiEngine({}, { voice: "echo" }), async () => goodWav());
  assert.notEqual(otherVoice.svc.fingerprint, svc.fingerprint, "a changed voice regenerates the clips");
  const kokoro = service(createEngine(testConfig({ voice: { engine: "kokoro" } }).voice), async () => goodWav());
  assert.notEqual(kokoro.svc.fingerprint, svc.fingerprint, "a changed engine regenerates the clips");
});

// @spec VOICE-CLIP-014
test("a changed or rotated credential does not change the fingerprint", () => {
  const a = service(openaiEngine({ api_key: "sk-one" }), async () => goodWav());
  const b = service(openaiEngine({ api_key: "sk-two" }), async () => goodWav());
  assert.equal(a.svc.fingerprint, b.svc.fingerprint);
});

// @spec VOICE-CLIP-015
test("an unset Kokoro knob is not part of the fingerprint; setting it changes it", () => {
  const kokoro = (voice: Record<string, unknown> = {}) => createEngine(testConfig({ voice: { engine: "kokoro", ...voice } }).voice);
  const bare = service(kokoro(), async () => goodWav()).svc.fingerprint;
  assert.equal(service(kokoro({ normalization: {} }), async () => goodWav()).svc.fingerprint, bare);
  assert.notEqual(service(kokoro({ lang_code: "b" }), async () => goodWav()).svc.fingerprint, bare);
});

// @spec VOICE-CLIP-003, VOICE-ENG-011, VOICE-ENG-001
test("clip phrases go through the engine's call and gate, as clip priority, one at a time, beside a live line that never overlaps them", async () => {
  const priorities: (string | undefined)[] = [];
  const s = await fakeServer(async (_req, res, n) => { await sleep(n === 1 ? 80 : 10); res.writeHead(200); res.write(streamedHeader()); res.end(pcm(7200)); });
  try {
    const engine = createEngine(testConfig({ voice: { engine: "pocket", pocket: { url: s.url } } }).voice);
    const synth: Synth = async (text, o) => { priorities.push(o?.priority); return collect(await engine.synthesize(text, { signal: new AbortController().signal, ...(o?.priority ? { priority: o.priority } : {}) })); };
    const { svc, dir } = service(engine, synth, ["a", "b"]);
    const started = svc.start();
    await waitFor(() => s.requests.length === 1, "the first clip phrase is on the wire");
    const line = synth("a live line", { priority: "line" });
    await Promise.all([started, line]);
    assert.equal(s.maxInflight, 1, "pocket takes one request at a time, clips and lines together");
    const texts = s.requests.map((r) => /name="text"\r\n\r\n([^\r]*)/.exec(r.body.toString())?.[1]);
    assert.deepEqual(texts, ["a", "a live line", "b"]);
    assert.deepEqual(priorities, ["clip", "line", "clip"]);
    assert.equal(readManifest(dir).clips.length, 2);
  } finally { await s.close(); }
});

// ---- failures

const emptyAudioError = () => collect(audioOf([])).then(() => new Error("unreachable"), (e: unknown) => e as Error);
const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

// @spec VOICE-CLIP-005, VOICE-CLIP-016, VOICE-ERR-001
test("a 401, 403, 404, 429, 5xx, timeout, connection failure, rejected audio or incomplete configuration is an outage for the phrase: nothing is committed, the phrase is not marked unspeakable, and the regeneration is retried", async () => {
  const failures: Error[] = [
    new TtsError(401, "bad key"), new TtsError(403, "forbidden"), new TtsError(404, "no such model"), new TtsError(429, "slow down"),
    new TtsError(500, "x"), new TtsError(503, "x"), timeout, refused,
    new Error("tts audio: unsupported bit depth 8"), new Error("tts audio: not a WAV file"), new Error("tts not configured: voice.openai.base_url is not set"),
  ];
  for (const err of failures) {
    mock.timers.enable({ apis: ["setTimeout"] });
    let up = false;
    const calls: string[] = [];
    const { svc, rec, dir } = service(openaiEngine(), async (t) => { calls.push(t); if (!up) throw err; return goodWav(); }, ["First.", "Second."]);
    await svc.start();
    assert.equal(existsSync(join(dir, "manifest.json")), false, `${err.message}: nothing committed`);
    assert.ok(rec.msgs("warn").length >= 1, `${err.message}: a warning is logged`);
    assert.deepEqual(calls, ["First."], `${err.message}: the regeneration stops at the failed phrase`);
    up = true;
    await tick(60_000, svc);
    assert.deepEqual(readManifest(dir).clips.map((c: { text: string }) => c.text), ["First.", "Second."], `${err.message}: retried after 60 s, every phrase present`);
    svc.stop();
    mock.timers.reset();
  }
});

// @spec VOICE-CLIP-006, VOICE-ERR-002
test("a 400 or 422 for one phrase, or audio of zero frames, or a clip under 100 ms leaves that phrase out, warns with its index and commits the rest under the computed fingerprint", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const empty = await emptyAudioError();
  const replies: Record<string, () => Buffer> = {
    ok0: () => goodWav(),
    bad400: () => { throw new TtsError(400, "bad text"); },
    bad422: () => { throw new TtsError(422, '{"detail":"unprocessable"}'); },
    zero: () => { throw empty; },
    short: () => goodWav(99),
    ok5: () => goodWav(),
  };
  const lines = Object.keys(replies);
  const calls: string[] = [];
  const { svc, rec, dir } = service(openaiEngine(), async (t) => { calls.push(t); return replies[t]!(); }, lines);
  await svc.start();
  const m = readManifest(dir);
  assert.equal(m.fingerprint, svc.fingerprint);
  assert.deepEqual(m.clips.map((c: { text: string }) => c.text), ["ok0", "ok5"]);
  assert.deepEqual(calls, lines, "every phrase was tried, in list order");
  const warned = JSON.stringify(rec.lines.filter((l) => l.level === "warn").map((l) => l.obj));
  for (const i of [1, 2, 3, 4]) assert.ok(warned.includes(`"index":${i}`), `warning names index ${i}`);
  const done = calls.length;
  await tick(60 * 60_000, svc);
  assert.equal(calls.length, done, "not retried until the fingerprint changes");
});

// @spec VOICE-CLIP-005
test("a phrase that fails with an outage after earlier phrases succeeded abandons the whole set and leaves the committed one as it was", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let outage = false;
  const engine = openaiEngine();
  const a = service(engine, async (t) => { if (outage && t === "Two.") throw new TtsError(429, "rate limited"); return goodWav(); });
  await a.svc.start();
  const before = readFileSync(join(a.dir, "manifest.json"), "utf8");
  outage = true;
  const rec = recordingLog();
  const b = new ClipService({ dir: a.dir, lines: ["One.", "Two.", "Three.", "Four."], engine, synth: async (t) => { if (t === "Two.") throw new TtsError(429, "rate limited"); return goodWav(); }, log: rec.log });
  await b.start();
  assert.equal(readFileSync(join(a.dir, "manifest.json"), "utf8"), before);
  assert.ok(rec.msgs("warn").length >= 1);
  b.stop();
});
