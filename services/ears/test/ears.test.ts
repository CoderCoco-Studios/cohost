import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { wavWrap, readWavHeader } from "../src/audio.js";
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

test("playback: a failed fetch is skipped and the queue keeps going", async () => {
  const { p, bus, rec } = playback((url) => url.includes("bad"));
  await p.onIdle(); // nothing queued
  const pending = Promise.all([p.enqueue("bad", "http://voice/bad.wav"), p.enqueue("good", "http://voice/good.wav")]);
  await pending;
  await waitFor(() => bus.of("voice.playing").length === 1);
  assert.deepEqual(bus.of("voice.playing"), [{ id: "good", sink: "discord" }]);
  assert.equal(bus.of("voice.done").length, 0, "the skipped line never played, so no done for it");
  assert.deepEqual(rec.msgs("warn"), ["playback failed"]);
});

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

test("hearing: an utterance is downsampled, transcribed and published with its speaker", async () => {
  const { h, bus, wavs } = hearing(async () => "did you see that");
  await h.heard(pcmMs(1000), "Chris", "u1");
  assert.deepEqual(readWavHeader(wavs[0]!), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 32000 });
  assert.deepEqual(bus.of("speech.heard"), [{ speaker: "Chris", speakerId: "u1", text: "did you see that", durationMs: 1000 }]);
});

test("hearing: too-short clips skip STT; empty or punctuation-only transcripts are dropped", async () => {
  const { h, bus, wavs } = hearing(async () => "");
  await h.heard(pcmMs(300), "Chris", "u1");
  assert.equal(wavs.length, 0);
  await h.heard(pcmMs(500), "Chris", "u1");
  const dots = hearing(async () => "...");
  await dots.h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(bus.published.length + dots.bus.published.length, 0);
});

test("hearing: an STT failure is a warning, not a crash", async () => {
  const { h, bus, rec } = hearing(async () => { throw new Error("stt 503"); });
  await h.heard(pcmMs(500), "Chris", "u1");
  assert.equal(bus.published.length, 0);
  assert.deepEqual(rec.msgs("warn"), ["transcription failed"]);
});

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
