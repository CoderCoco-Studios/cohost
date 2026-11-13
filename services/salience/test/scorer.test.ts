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
  ears: {},
  dashboard: {},
});
const ev = (text: string, mention = false) => ({ kind: "chat" as const, who: "bob", text, mention, isMod: false, isSub: false, changed: false });
const input: ScoreInput = { arousal: 0, events: [ev("hey Coco", true), ev("plain")] };

test("scorer rules honour reply_on_mention from config", async () => { // @spec SAL-SCORE-002
  assert.deepEqual((await createScorer(cfg({}), log).run(input)).scores, [1, 0.15]);
  assert.deepEqual((await createScorer(cfg({ reply_on_mention: false }), log).run(input)).scores, [0.15, 0.15]);
});

test("scorer http: scores are clamped to 0..1", async () => { // @spec SAL-SCORE-004, SAL-SCORE-007
  answer = { scores: [7, -2] };
  assert.deepEqual((await createScorer(cfg({ module: { kind: "http", url } }), log).run(input)).scores, [1, 0]);
});

test("scorer http: a wrong-length, non-numeric or missing list falls back to the rules", async () => { // @spec SAL-SCORE-004, SAL-SCORE-005
  const s = createScorer(cfg({ module: { kind: "http", url } }), log);
  for (const bad of [{ scores: [0.5] }, { scores: [0.5, "high"] }, { scores: [0.5, null] }, { nope: 1 }, [0.1, 0.2]]) {
    answer = bad;
    assert.deepEqual((await s.run(input)).scores, [1, 0.15], JSON.stringify(bad));
  }
});

// ---- kind=llm, against a fake OpenAI-compatible server

let llmBody: { messages?: { role: string; content: string }[]; max_tokens?: number } = {};
const llmServer = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  llmBody = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: '{"scores":[0.9,0.2,0.4]}' } }] }));
});
await new Promise<void>((r) => llmServer.listen(0, r));
after(() => llmServer.close());

test("scorer llm: the prompt names both people, caps tokens, and marks mention, mod and sub", async () => { // @spec SAL-SCORE-008
  const base = (llmServer.address() as { port: number }).port;
  const c = ConfigSchema.parse({
    cohost: { name: "Coco", streamer: "Chris" },
    llm: { provider: "openai", model: "m", embed_model: "e", openai: { base_url: `http://127.0.0.1:${base}/v1`, api_key: "" } },
    vision: { model: "v", obs: {} },
    chat: { twitch: {} },
    brain: { salience: { module: { kind: "llm" } } },
    voice: {},
    avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
    ears: {},
    dashboard: {},
  });
  const events = [
    { ...ev("hey Coco", true), isMod: true },
    { ...ev("subbed!"), isSub: true },
    ev("plain"),
  ];
  const out = await createScorer(c, log).run({ arousal: 0.25, events });
  assert.deepEqual(out.scores, [0.9, 0.2, 0.4], "the model's scores were used");
  const [system, user] = llmBody.messages!;
  assert.match(system!.content, /Coco/);
  assert.match(system!.content, /Chris/);
  assert.equal(llmBody.max_tokens, 120);
  const lines = user!.content.split("\n");
  assert.equal(lines[0], "Current arousal: 0.25");
  assert.equal(lines[1], "1. [chat, mentions co-host, mod] bob: hey Coco");
  assert.equal(lines[2], "2. [chat, sub] bob: subbed!");
  assert.equal(lines[3], "3. [chat] bob: plain");
});
