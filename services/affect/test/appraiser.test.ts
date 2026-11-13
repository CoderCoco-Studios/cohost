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
  ears: {},
  dashboard: {},
});
const input: AppraiseInput = { source: "chat", who: "bob", text: "lol nice", mention: false, valence: 0, arousal: 0 };

test("appraiser http: deltas pass through, clamped to ±0.5", async () => { // @spec AFF-HOOK-001, AFF-HOOK-002
  const a = createAppraiser(cfg, log);
  answer = { valence_delta: 0.2, arousal_delta: -0.1 };
  assert.deepEqual(await a.run(input), { valence_delta: 0.2, arousal_delta: -0.1 });
  answer = { valence_delta: 3, arousal_delta: -3 };
  assert.deepEqual(await a.run(input), { valence_delta: 0.5, arousal_delta: -0.5 });
});

test("appraiser http: a missing or non-finite delta falls back to the word lists", async () => { // @spec AFF-HOOK-003
  const a = createAppraiser(cfg, log);
  for (const bad of [{ valence_delta: 0.1 }, { valence_delta: "0.1", arousal_delta: 0 }, { valence_delta: null, arousal_delta: 0 }, null]) {
    answer = bad;
    assert.deepEqual(await a.run(input), appraiseRules(input), JSON.stringify(bad));
  }
});

test("appraiseRules: question marks add a little arousal; mixed tone nets out negative", () => { // @spec AFF-APPR-002, AFF-APPR-003
  const base = appraiseRules(input);
  assert.ok(appraiseRules({ ...input, text: "lol nice?" }).arousal_delta > base.arousal_delta);
  const mixed = appraiseRules({ ...input, text: "lol this is trash" });
  assert.ok(Math.abs(mixed.valence_delta - -0.03) < 1e-9);
});

// ---- kind=llm, against a fake OpenAI-compatible server

let llmBody: { messages?: { role: string; content: string }[]; max_tokens?: number } = {};
const llmServer = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  llmBody = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: '{"valence_delta":0.4,"arousal_delta":-0.3}' } }] }));
});
await new Promise<void>((r) => llmServer.listen(0, r));
after(() => llmServer.close());

test("appraiser llm: the prompt asks for both deltas within -0.5..0.5 and carries mood and line", async () => { // @spec AFF-HOOK-009
  const port = (llmServer.address() as { port: number }).port;
  const c = ConfigSchema.parse({
    cohost: { name: "Coco", streamer: "Chris" },
    llm: { provider: "openai", model: "m", embed_model: "e", openai: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "" } },
    vision: { model: "v", obs: {} },
    chat: { twitch: {} },
    brain: { affect: { module: { kind: "llm" } } },
    voice: {},
    avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
    ears: {},
    dashboard: {},
  });
  const out = await createAppraiser(c, log).run({ source: "chat", who: "bob", text: "hey Coco", mention: true, valence: 0.25, arousal: 0.5 });
  assert.deepEqual(out, { valence_delta: 0.4, arousal_delta: -0.3 }, "the validator range admits what the prompt now asks for");
  const [system, user] = llmBody.messages!;
  assert.match(system!.content, /Coco/);
  assert.match(system!.content, /Chris/);
  assert.match(system!.content, /valence_delta: -0\.5 \([^)]*\) \.\. 0\.5/);
  assert.match(system!.content, /arousal_delta: -0\.5 \([^)]*\) \.\. 0\.5/);
  assert.doesNotMatch(system!.content, /0\.3/, "no narrower range left in the prompt");
  assert.equal(llmBody.max_tokens, 60);
  assert.equal(user!.content, "Mood now: valence 0.25, arousal 0.50\n[chat, mentions co-host] bob: hey Coco");
});
