import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { parseWav, wavWrap } from "@cohost/shared";
import { ClipError, decodeClip } from "../src/capture.js";
import { Hearing } from "../src/hearing.js";

const cfg = (over: Record<string, unknown> = {}) => testConfig({ ears: over }).ears;
const silence = (ms: number, rate = 16000, channels = 1) => Buffer.alloc(Math.round((ms / 1000) * rate) * channels * 2);
const wav = (ms: number, rate = 16000, channels = 1) => wavWrap(silence(ms, rate, channels), rate, channels);

function hearing(text: string | Error, over: Record<string, unknown> = {}) {
  const bus = new FakeBus();
  const seen: Buffer[] = [];
  const h = new Hearing({
    cfg: cfg(over), bus, log: silentLog,
    transcribe: async (w) => { seen.push(w); if (text instanceof Error) throw text; return text; },
  });
  return { bus, h, seen };
}

// @spec EARS-CAP-001
test("heardClip: a clip is resampled to 16 kHz mono, transcribed and published as a live speech.heard", async () => {
  const { bus, h, seen } = hearing("hello world");
  const out = await h.heardClip({ pcm: silence(1000, 48000, 2), rate: 48000, channels: 2 }, "alice");
  assert.deepEqual(out, { heard: true, text: "hello world" });
  const info = parseWav(seen[0]!);
  assert.deepEqual([info.sampleRate, info.channels, Math.round(info.durationMs)], [16000, 1, 1000]);
  assert.deepEqual(bus.published, [{ type: "speech.heard", data: { speaker: "alice", text: "hello world", durationMs: 1000 } }]);
});

// @spec EARS-CAP-001
test("heardClip: too short, no word, drop phrase and STT failure publish nothing and say why", async () => {
  const short = hearing("hello");
  assert.deepEqual(await short.h.heardClip({ pcm: silence(100), rate: 16000, channels: 1 }, "a"), { heard: false, reason: "too-short" });
  assert.equal(short.seen.length, 0, "STT is not called for a clip under ears.min_speech_ms");

  const empty = hearing("...  ");
  assert.deepEqual(await empty.h.heardClip({ pcm: silence(1000), rate: 16000, channels: 1 }, "a"), { heard: false, reason: "empty" });

  const drop = hearing("Thank you.", { drop_phrases: ["thank you"] });
  assert.deepEqual(await drop.h.heardClip({ pcm: silence(1000), rate: 16000, channels: 1 }, "a"), { heard: false, reason: "drop-phrase" });

  const fail = hearing(new Error("stt 500"));
  assert.deepEqual(await fail.h.heardClip({ pcm: silence(1000), rate: 16000, channels: 1 }, "a"), { heard: false, reason: "stt-error" });

  for (const t of [short, empty, drop, fail]) assert.equal(t.bus.published.length, 0);
});

// @spec EARS-CAP-002
test("decodeClip: WAV content types go through parseWav; raw PCM takes rate and channels from the type", () => {
  const w = wav(500, 22050, 2);
  for (const type of ["audio/wav", "audio/x-wav", "audio/wave", "AUDIO/WAV; charset=binary"]) {
    const c = decodeClip(w, type);
    assert.deepEqual([c.rate, c.channels, c.pcm.length], [22050, 2, 22050 * 0.5 * 4], type);
  }
  const raw = silence(1000);
  assert.deepEqual(decodeClip(raw, "audio/L16"), { pcm: raw, rate: 16000, channels: 1 });
  const stereo = decodeClip(silence(1000, 44100, 2), "audio/pcm; rate=44100; channels=2");
  assert.deepEqual([stereo.rate, stereo.channels], [44100, 2]);
});

// @spec EARS-CAP-002
test("decodeClip: other types, 8-bit WAV, garbage, empty bodies and bad PCM parameters are refused", () => {
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ClipError ? e.code : String(e); } return "no error"; };
  assert.equal(code(() => decodeClip(wav(500), "text/plain")), "unsupported-type");
  assert.equal(code(() => decodeClip(wav(500), "")), "unsupported-type");
  assert.equal(code(() => decodeClip(Buffer.from("not a wav at all"), "audio/wav")), "bad-audio");
  const eight = wav(500);
  eight.writeUInt16LE(8, 34);
  assert.equal(code(() => decodeClip(eight, "audio/wav")), "bad-audio");
  assert.equal(code(() => decodeClip(Buffer.alloc(0), "audio/L16")), "bad-audio");
  assert.equal(code(() => decodeClip(silence(100), "audio/L16; rate=0")), "bad-audio");
  assert.equal(code(() => decodeClip(silence(100), "audio/L16; channels=9")), "bad-audio");
});
