import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama, AnthropicProvider, BedrockProvider, createChatProvider, createEmbedder } from "../src/index.js";

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


test("createChatProvider picks the backend from llm.provider; embeddings are always ollama", () => {
  assert.equal(createChatProvider(llmCfg({ provider: "ollama" })).name, "ollama");
  assert.equal(createChatProvider(llmCfg({ provider: "openai" })).name, "openai");
  assert.equal(createChatProvider(llmCfg({ provider: "anthropic", claude: { api_key: "k" } })).name, "anthropic");
  assert.equal(createChatProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1" } })).name, "bedrock");
  assert.ok(createEmbedder(llmCfg({ provider: "anthropic" })) instanceof Ollama);
});

test("openai-compatible: trailing slashes, bearer auth, config defaults and a failed chat", async () => {
  const seen: { url?: string; auth?: string } = {};
  const s = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.url = req.url; seen.auth = req.headers.authorization;
    lastBody = body ? JSON.parse(body) : {};
    if (lastBody.model === "broken") { res.statusCode = 502; return res.end("upstream down"); }
    res.end(JSON.stringify({ choices: [{ message: { content: "  hi there \n" } }] }));
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => s.close());
  const b = `http://127.0.0.1:${(s.address() as { port: number }).port}/v1///`;
  const p = new OpenAICompatible(llmCfg({ temperature: 0.3, max_tokens: 50, openai: { base_url: b, api_key: "sk-x" } }));
  assert.equal(await p.chat([{ role: "user", content: "x" }]), "hi there");
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.auth, "Bearer sk-x");
  assert.equal(lastBody.temperature, 0.3);
  assert.equal(lastBody.max_tokens, 50);
  await p.chat([{ role: "user", content: "x" }], { temperature: 0, maxTokens: 5 });
  assert.equal(lastBody.temperature, 0);
  assert.equal(lastBody.max_tokens, 5);
  const noKey = new OpenAICompatible(llmCfg({ openai: { base_url: b } }));
  await noKey.chat([{ role: "user", content: "x" }]);
  assert.equal(seen.auth, undefined);
  const broken = new OpenAICompatible(llmCfg({ model: "broken", openai: { base_url: b } }));
  await assert.rejects(broken.chat([{ role: "user", content: "x" }]), /openai chat 502: upstream down/);
});

test("ollama: embed returns the first vector and errors on an empty reply; ping reports status", async () => {
  let reply: unknown = { embeddings: [[0.1, 0.2, 0.3]] };
  let code = 200;
  const s = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    lastBody = body ? JSON.parse(body) : {};
    res.statusCode = code;
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => s.close());
  const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const o = new Ollama(llmCfg({ provider: "ollama", embed_model: "nomic" }), b);
  assert.deepEqual(await o.embed("hello"), [0.1, 0.2, 0.3]);
  assert.deepEqual(lastBody, { model: "nomic", input: "hello", keep_alive: "24h" });
  reply = { embeddings: [] };
  await assert.rejects(o.embed("hello"), /no vector/);
  code = 500;
  await assert.rejects(o.embed("hello"), /ollama embed 500/);
  await assert.rejects(o.chat([{ role: "user", content: "x" }]), /ollama chat 500/);
  assert.equal(await o.ping(), false);
  assert.match(o.lastError!, /ollama 500/);
  assert.equal(await new Ollama(llmCfg(), "http://127.0.0.1:1").ping(), false);
});

// ---- Claude (the SDK client is swapped for a recorder; no network)

type CreateReq = Record<string, unknown> & { messages: { role: string; content: string }[] };
function claude(over: Record<string, unknown> = {}, reply: Record<string, unknown> = {}) {
  const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-x", claude: { api_key: "k" }, ...over }));
  const calls: { req: CreateReq; opts: { signal?: AbortSignal } }[] = [];
  (p as unknown as { client: unknown }).client = {
    beta: { messages: { create: async (req: CreateReq, opts: { signal?: AbortSignal }) => {
      calls.push({ req, opts });
      return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: " [happy] " }, { type: "text", text: "hi! " }], ...reply };
    } } },
    models: { retrieve: async () => ({}) },
  };
  return { p, calls };
}

test("claude: system messages move to `system`, only text blocks are returned", async () => {
  const { p, calls } = claude();
  const out = await p.chat([
    { role: "system", content: "persona" },
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hey" },
    { role: "user", content: "again" },
  ]);
  assert.equal(out, "[happy] hi!");
  const { req } = calls[0]!;
  assert.equal(req.system, "persona\n\nrules");
  assert.deepEqual(req.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(req.model, "claude-x");
  assert.deepEqual(req.output_config, { effort: "low" });
});

test("claude: a conversation must open with a user turn", async () => {
  const { p, calls } = claude();
  await p.chat([{ role: "system", content: "s" }]);
  assert.deepEqual(calls[0]!.req.messages, [{ role: "user", content: "(begin)" }]);
  await p.chat([{ role: "assistant", content: "earlier line" }]);
  assert.deepEqual(calls[1]!.req.messages.map((m) => m.role), ["user", "assistant"]);
  await p.chat([{ role: "user", content: "x" }]);
  assert.equal(calls[2]!.req.system, undefined);
});

test("claude: max_tokens never drops below claude.max_tokens (thinking shares the budget)", async () => {
  const { p, calls } = claude({ claude: { api_key: "k", max_tokens: 1024 } });
  await p.chat([{ role: "user", content: "x" }], { maxTokens: 60 });
  await p.chat([{ role: "user", content: "x" }], { maxTokens: 4000 });
  assert.deepEqual(calls.map((c) => c.req.max_tokens), [1024, 4000]);
});

test("claude: transcript stops on replies, none on json; server fallbacks follow config", async () => {
  const { p, calls } = claude();
  const signal = new AbortController().signal;
  await p.chat([{ role: "user", content: "x" }], { signal });
  await p.chat([{ role: "user", content: "x" }], { json: true });
  assert.deepEqual(calls[0]!.req.stop_sequences, ["\n[chat]", "\n[voice]", "\n[screen]"]); // no "\n\n": thinking-era replies may use it
  assert.equal("stop_sequences" in calls[1]!.req, false);
  assert.equal(calls[0]!.opts.signal, signal);
  assert.equal(calls[0]!.req.fallbacks, "default");
  assert.deepEqual(calls[0]!.req.betas, ["server-side-fallback-2026-07-01"]);
  const off = claude({ claude: { api_key: "k", fallbacks: false } });
  await off.p.chat([{ role: "user", content: "x" }]);
  assert.equal("fallbacks" in off.calls[0]!.req, false);
});

test("claude: a refusal means say nothing", async () => {
  const { p } = claude({}, { stop_reason: "refusal" });
  assert.equal(await p.chat([{ role: "user", content: "x" }]), "");
});

test("claude: ping explains auth and unknown-model failures", async () => {
  const { p } = claude();
  assert.equal(await p.ping(), true);
  const client = (p as unknown as { client: { models: { retrieve: () => Promise<unknown> } } }).client;
  for (const [status, re] of [[401, /credentials \(401\).*ANTHROPIC_API_KEY/], [403, /credentials \(403\)/], [404, /no model "claude-x".*llm\.model/], [500, /boom/]] as const) {
    client.models.retrieve = async () => { throw Object.assign(new Error("boom"), { status }); };
    assert.equal(await p.ping(), false);
    assert.match(p.lastError!, re);
  }
  client.models.retrieve = async () => ({});
  assert.equal(await p.ping(), true);
  assert.equal(p.lastError, undefined);
});

test("bedrock: no server fallbacks, and ping is optimistic", async () => {
  const b = new BedrockProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1" } }));
  const calls: Record<string, unknown>[] = [];
  (b as unknown as { client: unknown }).client = { beta: { messages: { create: async (req: Record<string, unknown>) => { calls.push(req); return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } } } };
  assert.equal(await b.chat([{ role: "user", content: "x" }]), "ok");
  assert.equal("fallbacks" in calls[0]!, false);
  assert.equal("betas" in calls[0]!, false);
  assert.equal(await b.ping(), true);
});
