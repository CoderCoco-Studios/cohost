import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog, testConfig } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { readWavHeader } from "../src/audio.js";
import { Hearing, sttTranscriber } from "../src/hearing.js";

// ---- hearing

const pcmMs = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * 16000) * 2);
/** One connector-source utterance: 16 kHz mono PCM from source `discord` with the speaker id the connector gave. */
const heard = (h: Hearing, pcm: Buffer, speaker: string, id: string) => h.heardClip({ pcm, rate: 16000, channels: 1 }, speaker, "discord", id);
function hearing(transcribe: (wav: Buffer) => Promise<string>) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const wavs: Buffer[] = [];
  const h = new Hearing({ cfg: testConfig({ ears: { min_speech_ms: 400 } }).ears, bus, log: rec.log, transcribe: async (w) => { wavs.push(w); return transcribe(w); } });
  return { h, bus, rec, wavs };
}

// @spec EARS-HEAR-005, EARS-HEAR-006, EARS-HEAR-011
test("hearing: an utterance is downsampled, transcribed and published with its speaker", async () => {
  const { h, bus, wavs } = hearing(async () => "did you see that");
  await heard(h, pcmMs(1000), "Chris", "u1");
  assert.deepEqual(readWavHeader(wavs[0]!), { sampleRate: 16000, channels: 1, dataOffset: 44, dataLength: 32000 });
  const [{ utteranceId, ...rest }] = bus.of("speech.heard") as unknown as [Record<string, unknown>]; // EARS-PART-003
  assert.equal(typeof utteranceId, "string");
  assert.deepEqual(rest, { speaker: "Chris", speakerId: "u1", text: "did you see that", durationMs: 1000, source: "discord" });
});

// @spec EARS-HEAR-004, EARS-HEAR-007
test("hearing: too-short clips skip STT; empty or punctuation-only transcripts are dropped", async () => {
  const { h, bus, wavs } = hearing(async () => "");
  await heard(h, pcmMs(300), "Chris", "u1");
  assert.equal(wavs.length, 0);
  await heard(h, pcmMs(500), "Chris", "u1");
  const dots = hearing(async () => "...");
  await heard(dots.h, pcmMs(500), "Chris", "u1");
  assert.equal(bus.published.length + dots.bus.published.length, 0);
});

// @spec EARS-HEAR-008
test("hearing: an STT failure is a warning, not a crash", async () => {
  const { h, bus, rec } = hearing(async () => { throw new Error("stt 503"); });
  await heard(h, pcmMs(500), "Chris", "u1");
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
