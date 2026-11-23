// Tool calls on Ollama and OpenAI-compatible, and the provider-independent tool rules (issue #162).
// Tools are not carried across the boundary yet, so every test here fails until they are. Providers are read through `any`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConfigSchema } from "@cohost/config";
import { OpenAICompatible, Ollama } from "../src/index.js";

const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });
const hello = [{ role: "user" as const, content: "hello" }];
const stopsAll = ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const weather = { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } };
const clock = { name: "get-time", description: "Current time", parameters: { type: "object", properties: {} } };

type Kind = "ollama" | "openai";
const kinds: Kind[] = ["ollama", "openai"];
const make = (kind: Kind, url: string, over: Record<string, unknown> = {}): any =>
  kind === "ollama" ? new Ollama(llmCfg({ provider: "ollama", ...over }), url) : new OpenAICompatible(llmCfg({ openai: { base_url: `${url}/v1` }, ...over }));

type Seen = { url: string; body: Record<string, any> };
type Out = { write(s: string): void; end(): void };
/** A backend that records requests and scripts each response by hand. */
async function serve(script: (out: Out, n: number) => void | Promise<void>) {
  const seen: Seen[] = [];
  const s = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
    const out: Out = {
      write: (c) => { if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" }); res.write(c); },
      end: () => { if (!res.headersSent) res.writeHead(200); res.end(); },
    };
    await script(out, seen.length);
  });
  await new Promise<void>((r) => s.listen(0, r));
  after(() => { s.closeAllConnections(); s.close(); });
  return { seen, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}
/** A backend answering every request with one JSON body. */
const json = (body: unknown) => serve((o) => { o.write(JSON.stringify(body)); o.end(); });

/** The non-streamed body each provider kind reads. `calls` use the wire form of that kind. */
const ollamaBody = (content: string, calls: unknown[] | undefined, reason = "stop") =>
  ({ message: { content, ...(calls ? { tool_calls: calls } : {}) }, done: true, done_reason: reason });
const openaiBody = (content: string | null, calls: unknown[] | undefined, reason = "stop") =>
  ({ choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: reason }] });
const oCall = (name: string, args: unknown) => ({ function: { name, arguments: args } });
const aCall = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } };

// ---- checks before any request

// @spec LLM-TOOL-001
test("a tool name outside [A-Za-z0-9_-]{1,64} is a TypeError from complete() and from the first read of stream(), with no request sent", async () => {
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("ok", undefined) : openaiBody("ok", undefined));
    const p = make(kind, b.url);
    for (const name of ["", "has space", "dot.name", "x".repeat(65), "café", "a/b"]) {
      const tools = [{ ...weather, name }];
      assert.ok((await failure(p.complete(hello, { tools }))) instanceof TypeError, `${kind} complete ${JSON.stringify(name)}`);
      let it: any;
      assert.doesNotThrow(() => { it = p.stream(hello, { tools }); });
      assert.ok((await failure(it[Symbol.asyncIterator]().next())) instanceof TypeError, `${kind} stream ${JSON.stringify(name)}`);
    }
    // A bad name among good ones still fails; the boundary names pass.
    assert.ok((await failure(p.complete(hello, { tools: [weather, { ...clock, name: "bad name" }] }))) instanceof TypeError);
    assert.equal(b.seen.length, 0, `${kind}: a request was sent`);
    await p.complete(hello, { tools: [{ ...weather, name: "x".repeat(64) }, { ...weather, name: "A-z_9" }] });
    assert.equal(b.seen.length, 1);
  }
});

// @spec LLM-TOOL-002
test("json:true with a non-empty tools array is a TypeError from complete() and stream(), with no request sent", async () => {
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("ok", undefined) : openaiBody("ok", undefined));
    const p = make(kind, b.url);
    assert.ok((await failure(p.complete(hello, { json: true, tools: [weather] }))) instanceof TypeError, `${kind} complete`);
    let it: any;
    assert.doesNotThrow(() => { it = p.stream(hello, { json: true, tools: [weather] }); });
    assert.ok((await failure(it[Symbol.asyncIterator]().next())) instanceof TypeError, `${kind} stream`);
    assert.equal(b.seen.length, 0, `${kind}: a request was sent`);
  }
});

// @spec LLM-TOOL-026, LLM-STOP-019
test("tools: [] is no tools: json:true does not fail, no tools key is sent, and the normal stops are sent", async () => {
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("{}", undefined) : openaiBody("{}", undefined));
    const p = make(kind, b.url);
    await p.complete(hello, { json: true, tools: [] });
    assert.equal("tools" in b.seen[0]!.body, false, `${kind} json: tools key sent`);
    if (kind === "ollama") assert.equal(b.seen[0]!.body.format, "json");
    else assert.deepEqual(b.seen[0]!.body.response_format, { type: "json_object" });
    // A reply call with an empty array sends the stops of a call without tools.
    await p.complete(hello, { tools: [] });
    const stops = kind === "ollama" ? b.seen[1]!.body.options.stop : b.seen[1]!.body.stop;
    assert.deepEqual(stops, stopsAll, `${kind} complete`);
    assert.equal("tools" in b.seen[1]!.body, false);
  }
  for (const kind of kinds) {
    const b = await serve((o) => {
      o.write(kind === "ollama" ? JSON.stringify(ollamaBody("hi", undefined)) + "\n"
        : `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      o.end();
    });
    await collect(make(kind, b.url).stream(hello, { tools: [] }));
    const stops = kind === "ollama" ? b.seen[0]!.body.options.stop : b.seen[0]!.body.stop;
    assert.deepEqual(stops, stopsAll, `${kind} stream`);
    assert.equal("tools" in b.seen[0]!.body, false);
  }
});

// @spec LLM-STOP-008, LLM-STOP-009
test("with a non-empty tools array no stop key is sent, from complete() and stream()", async () => {
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("ok", undefined) : openaiBody("ok", undefined));
    await make(kind, b.url).complete(hello, { tools: [weather] });
    const body = b.seen[0]!.body;
    if (kind === "ollama") assert.equal("stop" in (body.options ?? {}), false, "ollama options.stop");
    else assert.equal("stop" in body, false, "openai stop");
    const s = await serve((o) => {
      o.write(kind === "ollama" ? JSON.stringify(ollamaBody("hi", undefined)) + "\n"
        : `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      o.end();
    });
    await collect(make(kind, s.url).stream(hello, { tools: [weather] }));
    const sb = s.seen[0]!.body;
    if (kind === "ollama") assert.equal("stop" in (sb.options ?? {}), false, "ollama stream options.stop");
    else assert.equal("stop" in sb, false, "openai stream stop");
  }
});

// ---- definitions out

// @spec LLM-TOOL-003, LLM-TOOL-006
test("tools go out as [{type:'function', function:{name, description, parameters}}] on Ollama and OpenAI-compatible, complete() and stream()", async () => {
  const want = [weather, clock].map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("ok", undefined) : openaiBody("ok", undefined));
    await make(kind, b.url).complete(hello, { tools: [weather, clock] });
    assert.deepEqual(b.seen[0]!.body.tools, want, `${kind} complete`);
    const s = await serve((o) => {
      o.write(kind === "ollama" ? JSON.stringify(ollamaBody("hi", undefined)) + "\n"
        : `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      o.end();
    });
    await collect(make(kind, s.url).stream(hello, { tools: [weather, clock] }));
    assert.deepEqual(s.seen[0]!.body.tools, want, `${kind} stream`);
    assert.equal("tool_choice" in s.seen[0]!.body, false);
  }
});

// ---- calls back

// @spec LLM-TOOL-004, LLM-TOOL-024, LLM-IF-013, LLM-IF-019
test("ollama: calls come from message.tool_calls[].function, in order, with ids unique in the reply; finish is tool_calls with or without text", async () => {
  const calls = [oCall("get_weather", { city: "Oslo" }), oCall("get_weather", { city: "Rome" }), oCall("get-time", {})];
  for (const text of ["  I will check. ", ""]) {
    const b = await json(ollamaBody(text, calls));
    const r = await make("ollama", b.url).complete(hello, { tools: [weather, clock] });
    assert.deepEqual(r.toolCalls.map((c: any) => [c.name, c.arguments]), [["get_weather", { city: "Oslo" }], ["get_weather", { city: "Rome" }], ["get-time", {}]]);
    const ids = r.toolCalls.map((c: any) => c.id);
    assert.ok(ids.every((i: unknown) => typeof i === "string" && i.length > 0));
    assert.equal(new Set(ids).size, 3, "ids are unique within the reply");
    for (const c of r.toolCalls) assert.equal("invalid" in c, false);
    assert.equal(r.finish, "tool_calls");
    assert.equal(r.text, text.trim());
    assert.deepEqual(r.message.toolCalls, r.toolCalls);
  }
});

// @spec LLM-TOOL-007, LLM-TOOL-020, LLM-TOOL-024, LLM-IF-013, LLM-IF-017
test("openai-compatible: arguments strings are parsed, backend ids kept, calls in order; finish_reason tool_calls gives tool_calls", async () => {
  const b = await json(openaiBody(null, [aCall("call_9", "get_weather", '{"city":"Oslo"}'), aCall("call_2", "get-time", "{}")], "tool_calls"));
  const r = await make("openai", b.url).complete(hello, { tools: [weather, clock] });
  assert.deepEqual(r.toolCalls, [
    { id: "call_9", name: "get_weather", arguments: { city: "Oslo" } },
    { id: "call_2", name: "get-time", arguments: {} },
  ]);
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.text, "");
  assert.deepEqual(r.message.toolCalls, r.toolCalls);
  const t = await json(openaiBody("Checking.", [aCall("c1", "get_weather", '{"city":"x"}')], "tool_calls"));
  const w = await make("openai", t.url).complete(hello, { tools: [weather] });
  assert.equal(w.text, "Checking.");
  assert.equal(w.finish, "tool_calls");
});

// @spec LLM-TOOL-021, LLM-IF-015
test("a model offered tools that asks for none returns its text with an empty toolCalls and no toolCalls on the message", async () => {
  for (const kind of kinds) {
    const b = await json(kind === "ollama" ? ollamaBody("just words", undefined) : openaiBody("just words", undefined));
    const r = await make(kind, b.url).complete(hello, { tools: [weather] });
    assert.equal(r.text, "just words");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finish, "stop");
    assert.equal("toolCalls" in r.message, false);
    // An empty tool_calls array is no calls.
    const e = await json(kind === "ollama" ? ollamaBody("w", []) : openaiBody("w", []));
    const q = await make(kind, e.url).complete(hello, { tools: [weather] });
    assert.deepEqual(q.toolCalls, []);
    assert.equal(q.finish, "stop");
  }
});

// ---- arguments

// @spec LLM-TOOL-016, LLM-TOOL-029
test("openai-compatible: arguments that are not a JSON object give {} plus invalid; an empty or whitespace string gives {} and no invalid", async () => {
  const b = await json(openaiBody(null, [
    aCall("a", "get_weather", "not json"),
    aCall("b", "get_weather", '{"city":'),
    aCall("c", "get_weather", "[1,2]"),
    aCall("d", "get_weather", "42"),
    aCall("e", "get_weather", ""),
    aCall("f", "get_weather", "  \n\t"),
    aCall("g", "get_weather", '{"city":"Oslo"}'),
  ], "tool_calls"));
  const r = await make("openai", b.url).complete(hello, { tools: [weather] });
  const by = Object.fromEntries(r.toolCalls.map((c: any) => [c.id, c]));
  assert.deepEqual(by.a, { id: "a", name: "get_weather", arguments: {}, invalid: "not json" });
  assert.deepEqual(by.b, { id: "b", name: "get_weather", arguments: {}, invalid: '{"city":' });
  assert.deepEqual(by.c, { id: "c", name: "get_weather", arguments: {}, invalid: "[1,2]" });
  assert.deepEqual(by.d, { id: "d", name: "get_weather", arguments: {}, invalid: "42" });
  for (const id of ["e", "f"]) {
    assert.deepEqual(by[id].arguments, {}, id);
    assert.equal("invalid" in by[id], false, id);
  }
  assert.deepEqual(by.g.arguments, { city: "Oslo" });
  assert.equal(r.toolCalls.length, 7, "no call is lost");
});

// @spec LLM-TOOL-016, LLM-TOOL-029
test("ollama: arguments that are not an object give {} plus invalid; an empty or whitespace string gives {} and no invalid", async () => {
  const b = await json(ollamaBody("", [oCall("get_weather", "not json"), oCall("get_weather", " "), oCall("get_weather", '{"city":"Oslo"}'), oCall("get_weather", { city: "Rome" })]));
  const r = await make("ollama", b.url).complete(hello, { tools: [weather] });
  assert.deepEqual(r.toolCalls.map((c: any) => [c.arguments, c.invalid]), [[{}, "not json"], [{}, undefined], [{ city: "Oslo" }, undefined], [{ city: "Rome" }, undefined]]);
  assert.equal("invalid" in r.toolCalls[1], false);
});

// @spec LLM-TOOL-016, LLM-TOOL-029
test("streamed arguments follow the same parsing on both providers", async () => {
  const o = await serve((out) => {
    out.write(JSON.stringify({ message: { content: "", tool_calls: [oCall("get_weather", "oops"), oCall("get_weather", "")] }, done: false }) + "\n");
    out.write(JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" }) + "\n");
    out.end();
  });
  const evo = await collect(make("ollama", o.url).stream(hello, { tools: [weather] }));
  const co = evo.filter((e) => e.type === "tool_call").map((e) => e.call);
  assert.deepEqual(co.map((c: any) => [c.arguments, c.invalid]), [[{}, "oops"], [{}, undefined]]);
  assert.equal("invalid" in co[1], false);

  const frag = (i: number, d: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, ...d }] }, finish_reason: finish }] })}\n\n`;
  const a = await serve((out) => {
    out.write(frag(0, { id: "x", type: "function", function: { name: "get_weather", arguments: "{bad" } }));
    out.write(frag(1, { id: "y", type: "function", function: { name: "get_weather", arguments: "  " } }));
    out.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    out.end();
  });
  const eva = await collect(make("openai", a.url).stream(hello, { tools: [weather] }));
  const ca = eva.filter((e) => e.type === "tool_call").map((e) => e.call);
  assert.deepEqual(ca, [{ id: "x", name: "get_weather", arguments: {}, invalid: "{bad" }, { id: "y", name: "get_weather", arguments: {} }]);
});

// ---- results forward

const asstWith = (content: string, toolCalls: any[]) => ({ role: "assistant" as const, content, toolCalls });
const results = [
  { role: "tool" as const, callId: "c1", name: "get_weather", content: "rain" },
  { role: "tool" as const, callId: "c2", name: "get-time", content: "boom", isError: true },
];

// @spec LLM-TOOL-005, LLM-TOOL-018, LLM-TOOL-019, LLM-TOOL-025, LLM-TOOL-028
test("ollama: an assistant message with calls and empty content sends content '', each result is its own {role:'tool', tool_name, content} in order, isError content as given", async () => {
  const b = await json(ollamaBody("done", undefined));
  const history = [
    ...hello,
    asstWith("", [{ id: "c1", name: "get_weather", arguments: { city: "Oslo" } }, { id: "c2", name: "get-time", arguments: {} }]),
    ...results,
  ];
  await make("ollama", b.url).complete(history, { tools: [weather, clock] });
  const msgs = b.seen[0]!.body.messages;
  assert.deepEqual(msgs.slice(-2), [
    { role: "tool", tool_name: "get_weather", content: "rain" },
    { role: "tool", tool_name: "get-time", content: "boom" },
  ]);
  const a = msgs.at(-3);
  assert.equal(a.role, "assistant");
  assert.equal(a.content, "");
  assert.deepEqual(a.tool_calls.map((c: any) => [c.function.name, c.function.arguments]), [["get_weather", { city: "Oslo" }], ["get-time", {}]]);
});

// @spec LLM-TOOL-008, LLM-TOOL-009, LLM-TOOL-018, LLM-TOOL-019, LLM-TOOL-025, LLM-TOOL-027
test("openai-compatible: assistant calls go back with arguments as JSON strings and content null when empty; each result is {role:'tool', tool_call_id, content} in order", async () => {
  const b = await json(openaiBody("done", undefined));
  const calls = [{ id: "c1", name: "get_weather", arguments: { city: "Oslo" } }, { id: "c2", name: "get-time", arguments: {} }];
  await make("openai", b.url).complete([...hello, asstWith("", calls), ...results], { tools: [weather, clock] });
  const msgs = b.seen[0]!.body.messages;
  assert.deepEqual(msgs.slice(-2), [
    { role: "tool", tool_call_id: "c1", content: "rain" },
    { role: "tool", tool_call_id: "c2", content: "boom" },
  ]);
  const a = msgs.at(-3);
  assert.equal(a.role, "assistant");
  assert.equal(a.content, null);
  assert.equal(a.tool_calls.length, 2);
  assert.deepEqual(a.tool_calls.map((c: any) => [c.id, c.type, c.function.name]), [["c1", "function", "get_weather"], ["c2", "function", "get-time"]]);
  assert.deepEqual(a.tool_calls.map((c: any) => JSON.parse(c.function.arguments)), [{ city: "Oslo" }, {}]);
  assert.equal(typeof a.tool_calls[0].function.arguments, "string");
  // Non-empty content stays a string.
  const b2 = await json(openaiBody("done", undefined));
  await make("openai", b2.url).complete([...hello, asstWith("Let me look.", calls.slice(0, 1)), results[0]!], { tools: [weather] });
  assert.equal(b2.seen[0]!.body.messages.at(-2).content, "Let me look.");
});

// @spec LLM-TOOL-017
test("an assistant call with invalid goes back to the model with arguments {} on both providers", async () => {
  const bad = { id: "c1", name: "get_weather", arguments: {}, invalid: "{oops" };
  const history = [...hello, asstWith("", [bad]), { role: "tool" as const, callId: "c1", name: "get_weather", content: "arguments were not JSON", isError: true }];
  const o = await json(ollamaBody("ok", undefined));
  await make("ollama", o.url).complete(history, { tools: [weather] });
  const oa = o.seen[0]!.body.messages.find((m: any) => m.role === "assistant");
  assert.deepEqual(oa.tool_calls[0].function.arguments, {});
  assert.doesNotMatch(JSON.stringify(o.seen[0]!.body.messages.filter((m: any) => m.role !== "tool")), /oops/);
  const a = await json(openaiBody("ok", undefined));
  await make("openai", a.url).complete(history, { tools: [weather] });
  const aa = a.seen[0]!.body.messages.find((m: any) => m.role === "assistant");
  assert.equal(aa.tool_calls[0].function.arguments, "{}");
  assert.doesNotMatch(JSON.stringify(aa), /oops/);
});

// ---- finish

// @spec LLM-IF-016, LLM-IF-019
test("ollama: done_reason length beats tool_calls and the completed calls are kept; done_reason stop with calls is tool_calls", async () => {
  const b = await json(ollamaBody("", [oCall("get_weather", { city: "Oslo" })], "length"));
  const r = await make("ollama", b.url).complete(hello, { tools: [weather] });
  assert.equal(r.finish, "length");
  assert.equal(r.toolCalls.length, 1);
  const s = await json(ollamaBody("", [oCall("get_weather", { city: "Oslo" })], "stop"));
  assert.equal((await make("ollama", s.url).complete(hello, { tools: [weather] })).finish, "tool_calls");
});

// @spec LLM-IF-016, LLM-IF-017, LLM-TOOL-022
test("openai-compatible: finish_reason length beats tool_calls; a call whose arguments the cap cut off is dropped and the completed calls kept", async () => {
  const b = await json(openaiBody("", [aCall("a", "get_weather", '{"city":"Oslo"}'), aCall("b", "get_weather", '{"city":"Ro')], "length"));
  const r = await make("openai", b.url).complete(hello, { tools: [weather] });
  assert.equal(r.finish, "length");
  assert.deepEqual(r.toolCalls, [{ id: "a", name: "get_weather", arguments: { city: "Oslo" } }]);
  assert.deepEqual(r.message.toolCalls, r.toolCalls);
  // Only the cut call is dropped: a complete call after length with valid arguments stays.
  const c = await json(openaiBody("", [aCall("a", "get_weather", '{"city":"Oslo"}')], "length"));
  const k = await make("openai", c.url).complete(hello, { tools: [weather] });
  assert.equal(k.finish, "length");
  assert.equal(k.toolCalls.length, 1);
  // A cap that cut the only call leaves no calls and no toolCalls on the message.
  const d = await json(openaiBody("partial", [aCall("a", "get_weather", '{"ci')], "length"));
  const z = await make("openai", d.url).complete(hello, { tools: [weather] });
  assert.deepEqual(z.toolCalls, []);
  assert.equal(z.finish, "length");
  assert.equal("toolCalls" in z.message, false);
});

// ---- streamed calls

const olLine = (content: string, calls?: unknown[]) =>
  JSON.stringify({ message: { content, ...(calls ? { tool_calls: calls } : {}) }, done: false }) + "\n";
const olEnd = (reason = "stop") => JSON.stringify({ message: { content: "" }, done: true, done_reason: reason }) + "\n";
const frag = (i: number | undefined, d: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ ...(i === undefined ? {} : { index: i }), ...d }] }, finish_reason: null }] })}\n\n`;
const txt = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: null }] })}\n\n`;
const fin = (reason: string) => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;

// @spec LLM-STREAM-003, LLM-STREAM-012, LLM-STREAM-032, LLM-TOOL-004, LLM-TOOL-024, LLM-IF-013, LLM-IF-019
test("ollama stream: calls are delivered after every text event, in order, immediately before done, with unique ids; done.result.toolCalls equals them", async () => {
  const b = await serve((o) => {
    o.write(olLine("Let me ", [oCall("get_weather", { city: "Oslo" })])); // a call line before the last text
    o.write(olLine("check."));
    o.write(olLine("", [oCall("get-time", {}), oCall("get_weather", { city: "Rome" })]));
    o.write(olEnd());
    o.end();
  });
  const evs = await collect(make("ollama", b.url).stream(hello, { tools: [weather, clock] }));
  assert.deepEqual(evs.map((e) => e.type), ["text", "text", "tool_call", "tool_call", "tool_call", "done"]);
  const calls = evs.filter((e) => e.type === "tool_call").map((e) => e.call);
  assert.deepEqual(calls.map((c: any) => [c.name, c.arguments]), [["get_weather", { city: "Oslo" }], ["get-time", {}], ["get_weather", { city: "Rome" }]]);
  assert.equal(new Set(calls.map((c: any) => c.id)).size, 3);
  const done = evs.at(-1);
  assert.deepEqual(done.result.toolCalls, calls);
  assert.equal(done.result.finish, "tool_calls");
  assert.equal(done.result.text, "Let me check.");
  assert.deepEqual(done.result.message.toolCalls, calls);
});

// @spec LLM-STREAM-006, LLM-STREAM-012, LLM-STREAM-032, LLM-TOOL-007, LLM-TOOL-020, LLM-TOOL-023, LLM-IF-013, LLM-IF-017
test("openai stream: fragments are assembled by index, held until finish_reason arrives, then delivered in index order after the text and before done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = await serve(async (o) => {
    o.write(txt("Checking"));
    o.write(frag(1, { id: "id1", type: "function", function: { name: "get-time", arguments: "" } }));
    o.write(frag(0, { id: "id0", type: "function", function: { name: "get_weather", arguments: '{"ci' } }));
    o.write(frag(1, { function: { arguments: "{}" } }));
    o.write(frag(0, { function: { arguments: 'ty":"Os' } }));
    o.write(txt("."));
    o.write(frag(0, { function: { arguments: 'lo"}' } }));
    await gate;
    o.write(fin("tool_calls"));
    o.end();
  });
  const it = make("openai", b.url).stream(hello, { tools: [weather, clock] })[Symbol.asyncIterator]();
  const evs: any[] = [];
  evs.push((await it.next()).value, (await it.next()).value);
  assert.deepEqual(evs.map((e) => e.type), ["text", "text"]);
  const pending = it.next();
  const early = await Promise.race([pending.then(() => "event"), sleep(150).then(() => "none")]);
  assert.equal(early, "none", "a call was delivered before finish_reason arrived");
  release();
  for (let r = await pending; !r.done; r = await it.next()) evs.push(r.value);
  assert.deepEqual(evs.map((e) => e.type), ["text", "text", "tool_call", "tool_call", "done"]);
  const calls = evs.filter((e) => e.type === "tool_call").map((e) => e.call);
  assert.deepEqual(calls, [
    { id: "id0", name: "get_weather", arguments: { city: "Oslo" } },
    { id: "id1", name: "get-time", arguments: {} },
  ]);
  assert.deepEqual(evs.at(-1).result.toolCalls, calls);
  assert.equal(evs.at(-1).result.finish, "tool_calls");
  assert.equal(evs.at(-1).result.text, "Checking.");
});

// @spec LLM-TOOL-022, LLM-TOOL-023, LLM-IF-016, LLM-IF-017, LLM-STREAM-032
test("openai stream: a call the cap cut off is never delivered; completed calls are, and done finishes length with the same calls", async () => {
  const b = await serve((o) => {
    o.write(frag(0, { id: "a", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }));
    o.write(frag(1, { id: "b", type: "function", function: { name: "get_weather", arguments: '{"city":"Ro' } }));
    o.write(fin("length"));
    o.end();
  });
  const evs = await collect(make("openai", b.url).stream(hello, { tools: [weather] }));
  assert.deepEqual(evs.map((e) => e.type), ["tool_call", "done"]);
  assert.deepEqual(evs[0].call, { id: "a", name: "get_weather", arguments: { city: "Oslo" } });
  assert.equal(evs[1].result.finish, "length");
  assert.deepEqual(evs[1].result.toolCalls, [evs[0].call]);
  assert.equal(evs[1].result.message.toolCalls?.length, 1);
});

// @spec LLM-IF-016, LLM-IF-019, LLM-STREAM-003
test("ollama stream: done_reason length with calls finishes length and still delivers the calls", async () => {
  const b = await serve((o) => { o.write(olLine("", [oCall("get_weather", { city: "Oslo" })])); o.write(olEnd("length")); o.end(); });
  const evs = await collect(make("ollama", b.url).stream(hello, { tools: [weather] }));
  assert.deepEqual(evs.map((e) => e.type), ["tool_call", "done"]);
  assert.equal(evs[1].result.finish, "length");
  assert.deepEqual(evs[1].result.toolCalls, [evs[0].call]);
});

// @spec LLM-TOOL-021, LLM-STREAM-032
test("stream: a model offered tools that asks for none gives text then done with an empty toolCalls, on both providers", async () => {
  for (const kind of kinds) {
    const b = await serve((o) => { o.write(kind === "ollama" ? olLine("hi") + olEnd() : txt("hi") + fin("stop")); o.end(); });
    const evs = await collect(make(kind, b.url).stream(hello, { tools: [weather] }));
    assert.deepEqual(evs.map((e) => e.type), ["text", "done"], kind);
    assert.deepEqual(evs[1].result.toolCalls, []);
    assert.equal("toolCalls" in evs[1].result.message, false);
  }
});

// @spec LLM-STREAM-029, LLM-STREAM-032, LLM-TOOL-004, LLM-TOOL-007
test("a backend that answers a stream request with one JSON body gives text, one tool_call per call, then done, on both providers", async () => {
  const bodies: Record<Kind, unknown> = {
    ollama: ollamaBody("Looking.", [oCall("get_weather", { city: "Oslo" }), oCall("get-time", {})]),
    openai: openaiBody("Looking.", [aCall("a", "get_weather", '{"city":"Oslo"}'), aCall("b", "get-time", "{}")], "tool_calls"),
  };
  for (const kind of kinds) {
    const b = await json(bodies[kind]);
    const evs = await collect(make(kind, b.url).stream(hello, { tools: [weather, clock] }));
    assert.deepEqual(evs.map((e) => e.type), ["text", "tool_call", "tool_call", "done"], kind);
    assert.equal(evs[0].delta, "Looking.");
    const calls = evs.filter((e) => e.type === "tool_call").map((e) => e.call);
    assert.deepEqual(calls.map((c: any) => [c.name, c.arguments]), [["get_weather", { city: "Oslo" }], ["get-time", {}]]);
    assert.deepEqual(evs.at(-1).result.toolCalls, calls);
    assert.equal(evs.at(-1).result.finish, "tool_calls");
    // No text: the calls and done only.
    const n = await json(kind === "ollama" ? ollamaBody("", [oCall("get_weather", { city: "x" })]) : openaiBody(null, [aCall("a", "get_weather", '{"city":"x"}')], "tool_calls"));
    assert.deepEqual((await collect(make(kind, n.url).stream(hello, { tools: [weather] }))).map((e) => e.type), ["tool_call", "done"], `${kind} no text`);
  }
});
