// Streamed replies on Ollama and OpenAI-compatible (issue #160). `stream()` does not exist yet, so providers are read
// through `any`; every test here fails until the shared stream machinery lands.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama, ChatError } from "../src/index.js";

const TIMEOUT = 200; // llm.timeout_ms for the timeout tests
const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", timeout_ms: TIMEOUT, ...over });
const hello = [{ role: "user" as const, content: "hello" }];
const stopsAll = ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> };
type Out = { write(s: string): void; end(): void; destroy(): void; status(n: number): void; closed: Promise<void> };
/** A backend whose handler scripts each response by hand (chunks, stalls, drops). */
async function serve(script: (out: Out, n: number) => void | Promise<void>) {
  const seen: Seen[] = [];
  const s = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    let code = 200;
    const closed = new Promise<void>((r) => res.once("close", () => r()));
    const out: Out = {
      status: (n) => { code = n; },
      write: (c) => { if (!res.headersSent) res.writeHead(code, { "content-type": "text/event-stream" }); res.write(c); },
      end: () => { if (!res.headersSent) res.writeHead(code); res.end(); },
      destroy: () => { if (!res.headersSent) res.writeHead(code); res.flushHeaders(); res.socket?.destroy(); },
      closed,
    };
    await script(out, seen.length);
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => { s.closeAllConnections(); s.close(); });
  return { seen, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}

const nd = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ message: { content }, done: false, ...extra }) + "\n";
const ndDone = (reason = "stop") => JSON.stringify({ message: { content: "" }, done: true, done_reason: reason }) + "\n";
const sse = (delta: string | null, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: delta === null ? {} : { content: delta }, finish_reason: finish }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

type Kind = "ollama" | "openai";
const kinds: Kind[] = ["ollama", "openai"];
const make = (kind: Kind, url: string, over: Record<string, unknown> = {}): any =>
  kind === "ollama" ? new Ollama(llmCfg({ provider: "ollama", ...over }), url) : new OpenAICompatible(llmCfg({ openai: { base_url: `${url}/v1` }, ...over }));
const piece = (kind: Kind, s: string) => (kind === "ollama" ? nd(s) : sse(s));
const finish = (kind: Kind, reason = "stop") => (kind === "ollama" ? ndDone(reason) : sse(null, reason) + DONE);

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const textOf = (evs: any[]) => evs.filter((e) => e.type === "text").map((e) => e.delta).join("");
/** The error an iterator throws, or undefined. */
const failure = async (it: AsyncIterable<any>): Promise<any> => { try { await collect(it); } catch (e) { return e; } };
/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = net.createServer(); await new Promise<void>((r) => s.listen(0, r));
  const port = (s.address() as net.AddressInfo).port; await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

// @spec LLM-IF-008, LLM-IF-021
test("stream() is lazy: no request until first read, and it never throws synchronously", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "hi") + finish(kind)); o.end(); });
    const it = make(kind, b.url).stream(hello)[Symbol.asyncIterator]();
    await sleep(50);
    assert.equal(b.seen.length, 0, `${kind}: request sent before first read`);
    await it.next();
    assert.equal(b.seen.length, 1);
    // A wrongly built request and an unreachable backend both surface from the first read.
    const bad = make(kind, b.url);
    let iter: any;
    assert.doesNotThrow(() => { iter = bad.stream(null); });
    await assert.rejects(iter[Symbol.asyncIterator]().next());
    const unreachable = make(kind, await deadUrl());
    assert.doesNotThrow(() => unreachable.stream(hello));
  }
});

// @spec LLM-IF-009, LLM-STREAM-009
test("stream() delivers text events then exactly one done, last, whose text is the concatenation of the deltas", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "Hello") + piece(kind, ", chat") + finish(kind)); o.end(); });
    const evs = await collect(make(kind, b.url).stream(hello));
    assert.deepEqual(evs.map((e) => e.type), ["text", "text", "done"], kind);
    assert.equal(evs.filter((e) => e.type === "done").length, 1);
    assert.equal(evs.at(-1).result.text, "Hello, chat");
    assert.equal(textOf(evs), evs.at(-1).result.text);
    assert.deepEqual(evs.at(-1).result.toolCalls, []);
    assert.equal(evs.at(-1).result.finish, "stop");
  }
});

// @spec LLM-IF-010
test("ending a stream() loop early cancels the request quietly, by break and by return()", async () => {
  for (const kind of kinds) {
    let closed: Promise<void> | undefined;
    const b = await serve(async (o) => { closed = o.closed; o.write(piece(kind, "one")); await sleep(5000); });
    for await (const e of make(kind, b.url, { timeout_ms: 5000 }).stream(hello)) { assert.equal(e.type, "text"); break; }
    await Promise.race([closed, sleep(2000).then(() => assert.fail(`${kind}: request not cancelled`))]);

    let closed2: Promise<void> | undefined;
    const b2 = await serve(async (o) => { closed2 = o.closed; o.write(piece(kind, "one")); await sleep(5000); });
    const it = make(kind, b2.url, { timeout_ms: 5000 }).stream(hello)[Symbol.asyncIterator]();
    await it.next();
    assert.deepEqual(await it.return?.(), { value: undefined, done: true });
    await Promise.race([closed2, sleep(2000).then(() => assert.fail(`${kind}: request not cancelled by return()`))]);
  }
});

// @spec LLM-STREAM-001, LLM-STREAM-002
test("ollama: stream() posts /api/chat with stream:true and each non-empty content piece is a text event", async () => {
  const b = await serve((o) => { o.write(nd("He") + nd("") + nd("llo") + ndDone()); o.end(); });
  const evs = await collect(make("ollama", b.url).stream(hello));
  assert.equal(b.seen[0]!.url, "/api/chat");
  assert.equal(b.seen[0]!.body.stream, true);
  assert.deepEqual(evs.filter((e) => e.type === "text").map((e) => e.delta), ["He", "llo"]);
  assert.equal(evs.at(-1).result.text, "Hello");
});

// @spec LLM-STREAM-004, LLM-STREAM-005
test("openai-compatible: stream() sends stream:true and reads SSE data chunks until [DONE]; delta.content is a text event", async () => {
  const b = await serve((o) => { o.write(sse("He") + sse(null) + sse("llo") + sse(null, "stop") + DONE); o.end(); });
  const evs = await collect(make("openai", b.url).stream(hello));
  assert.equal(b.seen[0]!.url, "/v1/chat/completions");
  assert.equal(b.seen[0]!.body.stream, true);
  assert.deepEqual(evs.filter((e) => e.type === "text").map((e) => e.delta), ["He", "llo"]);
  assert.equal(evs.at(-1).result.text, "Hello");
});

// @spec LLM-STREAM-036
test("openai-compatible: a stream that ends after the finish_reason chunk without [DONE] completes normally", async () => {
  const b = await serve((o) => { o.write(sse("hi") + sse(null, "stop")); o.end(); });
  const evs = await collect(make("openai", b.url).stream(hello));
  assert.equal(evs.at(-1).type, "done");
  assert.equal(evs.at(-1).result.text, "hi");
});

// @spec LLM-STREAM-037, LLM-STREAM-022, LLM-STREAM-024
test("a stream that ends before its final event throws a ChatError of kind stream and delivers no done", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "partial") + (kind === "openai" ? DONE : "")); o.end(); });
    const seen: any[] = [];
    let err: any;
    try { for await (const e of make(kind, b.url).stream(hello)) seen.push(e); } catch (e) { err = e; }
    assert.ok(err instanceof ChatError, kind);
    assert.equal(err.kind, "stream");
    assert.equal(seen.some((e) => e.type === "done"), false);
    assert.equal(textOf(seen), "partial");
  }
});

// @spec LLM-STREAM-009, LLM-STREAM-010, LLM-STREAM-011
test("deltas are trimmed: leading whitespace dropped, trailing held back and released only if text follows", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => {
      o.write(piece(kind, "  \n") + piece(kind, " Hi") + piece(kind, " there ") + piece(kind, "\n") + piece(kind, "you ") + piece(kind, "  ") + finish(kind));
      o.end();
    });
    const evs = await collect(make(kind, b.url).stream(hello));
    const deltas = evs.filter((e) => e.type === "text").map((e) => e.delta);
    assert.deepEqual(deltas, ["Hi", " there", " \nyou"], kind);
    assert.equal(evs.at(-1).result.text, "Hi there \nyou");
    assert.equal(deltas.join(""), evs.at(-1).result.text);
    assert.notEqual(deltas[0]![0], " ");
  }
});

// @spec LLM-STREAM-028
test("a reply with no text (empty or only whitespace) gives no text event and a done with empty text", async () => {
  for (const kind of kinds) {
    for (const body of [finish(kind), piece(kind, "  \n ") + finish(kind)]) {
      const b = await serve((o) => { o.write(body); o.end(); });
      const evs = await collect(make(kind, b.url).stream(hello));
      assert.deepEqual(evs.map((e) => e.type), ["done"], kind);
      assert.equal(evs[0].result.text, "");
    }
  }
});

// @spec LLM-STREAM-014, LLM-STOP-012, LLM-STOP-014, LLM-STOP-018, LLM-CHAT-016, LLM-CHAT-022
test("stream() requests carry the non-streamed fields: stops, defaults, caller overrides, JSON mode", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "x") + finish(kind)); o.end(); });
    const p = make(kind, b.url, { temperature: 0.4, max_tokens: 77 });
    await collect(p.stream(hello));
    await collect(p.stream(hello, { temperature: 0.9, maxTokens: 5 }));
    await collect(p.stream(hello, { json: true }));
    const [def, over, json] = b.seen.map((s) => s.body);
    if (kind === "ollama") {
      assert.deepEqual(def.options.stop, stopsAll);
      assert.equal(def.options.temperature, 0.4); assert.equal(def.options.num_predict, 77);
      assert.equal(over.options.temperature, 0.9); assert.equal(over.options.num_predict, 5);
      assert.equal(def.format, undefined);
      assert.equal(json.format, "json"); assert.equal("stop" in json.options, false);
    } else {
      assert.deepEqual(def.stop, stopsAll);
      assert.equal(def.temperature, 0.4); assert.equal(def.max_tokens, 77);
      assert.equal(over.temperature, 0.9); assert.equal(over.max_tokens, 5);
      assert.equal("response_format" in def, false);
      assert.deepEqual(json.response_format, { type: "json_object" }); assert.equal("stop" in json, false);
    }
  }
});

// @spec LLM-STREAM-014
test("the adapter performs no cut of its own on streamed text (a blank line in the stream is delivered)", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "one\n\ntwo") + finish(kind)); o.end(); });
    const evs = await collect(make(kind, b.url).stream(hello));
    assert.equal(evs.at(-1).result.text, "one\n\ntwo");
  }
});

// @spec LLM-CHAT-014
test("openai-compatible: stream() sends the bearer token when llm.openai.api_key is set and no authorization otherwise", async () => {
  const b = await serve((o) => { o.write(sse("x") + sse(null, "stop") + DONE); o.end(); });
  await collect(make("openai", b.url, { openai: { base_url: `${b.url}/v1`, api_key: "sk-test" } }).stream(hello));
  await collect(make("openai", b.url, { openai: { base_url: `${b.url}/v1`, api_key: "" } }).stream(hello));
  assert.equal(b.seen[0]!.headers.authorization, "Bearer sk-test");
  assert.equal(b.seen[1]!.headers.authorization, undefined);
});

// @spec LLM-STREAM-015, LLM-STREAM-018
test("no output within llm.timeout_ms of the request throws a TimeoutError, with or without a caller signal", async () => {
  for (const kind of kinds) {
    const b = await serve(async (o) => { o.write(kind === "openai" ? ": keepalive\n\n" : ""); await sleep(3000); });
    for (const opts of [undefined, { signal: new AbortController().signal }]) {
      const t0 = Date.now();
      const err = await failure(make(kind, b.url).stream(hello, opts));
      assert.equal(err?.name, "TimeoutError", `${kind} ${opts ? "with" : "without"} signal`);
      assert.ok(Date.now() - t0 < 2000);
    }
  }
});

// @spec LLM-STREAM-015
test("held-back whitespace counts as first output, so a short pause after it is not a first-output failure", async () => {
  const b = await serve(async (o) => { o.write(sse("  ")); await sleep(120); o.write(sse("ok") + sse(null, "stop") + DONE); o.end(); });
  const evs = await collect(make("openai", b.url, { timeout_ms: 300 }).stream(hello));
  assert.equal(evs.at(-1).result.text, "ok");
});

// @spec LLM-STREAM-016, LLM-STREAM-018
test("a gap of llm.timeout_ms between events after the first output throws a TimeoutError, also with a signal", async () => {
  for (const kind of kinds) {
    const b = await serve(async (o) => { o.write(piece(kind, "start")); await sleep(3000); });
    for (const opts of [undefined, { signal: new AbortController().signal }]) {
      const seen: any[] = [];
      let err: any;
      try { for await (const e of make(kind, b.url).stream(hello, opts)) seen.push(e); } catch (e) { err = e; }
      assert.equal(err?.name, "TimeoutError", kind);
      assert.equal(textOf(seen), "start");
      assert.equal(seen.some((e) => e.type === "done"), false);
    }
  }
});

// @spec LLM-STREAM-016
test("a keepalive counts as an event for the between-events bound", async () => {
  const b = await serve(async (o) => {
    o.write(sse("a"));
    for (let i = 0; i < 4; i++) { await sleep(120); o.write(": keepalive\n\n"); }
    o.write(sse("b") + sse(null, "stop") + DONE); o.end();
  });
  const evs = await collect(make("openai", b.url, { timeout_ms: 250 }).stream(hello));
  assert.equal(evs.at(-1).result.text, "ab");
});

// @spec LLM-STREAM-019
test("a reply whose events keep arriving within llm.timeout_ms is not ended for its total duration", async () => {
  const b = await serve(async (o) => {
    for (let i = 0; i < 8; i++) { o.write(sse(`w${i} `)); await sleep(100); }
    o.write(sse(null, "stop") + DONE); o.end();
  });
  const t0 = Date.now();
  const evs = await collect(make("openai", b.url, { timeout_ms: 250 }).stream(hello));
  assert.ok(Date.now() - t0 > 250, "the reply outlasts one timeout");
  assert.equal(evs.at(-1).result.text, "w0 w1 w2 w3 w4 w5 w6 w7");
});

// @spec LLM-STREAM-034, LLM-STREAM-035
test("time the caller spends between reads is not counted by either clock", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "a") + piece(kind, "b") + finish(kind)); o.end(); });
    const it = make(kind, b.url, { timeout_ms: 150 }).stream(hello)[Symbol.asyncIterator]();
    await sleep(400); // before the first read: first-output clock not running
    const first = await it.next();
    assert.equal(first.value.type, "text");
    await sleep(400); // between reads: between-events clock not running
    const rest: any[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) { rest.push(r.value); await sleep(200); }
    assert.equal(rest.at(-1).result.text, "ab", kind);
  }
});

// @spec LLM-STREAM-020, LLM-ERR-001, LLM-CHAT-020
test("a non-2xx answer before any event throws a ChatError of kind http with the status, after one request and no retry", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.status(503); o.write("upstream down"); o.end(); });
    const err = await failure(make(kind, b.url).stream(hello));
    assert.ok(err instanceof ChatError, kind);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 503);
    await sleep(100);
    assert.equal(b.seen.length, 1);
  }
});

// @spec LLM-ERR-004
test("a 400 naming tools or images is a plain http ChatError with that status", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.status(400); o.write('{"error":"this model does not support tools or images"}'); o.end(); });
    const err = await failure(make(kind, b.url).stream(hello));
    assert.ok(err instanceof ChatError);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 400);
    assert.equal(b.seen.length, 1);
  }
});

// @spec LLM-STREAM-023, LLM-STREAM-024
test("a chunk that cannot be parsed throws a ChatError of kind stream and delivers no done", async () => {
  for (const kind of kinds) {
    const bad = kind === "ollama" ? "{not json\n" : "data: {not json\n\n";
    const b = await serve((o) => { o.write(piece(kind, "ok") + bad + finish(kind)); o.end(); });
    const seen: any[] = [];
    let err: any;
    try { for await (const e of make(kind, b.url).stream(hello)) seen.push(e); } catch (e) { err = e; }
    assert.ok(err instanceof ChatError, kind);
    assert.equal(err.kind, "stream");
    assert.equal(seen.some((e) => e.type === "done"), false);
  }
});

// @spec LLM-STREAM-025, LLM-ERR-001, LLM-CHAT-020
test("a connection dropped after the response began throws kind stream and is not retried", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(piece(kind, "half")); setTimeout(() => o.destroy(), 30); });
    const seen: any[] = [];
    let err: any;
    try { for await (const e of make(kind, b.url).stream(hello)) seen.push(e); } catch (e) { err = e; }
    assert.ok(err instanceof ChatError, kind);
    assert.equal(err.kind, "stream");
    assert.equal(textOf(seen), "half");
    await sleep(100);
    assert.equal(b.seen.length, 1);
  }
});

// @spec LLM-STREAM-026, LLM-ERR-006
test("aborting the caller's signal throws the caller's abort reason, not a ChatError", async () => {
  for (const kind of kinds) {
    const b = await serve(async (o) => { o.write(piece(kind, "x")); await sleep(3000); });
    const ac = new AbortController();
    const reason = new Error("caller gave up");
    const it = make(kind, b.url, { timeout_ms: 5000 }).stream(hello, { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    ac.abort(reason);
    await assert.rejects(pending, (e: unknown) => e === reason);
  }
});

// @spec LLM-ERR-008, LLM-ERR-001
test("a refused connection throws a ChatError of kind connect with no status", async () => {
  for (const kind of kinds) {
    const err = await failure(make(kind, await deadUrl()).stream(hello));
    assert.ok(err instanceof ChatError, kind);
    assert.equal(err.kind, "connect");
    assert.equal(err.status, undefined);
  }
});

// @spec LLM-PING-007
test("a failed stream() leaves lastError unchanged", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.status(500); o.write("boom"); o.end(); });
    const p = make(kind, b.url);
    p.lastError = "earlier ping failure";
    await failure(p.stream(hello));
    assert.equal(p.lastError, "earlier ping failure");
    const q = make(kind, b.url); // lastError never set stays unset
    await failure(q.stream(hello));
    assert.equal(q.lastError, undefined);
  }
});
