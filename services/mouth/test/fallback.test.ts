import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { CLIP_POLL_MS, ClaimMemory, ClipCache, ClipMirror, FallbackLine, clipDir, refreshClips, startClipSync, type ClipSet, type FallbackClip } from "../src/fallback.js";

// ---- helpers

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "mouth-fallback-"));

/** A valid 16-bit mono WAV, 24 kHz, `ms` long, filled with a recognisable value. */
const wav = (fill = 1000, ms = 100) => {
  const pcm = Buffer.alloc(((24000 * ms) / 1000) * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(fill, i);
  return wavWrap(pcm, 24000, 1);
};

interface Entry { name: string; text: string; durationMs: number; bytes: number; sha256: string }
function entry(i: number, text: string, body: Buffer): Entry {
  const digest = sha(body);
  return { name: `${String(i).padStart(2, "0")}-${digest.slice(0, 8)}.wav`, text, durationMs: 100, bytes: body.length, sha256: digest };
}

/** A voice HTTP server's fallback routes: the manifest (null = 404) and the clip bodies. */
async function fakeVoice() {
  const state = {
    manifest: null as null | { fingerprint: string; clips: Entry[] } | string,
    manifestStatus: 200,
    clips: new Map<string, Buffer>(),
    requests: [] as string[],
    manifestSeenCache: [] as number[],
    onManifest: (() => {}) as () => void,
  };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    state.requests.push(url);
    if (url === "/fallback/manifest.json") {
      state.onManifest();
      if (state.manifest === null) { res.writeHead(404); res.end(); return; }
      res.writeHead(state.manifestStatus, { "content-type": "application/json" });
      res.end(typeof state.manifest === "string" ? state.manifest : JSON.stringify({ version: 1, generatedAt: 1, ...state.manifest }));
      return;
    }
    const m = /^\/fallback\/([\w.-]+)$/.exec(url);
    const body = m && state.clips.get(m[1]!);
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(() => server.close());
  const publish = (fingerprint: string, phrases: [string, Buffer][]) => {
    const clips = phrases.map(([text, body], i) => entry(i, text, body));
    state.clips = new Map(phrases.map(([, body], i) => [clips[i]!.name, body]));
    state.manifest = { fingerprint, clips };
    return clips;
  };
  return { base, state, publish, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const setup = () => {
  const dir = join(tmp(), "mouth", "fallback-clips");
  const rec = recordingLog();
  const cache = new ClipCache();
  const mirror = new ClipMirror(dir);
  return { dir, rec, cache, mirror, deps: (base: string) => ({ baseUrl: base, cache, mirror, log: rec.log }) };
};

const clipOf = (text: string, fill = 1000): FallbackClip => {
  const body = wav(fill);
  return { ...entry(0, text, body), wav: body };
};
const setOf = (fingerprint: string, ...clips: FallbackClip[]): ClipSet => ({ fingerprint, clips });

// ---- refresh

// @spec MOUTH-FALL-015, MOUTH-FALL-012
test("a manifest with a new fingerprint downloads every clip, verifies it, and replaces the memory cache and the disk mirror", async () => {
  const v = await fakeVoice();
  const { dir, cache, deps } = setup();
  v.publish("fp1", [["Error: unable to play line.", wav(1000)], ["Whoops.", wav(2000)]]);
  assert.equal(await refreshClips(deps(v.base)), "replaced");
  assert.equal(cache.fingerprint, "fp1");
  assert.deepEqual(cache.clips.map((c) => c.text), ["Error: unable to play line.", "Whoops."]);
  assert.deepEqual(cache.clips[0]!.wav, v.state.clips.get(cache.clips[0]!.name));
  assert.ok(v.state.requests.every((u) => u.startsWith("/fallback/")), "only voice's fallback routes are used");
  // the mirror holds the manifest and every clip, in mouth' own directory
  assert.deepEqual(readdirSync(dir).sort(), ["manifest.json", ...cache.clips.map((c) => c.name)].sort());
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).fingerprint, "fp1");
  assert.deepEqual(readFileSync(join(dir, cache.clips[1]!.name)), cache.clips[1]!.wav);
});

// @spec MOUTH-FALL-015
test("a manifest whose fingerprint matches the cache downloads nothing", async () => {
  const v = await fakeVoice();
  const { cache, deps } = setup();
  v.publish("fp1", [["One.", wav()]]);
  await refreshClips(deps(v.base));
  v.state.requests.length = 0;
  assert.equal(await refreshClips(deps(v.base)), "unchanged");
  assert.deepEqual(v.state.requests, ["/fallback/manifest.json"]);
  assert.equal(cache.clips.length, 1);
});

// @spec MOUTH-FALL-015, MOUTH-FALL-008
test("a changed fingerprint replaces the whole set, and an output's bad marks reset with it", async () => {
  const v = await fakeVoice();
  const { cache, deps } = setup();
  const fl = new FallbackLine({ cache, claims: new ClaimMemory(), sink: "discord", minIntervalMs: 0 });
  v.publish("fp1", [["One.", wav(1)], ["Two.", wav(2)]]);
  await refreshClips(deps(v.base));
  fl.markBad(cache.clips[0]!);
  assert.equal(fl.eligible().length, 1);
  v.publish("fp2", [["Three.", wav(3)]]);
  assert.equal(await refreshClips(deps(v.base)), "replaced");
  assert.deepEqual(cache.clips.map((c) => c.text), ["Three."]);
  assert.equal(fl.eligible().length, 1);
});

// @spec MOUTH-FALL-016
test("a failed, non-200 or unparseable manifest request keeps the cache unchanged", async () => {
  const v = await fakeVoice();
  const { cache, deps } = setup();
  v.publish("fp1", [["One.", wav()]]);
  await refreshClips(deps(v.base));
  const before = cache.clips;
  v.state.manifest = null; // 404: voice has no set (stub engine, or before its first generation)
  assert.equal(await refreshClips(deps(v.base)), "kept");
  v.state.manifest = { fingerprint: "fp2", clips: [] };
  v.state.manifestStatus = 503;
  assert.equal(await refreshClips(deps(v.base)), "kept");
  v.state.manifestStatus = 200;
  for (const junk of ["not json", "[]", JSON.stringify({ clips: [] }), JSON.stringify({ fingerprint: "x", clips: [{ name: "a" }] }), JSON.stringify({ fingerprint: "x", clips: [{ ...entry(0, "t", wav()), name: "../escape.wav" }] })]) {
    v.state.manifest = junk;
    assert.equal(await refreshClips(deps(v.base)), "kept", junk);
  }
  assert.equal(cache.clips, before);
  assert.equal(cache.fingerprint, "fp1");
  await v.close(); // unreachable
  assert.equal(await refreshClips(deps(v.base)), "kept");
  assert.equal(cache.fingerprint, "fp1");
});

// @spec MOUTH-FALL-016
test("a manifest that lists no clips empties the cache and the mirror", async () => {
  const v = await fakeVoice();
  const { dir, cache, deps } = setup();
  v.publish("fp1", [["One.", wav()]]);
  await refreshClips(deps(v.base));
  v.publish("fp-empty", []);
  assert.equal(await refreshClips(deps(v.base)), "replaced");
  assert.deepEqual(cache.clips, []);
  assert.equal(cache.fingerprint, "fp-empty");
  assert.deepEqual(readdirSync(dir), ["manifest.json"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).clips, []);
});

// @spec MOUTH-FALL-017
test("a failed download or a clip that fails the size, checksum or WAV check abandons the refresh, keeps the old set and retries next time", async () => {
  const v = await fakeVoice();
  const { dir, cache, deps } = setup();
  const good = wav(1000);
  v.publish("fp1", [["One.", good]]);
  await refreshClips(deps(v.base));
  const kept = cache.clips;
  const mirrorBefore = readFileSync(join(dir, "manifest.json"), "utf8");

  const second = wav(2000);
  const eightBit = Buffer.from(wavWrap(Buffer.alloc(200), 24000, 1)); eightBit.writeUInt16LE(8, 34);
  const bad: Record<string, (clips: Entry[]) => void> = {
    "a clip 404s (voice swapped sets mid-download)": (clips) => { v.state.clips.delete(clips[1]!.name); },
    "wrong byte count": (clips) => { v.state.clips.set(clips[1]!.name, Buffer.concat([second, Buffer.alloc(2)])); },
    "wrong checksum": (clips) => { const b = Buffer.from(second); b[b.length - 1] = b[b.length - 1]! ^ 0xff; v.state.clips.set(clips[1]!.name, b); },
    "not a WAV": () => { /* replaced below */ },
    "8-bit WAV": () => { /* replaced below */ },
  };
  for (const [what, tamper] of Object.entries(bad)) {
    let clips: Entry[];
    if (what === "not a WAV") {
      const junk = Buffer.from("this is not a wav file at all");
      clips = v.publish("fp2", [["One.", good], ["Two.", junk]]);
    } else if (what === "8-bit WAV") {
      clips = v.publish("fp2", [["One.", good], ["Two.", eightBit]]);
    } else {
      clips = v.publish("fp2", [["One.", good], ["Two.", second]]);
      tamper(clips);
    }
    assert.equal(await refreshClips(deps(v.base)), "kept", what);
    assert.equal(cache.clips, kept, what);
    assert.equal(cache.fingerprint, "fp1", what);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), mirrorBefore, `${what}: mirror untouched`);
    assert.deepEqual(readdirSync(join(dir, "..")).sort(), ["fallback-clips"], `${what}: no partial download left behind`);
  }
  // the next poll retries and succeeds once voice serves a consistent set
  v.publish("fp2", [["One.", good], ["Two.", second]]);
  assert.equal(await refreshClips(deps(v.base)), "replaced");
  assert.equal(cache.fingerprint, "fp2");
});

// @spec MOUTH-FALL-019
test("a disk mirror that cannot be written still leaves the verified new set in memory, with a warning", async () => {
  const v = await fakeVoice();
  const rec = recordingLog();
  const parent = tmp();
  const blocker = join(parent, "mouth");
  writeFileSync(blocker, "a file where the directory should be");
  const cache = new ClipCache();
  v.publish("fp1", [["One.", wav()]]);
  const out = await refreshClips({ baseUrl: v.base, cache, mirror: new ClipMirror(join(blocker, "fallback-clips")), log: rec.log });
  assert.equal(out, "replaced");
  assert.equal(cache.fingerprint, "fp1");
  assert.equal(cache.clips.length, 1);
  assert.ok(rec.msgs("warn").some((m) => /mirror/.test(m ?? "")), "a warning about the mirror");
});

// ---- mirror load and polling

// @spec MOUTH-FALL-018
test("load reads back a saved set, and reports an unreadable manifest or a missing or damaged clip as an error", async () => {
  const { dir } = setup();
  const mirror = new ClipMirror(dir);
  assert.equal(await mirror.load(), undefined, "no mirror yet is not an error");
  const a = clipOf("One.", 1), b = clipOf("Two.", 2);
  b.name = "01-bbbbbbbb.wav";
  await mirror.save(setOf("fp1", a, b));
  const back = (await mirror.load())!;
  assert.equal(back.fingerprint, "fp1");
  assert.deepEqual(back.clips.map((c) => [c.name, c.text]), [[a.name, "One."], [b.name, "Two."]]);
  assert.deepEqual(back.clips[0]!.wav, a.wav);
  // damaged clip
  writeFileSync(join(dir, b.name), "garbage");
  await assert.rejects(mirror.load());
  // missing clip
  rmSync(join(dir, b.name));
  await assert.rejects(mirror.load());
  // unreadable manifest
  await mirror.save(setOf("fp1", a, b));
  writeFileSync(join(dir, "manifest.json"), "{ not json");
  await assert.rejects(mirror.load());
});

// @spec MOUTH-FALL-018, MOUTH-FALL-014
test("startClipSync loads the mirror before the first manifest request, so a set is playable while voice is down", async () => {
  const v = await fakeVoice();
  const { dir, cache, rec } = setup();
  const mirror = new ClipMirror(dir);
  const a = clipOf("From disk.");
  await mirror.save(setOf("fp-disk", a));
  const seen: number[] = [];
  v.state.onManifest = () => { seen.push(cache.clips.length); };
  const sync = startClipSync({ baseUrl: v.base, cache, mirror, log: rec.log, intervalMs: 60_000 });
  await sync.first;
  sync.stop();
  assert.deepEqual(seen, [1], "the mirrored set was already in memory when voice was first asked");
  assert.equal(cache.clips[0]!.text, "From disk.", "voice answered 404, so the mirrored set stays");
});

// @spec MOUTH-FALL-018
test("a corrupt mirror starts an empty cache with a warning, then refreshes from voice", async () => {
  const v = await fakeVoice();
  const { dir, cache, rec } = setup();
  const mirror = new ClipMirror(dir);
  await mirror.save(setOf("fp-disk", clipOf("From disk.")));
  writeFileSync(join(dir, "manifest.json"), "{ not json");
  v.publish("fp-live", [["Live.", wav()]]);
  const sync = startClipSync({ baseUrl: v.base, cache, mirror, log: rec.log, intervalMs: 60_000 });
  await sync.first;
  sync.stop();
  assert.ok(rec.msgs("warn").some((m) => /mirror/.test(m ?? "")));
  assert.deepEqual(cache.clips.map((c) => c.text), ["Live."]);
});

// @spec MOUTH-FALL-014
test("startClipSync asks for the manifest at startup and then on every interval, until stopped", async () => {
  const v = await fakeVoice();
  const { cache, mirror, rec } = setup();
  const sync = startClipSync({ baseUrl: v.base, cache, mirror, log: rec.log, intervalMs: 20 });
  await waitFor(() => v.state.requests.length >= 3, "three manifest polls");
  assert.ok(v.state.requests.every((u) => u === "/fallback/manifest.json"));
  sync.stop();
  await new Promise((r) => setTimeout(r, 30)); // let an in-flight poll finish
  const n = v.state.requests.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(v.state.requests.length, n, "no polls after stop");
});

// @spec MOUTH-FALL-014
test("the default poll interval is 60 s", () => {
  assert.equal(CLIP_POLL_MS, 60_000);
});

// ---- choosing a clip

type LineOver = { now?: () => number; random?: () => number; minIntervalMs?: number; sink?: string; claims?: ClaimMemory; cache?: ClipCache };
const line = (clips: FallbackClip[], over: LineOver = {}) => {
  const cache = over.cache ?? new ClipCache();
  if (!over.cache) cache.replace(setOf("fp1", ...clips));
  const claims = over.claims ?? new ClaimMemory();
  return { cache, claims, line: new FallbackLine({ cache, claims, sink: over.sink ?? "discord", minIntervalMs: over.minIntervalMs ?? 20_000, now: over.now, random: over.random }) };
};
const named = (text: string, n: number): FallbackClip => ({ ...clipOf(text, n), name: `0${n}-${text}.wav` });

// @spec MOUTH-FALL-005
test("an empty cache, or one where every clip is marked bad, offers no clip", () => {
  assert.equal(line([]).line.pick("u1"), undefined);
  const { cache, line: l } = line([named("a", 1), named("b", 2)]);
  l.markBad(cache.clips[0]!);
  l.markBad(cache.clips[1]!);
  assert.equal(l.pick("u1"), undefined);
});

// @spec MOUTH-FALL-006
test("picks uniformly among eligible clips and never the phrase it last started when another exists", () => {
  const clips = [named("a", 1), named("b", 2), named("c", 3)];
  let r = 0;
  const { line: l } = line(clips, { random: () => r, now: () => 1_000_000, minIntervalMs: 0 });
  r = 0;
  const first = l.pick("u1")!;
  assert.equal(first.text, "a", "random 0 picks the first eligible");
  l.started(first);
  const eligible = new Set<string>();
  for (const x of [0, 0.34, 0.67, 0.99]) { r = x; eligible.add(l.pick("u2")!.text); }
  assert.deepEqual([...eligible].sort(), ["b", "c"], "a is excluded; b and c are both reachable");
  // a lone clip is eligible even though it was the last started
  const solo = line([named("only", 1)], { minIntervalMs: 0 });
  const c = solo.line.pick("u1")!;
  solo.line.started(c);
  assert.equal(solo.line.pick("u2")!.text, "only");
});

// @spec MOUTH-FALL-006, MOUTH-FALL-008
test("clips marked bad are never picked", () => {
  const { cache, line: l } = line([named("a", 1), named("b", 2)], { random: () => 0, minIntervalMs: 0 });
  l.markBad(cache.clips[0]!);
  for (let i = 0; i < 5; i++) assert.equal(l.pick(`u${i}`)!.text, "b");
});

// @spec MOUTH-FALL-007
test("no clip is offered within min_interval_ms of the last one handed to the player", () => {
  let now = 1_000_000;
  const { line: l } = line([named("a", 1), named("b", 2)], { now: () => now });
  const c = l.pick("u1")!;
  assert.ok(c, "nothing has played yet, so the first give-up may speak");
  l.started(c);
  now += 19_999;
  assert.equal(l.pick("u2"), undefined);
  now += 1;
  assert.ok(l.pick("u3"), "at exactly the interval it may speak again");
});

// @spec MOUTH-FALL-007
test("a clip that was picked but never handed to the player does not start the storm clock", () => {
  const now = 1_000_000;
  const { line: l } = line([named("a", 1)], { now: () => now });
  assert.ok(l.pick("u1"));
  assert.ok(l.pick("u2"), "pick alone does not count; started() does");
});

// @spec MOUTH-FALL-009, MOUTH-FALL-010
test("a line a real sink other than the giving-up output's own has claimed gets no fallback; its own, virtual and error claims do not count", () => {
  const { line: l, claims } = line([named("a", 1)], { minIntervalMs: 0 });
  claims.seen("u1"); claims.claim("u1", "dashboard");
  claims.seen("u2"); claims.claim("u2", "discord");
  claims.seen("u3"); claims.claim("u3", "virtual");
  claims.seen("u4"); claims.claim("u4", "error");
  assert.equal(l.pick("u1"), undefined);
  assert.ok(l.pick("u2"));
  assert.ok(l.pick("u3"));
  assert.ok(l.pick("u4"));
  assert.ok(l.pick("never-seen"));
});

// @spec MOUTH-FALL-009, MOUTH-ROUTE-004
test("another mouth output's claim counts as a real sink, and an output's own name is its own", () => {
  const cache = new ClipCache();
  cache.replace(setOf("fp1", named("a", 1)));
  const claims = new ClaimMemory();
  const a = line([], { cache, claims, sink: "discord", minIntervalMs: 0 }).line;
  const b = line([], { cache, claims, sink: "other", minIntervalMs: 0 }).line;
  claims.seen("u1"); claims.claim("u1", "other");
  assert.equal(a.pick("u1"), undefined, "discord gives up after other already claimed the line");
  assert.ok(b.pick("u1"), "other's own claim does not stop other's fallback");
});

// @spec MOUTH-FALL-010
test("only the newest 50 utterance ids are remembered", () => {
  const { line: l, claims } = line([named("a", 1)], { minIntervalMs: 0 });
  claims.seen("old"); claims.claim("old", "dashboard");
  for (let i = 0; i < 50; i++) claims.seen(`n${i}`);
  assert.ok(l.pick("old"), "the 51st id pushed the oldest out");
  claims.seen("n0"); claims.claim("n0", "dashboard"); // still among the newest 50
  assert.equal(l.pick("n0"), undefined);
});

// @spec MOUTH-FALL-010
test("a claim for an id mouth never saw an utterance for is still remembered", () => {
  const { line: l, claims } = line([named("a", 1)], { minIntervalMs: 0 });
  claims.claim("early", "dashboard");
  assert.equal(l.pick("early"), undefined);
});

// @spec MOUTH-ROUTE-004, MOUTH-FALL-007, MOUTH-FALL-006
test("each output has its own storm clock and last phrase: one output speaking does not silence or steer another", () => {
  const now = 1_000_000;
  const cache = new ClipCache();
  cache.replace(setOf("fp1", named("a", 1), named("b", 2)));
  const claims = new ClaimMemory();
  const a = line([], { cache, claims, sink: "discord", now: () => now, random: () => 0 }).line;
  const b = line([], { cache, claims, sink: "other", now: () => now, random: () => 0 }).line;
  const first = a.pick("u1")!;
  assert.equal(first.text, "a");
  a.started(first);
  assert.equal(a.pick("u2"), undefined, "discord is inside its own interval");
  assert.equal(b.pick("u2")!.text, "a", "other has not spoken: no storm limit and no last phrase to avoid");
});

// @spec MOUTH-ROUTE-004, MOUTH-FALL-008
test("each output has its own bad-clip marks over the shared cache", () => {
  const cache = new ClipCache();
  cache.replace(setOf("fp1", named("a", 1), named("b", 2)));
  const claims = new ClaimMemory();
  const a = line([], { cache, claims, sink: "discord", minIntervalMs: 0, random: () => 0 }).line;
  const b = line([], { cache, claims, sink: "other", minIntervalMs: 0, random: () => 0 }).line;
  a.markBad(cache.clips[0]!);
  assert.equal(a.pick("u1")!.text, "b");
  assert.equal(b.pick("u1")!.text, "a", "other never marked a bad");
});

// @spec MOUTH-FALL-012
test("the clip mirror directory is <data dir>/mouth/fallback-clips", () => {
  assert.equal(clipDir("/data"), join("/data", "mouth", "fallback-clips"));
});

// ---- cache housekeeping

// @spec MOUTH-FALL-008
test("bad marks are kept while the fingerprint is unchanged and cleared when it changes", () => {
  const cache = new ClipCache();
  cache.replace(setOf("fp1", named("a", 1)));
  const { line: l } = line([], { cache });
  l.markBad(cache.clips[0]!);
  cache.replace(setOf("fp1", named("a", 1)));
  assert.equal(l.eligible().length, 0);
  cache.replace(setOf("fp2", named("a", 1)));
  assert.equal(l.eligible().length, 1);
});

test("the mirror directory is only ever swapped by rename: no temporary leftovers after a save", async () => {
  const { dir } = setup();
  const mirror = new ClipMirror(dir);
  await mirror.save(setOf("fp1", clipOf("One.")));
  await mirror.save(setOf("fp2", clipOf("Two.", 5)));
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).fingerprint, "fp2");
  assert.deepEqual(readdirSync(join(dir, "..")), ["fallback-clips"]);
  assert.equal(existsSync(join(dir, "manifest.json")), true);
});
