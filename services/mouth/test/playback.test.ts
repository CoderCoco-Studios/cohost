import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { applyGain, wavToDiscordPcm } from "../src/audio.js";
import { ClipCache, type FallbackClip } from "../src/clips.js"; import { ClaimMemory, FallbackLine } from "../src/fallback.js";
import { Playback, httpAudio } from "../src/playback.js";

// ---- playback queue

function playback(fail: (url: string) => boolean = () => false) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const played: number[] = [];
  const fetched: string[] = [];
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0,
    fetchAudio: async (url) => { fetched.push(url); if (fail(url)) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: (pcm) => played.push(pcm.length),
  });
  return { p, bus, rec, played, fetched };
}

// @spec MOUTH-PLAY-002, MOUTH-PLAY-003, MOUTH-PLAY-004
test("playback: plays one utterance at a time, in order, reporting playing and done", async () => {
  const { p, bus, played, fetched } = playback();
  await p.enqueue("a", "http://voice/a.wav");
  await p.enqueue("b", "http://voice/b.wav");
  assert.deepEqual(fetched, ["http://voice/a.wav"], "b waits for a");
  assert.deepEqual(played, [2400 * 2 * 4], "24k mono resampled to 48k stereo");
  assert.deepEqual(bus.published, [{ type: "voice.playing", data: { id: "a", sink: "discord" } }]);
  await p.onIdle();
  assert.deepEqual(bus.published.slice(1), [
    { type: "voice.done", data: { id: "a", sink: "discord" } },
    { type: "voice.playing", data: { id: "b", sink: "discord" } },
  ]);
  await p.onIdle();
  assert.deepEqual(bus.published.at(-1), { type: "voice.done", data: { id: "b", sink: "discord" } });
  await p.onIdle(); // idle with nothing playing: no extra done
  assert.equal(bus.of("voice.done").length, 2);
});

// @spec MOUTH-PLAY-005, MOUTH-PLAY-006
test("playback: a failed fetch is given up: one voice.failed with the error text, no playing or done, then the queue keeps going", async () => {
  const { p, bus, rec } = playback((url) => url.includes("bad"));
  await p.onIdle(); // nothing queued
  await Promise.all([p.enqueue("bad", "http://voice/bad.wav"), p.enqueue("good", "http://voice/good.wav")]);
  await waitFor(() => bus.of("voice.playing").length === 1);
  assert.deepEqual(bus.of("voice.failed"), [{ id: "bad", sink: "discord", reason: "Error: fetch audio 404" }]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "good", sink: "discord" }]);
  assert.equal(bus.of("voice.done").length, 0, "the given-up line never played, so no done for it");
  assert.deepEqual(bus.types(), ["voice.failed", "voice.playing"], "the report precedes the next line");
  assert.deepEqual(rec.msgs("warn"), ["playback failed"]);
});

// @spec MOUTH-PLAY-005, MOUTH-PLAY-006
test("playback: a conversion failure and a player that throws are each given up exactly once", async () => {
  const bus = new FakeBus();
  const rec = recordingLog();
  let mode: "garbage" | "throw" = "garbage";
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0,
    fetchAudio: async () => (mode === "garbage" ? Buffer.from("not a wav") : wavWrap(Buffer.alloc(4800), 24000, 1)),
    play: () => { throw new Error("player exploded"); },
  });
  await p.enqueue("a", "http://voice/a.wav");
  mode = "throw";
  await p.enqueue("b", "http://voice/b.wav");
  assert.deepEqual(bus.published, [
    { type: "voice.failed", data: { id: "a", sink: "discord", reason: "Error: bad wav" } },
    { type: "voice.failed", data: { id: "b", sink: "discord", reason: "Error: player exploded" } },
  ]);
  assert.deepEqual(rec.msgs("warn"), ["playback failed", "playback failed"]);
});

// @spec MOUTH-PLAY-005
test("playback: once the player has the audio the line is not given up, even if announcing it fails", async () => {
  const { p, bus, rec, played } = playback();
  bus.fail = (type) => type === "voice.playing";
  await p.enqueue("a", "http://voice/a.wav");
  assert.equal(played.length, 1);
  assert.deepEqual(bus.of("voice.failed"), []);
  assert.deepEqual(rec.msgs("warn"), ["voice.playing publish failed"]);
  await p.enqueue("b", "http://voice/b.wav");
  assert.equal(played.length, 1, "b still waits for a, which is playing");
  await p.onIdle();
  assert.equal(played.length, 2);
});

// @spec MOUTH-PLAY-006
test("playback: a failed voice.failed publish is logged and the queue continues", async () => {
  const { p, bus, rec } = playback((url) => url.includes("bad"));
  bus.fail = (type) => type === "voice.failed";
  await Promise.all([p.enqueue("bad", "http://voice/bad.wav"), p.enqueue("good", "http://voice/good.wav")]);
  await waitFor(() => bus.of("voice.playing").length === 1);
  assert.deepEqual(rec.msgs("warn"), ["playback failed", "voice.failed publish failed"]);
});

// ---- fallback line in the playback queue

const clip = (text: string, fill = 7): FallbackClip => {
  const body = wavWrap(Buffer.alloc(2400 * 2, fill), 24000, 1);
  return { name: `00-${text.length}.wav`, text, durationMs: 100, bytes: body.length, sha256: "x", wav: body };
};
function withFallback(opts: { clips?: FallbackClip[]; now?: () => number; minIntervalMs?: number; failPlay?: (pcm: Buffer) => boolean } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const played: Buffer[] = [];
  const fetched: string[] = [];
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp1", clips: opts.clips ?? [clip("Error: unable to play line.")] });
  const claims = new ClaimMemory();
  const fallback = new FallbackLine({ cache, claims, sink: "discord", minIntervalMs: opts.minIntervalMs ?? 20_000, now: opts.now, random: () => 0 });
  const p = new Playback({
    bus, log: rec.log, sink: "discord", gainDb: 0, fallback,
    fetchAudio: async (url) => { fetched.push(url); if (url.includes("bad")) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: (pcm) => { if (opts.failPlay?.(pcm)) throw new Error("player exploded"); played.push(pcm); },
  });
  return { p, bus, rec, played, fetched, cache, fallback, claims };
}

// @spec MOUTH-FALL-001, MOUTH-FALL-002, MOUTH-FALL-004, MOUTH-FALL-011
test("fallback: a give-up plays one cached clip converted like an utterance, claims the id, then reports voice.failed with the clip", async () => {
  const c = clip("Error: unable to play line.");
  const { p, bus, played, fetched } = withFallback({ clips: [c] });
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 1);
  assert.deepEqual(played[0], wavToDiscordPcm(c.wav), "converted as in MOUTH-AUD-002");
  assert.deepEqual(fetched, ["http://voice/bad.wav"], "no network request to choose or play the clip");
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "bad", sink: "discord" } },
    { type: "voice.failed", data: { id: "bad", sink: "discord", reason: "Error: fetch audio 404", fallback: { clip: c.name, text: "Error: unable to play line." } } },
  ]);
});

// @spec MOUTH-FALL-003, MOUTH-PLAY-004
test("fallback: the given-up utterance stays current until the player is idle, then voice.done and the next line", async () => {
  const { p, bus, played } = withFallback();
  await p.enqueue("bad", "http://voice/bad.wav");
  await p.enqueue("good", "http://voice/good.wav");
  assert.equal(played.length, 1, "good waits for the fallback clip");
  await p.onIdle();
  assert.deepEqual(bus.published.slice(2), [
    { type: "voice.done", data: { id: "bad", sink: "discord" } },
    { type: "voice.playing", data: { id: "good", sink: "discord" } },
  ]);
  assert.equal(played.length, 2);
});

// @spec MOUTH-FALL-005, MOUTH-PLAY-006
test("fallback: with no clips the give-up is a silent skip, with voice.failed carrying no fallback", async () => {
  const { p, bus, played } = withFallback({ clips: [] });
  await Promise.all([p.enqueue("bad", "http://voice/bad.wav"), p.enqueue("good", "http://voice/good.wav")]);
  await waitFor(() => bus.of("voice.playing").length === 1);
  assert.deepEqual(bus.of("voice.failed"), [{ id: "bad", sink: "discord", reason: "Error: fetch audio 404" }]);
  assert.equal(played.length, 1);
  assert.equal(bus.of("voice.done").length, 0);
});

// @spec MOUTH-FALL-007, MOUTH-PLAY-006
test("fallback: a second give-up within min_interval_ms is silent but still reported", async () => {
  let now = 1_000_000;
  const { p, bus, played } = withFallback({ now: () => now });
  await p.enqueue("bad1", "http://voice/bad1.wav");
  await p.onIdle();
  now += 5_000;
  await p.enqueue("bad2", "http://voice/bad2.wav");
  assert.equal(played.length, 1, "only the first give-up spoke");
  assert.deepEqual(bus.of("voice.failed").map((f) => [f.id, f.fallback !== undefined]), [["bad1", true], ["bad2", false]]);
  now += 15_000;
  await p.enqueue("bad3", "http://voice/bad3.wav");
  assert.equal(played.length, 2, "20 s after the last clip it may speak again");
});

// @spec MOUTH-FALL-009
test("fallback: a line a dashboard sink already claimed gets no fallback", async () => {
  const { p, bus, played, claims } = withFallback();
  claims.seen("bad");
  claims.claim("bad", "dashboard");
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 0);
  assert.deepEqual(bus.types(), ["voice.failed"]);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
});

// @spec MOUTH-FALL-008, MOUTH-FALL-005
test("fallback: a clip that fails conversion means no fallback for this give-up, a warning naming the clip, and it is never picked again", async () => {
  const broken: FallbackClip = { ...clip("Broken."), wav: Buffer.from("not a wav"), name: "00-broken.wav" };
  const { p, bus, rec, played, fallback } = withFallback({ clips: [broken], minIntervalMs: 0 });
  await p.enqueue("bad1", "http://voice/bad1.wav");
  assert.equal(played.length, 0);
  assert.deepEqual(bus.types(), ["voice.failed"]);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
  const warn = rec.lines.find((l) => l.level === "warn" && /fallback clip/.test(l.msg ?? ""));
  assert.match(JSON.stringify(warn), /00-broken\.wav/);
  assert.equal(fallback.eligible().length, 0, "marked bad");
  await p.enqueue("bad2", "http://voice/bad2.wav");
  assert.equal(rec.lines.filter((l) => /fallback clip/.test(l.msg ?? "")).length, 1, "not tried a second time");
});

// @spec MOUTH-FALL-008
test("fallback: a player that throws on the clip means no fallback, marks nothing, and does not start the storm clock", async () => {
  let failing = true;
  const clipPcmLength = wavToDiscordPcm(clip("x").wav).length;
  const { p, bus, played, fallback } = withFallback({ failPlay: (pcm) => failing && pcm.length === clipPcmLength });
  await p.enqueue("bad1", "http://voice/bad1.wav");
  assert.equal(played.length, 0);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
  assert.equal(fallback.eligible().length, 1, "the clip is not marked bad");
  failing = false;
  await p.enqueue("bad2", "http://voice/bad2.wav");
  assert.equal(played.length, 1, "a failed hand-over did not count against the interval");
});

// @spec MOUTH-FALL-001, MOUTH-FALL-002
test("fallback: if announcing the fallback claim fails, the clip still plays and voice.failed still carries it", async () => {
  const { p, bus, rec, played } = withFallback();
  bus.fail = (type) => type === "voice.playing";
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 1);
  assert.ok(bus.of("voice.failed")[0]!.fallback);
  assert.ok(rec.msgs("warn").includes("voice.playing publish failed"));
});

// @spec MOUTH-PLAY-009
test("playback: a failed voice.done publish is logged and the next queued utterance still plays", async () => {
  const { p, bus, rec } = playback();
  bus.fail = (type) => type === "voice.done";
  await p.enqueue("a", "http://voice/a.wav");
  await p.enqueue("b", "http://voice/b.wav");
  await p.onIdle(); // done(a) rejects: must not throw or leave a rejection behind
  assert.deepEqual(rec.msgs("warn"), ["voice.done publish failed"]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "a", sink: "discord" }, { id: "b", sink: "discord" }]);
});

// @spec MOUTH-PLAY-002, MOUTH-PLAY-005
test("httpAudio returns the body, and throws on a non-2xx", async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.url === "/ok.wav" ? 200 : 404; res.end("WAVBYTES"); });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await httpAudio(`${base}/ok.wav`)).toString(), "WAVBYTES");
  await assert.rejects(httpAudio(`${base}/gone.wav`), /fetch audio 404/);
});


// ---- routing: sink names, gain, independent outputs

/** A second output named `sink` over its own player, sharing nothing but the bus. */
function output(sink: string, over: { gainDb?: number; cache?: ClipCache; claims?: ClaimMemory; bus?: FakeBus; fail?: (url: string) => boolean; now?: () => number } = {}) {
  const bus = over.bus ?? new FakeBus();
  const rec = recordingLog();
  const played: Buffer[] = [];
  const cache = over.cache ?? new ClipCache();
  const claims = over.claims ?? new ClaimMemory();
  const fallback = new FallbackLine({ cache, claims, sink, minIntervalMs: 20_000, now: over.now, random: () => 0 });
  const p = new Playback({
    bus, log: rec.log, sink, gainDb: over.gainDb ?? 0, fallback,
    fetchAudio: async (url) => { if (over.fail?.(url)) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800, 3), 24000, 1); },
    play: (pcm) => { played.push(pcm); },
  });
  return { p, bus, rec, played, cache, claims, fallback };
}

// @spec MOUTH-ROUTE-001
test("routing: voice.playing, voice.done and voice.failed carry the output's own sink name", async () => {
  const o = output("speakers", { fail: (url) => url.includes("bad") });
  await o.p.enqueue("a", "http://voice/a.wav");
  await o.p.onIdle();
  await o.p.enqueue("bad", "http://voice/bad.wav");
  assert.deepEqual(o.bus.published, [
    { type: "voice.playing", data: { id: "a", sink: "speakers" } },
    { type: "voice.done", data: { id: "a", sink: "speakers" } },
    { type: "voice.failed", data: { id: "bad", sink: "speakers", reason: "Error: fetch audio 404" } },
  ]);
});

// @spec MOUTH-ROUTE-005
test("applyGain multiplies every sample by 10^(dB/20), rounds, and clamps to the signed 16-bit range", () => {
  const src = Buffer.alloc(8);
  [1000, -1000, 20000, -20000].forEach((v, i) => src.writeInt16LE(v, i * 2));
  const six = applyGain(src, 20 * Math.log10(2));
  assert.deepEqual([0, 1, 2, 3].map((i) => six.readInt16LE(i * 2)), [2000, -2000, 32767, -32768], "x2, clamped at both ends");
  const quiet = applyGain(src, -20);
  assert.deepEqual([0, 1, 2, 3].map((i) => quiet.readInt16LE(i * 2)), [100, -100, 2000, -2000]);
  assert.deepEqual([0, 1, 2, 3].map((i) => src.readInt16LE(i * 2)), [1000, -1000, 20000, -20000], "the input is not modified");
});

// @spec MOUTH-ROUTE-005
test("applyGain at 0 dB returns the same bytes untouched, and keeps the length", () => {
  const src = Buffer.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(applyGain(src, 0), src);
  assert.equal(applyGain(Buffer.alloc(40), 12).length, 40);
});

// @spec MOUTH-ROUTE-005
test("routing: an utterance is converted and then gained before the player gets it; gain 0 is bit-identical to no gain", async () => {
  const src = wavToDiscordPcm(wavWrap(Buffer.alloc(4800, 3), 24000, 1));
  const flat = output("discord");
  await flat.p.enqueue("a", "http://voice/a.wav");
  assert.deepEqual(flat.played[0], src);
  const loud = output("discord", { gainDb: 6 });
  await loud.p.enqueue("a", "http://voice/a.wav");
  assert.deepEqual(loud.played[0], applyGain(src, 6));
  assert.notDeepEqual(loud.played[0], src);
});

// @spec MOUTH-ROUTE-005, MOUTH-FALL-001
test("routing: a fallback clip gets the same output gain as an utterance", async () => {
  const c = clip("Error: unable to play line.");
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp1", clips: [c] });
  const o = output("discord", { cache, gainDb: -6, fail: () => true });
  await o.p.enqueue("bad", "http://voice/bad.wav");
  assert.deepEqual(o.played[0], applyGain(wavToDiscordPcm(c.wav), -6));
});

// @spec MOUTH-ROUTE-004
test("routing: two outputs have independent queues, so a give-up or a stall on one does not delay the other", async () => {
  const bus = new FakeBus();
  const claims = new ClaimMemory();
  const cache = new ClipCache();
  cache.replace({ fingerprint: "fp1", clips: [clip("Oops.")] });
  const a = output("discord", { bus, claims, cache, fail: () => true });
  const b = output("second", { bus, claims, cache });
  await a.p.enqueue("u1", "http://voice/u1.wav"); // gives up and says a fallback clip: a is busy
  await a.p.enqueue("u2", "http://voice/u2.wav"); // queued behind it on a
  await b.p.enqueue("u1", "http://voice/u1.wav"); // b plays at once, whatever a is doing
  assert.equal(a.played.length, 1, "a holds u2 behind its fallback clip");
  assert.equal(b.played.length, 1, "b played u1 immediately");
  assert.deepEqual(bus.published.filter((e) => e.data.sink === "second"), [{ type: "voice.playing", data: { id: "u1", sink: "second" } }]);
  await b.p.onIdle();
  assert.deepEqual(bus.of("voice.done").map((d) => d.sink), ["second"], "only b finished anything");
  await a.p.onIdle();
  assert.equal(a.played.length, 1, "u2 on a failed too (fetch fails), so a plays no new audio: its fallback is inside the storm interval");
});

// @spec MOUTH-PLAY-005
test("playback: a give-up logs 'playback failed' once and the failure text becomes the reason", async () => {
  const o = output("discord", { fail: () => true });
  await o.p.enqueue("bad", "http://voice/bad.wav");
  assert.deepEqual(o.rec.msgs("warn"), ["playback failed"]);
  assert.equal(o.bus.of("voice.failed")[0]!.reason, "Error: fetch audio 404");
});
