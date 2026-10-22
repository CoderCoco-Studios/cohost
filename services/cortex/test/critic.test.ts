import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { createCritic } from "../src/critic.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
let answer: unknown;
let lastBody: Record<string, unknown> = {};
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  lastBody = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());

const cfg = (critic: Record<string, unknown>) => ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain: { cortex: { critic } },
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/critic`;
const line = { text: "hello chat", emotion: "happy" as const, reason: "engaged", transcript: "[chat] bob: hi" };

test("critic rules: pass-through", async () => {
  const c = createCritic(cfg({}), log);
  assert.equal(c.kind, "rules");
  assert.deepEqual(await c.run(line), { ok: true });
});

test("critic http: receives the line and can veto, rewrite or re-emote it", async () => {
  const c = createCritic(cfg({ kind: "http", url }), log);
  answer = { ok: false, note: "repeats itself" };
  assert.deepEqual(await c.run(line), { ok: false, note: "repeats itself" });
  assert.deepEqual(lastBody, line);
  answer = { ok: true, text: "  hey chat  ", emotion: "laugh" };
  assert.deepEqual(await c.run(line), { ok: true, text: "hey chat", emotion: "laugh" });
});

test("critic http: an unknown emotion or a blank rewrite is dropped, not passed on", async () => {
  const c = createCritic(cfg({ kind: "http", url }), log);
  answer = { ok: true, text: "   ", emotion: "furious", note: 5 };
  assert.deepEqual(await c.run(line), { ok: true });
});

test("critic http: no boolean ok → unusable → the rules pass the line through", async () => {
  const c = createCritic(cfg({ kind: "http", url }), log);
  answer = { ok: "false" };
  assert.deepEqual(await c.run(line), { ok: true });
  answer = null;
  assert.deepEqual(await c.run(line), { ok: true });
});
