import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { createScorer, type ScoreInput } from "../src/scoring.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
let answer: unknown;
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/score`;

const cfg = (salience: Record<string, unknown>) => ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain: { salience },
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});
const ev = (text: string, mention = false) => ({ kind: "chat" as const, who: "bob", text, mention, isMod: false, isSub: false, changed: false });
const input: ScoreInput = { arousal: 0, events: [ev("hey Coco", true), ev("plain")] };

test("scorer rules honour reply_on_mention from config", async () => {
  assert.deepEqual((await createScorer(cfg({}), log).run(input)).scores, [1, 0.15]);
  assert.deepEqual((await createScorer(cfg({ reply_on_mention: false }), log).run(input)).scores, [0.15, 0.15]);
});

test("scorer http: scores are clamped to 0..1", async () => {
  answer = { scores: [7, -2] };
  assert.deepEqual((await createScorer(cfg({ module: { kind: "http", url } }), log).run(input)).scores, [1, 0]);
});

test("scorer http: a wrong-length, non-numeric or missing list falls back to the rules", async () => {
  const s = createScorer(cfg({ module: { kind: "http", url } }), log);
  for (const bad of [{ scores: [0.5] }, { scores: [0.5, "high"] }, { scores: [0.5, null] }, { nope: 1 }, [0.1, 0.2]]) {
    answer = bad;
    assert.deepEqual((await s.run(input)).scores, [1, 0.15], JSON.stringify(bad));
  }
});
