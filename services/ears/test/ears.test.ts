import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { readWavHeader, wavToDiscordPcm } from "../src/audio.js";
import { ClipCache, FallbackLine, type FallbackClip } from "../src/fallback.js";
import { Playback, httpAudio } from "../src/playback.js";
import { Hearing, sttTranscriber } from "../src/hearing.js";

// ---- playback queue

function playback(fail: (url: string) => boolean = () => false) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const played: number[] = [];
  const fetched: string[] = [];
  const p = new Playback({
    bus, log: rec.log,
    fetchAudio: async (url) => { fetched.push(url); if (fail(url)) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: (pcm) => played.push(pcm.length),
  });
  return { p, bus, rec, played, fetched };
}

// @spec EARS-PLAY-002, EARS-PLAY-003, EARS-PLAY-004
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

// @spec EARS-PLAY-005, EARS-PLAY-006
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

// @spec EARS-PLAY-005, EARS-PLAY-006
test("playback: a conversion failure and a player that throws are each given up exactly once", async () => {
  const bus = new FakeBus();
  const rec = recordingLog();
  let mode: "garbage" | "throw" = "garbage";
  const p = new Playback({
    bus, log: rec.log,
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

// @spec EARS-PLAY-005
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

// @spec EARS-PLAY-006
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
  const fallback = new FallbackLine({ cache, minIntervalMs: opts.minIntervalMs ?? 20_000, now: opts.now, random: () => 0 });
  const p = new Playback({
    bus, log: rec.log, fallback,
    fetchAudio: async (url) => { fetched.push(url); if (url.includes("bad")) throw new Error("fetch audio 404"); return wavWrap(Buffer.alloc(4800), 24000, 1); },
    play: (pcm) => { if (opts.failPlay?.(pcm)) throw new Error("player exploded"); played.push(pcm); },
  });
  return { p, bus, rec, played, fetched, cache, fallback };
}

// @spec EARS-FALL-001, EARS-FALL-002, EARS-FALL-004, EARS-FALL-011
test("fallback: a give-up plays one cached clip converted like an utterance, claims the id, then reports voice.failed with the clip", async () => {
  const c = clip("Error: unable to play line.");
  const { p, bus, played, fetched } = withFallback({ clips: [c] });
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 1);
  assert.deepEqual(played[0], wavToDiscordPcm(c.wav), "converted as in EARS-AUD-002");
  assert.deepEqual(fetched, ["http://voice/bad.wav"], "no network request to choose or play the clip");
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "bad", sink: "discord" } },
    { type: "voice.failed", data: { id: "bad", sink: "discord", reason: "Error: fetch audio 404", fallback: { clip: c.name, text: "Error: unable to play line." } } },
  ]);
});

// @spec EARS-FALL-003, EARS-PLAY-004
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

// @spec EARS-FALL-005, EARS-PLAY-006
test("fallback: with no clips the give-up is a silent skip, with voice.failed carrying no fallback", async () => {
  const { p, bus, played } = withFallback({ clips: [] });
  await Promise.all([p.enqueue("bad", "http://voice/bad.wav"), p.enqueue("good", "http://voice/good.wav")]);
  await waitFor(() => bus.of("voice.playing").length === 1);
  assert.deepEqual(bus.of("voice.failed"), [{ id: "bad", sink: "discord", reason: "Error: fetch audio 404" }]);
  assert.equal(played.length, 1);
  assert.equal(bus.of("voice.done").length, 0);
});

// @spec EARS-FALL-007, EARS-PLAY-006
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

// @spec EARS-FALL-009
test("fallback: a line a dashboard sink already claimed gets no fallback", async () => {
  const { p, bus, played, fallback } = withFallback();
  fallback.seen("bad");
  fallback.claim("bad", "dashboard");
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 0);
  assert.deepEqual(bus.types(), ["voice.failed"]);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
});

// @spec EARS-FALL-008, EARS-FALL-005
test("fallback: a clip that fails conversion means no fallback for this give-up, a warning naming the clip, and it is never picked again", async () => {
  const broken: FallbackClip = { ...clip("Broken."), wav: Buffer.from("not a wav"), name: "00-broken.wav" };
  const { p, bus, rec, played, cache } = withFallback({ clips: [broken], minIntervalMs: 0 });
  await p.enqueue("bad1", "http://voice/bad1.wav");
  assert.equal(played.length, 0);
  assert.deepEqual(bus.types(), ["voice.failed"]);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
  const warn = rec.lines.find((l) => l.level === "warn" && /fallback clip/.test(l.msg ?? ""));
  assert.match(JSON.stringify(warn), /00-broken\.wav/);
  assert.equal(cache.eligible().length, 0, "marked bad");
  await p.enqueue("bad2", "http://voice/bad2.wav");
  assert.equal(rec.lines.filter((l) => /fallback clip/.test(l.msg ?? "")).length, 1, "not tried a second time");
});

// @spec EARS-FALL-008
test("fallback: a player that throws on the clip means no fallback, marks nothing, and does not start the storm clock", async () => {
  let failing = true;
  const clipPcmLength = wavToDiscordPcm(clip("x").wav).length;
  const { p, bus, played, cache } = withFallback({ failPlay: (pcm) => failing && pcm.length === clipPcmLength });
  await p.enqueue("bad1", "http://voice/bad1.wav");
  assert.equal(played.length, 0);
  assert.equal(bus.of("voice.failed")[0]!.fallback, undefined);
  assert.equal(cache.eligible().length, 1, "the clip is not marked bad");
  failing = false;
  await p.enqueue("bad2", "http://voice/bad2.wav");
  assert.equal(played.length, 1, "a failed hand-over did not count against the interval");
});

// @spec EARS-FALL-001, EARS-FALL-002
test("fallback: if announcing the fallback claim fails, the clip still plays and voice.failed still carries it", async () => {
  const { p, bus, rec, played } = withFallback();
  bus.fail = (type) => type === "voice.playing";
  await p.enqueue("bad", "http://voice/bad.wav");
  assert.equal(played.length, 1);
  assert.ok(bus.of("voice.failed")[0]!.fallback);
  assert.ok(rec.msgs("warn").includes("voice.playing publish failed"));
});

// @spec EARS-PLAY-009
test("playback: a failed voice.done publish is logged and the next queued utterance still plays", async () => {
  const { p, bus, rec } = playback();
  bus.fail = (type) => type === "voice.done";
  await p.enqueue("a", "http://voice/a.wav");
  await p.enqueue("b", "http://voice/b.wav");
  await p.onIdle(); // done(a) rejects: must not throw or leave a rejection behind
  assert.deepEqual(rec.msgs("warn"), ["voice.done publish failed"]);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "a", sink: "discord" }, { id: "b", sink: "discord" }]);
});

// @spec EARS-PLAY-002, EARS-PLAY-005
test("httpAudio returns the body, and throws on a non-2xx", async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.url === "/ok.wav" ? 200 : 404; res.end("WAVBYTES"); });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await httpAudio(`${base}/ok.wav`)).toString(), "WAVBYTES");
  await assert.rejects(httpAudio(`${base}/gone.wav`), /fetch audio 404/);
});

// ---- hearing

const pcmMs = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * 48000) * 4);
function hearing(transcribe: (wav: Buffer) => Promise<string>) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const wavs: Buffer[] = [];
  const h = new Hearing({ cfg: testConfig({ ears: { min_speech_ms: 400 } }).ears, bus, log: rec.log, transcribe: async (w) => { wavs.push(w); return transcribe(w); } });
  return { h, bus, rec, wavs };
}

// @spec EARS-HEAR-005, EARS-HEAR-006
test("hearing: an utterance is downsampled, transcribed and published with its speaker", async () => {
  const { h, bus, wavs } = hearing(async () => "did you see that");
  await h.heard(pcmMs(1000), "Chris", "u1");
  assert.deepEqual(readWavHeader(wavs[0]!), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 32000 });
  assert.deepEqual(bus.of("speech.heard"), [{ speaker: "Chris", speakerId: "u1", text: "did you see that", durationMs: 1000 }]);
});

// @spec EARS-HEAR-004, EARS-HEAR-007
test("hearing: too-short clips skip STT; empty or punctuation-only transcripts are dropped", async () => {
  const { h, bus, wavs } = hearing(async () => "");
  await h.heard(pcmMs(300), "Chris", "u1");
  assert.equal(wavs.length, 0);
  await h.heard(pcmMs(500), "Chris", "u1");
  const dots = hearing(async () => "...");
  await dots.h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(bus.published.length + dots.bus.published.length, 0);
});

// @spec EARS-HEAR-008
test("hearing: an STT failure is a warning, not a crash", async () => {
  const { h, bus, rec } = hearing(async () => { throw new Error("stt 503"); });
  await h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(bus.published.length, 0);
  assert.deepEqual(rec.msgs("warn"), ["transcription failed"]);
});

// @spec EARS-HEAR-005
test("sttTranscriber posts the WAV as OpenAI-style multipart form data", async () => {
  let form: FormData | undefined;
  let path: string | undefined;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    path = req.url;
    form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"]! } }).formData();
    res.end(JSON.stringify({ text: "  hello there  " }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  process.env.STT_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const wav = wavWrap(Buffer.alloc(320), 16000, 1);
  assert.equal(await sttTranscriber(testConfig({ ears: { stt_model: "whisper-x" } }).ears)(wav), "hello there");
  assert.equal(path, "/v1/audio/transcriptions");
  assert.equal(form!.get("model"), "whisper-x");
  assert.equal(form!.get("language"), "en");
  const file = form!.get("file") as File;
  assert.equal(file.name, "speech.wav");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
});
