/**
 * Wire-level tests for the model backends: the Claude and Bedrock providers run through the real SDK clients against
 * a local server that replays recorded responses (test/fixtures), so no test reaches the network. Also the
 * request-shape specs that need an exact body (Ollama chat, JSON mode, `max_tokens`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { Context } from "@cohost/working-memory";
import {
  AnthropicProvider, BedrockProvider, MockProvider, Ollama, OpenAICompatible, TRANSCRIPT_STOPS, createChatProvider,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, "fixtures", name), "utf8");
const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });
const user = (content: string) => [{ role: "user" as const, content }];

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
interface Reply { status?: number; file: string }

/** A server that records each request and answers from a queue of fixture files. */
async function replay(replies: Reply[]): Promise<{ base: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    const next = replies.shift();
    res.statusCode = next?.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(next ? fixture(next.file) : "{}");
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

/** Set environment variables for one test and restore them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---- Claude API, recorded fixtures

// @spec LLM-CLAUDE-011, LLM-CLAUDE-004, LLM-CLAUDE-005, LLM-CLAUDE-007, LLM-CLAUDE-003, LLM-IF-004
test("claude api: a recorded reply is parsed and the request carries effort, betas, fallbacks and no temperature", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    await withEnv({ ANTHROPIC_BASE_URL: srv.base }, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-fixture" } }));
      const out = await p.chat([{ role: "system", content: "persona" }, ...user("hi")], { maxTokens: 90 });
      assert.equal(out, "[happy] Hello chat! Welcome in.");
    });
    const req = srv.seen[0]!;
    assert.equal(req.method, "POST");
    assert.match(req.url!, /^\/v1\/messages/);
    assert.equal(req.headers.authorization, "Bearer sk-fixture");
    assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(req.body.model, "claude-fixture");
    assert.equal(req.body.max_tokens, 90); // @spec LLM-CLAUDE-003: the hook's budget is honoured
    assert.equal(req.body.system, "persona");
    assert.deepEqual(req.body.output_config, { effort: "low" });
    assert.equal(req.body.fallbacks, "default");
    assert.equal("temperature" in req.body, false);
    assert.deepEqual(req.body.stop_sequences, ["\n[chat]", "\n[voice]", "\n[screen]"]);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-007
test("claude api: with fallbacks off the request carries neither betas nor fallbacks", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    await withEnv({ ANTHROPIC_BASE_URL: srv.base }, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", fallbacks: false } }));
      await p.chat(user("hi"));
    });
    const req = srv.seen[0]!;
    assert.equal("fallbacks" in req.body, false);
    assert.equal("betas" in req.body, false);
    assert.doesNotMatch(String(req.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-003
test("claude: with no maxTokens from the caller, max_tokens is llm.claude.max_tokens", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }, { file: "anthropic-message.json" }]);
  try {
    await withEnv({ ANTHROPIC_BASE_URL: srv.base }, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", max_tokens: 1536 } }));
      await p.chat(user("hi"));
      await p.chat(user("hi"), { maxTokens: 0 }); // below the API minimum of 1: raised to it
    });
    assert.deepEqual(srv.seen.map((s) => s.body.max_tokens), [1536, 1]);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-011, LLM-CLAUDE-006, LLM-CLAUDE-009
test("claude api: a recorded refusal gives an empty reply; no configured key falls back to ANTHROPIC_API_KEY", async () => {
  const srv = await replay([{ file: "anthropic-refusal.json" }]);
  try {
    await withEnv({ ANTHROPIC_BASE_URL: srv.base, ANTHROPIC_API_KEY: "sk-from-env" }, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "" } }));
      assert.equal(await p.chat(user("hi")), "");
    });
    assert.equal(srv.seen[0]!.headers.authorization, "Bearer sk-from-env");
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-011, LLM-PING-003, LLM-PING-005
test("claude api: ping against recorded model, 401 and 404 answers", async () => {
  const srv = await replay([
    { file: "anthropic-error-401.json", status: 401 },
    { file: "anthropic-error-404.json", status: 404 },
    { file: "anthropic-model.json" },
  ]);
  try {
    await withEnv({ ANTHROPIC_BASE_URL: srv.base }, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "bad" } }));
      assert.equal(await p.ping(), false);
      assert.match(p.lastError!, /credentials \(401\)/);
      assert.equal(await p.ping(), false);
      assert.match(p.lastError!, /no model "claude-fixture"/);
      assert.equal(await p.ping(), true);
      assert.equal(p.lastError, undefined);
    });
    assert.match(srv.seen[0]!.url!, /^\/v1\/models\/claude-fixture/);
  } finally { srv.close(); }
});

// ---- Bedrock, recorded fixtures

// @spec LLM-CLAUDE-012, LLM-CLAUDE-008, LLM-CLAUDE-009, LLM-PING-004, LLM-PING-006
test("bedrock: a recorded reply is parsed; no betas or fallbacks are sent; a region from the environment is accepted", async () => {
  const srv = await replay([{ file: "bedrock-message.json" }]);
  try {
    await withEnv({
      ANTHROPIC_BEDROCK_MANTLE_BASE_URL: srv.base, AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret",
    }, async () => {
      const b = new BedrockProvider(llmCfg({ provider: "bedrock", model: "anthropic.claude-fixture", bedrock: { region: "" } }));
      assert.equal(await b.chat(user("hi"), { maxTokens: 70 }), "[smug] From Bedrock, with love.");
      assert.equal(await b.ping(), true);
      assert.equal(b.pingIsNominal, true);
    });
    assert.equal(srv.seen.length, 1, "ping makes no request");
    const req = srv.seen[0]!;
    assert.match(req.url!, /messages/);
    assert.equal(req.body.max_tokens, 70);
    assert.equal(req.body.model, "anthropic.claude-fixture");
    assert.equal("fallbacks" in req.body, false);
    assert.equal("betas" in req.body, false);
    assert.doesNotMatch(String(req.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
    assert.match(String(req.headers.authorization), /AWS4-HMAC-SHA256/);
  } finally { srv.close(); }
});

// ---- opt-in live smoke

// @spec LLM-CLAUDE-013
test("claude api live smoke (set ANTHROPIC_API_KEY and COHOST_LIVE_CLAUDE_MODEL to run)", { skip: !process.env.ANTHROPIC_API_KEY || !process.env.COHOST_LIVE_CLAUDE_MODEL }, async () => {
  const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: process.env.COHOST_LIVE_CLAUDE_MODEL, claude: { api_key: "" } }));
  assert.equal(await p.ping(), true, p.lastError);
  const out = await p.chat(user("Reply with the single word: ok"), { maxTokens: 512 });
  assert.ok(out.length > 0);
});

// ---- Ollama and OpenAI request bodies

async function bodyServer(): Promise<{ base: string; bodies: Record<string, unknown>[]; reply: { json: unknown; status: number }; close: () => void }> {
  const bodies: Record<string, unknown>[] = [];
  const reply = { json: {} as unknown, status: 200 };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    if (raw) bodies.push(JSON.parse(raw));
    res.statusCode = reply.status;
    res.end(JSON.stringify(reply.json));
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, reply, close: () => server.close() };
}

// @spec LLM-CHAT-001, LLM-STOP-001, LLM-CHAT-007
test("ollama chat: the exact request body, the exact stop list, and an empty reply is an empty string", async () => {
  const s = await bodyServer();
  try {
    s.reply.json = { message: { content: "  hello  " } };
    const o = new Ollama(llmCfg({ provider: "ollama", model: "qwen", temperature: 0.7, max_tokens: 90, num_ctx: 4096 }), s.base);
    assert.equal(await o.chat(user("hi")), "hello");
    assert.deepEqual(s.bodies[0], {
      model: "qwen",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      keep_alive: "24h",
      options: { temperature: 0.7, num_ctx: 4096, num_predict: 90, stop: ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"] },
    });
    s.reply.json = {};
    assert.equal(await o.chat(user("hi")), "");
    s.reply.json = { message: {} };
    assert.equal(await o.chat(user("hi")), "");
  } finally { s.close(); }
});

// @spec LLM-CHAT-007
test("openai-compatible: a reply with no content (missing or null) is an empty string", async () => {
  const s = await bodyServer();
  try {
    const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${s.base}/v1` } }));
    s.reply.json = { choices: [] };
    assert.equal(await p.chat(user("hi")), "");
    s.reply.json = { choices: [{ message: { content: null } }] };
    assert.equal(await p.chat(user("hi")), "");
  } finally { s.close(); }
});

// @spec LLM-PING-001
test("ollama ping: a 2xx answer from /api/tags is true and clears lastError", async () => {
  const s = await bodyServer();
  try {
    const o = new Ollama(llmCfg({ provider: "ollama" }), s.base);
    s.reply.status = 500;
    assert.equal(await o.ping(), false);
    assert.match(o.lastError!, /ollama 500/);
    s.reply.status = 200;
    assert.equal(await o.ping(), true);
    assert.equal(o.lastError, undefined);
  } finally { s.close(); }
});

// @spec LLM-CHAT-010
test("json mode asks Ollama for format json and OpenAI-compatible servers for a json_object response; other calls ask for neither", async () => {
  const s = await bodyServer();
  try {
    s.reply.json = { message: { content: "{}" }, choices: [{ message: { content: "{}" } }] };
    const o = new Ollama(llmCfg({ provider: "ollama" }), s.base);
    const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${s.base}/v1` } }));
    await o.chat(user("hi"), { json: true });
    await p.chat(user("hi"), { json: true });
    await o.chat(user("hi"));
    await p.chat(user("hi"));
    assert.equal(s.bodies[0]!.format, "json");
    assert.deepEqual(s.bodies[1]!.response_format, { type: "json_object" });
    assert.equal("format" in s.bodies[2]!, false);
    assert.equal("response_format" in s.bodies[3]!, false);
  } finally { s.close(); }
});

// ---- mock

// @spec LLM-MOCK-001
test("mock provider: the reply text is cut at 80 characters and an empty user message says hello", async () => {
  const p = new MockProvider({ model: "m" });
  assert.equal(await p.chat(user("x".repeat(200))), `[happy] mock: ${"x".repeat(80)}`);
  assert.equal(await p.chat(user("   \n  ")), "[happy] mock: hello");
  assert.equal(await p.chat([{ role: "system", content: "s" }]), "[happy] mock: hello");
  assert.ok(createChatProvider(llmCfg({ provider: "mock" })) instanceof MockProvider);
});

// ---- cross-package

// @spec LLM-STOP-006
test("every tag working-memory renders at the start of a chat, voice or screen line has a matching transcript stop", () => {
  const ctx = new Context(10);
  const ev = (type: string, data: Record<string, unknown>, ts: number) => ({ id: String(ts), type, ts, source: "t", data }) as unknown as Parameters<Context["push"]>[0];
  ctx.push(ev("chat.message", { platform: "twitch", user: "viewer", text: "hello", isMod: false, isSub: false, mentionsCohost: false }, 1));
  ctx.push(ev("speech.heard", { speaker: "Streamer", text: "hi chat", durationMs: 500 }, 2));
  ctx.push(ev("vision.summary", { text: "a menu", changed: true }, 3));
  ctx.pushSelf("welcome", "happy");
  const lines = ctx.transcript("Coco").split("\n");
  const tags = lines.map((l) => /^\[[a-z]+\]/.exec(l)?.[0]);
  assert.equal(lines.length, 4);
  assert.equal(tags[3], undefined, "the co-host's own line carries no tag");
  tags.length = 3;
  assert.ok(tags.every((t) => t !== undefined));
  assert.deepEqual(TRANSCRIPT_STOPS, tags.map((t) => `\n${t}`));
  assert.equal(TRANSCRIPT_STOPS.some((s) => s.startsWith("\nCoco")), false, "the co-host's own line is not a stop");
});

after(() => { /* servers are closed per test in try/finally */ });
