import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama, AnthropicProvider, BedrockProvider, createChatProvider, createEmbedder, TRANSCRIPT_STOPS } from "../src/index.js";
import { TRANSCRIPT_TAGS } from "@cohost/working-memory";

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

// @spec LLM-STOP-002, LLM-STOP-003, LLM-STOP-005
test("openai-compatible: reply calls send the four stops; json calls send none", async () => {
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${base}/v1`, api_key: "k" } }));
  await p.chat([{ role: "user", content: "hi" }]);
  assert.deepEqual(lastBody.stop, ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"]);
  await p.chat([{ role: "user", content: "hi" }], { json: true });
  assert.equal("stop" in lastBody, false);
});

// @spec LLM-STOP-007
test("TRANSCRIPT_STOPS is a newline followed by each working-memory transcript tag", () => {
  assert.deepEqual([...TRANSCRIPT_STOPS], TRANSCRIPT_TAGS.map((t) => `\n${t}`));
  assert.ok(TRANSCRIPT_STOPS.length > 0);
});

// @spec LLM-STOP-001, LLM-STOP-003
test("ollama: json calls drop the stop list too", async () => {
  const o = new Ollama(llmCfg({ provider: "ollama" }), base);
  await o.chat([{ role: "user", content: "hi" }]);
  assert.ok((lastBody.options as { stop?: string[] }).stop?.includes("\n\n"));
  await o.chat([{ role: "user", content: "hi" }], { json: true });
  assert.equal("stop" in (lastBody.options as object), false);
});

// @spec LLM-PING-002, LLM-PING-005
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

// @spec LLM-CHAT-006
test("an aborted signal rejects the request", async () => {
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${base}/v1` } }));
  await assert.rejects(p.chat([{ role: "user", content: "hi" }], { signal: AbortSignal.abort() }));
});


// @spec LLM-IF-002, LLM-EMBED-003
test("createChatProvider picks the backend from llm.provider; embeddings are always ollama", () => {
  assert.equal(createChatProvider(llmCfg({ provider: "ollama" })).name, "ollama");
  assert.equal(createChatProvider(llmCfg({ provider: "openai" })).name, "openai");
  assert.equal(createChatProvider(llmCfg({ provider: "anthropic", claude: { api_key: "k" } })).name, "anthropic");
  assert.equal(createChatProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1" } })).name, "bedrock");
  assert.ok(createEmbedder(llmCfg({ provider: "anthropic" })) instanceof Ollama);
});

// @spec LLM-CHAT-002, LLM-CHAT-003, LLM-CHAT-004, LLM-CHAT-005, LLM-IF-004
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

// @spec LLM-EMBED-001, LLM-EMBED-002, LLM-PING-001, LLM-CHAT-005
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

// @spec LLM-CLAUDE-001, LLM-CLAUDE-004, LLM-CLAUDE-005, LLM-IF-004
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

// @spec LLM-CLAUDE-001, LLM-CLAUDE-002
test("claude: a conversation must open with a user turn", async () => {
  const { p, calls } = claude();
  await p.chat([{ role: "system", content: "s" }]);
  assert.deepEqual(calls[0]!.req.messages, [{ role: "user", content: "(begin)" }]);
  await p.chat([{ role: "assistant", content: "earlier line" }]);
  assert.deepEqual(calls[1]!.req.messages.map((m) => m.role), ["user", "assistant"]);
  await p.chat([{ role: "user", content: "x" }]);
  assert.equal(calls[2]!.req.system, undefined);
});

// @spec LLM-CLAUDE-003
test("claude: max_tokens never drops below claude.max_tokens (thinking shares the budget)", async () => {
  const { p, calls } = claude({ claude: { api_key: "k", max_tokens: 1024 } });
  await p.chat([{ role: "user", content: "x" }], { maxTokens: 60 });
  await p.chat([{ role: "user", content: "x" }], { maxTokens: 4000 });
  assert.deepEqual(calls.map((c) => c.req.max_tokens), [1024, 4000]);
});

// @spec LLM-STOP-003, LLM-STOP-004, LLM-CLAUDE-007, LLM-CLAUDE-010
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

// @spec LLM-CLAUDE-006
test("claude: a refusal means say nothing", async () => {
  const { p } = claude({}, { stop_reason: "refusal" });
  assert.equal(await p.chat([{ role: "user", content: "x" }]), "");
});

// @spec LLM-PING-003, LLM-PING-005
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

// @spec LLM-CLAUDE-008, LLM-PING-004
test("bedrock: no server fallbacks, and ping is optimistic", async () => {
  const b = new BedrockProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1" } }));
  const calls: Record<string, unknown>[] = [];
  (b as unknown as { client: unknown }).client = { beta: { messages: { create: async (req: Record<string, unknown>) => { calls.push(req); return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } } } };
  assert.equal(await b.chat([{ role: "user", content: "x" }]), "ok");
  assert.equal("fallbacks" in calls[0]!, false);
  assert.equal("betas" in calls[0]!, false);
  assert.equal(await b.ping(), true);
});

import { MockProvider, HashEmbedder } from "../src/index.js";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

// @spec LLM-MOCK-001, LLM-MOCK-002, LLM-MOCK-004, LLM-IF-002
test("mock provider: deterministic, tagged reply; ping true; JSON mode parses", async () => {
  const p = createChatProvider(llmCfg({ provider: "mock" }));
  assert.ok(p instanceof MockProvider);
  assert.equal(p.name, "mock");
  const msgs = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "  hello   there " }];
  const a = await p.chat(msgs);
  assert.equal(a, await p.chat(msgs));
  assert.equal(a, "[happy] mock: hello there");
  assert.equal(await p.ping(), true);
  assert.equal(p.lastError, undefined);
  assert.deepEqual(JSON.parse(await p.chat(msgs, { json: true })), {});
  assert.ok((await p.chat([])).length > 0);
});

// @spec LLM-MOCK-003
test("mock provider: an already-aborted signal throws", async () => {
  const p = new MockProvider({ model: "m" });
  await assert.rejects(p.chat([{ role: "user", content: "x" }], { signal: AbortSignal.abort() }));
});

// @spec LLM-EMBED-005, LLM-EMBED-006
test("hash embedder: 64-dim unit vectors, deterministic, token overlap ranks higher; empty is valid", async () => {
  const e = new HashEmbedder();
  const [a, b, c] = await Promise.all([e.embed("dog park walk"), e.embed("walk the dog"), e.embed("quantum physics")]);
  assert.equal(a?.length, 64);
  assert.ok(Math.abs(cosine(a!, a!) - 1) < 1e-9);
  assert.deepEqual(await e.embed("dog park walk"), a);
  assert.ok(cosine(a!, b!) > cosine(a!, c!));
  assert.ok(cosine(a!, b!) > cosine(b!, c!));
  const empty = await e.embed("");
  assert.equal(empty.length, 64);
  assert.ok(empty.every(Number.isFinite));
});

// @spec LLM-EMBED-003
test("factory: mock provider needs no network and pairs with the hash embedder; others still use Ollama", () => {
  const cfg = llmCfg({ provider: "mock" });
  assert.ok(createEmbedder(cfg) instanceof HashEmbedder);
  assert.ok(createEmbedder(llmCfg({ provider: "openai" })) instanceof Ollama);
  assert.equal(createChatProvider(llmCfg({ provider: "openai" })).name, "openai");
});

// ---- default request timeout (llm.timeout_ms, CFG-SCH-013)

/** A backend that accepts connections and never answers (a black hole). */
const hole = http.createServer(() => {});
await new Promise<void>((r) => hole.listen(0, r));
after(() => { hole.closeAllConnections(); hole.close(); });
const holeUrl = `http://127.0.0.1:${(hole.address() as { port: number }).port}`;
/** `llm.timeout_ms` is added by the config task; the providers read it defensively, so tests set it on the object. */
const withTimeout = (ms: number, over: Record<string, unknown> = {}) => ({ ...llmCfg(over), timeout_ms: ms }) as ReturnType<typeof llmCfg>;
const user = [{ role: "user" as const, content: "x" }];

// @spec LLM-CHAT-008
test("timeout: a black-holed Ollama and OpenAI-compatible backend fails chat, embed and ping once llm.timeout_ms passes", async () => {
  const o = new Ollama(withTimeout(150, { provider: "ollama" }), holeUrl);
  const oa = new OpenAICompatible(withTimeout(150, { openai: { base_url: `${holeUrl}/v1` } }));
  for (const call of [() => o.chat(user), () => o.embed("x"), () => oa.chat(user)]) {
    const t0 = performance.now();
    await assert.rejects(call());
    assert.ok(performance.now() - t0 < 3000, "gave up near the timeout, not never");
  }
  assert.equal(await o.ping(), false);
  assert.match(o.lastError!, /cannot reach ollama/);
  assert.equal(await oa.ping(), false);
  assert.match(oa.lastError!, /cannot reach/);
});

// @spec LLM-CHAT-008
test("timeout: llm.timeout_ms defaults to 60000 when the config object has none", async () => {
  const spy = mock.method(AbortSignal, "timeout", (ms: number) => { void ms; return new AbortController().signal; });
  after(() => spy.mock.restore());
  const s = http.createServer(async (req, res) => { for await (const _ of req); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], message: { content: "ok" }, embeddings: [[1]], models: [] })); });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => s.close());
  const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  await new OpenAICompatible(llmCfg({ openai: { base_url: `${b}/v1` } })).chat(user);
  await new Ollama(llmCfg({ provider: "ollama" }), b).embed("x");
  assert.deepEqual(spy.mock.calls.map((c) => c.arguments[0]), [60000, 60000]);
  await new OpenAICompatible(withTimeout(1234, { openai: { base_url: `${b}/v1` } })).chat(user);
  assert.equal(spy.mock.calls.at(-1)!.arguments[0], 1234);
});

// @spec LLM-CHAT-008, LLM-CHAT-006
test("timeout: a caller's AbortSignal wins over the default timeout", async () => {
  const slow = http.createServer(async (req, res) => {
    for await (const _ of req);
    await new Promise((r) => setTimeout(r, 400));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "late but fine" } }] }));
  });
  await new Promise<void>((r) => slow.listen(0, r));
  after(() => slow.close());
  const url = `http://127.0.0.1:${(slow.address() as { port: number }).port}/v1`;
  const p = new OpenAICompatible(withTimeout(100, { openai: { base_url: url } }));
  await assert.rejects(p.chat(user)); // no signal: the 100 ms default applies
  assert.equal(await p.chat(user, { signal: new AbortController().signal }), "late but fine"); // a signal replaces it
});

// @spec LLM-CHAT-008
test("timeout: Claude requests carry the default timeout only when the caller passes no signal; ping is bounded too", async () => {
  const { p, calls } = claude();
  (p as unknown as { cfg: unknown }).cfg = { ...(p as unknown as { cfg: object }).cfg, timeout_ms: 4321 };
  await p.chat(user);
  assert.equal((calls[0]!.opts as { timeout?: number }).timeout, 4321);
  assert.equal(calls[0]!.opts.signal, undefined);
  const signal = new AbortController().signal;
  await p.chat(user, { signal });
  assert.equal(calls[1]!.opts.signal, signal);
  assert.equal("timeout" in calls[1]!.opts, false);
  const seen: unknown[] = [];
  (p as unknown as { client: { models: { retrieve: (...a: unknown[]) => Promise<unknown> } } }).client.models.retrieve = async (...a) => { seen.push(a[2]); return {}; };
  assert.equal(await p.ping(), true);
  assert.deepEqual(seen, [{ timeout: 4321 }]);
  const dflt = claude();
  await dflt.p.chat(user);
  assert.equal((dflt.calls[0]!.opts as { timeout?: number }).timeout, 60000);
});

// @spec LLM-PING-006
test("bedrock: pingIsNominal tells callers its ping is not a probe; real providers do not set it", () => {
  const b = new BedrockProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1" } }));
  assert.equal(b.pingIsNominal, true);
  for (const provider of ["ollama", "openai", "mock"] as const) assert.equal(createChatProvider(llmCfg({ provider })).pingIsNominal, undefined);
  assert.equal(createChatProvider(llmCfg({ provider: "anthropic", claude: { api_key: "k" } })).pingIsNominal, undefined);
});

// @spec LLM-CHAT-009
test("a failed Ollama or OpenAI-compatible chat makes exactly one request and is not retried", async () => {
  let hits = 0;
  const s = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    hits++;
    res.statusCode = 503;
    res.end("unavailable");
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => s.close());
  const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const msgs = [{ role: "user" as const, content: "x" }];
  await assert.rejects(new OpenAICompatible(llmCfg({ openai: { base_url: `${b}/v1` } })).chat(msgs), /openai chat 503/);
  assert.equal(hits, 1);
  await assert.rejects(new Ollama(llmCfg({ provider: "ollama" }), b).chat(msgs), /ollama chat 503/);
  assert.equal(hits, 2);
});
