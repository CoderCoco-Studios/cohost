import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testConfig } from "@cohost/testing";
import { ConfigSchema } from "@cohost/config";
import { kokoroRequestSettings, kokoroSynth } from "../src/voice.js";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
const fields = fixture("kokoro-speech-fields.json") as { request: string[]; normalization_options: string[]; bounds: Record<string, number[]>; lang_codes: string[] };

const KNOBS = {
  voice: "af_bella(2)+af_sky", speed: 1.1, lang_code: "b", volume_multiplier: 1.5,
  normalization: { url_normalization: false, remove_emoji: true },
};

test("with no knob set the request is exactly model, voice, speed and wav", () => { // @spec VOICE-SYN-009
  assert.deepEqual(kokoroRequestSettings(testConfig().voice), { model: "kokoro", voice: "af_heart", speed: 1.05, response_format: "wav" });
});

test("set knobs reach the request as the recorded Kokoro-FastAPI body, unset ones stay out", async () => { // @spec VOICE-SYN-009
  let body: unknown;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.end(Buffer.alloc(0));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const saved = process.env.TTS_URL;
  process.env.TTS_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await kokoroSynth(testConfig({ voice: KNOBS }).voice)("hi chat");
    assert.deepEqual(body, fixture("kokoro-speech-request.json"));
    await kokoroSynth(testConfig({ voice: { normalization: {} } }).voice)("hi");
    assert.deepEqual(Object.keys(body as object).sort(), ["input", "model", "response_format", "speed", "voice"]);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.TTS_URL; else process.env.TTS_URL = saved;
  }
});

test("every field the synthesizer can send exists in the pinned Kokoro-FastAPI request schema", () => { // @spec VOICE-SYN-009
  const sent = kokoroRequestSettings(testConfig({ voice: KNOBS }).voice);
  for (const k of [...Object.keys(sent), "input"]) assert.ok(fields.request.includes(k), `${k} is not a Kokoro-FastAPI request field`);
  for (const k of Object.keys(sent.normalization_options as object)) assert.ok(fields.normalization_options.includes(k), k);
  // every normalization key the config accepts is a real one, and the real ones are all accepted
  const accepted = Object.keys((ConfigSchema.shape.voice.shape.normalization as any).removeDefault().shape);
  assert.deepEqual(accepted.sort(), [...fields.normalization_options].sort());
});

const base = () => ({
  cohost: { name: "Coco", streamer: "Chris" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} },
  chat: { twitch: {} }, brain: {}, avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: {}, dashboard: {},
});

test("voice.* knob bounds match the Kokoro-FastAPI schema", () => { // @spec CFG-SCH-029
  const parse = (voice: Record<string, unknown>) => ConfigSchema.safeParse({ ...base(), voice });
  const bad = (voice: Record<string, unknown>) => { const r = parse(voice); return r.success ? null : r.error.issues.map((i) => i.path.join(".")); };
  assert.equal(parse({}).success, true);
  assert.equal(parse({ speed: fields.bounds.speed![0], volume_multiplier: fields.bounds.volume_multiplier![1] }).success, true);
  assert.deepEqual(bad({ speed: 0.2 }), ["voice.speed"]);
  assert.deepEqual(bad({ speed: 4.1 }), ["voice.speed"]);
  assert.deepEqual(bad({ volume_multiplier: -1 }), ["voice.volume_multiplier"]);
  assert.deepEqual(bad({ volume_multiplier: 10.5 }), ["voice.volume_multiplier"]);
  assert.deepEqual(bad({ lang_code: "xx" }), ["voice.lang_code"]);
  for (const c of fields.lang_codes) assert.equal(parse({ lang_code: c }).success, true, c);
  assert.deepEqual(bad({ normalization: { remove_emoji: "yes" } }), ["voice.normalization.remove_emoji"]);
  assert.deepEqual(bad({ voice: "af_heart; drop" }), ["voice.voice"]);
  assert.equal(parse({ voice: "af_bella(2)+af_sky" }).success, true);
  const blank = ConfigSchema.parse({ ...base(), voice: { lang_code: "" } });
  assert.equal(blank.voice.lang_code, undefined);
  assert.equal(blank.voice.speed, 1.05);
});
