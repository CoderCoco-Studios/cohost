import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama } from "../src/index.js";

const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });

let lastBody: Record<string, unknown> = {};
let status = 200;
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (body) lastBody = JSON.parse(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], message: { content: "ok" }, models: [] }));
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

test("openai-compatible: reply calls send the four stops; json calls send none", async () => {
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${base}/v1`, api_key: "k" } }));
  await p.chat([{ role: "user", content: "hi" }]);
  assert.deepEqual(lastBody.stop, ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"]);
  await p.chat([{ role: "user", content: "hi" }], { json: true });
  assert.equal("stop" in lastBody, false);
});

test("ollama: json calls drop the stop list too", async () => {
  const o = new Ollama(llmCfg({ provider: "ollama" }), base);
  await o.chat([{ role: "user", content: "hi" }]);
  assert.ok((lastBody.options as { stop?: string[] }).stop?.includes("\n\n"));
  await o.chat([{ role: "user", content: "hi" }], { json: true });
  assert.equal("stop" in (lastBody.options as object), false);
});

test("ping failure records why, including the auth hint", async () => {
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${base}/v1`, api_key: "bad" } }));
  status = 401;
  assert.equal(await p.ping(), false);
  assert.match(p.lastError!, /401.*api_key/);
  status = 200;
  assert.equal(await p.ping(), true);
  assert.equal(p.lastError, undefined);
  const dead = new OpenAICompatible(llmCfg({ openai: { base_url: "http://127.0.0.1:1/v1" } }));
  assert.equal(await dead.ping(), false);
  assert.match(dead.lastError!, /cannot reach/);
});

test("an aborted signal rejects the request", async () => {
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${base}/v1` } }));
  await assert.rejects(p.chat([{ role: "user", content: "hi" }], { signal: AbortSignal.abort() }));
});
