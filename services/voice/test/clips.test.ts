import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipService, clipFingerprint, CLIP_RETRY_INITIAL_MS, CLIP_RETRY_MAX_MS } from "../src/clips.js";
import { TtsError, Voice } from "../src/voice.js";

// ---- helpers

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "voice-clips-")); dirs.push(d); return d; };
afterEach(() => { mock.timers.reset(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A 16-bit mono 24 kHz WAV `ms` long whose bytes depend on `fill`. */
const wav = (fill: number, ms = 300) => {
  const pcm = Buffer.alloc(((24000 * ms) / 1000) * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(fill, i);
  return wavWrap(pcm, 24000, 1);
};
const fillFor = (text: string) => 100 + [...text].reduce((n, c) => n + c.charCodeAt(0), 0);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const settings = { model: "kokoro", voice: "af_heart", speed: 1.05, response_format: "wav" };

/** A fake TTS backend: records every request and how many ran at once. */
function fakeTts(reply: (text: string, call: number) => Buffer | Promise<Buffer> = (t) => wav(fillFor(t))) {
  const s = { calls: [] as string[], inflight: 0, maxInflight: 0 };
  const synth = async (text: string) => {
    s.calls.push(text);
    s.inflight++;
    s.maxInflight = Math.max(s.maxInflight, s.inflight);
    try { return await reply(text, s.calls.length); } finally { s.inflight--; }
  };
  return Object.assign(s, { synth });
}

function service(over: Partial<ConstructorParameters<typeof ClipService>[0]> & { dir?: string } = {}) {
  const rec = recordingLog();
  const tts = fakeTts();
  const dir = over.dir ?? tmp();
  const svc = new ClipService({ dir, lines: ["Line one.", "Line two.", "Line three."], engine: "kokoro", settings, synth: tts.synth, log: rec.log, ...over });
  return { svc, rec, tts, dir };
}

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const setDirs = (dir: string) => (existsSync(join(dir, "sets")) ? readdirSync(join(dir, "sets")) : []);
const tmpEntries = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".tmp-"));
const tick = async (ms: number, svc: ClipService) => { mock.timers.tick(ms); await svc.idle(); };

// ---- fingerprint

test("fingerprint hashes the trimmed phrase list in order, the engine, every TTS setting and a format version", () => { // @spec VOICE-CLIP-001
  const base = { lines: ["a", "b"], engine: "kokoro", settings };
  const fp = clipFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(clipFingerprint({ ...base, lines: ["  a ", "b\n"] }), fp, "phrases are trimmed");
  assert.equal(clipFingerprint({ ...base, settings: { response_format: "wav", speed: 1.05, voice: "af_heart", model: "kokoro" } }), fp, "key order does not matter");
  assert.notEqual(clipFingerprint({ ...base, lines: ["b", "a"] }), fp, "order");
  assert.notEqual(clipFingerprint({ ...base, lines: ["a"] }), fp, "list");
  assert.notEqual(clipFingerprint({ ...base, engine: "other" }), fp, "engine");
  assert.notEqual(clipFingerprint({ ...base, settings: { ...settings, model: "kokoro-2" } }), fp, "model");
  assert.notEqual(clipFingerprint({ ...base, settings: { ...settings, voice: "af_bella" } }), fp, "voice");
  assert.notEqual(clipFingerprint({ ...base, settings: { ...settings, speed: 1 } }), fp, "speed");
  assert.notEqual(clipFingerprint({ ...base, settings: { ...settings, pitch: 2 } }), fp, "a setting added later");
  assert.equal(clipFingerprint({ ...base }), fp, "deterministic");
});

// ---- generation, manifest and swap

test("a fresh store is generated one phrase at a time, in list order, after start, and committed with the manifest fields", async () => { // @spec VOICE-CLIP-003, VOICE-CLIP-009
  const { svc, tts, dir } = service({ lines: ["  First. ", "Second.", "Third."] });
  const started = svc.start();
  await started;
  assert.deepEqual(tts.calls, ["First.", "Second.", "Third."]);
  assert.equal(tts.maxInflight, 1);
  const m = readManifest(dir);
  assert.equal(m.version, 1);
  assert.equal(m.fingerprint, svc.fingerprint);
  assert.equal(typeof m.generatedAt, "number");
  assert.match(m.set, /^sets\/\d+-[0-9a-f]+$/);
  assert.equal(m.clips.length, 3);
  m.clips.forEach((c: Record<string, unknown>, i: number) => {
    const bytes = readFileSync(join(dir, m.set, c.name as string));
    assert.deepEqual(Object.keys(c).sort(), ["bytes", "durationMs", "name", "sha256", "text"]);
    assert.equal(c.name, `${String(i).padStart(2, "0")}-${sha(bytes).slice(0, 8)}.wav`);
    assert.equal(c.text, ["First.", "Second.", "Third."][i]);
    assert.equal(c.durationMs, 300);
    assert.equal(c.bytes, bytes.length);
    assert.equal(c.sha256, sha(bytes));
  });
});

test("start returns before the regeneration finishes and a second start does not run a second regeneration", async () => { // @spec VOICE-CLIP-003
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tts = fakeTts(async (t) => { await gate; return wav(fillFor(t)); });
  const { svc, dir } = service({ synth: tts.synth, lines: ["A.", "B."] });
  const first = svc.start();
  const second = svc.start();
  // start first reads the stored manifest (async fs on the libuv pool), so the first TTS request lands after an
  // unbounded number of event-loop turns: wait for it rather than for a fixed number of ticks.
  await waitFor(() => tts.calls.length > 0, "the first TTS request");
  assert.equal(existsSync(join(dir, "manifest.json")), false, "nothing committed while TTS is busy");
  assert.deepEqual(tts.calls, ["A."], "one request at a time, one regeneration");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(tts.calls, ["A.", "B."]);
});

test("an unchanged fingerprint with a complete store makes no TTS request and leaves the store untouched", async () => { // @spec VOICE-CLIP-002
  const dir = tmp();
  const a = service({ dir });
  await a.svc.start();
  const before = { manifest: readFileSync(join(dir, "manifest.json"), "utf8"), sets: setDirs(dir), mtime: statSync(join(dir, "manifest.json")).mtimeMs };
  const b = service({ dir });
  await b.svc.start();
  assert.deepEqual(b.tts.calls, []);
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before.manifest);
  assert.deepEqual(setDirs(dir), before.sets);
  assert.equal(statSync(join(dir, "manifest.json")).mtimeMs, before.mtime);
  assert.equal(b.svc.manifest()?.fingerprint, a.svc.fingerprint, "the stored set is served");
});

test("a missing or empty clip file makes the store damaged, so voice regenerates", async () => { // @spec VOICE-CLIP-002
  for (const damage of ["missing", "empty"] as const) {
    const dir = tmp();
    await service({ dir }).svc.start();
    const m = readManifest(dir);
    const file = join(dir, m.set, m.clips[1].name);
    if (damage === "missing") rmSync(file); else writeFileSync(file, "");
    const again = service({ dir });
    await again.svc.start();
    assert.equal(again.tts.calls.length, 3, damage);
    assert.notEqual(readManifest(dir).set, m.set);
    for (const c of readManifest(dir).clips) assert.ok(statSync(join(dir, readManifest(dir).set, c.name)).size > 0);
  }
});

test("an unreadable manifest or a changed fingerprint regenerates the whole set", async () => { // @spec VOICE-CLIP-003
  const dir = tmp();
  await service({ dir }).svc.start();
  const changed = service({ dir, lines: ["Line one.", "Different."] });
  await changed.svc.start();
  assert.deepEqual(changed.tts.calls, ["Line one.", "Different."]);
  assert.equal(readManifest(dir).clips.length, 2);
  writeFileSync(join(dir, "manifest.json"), "{ not json");
  const broken = service({ dir });
  await broken.svc.start();
  assert.equal(broken.tts.calls.length, 3);
  assert.equal(readManifest(dir).fingerprint, broken.svc.fingerprint);
});

test("the committed set is replaced whole: the old set is served until the new manifest is renamed in", async () => { // @spec VOICE-CLIP-004
  const dir = tmp();
  await service({ dir, lines: ["Old one.", "Old two."] }).svc.start();
  const oldManifest = readManifest(dir);

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tts = fakeTts(async (t, n) => { if (n === 2) await gate; return wav(fillFor(t)); });
  const { svc } = service({ dir, lines: ["New one.", "New two."], synth: tts.synth });
  const run = svc.start();
  await waitFor(() => tts.calls.length === 2, "the second (gated) TTS request"); // not a fixed sleep: async fs first
  assert.equal(tts.calls.length, 2, "mid-regeneration");
  assert.deepEqual(readManifest(dir), oldManifest, "manifest untouched while the new set is being written");
  assert.deepEqual(setDirs(dir), [oldManifest.set.split("/")[1]], "no new set directory yet");
  assert.equal(svc.manifest()?.clips[0]?.text, "Old one.", "the old set is still served");
  release();
  await run;
  const next = readManifest(dir);
  assert.notEqual(next.set, oldManifest.set);
  assert.deepEqual(next.clips.map((c: { text: string }) => c.text), ["New one.", "New two."]);
  for (const c of next.clips) assert.ok(existsSync(join(dir, next.set, c.name)), "the committed set is complete");
  assert.equal(svc.manifest()?.clips[0]?.text, "New one.");
});

test("two regenerations never share a set directory", async () => { // @spec VOICE-CLIP-004
  const dir = tmp();
  const now = () => 1_700_000_000_000; // same millisecond for both commits
  await service({ dir, lines: ["A."], now }).svc.start();
  const first = readManifest(dir).set;
  await service({ dir, lines: ["B."], now }).svc.start();
  assert.notEqual(readManifest(dir).set, first);
});

test("a regeneration whose store cannot be written is abandoned with a warning and retried like a TTS outage", async () => { // @spec VOICE-CLIP-005
  mock.timers.enable({ apis: ["setTimeout"] });
  const parent = tmp();
  writeFileSync(join(parent, "blocker"), "a file, not a directory");
  const { svc, rec, tts } = service({ dir: join(parent, "blocker", "clips") });
  await svc.start();
  assert.equal(svc.manifest(), undefined);
  assert.ok(rec.msgs("warn").length >= 1);
  const calls = tts.calls.length;
  await tick(CLIP_RETRY_INITIAL_MS, svc);
  assert.ok(tts.calls.length > calls, "retried after 60 s");
  svc.stop();
});

test("a TTS outage (5xx or connection error) abandons the regeneration, keeps the old set, and retries 60 s, 120 s ... capped at 15 min", async () => { // @spec VOICE-CLIP-005
  mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmp();
  await service({ dir, lines: ["Old."] }).svc.start();
  const oldManifestText = readFileSync(join(dir, "manifest.json"), "utf8");

  // The first two phrases succeed, then TTS goes down for good (alternating a 5xx and a connection error).
  const tts = fakeTts(async (t, n) => {
    if (n >= 3) throw n % 2 ? new TtsError(503, "busy") : new TypeError("fetch failed");
    return wav(fillFor(t));
  });
  const { svc, rec } = service({ dir, lines: ["N1.", "N2.", "N3."], synth: tts.synth });
  await svc.start();
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), oldManifestText, "old manifest stays");
  assert.equal(svc.manifest()?.clips[0]?.text, "Old.");
  assert.ok(rec.msgs("warn").length >= 1);
  assert.deepEqual(tmpEntries(dir), [], "the abandoned temporary directory is removed");

  const delays = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
  assert.equal(CLIP_RETRY_INITIAL_MS, 60_000);
  assert.equal(CLIP_RETRY_MAX_MS, 900_000);
  for (const d of delays.slice(0, 4)) {
    const before = tts.calls.length;
    mock.timers.tick(d - 1);
    await svc.idle();
    assert.equal(tts.calls.length, before, `no retry before ${d} ms`);
    await tick(1, svc);
    assert.ok(tts.calls.length > before, `retry at ${d} ms`);
  }
  assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), oldManifestText, "still the old set while TTS is down");
  svc.stop();
});

test("the retry delay stops growing at 15 min and retries end at the first success", async () => { // @spec VOICE-CLIP-005
  mock.timers.enable({ apis: ["setTimeout"] });
  let up = false;
  const tts = fakeTts(async (t) => { if (!up) throw new TtsError(500, "down"); return wav(fillFor(t)); });
  const { svc, dir } = service({ synth: tts.synth, lines: ["Only."] });
  await svc.start();
  for (const d of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]) {
    const before = tts.calls.length;
    mock.timers.tick(d - 1);
    await svc.idle();
    assert.equal(tts.calls.length, before, `not before ${d}`);
    await tick(1, svc);
    assert.equal(tts.calls.length, before + 1, `at ${d}`);
  }
  up = true;
  await tick(900_000, svc);
  assert.equal(readManifest(dir).clips.length, 1);
  const done = tts.calls.length;
  await tick(10 * 900_000, svc);
  assert.equal(tts.calls.length, done, "no more retries after a success");
});

test("stop cancels a pending retry", async () => { // @spec VOICE-CLIP-005
  mock.timers.enable({ apis: ["setTimeout"] });
  const tts = fakeTts(async () => { throw new TtsError(502, "bad gateway"); });
  const { svc } = service({ synth: tts.synth });
  await svc.start();
  const calls = tts.calls.length;
  svc.stop();
  mock.timers.tick(10 * 900_000);
  await svc.idle();
  assert.equal(tts.calls.length, calls);
});

// ---- per-phrase failures

test("an unspeakable phrase (4xx, not a WAV, not 16-bit, under 100 ms) is skipped with a warning naming its index, the rest is committed, and it is not retried", async () => { // @spec VOICE-CLIP-006
  mock.timers.enable({ apis: ["setTimeout"] });
  const eightBit = Buffer.from(wav(1));
  eightBit.writeUInt16LE(8, 34); // bits per sample
  const replies: Record<string, () => Buffer> = {
    ok0: () => wav(11),
    bad4xx: () => { throw new TtsError(422, "unprocessable"); },
    notWav: () => Buffer.from("definitely not audio"),
    eightBit: () => eightBit,
    tooShort: () => wav(5, 99),
    ok5: () => wav(55),
  };
  const lines = Object.keys(replies);
  const tts = fakeTts(async (t) => replies[t]!());
  const { svc, dir, rec } = service({ synth: tts.synth, lines });
  await svc.start();
  const m = readManifest(dir);
  assert.equal(m.fingerprint, svc.fingerprint, "committed under the computed fingerprint");
  assert.deepEqual(m.clips.map((c: { text: string }) => c.text), ["ok0", "ok5"]);
  const warned = JSON.stringify(rec.lines.filter((l) => l.level === "warn").map((l) => l.obj));
  for (const i of [1, 2, 3, 4]) assert.ok(warned.includes(`"index":${i}`), `warning names index ${i}`);
  assert.ok(!warned.includes(`"index":0`) && !warned.includes(`"index":5`));
  const calls = tts.calls.length;
  await tick(60 * 60_000, svc);
  assert.equal(tts.calls.length, calls, "no retry");
  const restarted = service({ dir, lines, synth: tts.synth });
  await restarted.svc.start();
  assert.equal(tts.calls.length, calls, "the next start sees the same fingerprint and does not retry the phrase");
});

test("when every phrase is unspeakable the committed manifest lists no clips", async () => { // @spec VOICE-CLIP-006
  const tts = fakeTts(async () => { throw new TtsError(400, "no"); });
  const { svc, dir } = service({ synth: tts.synth });
  await svc.start();
  const m = readManifest(dir);
  assert.deepEqual(m.clips, []);
  assert.equal(m.fingerprint, svc.fingerprint);
  assert.deepEqual(svc.manifest()?.clips, []);
});

// ---- cleanup

test("after a commit every other set and every temporary directory older than an hour is deleted", async () => { // @spec VOICE-CLIP-007
  const dir = tmp();
  await service({ dir, lines: ["One."] }).svc.start();
  const first = readManifest(dir).set;
  mkdirSync(join(dir, "sets", "stray-set"));
  const old = join(dir, ".tmp-old");
  const fresh = join(dir, ".tmp-fresh");
  mkdirSync(old); writeFileSync(join(old, "00.wav"), "x");
  mkdirSync(fresh);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  await service({ dir, lines: ["Two."] }).svc.start();
  const m = readManifest(dir);
  assert.deepEqual(setDirs(dir), [m.set.split("/")[1]], "only the committed set remains");
  assert.ok(!existsSync(join(dir, first)));
  assert.ok(!existsSync(old), "old temporary directory removed");
  assert.ok(existsSync(fresh), "a temporary directory under an hour old is kept");
});

// ---- stub and empty list

test("an empty phrase list commits a manifest listing no clips and makes no TTS request", async () => { // @spec VOICE-CLIP-010
  const { svc, tts, dir } = service({ lines: [] });
  await svc.start();
  assert.deepEqual(tts.calls, []);
  const m = readManifest(dir);
  assert.deepEqual(m.clips, []);
  assert.equal(m.fingerprint, svc.fingerprint);
  assert.deepEqual(svc.manifest()?.clips, []);
  // Emptying the list after a populated set replaces it.
  const dir2 = tmp();
  await service({ dir: dir2 }).svc.start();
  await service({ dir: dir2, lines: [] }).svc.start();
  assert.deepEqual(readManifest(dir2).clips, []);
});

// ---- routes

async function serve(voice: Voice) {
  const server = http.createServer(voice.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const voiceWith = (clips?: ClipService) => new Voice({ bus: new FakeBus(), log: recordingLog().log, synth: async () => wav(1), publicUrl: "http://voice:8700", clips });

test("GET /fallback/manifest.json is 404 until a set is committed, then serves the manifest without its set field", async () => { // @spec VOICE-CLIP-011
  const { svc, dir } = service();
  const s = await serve(voiceWith(svc));
  try {
    assert.equal((await fetch(`${s.base}/fallback/manifest.json`)).status, 404);
    await svc.start();
    const res = await fetch(`${s.base}/fallback/manifest.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = await res.json() as Record<string, unknown>;
    const disk = readManifest(dir);
    assert.equal("set" in body, false);
    assert.deepEqual(body, { version: disk.version, fingerprint: disk.fingerprint, generatedAt: disk.generatedAt, clips: disk.clips });
  } finally { await s.close(); }
});

test("GET /fallback/<name> serves a listed clip as audio/wav and 404s any other name, including one from a replaced set", async () => { // @spec VOICE-CLIP-012
  const dir = tmp();
  const first = service({ dir, lines: ["Old."] });
  await first.svc.start();
  const oldName = readManifest(dir).clips[0].name as string;
  const next = service({ dir, lines: ["New."] });
  await next.svc.start();
  const m = readManifest(dir);
  const s = await serve(voiceWith(next.svc));
  try {
    const name = m.clips[0].name as string;
    const bytes = readFileSync(join(dir, m.set, name));
    const res = await fetch(`${s.base}/fallback/${name}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    assert.equal((await fetch(`${s.base}/fallback/${oldName}`)).status, 404, "a replaced clip's name");
    assert.equal((await fetch(`${s.base}/fallback/99-deadbeef.wav`)).status, 404);
    assert.equal((await fetch(`${s.base}/fallback/..%2Fmanifest.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/fallback/`)).status, 404);
  } finally { await s.close(); }
});

test("a voice with no clip service (the stub engine) answers 404 on every /fallback/ path and its audio and health routes still work", async () => { // @spec VOICE-CLIP-008
  const s = await serve(voiceWith(undefined));
  try {
    assert.equal((await fetch(`${s.base}/fallback/manifest.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/fallback/00-12345678.wav`)).status, 404);
    assert.equal(await (await fetch(`${s.base}/health`)).text(), "ok");
  } finally { await s.close(); }
});
