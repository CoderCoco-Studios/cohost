// Result contract: ChatResult, ChatError, complete() on Ollama and OpenAI-compatible (issue #158).
// `complete` and `ChatError` do not exist yet, so the module is read through a namespace and `any`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama } from "../src/index.js";
import * as llmApi from "../src/index.js";

const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });
const withTimeout = (ms: number, over: Record<string, unknown> = {}) => ({ ...llmCfg(over), timeout_ms: ms }) as ReturnType<typeof llmCfg>;

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> };
/** A backend that records every request and answers with `reply(n)` (status and JSON body or raw text). */
async function recorder(reply: (n: number) => { status?: number; json?: unknown; text?: string } = () => ({})) {
  const seen: Seen[] = [];
  const s = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    const r = reply(seen.length);
    res.statusCode = r.status ?? 200;
    if (r.text !== undefined) return void res.end(r.text);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.json ?? { message: { content: "hi" }, done_reason: "stop", choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => { s.closeAllConnections(); s.close(); });
  return { seen, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}

/** A backend that accepts connections and never answers. */
const hole = http.createServer(() => {});
await new Promise<void>((r) => hole.listen(0, r));
after(() => { hole.closeAllConnections(); hole.close(); });
const holeUrl = `http://127.0.0.1:${(hole.address() as { port: number }).port}`;

const stopsAll = ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"];
const hello = [{ role: "user" as const, content: "hello" }];

// @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-022
test("ollama: complete() resolves to a ChatResult with trimmed text and an assistant message without toolCalls", async () => {
  const b = await recorder(() => ({ json: { message: { content: "  hi there \n" }, done_reason: "stop" } }));
  const r = await (new Ollama(llmCfg({ provider: "ollama" }), b.url) as any).complete(hello);
  assert.deepEqual(r, { text: "hi there", toolCalls: [], finish: "stop", message: { role: "assistant", content: "hi there" } });
  assert.equal("toolCalls" in r.message, false);
  const empty = await recorder(() => ({ json: { message: {}, done_reason: "stop" } }));
  const e = await (new Ollama(llmCfg({ provider: "ollama" }), empty.url) as any).complete(hello);
  assert.equal(e.text, "");
  assert.equal(e.message.content, "");
});

// @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-022
test("openai-compatible: complete() resolves to a ChatResult; null content gives an empty text", async () => {
  const b = await recorder(() => ({ json: { choices: [{ message: { content: "\n ok  " }, finish_reason: "stop" }] } }));
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } })) as any;
  assert.deepEqual(await p.complete(hello), { text: "ok", toolCalls: [], finish: "stop", message: { role: "assistant", content: "ok" } });
  const n = await recorder(() => ({ json: { choices: [{ message: { content: null }, finish_reason: "stop" }] } }));
  const q = await (new OpenAICompatible(llmCfg({ openai: { base_url: `${n.url}/v1` } })) as any).complete(hello);
  assert.equal(q.text, "");
  assert.equal("toolCalls" in q.message, false);
});

// @spec LLM-CHAT-011, LLM-CHAT-015, LLM-STOP-011
test("ollama: complete() sends the same non-streamed /api/chat request as chat(), with defaults and the four stops", async () => {
  const b = await recorder();
  const o = new Ollama(llmCfg({ provider: "ollama", temperature: 0.4, max_tokens: 77, num_ctx: 2048 }), b.url) as any;
  await o.chat(hello);
  await o.complete(hello);
  assert.equal(b.seen[1]!.url, "/api/chat");
  assert.deepEqual(b.seen[1]!.body, b.seen[0]!.body);
  assert.equal(b.seen[1]!.body.stream, false);
  assert.equal(b.seen[1]!.body.keep_alive, "24h");
  assert.deepEqual(b.seen[1]!.body.options, { temperature: 0.4, num_ctx: 2048, num_predict: 77, stop: stopsAll });
  await o.complete(hello, { temperature: 0.9, maxTokens: 5 });
  assert.equal(b.seen[2]!.body.options.temperature, 0.9);
  assert.equal(b.seen[2]!.body.options.num_predict, 5);
});

// @spec LLM-CHAT-012, LLM-CHAT-013, LLM-CHAT-015, LLM-STOP-013
test("openai-compatible: complete() posts to <base_url>/chat/completions with bearer only when a key is set", async () => {
  const b = await recorder();
  const keyed = new OpenAICompatible(llmCfg({ temperature: 0.3, max_tokens: 64, openai: { base_url: `${b.url}/v1///`, api_key: "sekret" } })) as any;
  await keyed.chat(hello);
  await keyed.complete(hello);
  assert.equal(b.seen[1]!.url, "/v1/chat/completions");
  assert.equal(b.seen[1]!.headers.authorization, "Bearer sekret");
  assert.deepEqual(b.seen[1]!.body, b.seen[0]!.body);
  assert.equal(b.seen[1]!.body.stream, false);
  assert.equal(b.seen[1]!.body.temperature, 0.3);
  assert.equal(b.seen[1]!.body.max_tokens, 64);
  assert.deepEqual(b.seen[1]!.body.stop, stopsAll);
  await keyed.complete(hello, { temperature: 1, maxTokens: 9 });
  assert.equal(b.seen[2]!.body.temperature, 1);
  assert.equal(b.seen[2]!.body.max_tokens, 9);
  const open = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1`, api_key: "" } })) as any;
  await open.complete(hello);
  assert.equal("authorization" in b.seen[3]!.headers, false);
});

// @spec LLM-CHAT-021
test("complete(): json:true sends the backend's JSON mode and no stops; otherwise neither JSON key is sent", async () => {
  const b = await recorder();
  const o = new Ollama(llmCfg({ provider: "ollama" }), b.url) as any;
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } })) as any;
  await o.complete(hello, { json: true });
  assert.equal(b.seen[0]!.body.format, "json");
  assert.equal("stop" in b.seen[0]!.body.options, false);
  await o.complete(hello);
  assert.equal("format" in b.seen[1]!.body, false);
  await p.complete(hello, { json: true });
  assert.deepEqual(b.seen[2]!.body.response_format, { type: "json_object" });
  assert.equal("stop" in b.seen[2]!.body, false);
  await p.complete(hello);
  assert.equal("response_format" in b.seen[3]!.body, false);
});

// @spec LLM-IF-014, LLM-IF-015
test("complete(): finish is length when the token cap ended the reply, stop otherwise, on both providers", async () => {
  for (const [reason, want] of [["length", "length"], ["stop", "stop"], ["unload", "stop"]] as const) {
    const b = await recorder(() => ({ json: { message: { content: "x" }, done_reason: reason } }));
    assert.equal((await (new Ollama(llmCfg({ provider: "ollama" }), b.url) as any).complete(hello)).finish, want, `ollama ${reason}`);
  }
  for (const [reason, want] of [["length", "length"], ["stop", "stop"], ["content_filter", "stop"], [null, "stop"]] as const) {
    const b = await recorder(() => ({ json: { choices: [{ message: { content: "x" }, finish_reason: reason }] } }));
    const r = await (new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } })) as any).complete(hello);
    assert.equal(r.finish, want, `openai ${reason}`);
  }
});

// @spec LLM-IF-011, LLM-IF-012
test("chat(): a tool message or an assistant toolCalls is a TypeError before any request on every provider; a model-emitted tool call is ignored", async () => {
  const b = await recorder(() => ({ json: {
    message: { content: "text", tool_calls: [{ function: { name: "t", arguments: {} } }] },
    choices: [{ message: { content: "text", tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  } }));
  const o = new Ollama(llmCfg({ provider: "ollama" }), b.url);
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } }));
  // Claude and Bedrock take a stubbed transport that counts requests, so a rejected call that sends one is visible.
  let claudeRequests = 0;
  const stub = (async () => { claudeRequests++; throw new Error("no request expected"); }) as typeof fetch;
  const anth = new llmApi.AnthropicProvider(llmCfg({ provider: "anthropic", claude: { api_key: "k" } }), undefined, { fetch: stub });
  const bed = new llmApi.BedrockProvider(llmCfg({ provider: "bedrock", bedrock: { region: "us-east-1", access_key_id: "AKIATEST", secret_access_key: "test-secret" } }), undefined, { fetch: stub });
  const mock = new llmApi.MockProvider({ model: "m" });
  const toolMsg = [...hello, { role: "tool", callId: "1", name: "t", content: "r" }] as any;
  const asstCalls = [...hello, { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: {} }] }] as any;
  for (const prov of [o, p, anth, bed, mock]) for (const h of [toolMsg, asstCalls]) {
    await assert.rejects(prov.chat(h), TypeError, prov.name);
  }
  assert.equal(b.seen.length, 0, "no request was sent to Ollama or OpenAI-compatible");
  assert.equal(claudeRequests, 0, "no request was sent to Claude or Bedrock");
  const asstEmpty = [...hello, { role: "assistant", content: "ok", toolCalls: [] }] as any;
  assert.equal(await o.chat(asstEmpty), "text");
  assert.equal(await p.chat(hello), "text");
});

// @spec LLM-ERR-007
test("a non-2xx answer is a ChatError of kind http with the status and the existing message, from chat() and complete()", async () => {
  const ChatError = (llmApi as any).ChatError;
  assert.equal(typeof ChatError, "function", "ChatError is exported");
  const b = await recorder(() => ({ status: 503, text: "overloaded" }));
  const o = new Ollama(llmCfg({ provider: "ollama" }), b.url) as any;
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } })) as any;
  for (const [call, name] of [[() => o.chat(hello), "ollama"], [() => o.complete(hello), "ollama"], [() => p.chat(hello), "openai"], [() => p.complete(hello), "openai"]] as const) {
    await assert.rejects(call(), (e: any) => e instanceof ChatError && e instanceof Error && e.kind === "http" && e.status === 503 && e.message === `${name} chat 503: overloaded`);
  }
});

// @spec LLM-ERR-005
test("complete() and chat(): a default-timeout expiry rejects with the TimeoutError of AbortSignal.timeout, not a ChatError", async () => {
  const ChatError = (llmApi as any).ChatError;
  assert.equal(typeof ChatError, "function", "ChatError is exported");
  const o = new Ollama(withTimeout(150, { provider: "ollama" }), holeUrl) as any;
  const p = new OpenAICompatible(withTimeout(150, { openai: { base_url: `${holeUrl}/v1` } })) as any;
  for (const call of [() => o.complete(hello), () => p.complete(hello), () => o.chat(hello), () => p.chat(hello)]) {
    await assert.rejects(call(), (e: any) => e?.name === "TimeoutError" && !(e instanceof ChatError));
  }
});

// @spec LLM-CHAT-019
test("complete(): a failing request is made once; no retry or back-off", async () => {
  const b = await recorder(() => ({ status: 500, text: "boom" }));
  const o = new Ollama(llmCfg({ provider: "ollama" }), b.url) as any;
  const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${b.url}/v1` } })) as any;
  await assert.rejects(o.complete(hello), /ollama chat 500/);
  await assert.rejects(p.complete(hello), /openai chat 500/);
  assert.equal(b.seen.length, 2, "one fetch per call");
  const dead = new OpenAICompatible(llmCfg({ openai: { base_url: "http://127.0.0.1:1/v1" } })) as any;
  await assert.rejects(dead.complete(hello), /fetch failed/);
});
