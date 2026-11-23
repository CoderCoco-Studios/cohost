// Image input on every real provider (issue #164): a user message's `images` reach the request body in each vendor's form on
// chat(), complete() and stream(), and data in no supported format is a TypeError before any request.
// Providers are read through `any` so a test can pass the request shapes the spec names.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { AnthropicProvider, BedrockProvider, OpenAICompatible, Ollama } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, "fixtures", name), "utf8");
const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });
const CONFIGURED = { region: "eu-west-2", access_key_id: "AKIACONFIG", secret_access_key: "config-secret" };

/** Real leading bytes of each supported format, then filler, as the bare base64 the callers send. */
const b64 = (...bytes: number[]) => Buffer.from([...bytes, ...new Array(24).fill(7)]).toString("base64");
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const JPEG = b64(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"));
const PNG = b64(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const GIF = b64(...ascii("GIF89a"));
const WEBP = b64(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 "));
const FORMATS: [string, string][] = [["image/jpeg", JPEG], ["image/png", PNG], ["image/gif", GIF], ["image/webp", WEBP]];
/** Data in none of the four formats: ASCII "ABC", a RIFF container that is not WebP, a text file, and the empty string. */
const UNKNOWN: [string, string][] = [
  ["plain bytes", "QUJD"],
  ["RIFF but WAVE", b64(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVEfmt "))],
  ["text", Buffer.from("not an image at all, just text").toString("base64")],
  ["empty", ""],
];

type Kind = "openai" | "anthropic" | "bedrock";
type Call = "chat" | "complete" | "stream";
const kinds: Kind[] = ["openai", "anthropic", "bedrock"];
const claudeKinds = ["anthropic", "bedrock"] as const;
const calls: Call[] = ["chat", "complete", "stream"];

type Seen = { url: string; body: Record<string, any> };
/** A backend that records each request body and answers a plain reply: SSE for a streamed request, JSON otherwise. */
async function serve(kind: Kind | "ollama") {
  const seen: Seen[] = [];
  const s = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url ?? "", body });
    const streaming = body.stream === true;
    if (kind === "openai") {
      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      }
    } else if (kind === "ollama") {
      res.writeHead(200, { "content-type": streaming ? "application/x-ndjson" : "application/json" });
      res.end(streaming
        ? JSON.stringify({ message: { content: "ok" }, done: false }) + "\n" + JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" }) + "\n"
        : JSON.stringify({ message: { content: "ok" }, done: true, done_reason: "stop" }));
    } else if (streaming) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(fixture(`${kind}-stream-plain.sse`));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixture(kind === "anthropic" ? "anthropic-message.json" : "bedrock-message.json"));
    }
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => { s.closeAllConnections(); s.close(); });
  return { seen, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}

/** The real provider; Claude and Bedrock send through the SDK with its `fetch` pointed at the local server. */
const make = (kind: Kind | "ollama", url: string): any => {
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    return fetch(`${url}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  switch (kind) {
    case "openai": return new OpenAICompatible(llmCfg({ openai: { base_url: `${url}/v1` } }));
    case "ollama": return new Ollama(llmCfg({ provider: "ollama" }), url);
    case "anthropic": return new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), { fetch: fetchImpl });
    case "bedrock": return new BedrockProvider(llmCfg({ provider: "bedrock", model: "anthropic.claude-fixture", bedrock: CONFIGURED }), { fetch: fetchImpl });
  }
};

async function collect(it: AsyncIterable<any>): Promise<void> { for await (const _ of it) { /* drain */ } }
/** Runs one call to the end; a stream() is drained. */
const run = async (p: any, call: Call, messages: unknown[]): Promise<void> => {
  if (call === "stream") await collect(p.stream(messages));
  else await p[call](messages);
};
const failure = async (p: any, call: Call, messages: unknown[]): Promise<any> => { try { await run(p, call, messages); } catch (e) { return e; } };
const lastUser = (seen: Seen[]) => (seen.at(-1)!.body.messages as any[]).filter((m) => m.role === "user").at(-1);

const imageBlock = (media_type: string, data: string) => ({ type: "image", source: { type: "base64", media_type, data } });
const imagePart = (media_type: string, data: string) => ({ type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } });

// ---- OpenAI-compatible

// @spec LLM-VIS-002, LLM-VIS-010, LLM-VIS-011
test("openai-compatible: a user message with images sends one text part then one image_url data-URL part per image, on chat(), complete() and stream()", async () => {
  for (const call of calls) {
    const b = await serve("openai");
    const p = make("openai", b.url);
    await run(p, call, [{ role: "system", content: "persona" }, { role: "user", content: "what is this?", images: [JPEG, PNG] }]);
    assert.equal(b.seen.length, 1, call);
    assert.deepEqual(b.seen[0]!.body.messages, [
      { role: "system", content: "persona" },
      { role: "user", content: [{ type: "text", text: "what is this?" }, imagePart("image/jpeg", JPEG), imagePart("image/png", PNG)] },
    ], call);
    assert.equal(JSON.stringify(b.seen[0]!.body).includes('"images"'), false, `${call}: no images key in the body`);
  }
});

// @spec LLM-VIS-007
test("openai-compatible: a user message without images sends content as a string on chat(), complete() and stream(), as does one with an empty images array", async () => {
  for (const call of calls) {
    const b = await serve("openai");
    const p = make("openai", b.url);
    await run(p, call, [{ role: "user", content: "plain" }]);
    await run(p, call, [{ role: "user", content: "empty list", images: [] }]);
    assert.deepEqual(b.seen.map((s) => (s.body.messages as any[])[0].content), ["plain", "empty list"], call);
  }
});

// @spec LLM-VIS-002, LLM-VIS-007
test("openai-compatible: only the user message that has images turns into parts; the others in the history keep string content", async () => {
  const b = await serve("openai");
  await make("openai", b.url).chat([
    { role: "user", content: "first" }, { role: "assistant", content: "a reply" },
    { role: "user", content: "look", images: [GIF] }, { role: "user", content: "and then" },
  ]);
  assert.deepEqual(b.seen[0]!.body.messages, [
    { role: "user", content: "first" }, { role: "assistant", content: "a reply" },
    { role: "user", content: [{ type: "text", text: "look" }, imagePart("image/gif", GIF)] }, { role: "user", content: "and then" },
  ]);
});

// ---- Claude and Bedrock

// @spec LLM-VIS-003, LLM-VIS-012, LLM-VIS-013
test("claude and bedrock: a user message with images sends one base64 image block per image before the text block, on chat(), complete() and stream()", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const b = await serve(kind);
    const p = make(kind, b.url);
    await run(p, call, [{ role: "system", content: "persona" }, { role: "user", content: "what is this?", images: [JPEG, WEBP] }]);
    assert.equal(b.seen.length, 1, `${kind} ${call}`);
    const body = b.seen[0]!.body;
    assert.equal(body.system, "persona", `${kind} ${call}`);
    assert.deepEqual(body.messages, [
      { role: "user", content: [imageBlock("image/jpeg", JPEG), imageBlock("image/webp", WEBP), { type: "text", text: "what is this?" }] },
    ], `${kind} ${call}`);
  }
});

// @spec LLM-VIS-003
test("claude and bedrock: only the user message that has images becomes blocks; the others stay plain text turns", async () => {
  for (const kind of claudeKinds) {
    const b = await serve(kind);
    await make(kind, b.url).chat([
      { role: "user", content: "first" }, { role: "assistant", content: "a reply" }, { role: "user", content: "look", images: [PNG] },
    ]);
    assert.deepEqual(b.seen[0]!.body.messages, [
      { role: "user", content: "first" }, { role: "assistant", content: "a reply" },
      { role: "user", content: [imageBlock("image/png", PNG), { type: "text", text: "look" }] },
    ], kind);
  }
});

// ---- media type

// @spec LLM-VIS-004
test("each provider that needs a media type reads it from the leading bytes: JPEG, PNG, GIF and WebP", async () => {
  for (const kind of kinds) for (const [media, data] of FORMATS) {
    const b = await serve(kind);
    await make(kind, b.url).complete([{ role: "user", content: "look", images: [data] }]);
    const content = lastUser(b.seen).content as any[];
    const want = kind === "openai" ? imagePart(media, data) : imageBlock(media, data);
    assert.deepEqual(content.find((c) => c.type !== "text"), want, `${kind} ${media}`);
  }
});

// @spec LLM-VIS-004
test("the media type is per image: a message mixing formats labels each one by its own bytes, and the data is sent as given", async () => {
  for (const kind of kinds) {
    const b = await serve(kind);
    await make(kind, b.url).complete([{ role: "user", content: "look", images: [WEBP, GIF, JPEG, PNG] }]);
    const parts = (lastUser(b.seen).content as any[]).filter((c) => c.type !== "text");
    const want = [["image/webp", WEBP], ["image/gif", GIF], ["image/jpeg", JPEG], ["image/png", PNG]]
      .map(([m, d]) => (kind === "openai" ? imagePart(m!, d!) : imageBlock(m!, d!)));
    assert.deepEqual(parts, want, kind);
  }
});

// @spec LLM-VIS-005
test("data in none of the supported formats is a TypeError from chat() and complete() with no request sent, on openai-compatible, claude and bedrock", async () => {
  for (const kind of kinds) for (const call of ["chat", "complete"] as const) for (const [what, bad] of UNKNOWN) {
    const b = await serve(kind);
    const err = await failure(make(kind, b.url), call, [{ role: "user", content: "look", images: [bad] }]);
    assert.ok(err instanceof TypeError, `${kind} ${call} ${what}: got ${err}`);
    assert.equal(b.seen.length, 0, `${kind} ${call} ${what}: a request was sent`);
  }
});

// @spec LLM-VIS-005
test("stream() never throws synchronously on unknown image data; the TypeError comes from the first read, with no request sent", async () => {
  for (const kind of kinds) {
    const b = await serve(kind);
    const p = make(kind, b.url);
    let it: any;
    assert.doesNotThrow(() => { it = p.stream([{ role: "user", content: "look", images: ["QUJD"] }]); }, kind);
    let err: any;
    try { await it[Symbol.asyncIterator]().next(); } catch (e) { err = e; }
    assert.ok(err instanceof TypeError, `${kind}: got ${err}`);
    assert.equal(b.seen.length, 0, `${kind}: a request was sent`);
  }
});

// @spec LLM-VIS-005
test("one bad image among good ones fails the whole call before any request, wherever it sits in the history", async () => {
  for (const kind of kinds) for (const call of calls) {
    const b = await serve(kind);
    const p = make(kind, b.url);
    const hist = [
      { role: "user", content: "earlier", images: [JPEG] }, { role: "assistant", content: "seen" },
      { role: "user", content: "later", images: [PNG, "QUJD"] },
    ];
    assert.ok((await failure(p, call, hist)) instanceof TypeError, `${kind} ${call}`);
    assert.equal(b.seen.length, 0, `${kind} ${call}: a request was sent`);
  }
});

// @spec LLM-VIS-005
test("a rejected call leaves the provider usable: the next call with valid images is sent", async () => {
  for (const kind of kinds) {
    const b = await serve(kind);
    const p = make(kind, b.url);
    assert.ok((await failure(p, "complete", [{ role: "user", content: "look", images: ["QUJD"] }])) instanceof TypeError);
    await p.complete([{ role: "user", content: "look", images: [JPEG] }]);
    assert.equal(b.seen.length, 1, kind);
  }
});

// ---- Ollama

// @spec LLM-VIS-008
test("ollama: complete() sends the message's images array, as given, in the /api/chat body", async () => {
  const b = await serve("ollama");
  // Ollama needs no media type, so data the sniffer would refuse goes through unchanged (LLM-VIS-001).
  await make("ollama", b.url).complete([{ role: "user", content: "what is this?", images: [JPEG, "QUJD"] }]);
  assert.equal(b.seen[0]!.url, "/api/chat");
  assert.deepEqual(b.seen[0]!.body.messages, [{ role: "user", content: "what is this?", images: [JPEG, "QUJD"] }]);
});

// @spec LLM-VIS-009
test("ollama: stream() sends the message's images array, as given, in the /api/chat body", async () => {
  const b = await serve("ollama");
  await collect(make("ollama", b.url).stream([{ role: "user", content: "what is this?", images: [PNG, "QUJD"] }]));
  assert.equal(b.seen[0]!.url, "/api/chat");
  assert.equal(b.seen[0]!.body.stream, true);
  assert.deepEqual(b.seen[0]!.body.messages, [{ role: "user", content: "what is this?", images: [PNG, "QUJD"] }]);
});

// ---- large images, empty text, unconfigured providers

// @spec LLM-VIS-002, LLM-VIS-003, LLM-VIS-004
test("a valid 6 MB image is sent on every provider, read as its format, not refused for its length", async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 7);
  big.set([0xff, 0xd8, 0xff, 0xe0]);
  const data = big.toString("base64");
  for (const kind of kinds) {
    const b = await serve(kind);
    await make(kind, b.url).complete([{ role: "user", content: "look", images: [data] }]);
    const part = (lastUser(b.seen).content as any[]).find((c) => c.type !== "text");
    assert.deepEqual(part, kind === "openai" ? imagePart("image/jpeg", data) : imageBlock("image/jpeg", data), kind);
  }
});

// @spec LLM-VIS-002, LLM-VIS-012
test("a user message with images and empty content sends only the image parts: the empty text part or block is omitted", async () => {
  const b = await serve("openai");
  await make("openai", b.url).complete([{ role: "user", content: "", images: [PNG] }]);
  assert.deepEqual(lastUser(b.seen).content, [imagePart("image/png", PNG)]);
  for (const kind of claudeKinds) {
    const c = await serve(kind);
    await make(kind, c.url).complete([{ role: "user", content: "", images: [PNG] }]);
    assert.deepEqual(lastUser(c.seen).content, [imageBlock("image/png", PNG)], kind);
  }
});

// @spec LLM-VIS-005
test("bad image data on an unconfigured Claude or Bedrock provider is still a TypeError, not not_configured", async () => {
  const unconfigured: any[] = [
    new AnthropicProvider(llmCfg({ provider: "anthropic" })),
    new BedrockProvider(llmCfg({ provider: "bedrock" })),
  ];
  for (const p of unconfigured) {
    const bad = [{ role: "user" as const, content: "look", images: ["QUJD"] }];
    assert.ok((await failure(p, "chat", bad)) instanceof TypeError, p.name);
    assert.ok((await failure(p, "complete", bad)) instanceof TypeError, p.name);
  }
});
