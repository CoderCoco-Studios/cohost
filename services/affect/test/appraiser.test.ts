import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { createAppraiser, appraiseRules, type AppraiseInput } from "../src/appraise.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
let answer: unknown;
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/appraise`;

const cfg = ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain: { affect: { module: { kind: "http", url } } },
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});
const input: AppraiseInput = { source: "chat", who: "bob", text: "lol nice", mention: false, valence: 0, arousal: 0 };

test("appraiser http: deltas pass through, clamped to ±0.5", async () => {
  const a = createAppraiser(cfg, log);
  answer = { valence_delta: 0.2, arousal_delta: -0.1 };
  assert.deepEqual(await a.run(input), { valence_delta: 0.2, arousal_delta: -0.1 });
  answer = { valence_delta: 3, arousal_delta: -3 };
  assert.deepEqual(await a.run(input), { valence_delta: 0.5, arousal_delta: -0.5 });
});

test("appraiser http: a missing or non-finite delta falls back to the word lists", async () => {
  const a = createAppraiser(cfg, log);
  for (const bad of [{ valence_delta: 0.1 }, { valence_delta: "0.1", arousal_delta: 0 }, { valence_delta: null, arousal_delta: 0 }, null]) {
    answer = bad;
    assert.deepEqual(await a.run(input), appraiseRules(input), JSON.stringify(bad));
  }
});

test("appraiseRules: question marks add a little arousal; mixed tone nets out negative", () => {
  const base = appraiseRules(input);
  assert.ok(appraiseRules({ ...input, text: "lol nice?" }).arousal_delta > base.arousal_delta);
  const mixed = appraiseRules({ ...input, text: "lol this is trash" });
  assert.ok(Math.abs(mixed.valence_delta - -0.03) < 1e-9);
});
