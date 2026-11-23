import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { collect, type Synth, type TtsEngine } from "../src/engine.js";
import { createEngine } from "../src/engines.js";
import { Voice } from "../src/voice.js";
import { fakeServer, pcm, streamedHeader, wavBytes, type FakeServer } from "./tts-helpers.js";

const say = (id: string, text = "hello chat") => event("brain.say", { id, text, emotion: "happy", gesture: "wave" });

function setup(synth: Synth) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const voice = new Voice({ bus, log: rec.log, synth, publicUrl: "http://voice:8700" });
  return { voice, bus, rec };
}

/** The synth the service builds from an engine: its audio taken whole. */
const synthOf = (engine: TtsEngine): Synth => async (text, o) =>
  collect(await engine.synthesize(text, { signal: o?.signal ?? new AbortController().signal, ...(o?.priority ? { priority: o.priority } : {}) }));

const pocketAt = (s: FakeServer) => createEngine(testConfig({ voice: { engine: "pocket", pocket: { url: s.url } } }).voice);
const openaiAt = (s: FakeServer) => createEngine(testConfig({ voice: { engine: "openai", voice: "nova", openai: { base_url: `${s.url}/v1`, model: "m" } } }).voice);

// @spec VOICE-ENG-001
test("a line is synthesized through the one contract: the synth is called with the line's text, line priority and an abort signal", async () => {
  const seen: { text: string; priority?: string; signal?: AbortSignal }[] = [];
  const { voice, bus } = setup(async (text, o) => { seen.push({ text, priority: o?.priority, signal: o?.signal }); return wavBytes(pcm(2400)); });
  await voice.onEvent(say("u1", "good evening"));
  await voice.whenIdle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.text, "good evening");
  assert.equal(seen[0]!.priority, "line");
  assert.ok(seen[0]!.signal instanceof AbortSignal);
  assert.equal(bus.of("voice.utterance").length, 1);
  voice.stop();
});

// @spec VOICE-ENG-014, VOICE-ENG-015
test("a voice.stop for a line being synthesized does not abort its request, which runs to its end and is discarded", async () => {
  let signal!: AbortSignal;
  let discarded!: () => boolean;
  let finish!: () => void;
  const { voice, bus } = setup((_t, o) => new Promise<Buffer>((resolve) => { signal = o!.signal!; discarded = o!.discarded!; finish = () => resolve(wavBytes(pcm(2400))); }));
  await voice.onEvent(say("u1"));
  await waitFor(() => signal !== undefined, "synthesis started");
  await voice.onEvent(event("voice.stop", { ids: ["u1"], reason: "barge-in" } as never));
  assert.equal(signal.aborted, false, "the stop does not abort the request");
  assert.equal(discarded(), true, "the synth is told the line was stopped, so its outcome moves no health");
  finish();
  await voice.whenIdle();
  assert.deepEqual(bus.published, [], "the result is discarded");
});

// @spec VOICE-ENG-015
test("an engine request is aborted when the voice service stops", async () => {
  let signal!: AbortSignal;
  const { voice } = setup((_t, o) => new Promise<Buffer>(() => { signal = o!.signal!; }));
  await voice.onEvent(say("u1"));
  await waitFor(() => signal !== undefined, "synthesis started");
  assert.equal(signal.aborted, false);
  voice.stop();
  assert.equal(signal.aborted, true);
});

// @spec VOICE-ENV-005, VOICE-ENG-003
test("audio an adapter rejects, or audio of zero frames, fails the line on the `tts failed` path with no utterance", async () => {
  const bodies: [string, (res: import("node:http").ServerResponse) => void][] = [
    ["8-bit", (res) => { res.writeHead(200); res.end(wavBytes(Buffer.alloc(100), { bits: 8 })); }],
    ["not a WAV", (res) => { res.writeHead(200); res.end("<html>oops</html>"); }],
    ["zero frames", (res) => { res.writeHead(200); res.end(streamedHeader()); }],
  ];
  for (const [what, answer] of bodies) {
    const s = await fakeServer((_req, res) => answer(res));
    try {
      const { voice, bus, rec } = setup(synthOf(openaiAt(s)));
      await voice.onEvent(say("u1"));
      await voice.whenIdle();
      assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "u1", seq: 0, sink: "error" } }], what);
      assert.deepEqual(rec.msgs("error"), ["tts failed"], what);
    } finally { await s.close(); }
  }
});

// @spec VOICE-ENV-005, VOICE-POC-004, VOICE-POC-005
test("the WAV assembled from an engine's audio is parsed with parseWav: the utterance keeps pocket's 200 ms tail in durationMs and its envelope is not trimmed", async () => {
  const speech = pcm(7200, 20000); // 300 ms, loud
  const s = await fakeServer((_req, res) => { res.writeHead(200); res.write(streamedHeader()); res.write(speech); res.end(Buffer.alloc(4800 * 2)); });
  try {
    const { voice, bus } = setup(synthOf(pocketAt(s)));
    await voice.onEvent(say("u1"));
    await voice.whenIdle();
    const [u] = bus.of("voice.utterance");
    assert.equal(u!.durationMs, 500);
    assert.equal(u!.sampleRate, 24000);
    assert.equal(u!.envelope.length, 15, "one value per 800-frame window over the whole 500 ms");
    assert.ok(u!.envelope.slice(0, 9).every((v: number) => v > 0.9), "speech windows are open");
    assert.ok(u!.envelope.at(-1)! < 0.1, "the mouth is closed at the end, the tail kept");
    voice.stop();
  } finally { await s.close(); }
});
