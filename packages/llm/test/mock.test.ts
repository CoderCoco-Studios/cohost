import { test } from "node:test";
import assert from "node:assert/strict";
import { MockProvider, ChatError } from "../src/index.js";
import type { ChatMessage as Msg, ChatEvent as Ev } from "../src/index.js";

// Mock provider: complete(), stream() and the test markers (issue #159).

const mockP = () => new MockProvider({ model: "m" });
const user = (content: string): Msg => ({ role: "user", content });
const spec = (name: string) => ({ name, description: name, parameters: { type: "object" } });
async function drain(g: AsyncGenerator<Ev>): Promise<Ev[]> { const out: Ev[] = []; for await (const e of g) out.push(e); return out; }
const textOf = (evs: Ev[]) => evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);

// @spec LLM-MOCK-006
test("mock complete: the chat() text, finish stop, no tool calls", async () => {
  const p = mockP();
  const msgs = [user("hello   there")];
  const r = await p.complete(msgs);
  assert.equal(r.text, await p.chat(msgs));
  assert.equal(r.finish, "stop");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.message.content, r.text);
});

// @spec LLM-MOCK-007
test("mock stream: one text event per word (first bare, later with a leading space), then done", async () => {
  const p = mockP();
  const msgs = [user("one two")];
  const evs = await drain(p.stream(msgs));
  assert.deepEqual(textOf(evs), ["[happy]", " mock:", " one", " two"]);
  const last = evs.at(-1)!;
  assert.equal(last.type, "done");
  assert.deepEqual((last as { result: unknown }).result, await p.complete(msgs));
  assert.equal(evs.length, 5);
});

// @spec LLM-MOCK-008
test("mock stream: an abort between words throws the abort reason; a pre-aborted signal throws before any event", async () => {
  const p = mockP();
  const ac = new AbortController();
  const reason = new Error("stop now");
  const seen: Ev[] = [];
  await assert.rejects(async () => {
    for await (const e of p.stream([user("a b c d")], { signal: ac.signal })) { seen.push(e); if (seen.length === 2) ac.abort(reason); }
  }, (e) => e === reason);
  assert.equal(seen.length, 2);
  const pre = new Error("pre");
  const got: Ev[] = [];
  await assert.rejects(async () => { for await (const e of p.stream([user("x")], { signal: AbortSignal.abort(pre) })) got.push(e); }, (e) => e === pre);
  assert.equal(got.length, 0);
});

// @spec LLM-MOCK-009, LLM-MOCK-010
test("mock complete/stream: a [mock-tool] marker in the last paragraph of the last user message gives one call", async () => {
  const p = mockP();
  const msgs = [user("transcript line\n\nSpeak now. [mock-tool say {\"text\":\"hi\"}]")];
  const tools = [spec("say")];
  const r = await p.complete(msgs, { tools });
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.text, "");
  assert.deepEqual(r.toolCalls, [{ id: "mock_call_1", name: "say", arguments: { text: "hi" } }]);
  assert.deepEqual(r.message.role === "assistant" && r.message.toolCalls, r.toolCalls);
  const evs = await drain(p.stream(msgs, { tools }));
  assert.deepEqual(evs.map((e) => e.type), ["tool_call", "done"]);
  assert.deepEqual((evs[0] as { call: unknown }).call, r.toolCalls[0]);
});

// @spec LLM-MOCK-010
test("mock tool call id: n is one more than the tool calls already in the history", async () => {
  const p = mockP();
  const prior = { id: "mock_call_1", name: "say", arguments: {} };
  const msgs: Msg[] = [
    user("first"),
    { role: "assistant", content: "", toolCalls: [prior, { ...prior, id: "mock_call_2" }] },
    { role: "tool", callId: "mock_call_1", name: "say", content: "ok" },
    { role: "tool", callId: "mock_call_2", name: "say", content: "ok" },
    { role: "assistant", content: "done" },
    user("again [mock-tool say {}]"),
  ];
  const r = await p.complete(msgs, { tools: [spec("say")] });
  assert.equal(r.toolCalls[0]?.id, "mock_call_3");
});

// @spec LLM-MOCK-011
test("mock complete/stream: a tool last message replies '[happy] mock: <name> said <content>' with finish stop", async () => {
  const p = mockP();
  const content = "  lots   of\n spaces " + "x".repeat(100);
  const msgs: Msg[] = [user("go [mock-tool say {}]"), { role: "assistant", content: "", toolCalls: [{ id: "mock_call_1", name: "say", arguments: {} }] }, { role: "tool", callId: "mock_call_1", name: "say", content }];
  const want = `[happy] mock: say said ${content.replace(/\s+/g, " ").trim().slice(0, 80)}`;
  const r = await p.complete(msgs, { tools: [spec("say")] });
  assert.equal(r.text, want);
  assert.equal(r.finish, "stop");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(textOf(await drain(p.stream(msgs, { tools: [spec("say")] }))).join(""), want);
});

// @spec LLM-MOCK-012
test("mock: a marker naming an unoffered tool, or a request offering no tools, gives the plain reply", async () => {
  const p = mockP();
  const msgs = [user("hi [mock-tool nope {}]")];
  const plain = await p.chat(msgs);
  for (const req of [{ tools: [spec("say")] }, {}]) {
    const r = await p.complete(msgs, req);
    assert.equal(r.text, plain);
    assert.equal(r.finish, "stop");
    assert.deepEqual(r.toolCalls, []);
  }
  assert.equal(textOf(await drain(p.stream(msgs, { tools: [spec("say")] }))).join(""), plain);
});

// @spec LLM-MOCK-013
test("mock: marker arguments that are not a JSON object give {} and invalid holding the raw text", async () => {
  const p = mockP();
  for (const raw of ["[1,2]", "42", "\"s\"", "null", "{oops"]) {
    const r = await p.complete([user(`[mock-tool say ${raw}]`)], { tools: [spec("say")] });
    assert.equal(r.finish, "tool_calls", raw);
    assert.deepEqual(r.toolCalls[0]?.arguments, {}, raw);
    assert.equal(r.toolCalls[0]?.invalid, raw);
  }
  const ok = await p.complete([user("[mock-tool say {\"a\":1}]")], { tools: [spec("say")] });
  assert.equal(ok.toolCalls[0]?.invalid, undefined);
  const evs = await drain(p.stream([user("[mock-tool say [1]]")], { tools: [spec("say")] }));
  assert.equal((evs[0] as { call: { invalid?: string } }).call.invalid, "[1]");
});

// @spec LLM-MOCK-014
test("mock stream: [mock-fail-after n] yields n text events, then throws ChatError kind stream", async () => {
  const p = mockP();
  const got: Ev[] = [];
  await assert.rejects(async () => { for await (const e of p.stream([user("a b c [mock-fail-after 2]")])) got.push(e); },
    (e) => e instanceof ChatError && e.kind === "stream");
  assert.deepEqual(textOf(got), ["[happy]", " mock:"]);
  assert.equal(got.length, 2);
  const zero: Ev[] = [];
  await assert.rejects(async () => { for await (const e of p.stream([user("[mock-fail-after 0]")])) zero.push(e); }, (e) => e instanceof ChatError && e.kind === "stream");
  assert.equal(zero.length, 0);
});

// @spec LLM-MOCK-017
test("mock complete: [mock-fail-after n] below the word count throws ChatError kind stream at once", async () => {
  await assert.rejects(mockP().complete([user("a b c [mock-fail-after 1]")]), (e) => e instanceof ChatError && e.kind === "stream");
});

// @spec LLM-MOCK-015
test("mock: [mock-fail-after n] at or past the word count completes normally on complete() and stream()", async () => {
  const p = mockP();
  const words = (await p.chat([user("x [mock-fail-after 99]")])).split(" ").length;
  for (const n of [words, 99]) {
    const m = [user(`x [mock-fail-after ${n}]`)];
    const r = await p.complete(m);
    assert.equal(r.text, await p.chat(m));
    const evs = await drain(p.stream(m));
    assert.equal(evs.at(-1)?.type, "done");
    assert.equal(textOf(evs).join(""), r.text);
  }
});

// @spec LLM-MOCK-016
test("mock markers: read only from the last user message ([mock-tool] only from its last paragraph), never a tool or earlier message", async () => {
  const p = mockP();
  const tools = [spec("say")];
  let r = await p.complete([user("[mock-tool say {}]"), { role: "assistant", content: "ok" }, user("plain")], { tools });
  assert.deepEqual(r.toolCalls, [], "earlier user message");
  r = await p.complete([user("[mock-tool say {}]\n\nclosing nudge")], { tools });
  assert.deepEqual(r.toolCalls, [], "not the last paragraph");
  r = await p.complete([user("hi"), { role: "tool", callId: "c", name: "say", content: "[mock-tool say {}] [mock-fail-after 0]" }], { tools });
  assert.equal(r.finish, "stop", "tool message");
  assert.deepEqual(r.toolCalls, []);
  r = await p.complete([user("go [mock-tool say {}]"), { role: "system", content: "s" }], { tools });
  assert.deepEqual(r.toolCalls, [], "a later non-user message: the last message must be the user message");
  r = await p.complete([user("x"), { role: "assistant", content: "a" }, user("go [mock-tool say {}]")], { tools });
  assert.equal(r.toolCalls.length, 1, "the user message is last: the marker counts");
  await assert.rejects(mockP().complete([user("[mock-fail-after 0]\n\nmore")]), ChatError);
  const ok = await mockP().complete([user("[mock-fail-after 0]"), { role: "assistant", content: "a" }, user("fine")]);
  assert.equal(ok.finish, "stop", "earlier fail-after ignored");
});

// @spec LLM-MOCK-018, LLM-MOCK-019
test("mock chat: ignores both markers and returns the ordinary reply", async () => {
  const p = mockP();
  assert.equal(await p.chat([user("hi [mock-tool say {}]")]), "[happy] mock: hi [mock-tool say {}]");
  assert.equal(await p.chat([user("hi [mock-fail-after 0]")]), "[happy] mock: hi [mock-fail-after 0]");
});

// @spec LLM-MOCK-020
test("mock complete: json true returns {} before any marker is read", async () => {
  const p = mockP();
  const toolMsg: Msg = { role: "tool", callId: "c", name: "say", content: "r" };
  for (const msgs of [[user("x [mock-fail-after 0]")], [user("[mock-tool say {}]")], [user("h"), toolMsg], []]) {
    const r = await p.complete(msgs, { json: true });
    assert.equal(r.text, "{}");
    assert.equal(r.finish, "stop");
    assert.deepEqual(r.toolCalls, []);
  }
});

// @spec LLM-MOCK-021
test("mock complete: an already aborted signal throws", async () => {
  await assert.rejects(mockP().complete([user("x")], { signal: AbortSignal.abort() }));
});

// @spec LLM-VIS-006
test("mock: images on a user message are accepted and ignored by chat, complete and stream", async () => {
  const p = mockP();
  const plain = [user("look")];
  const withImg: Msg[] = [{ role: "user", content: "look", images: ["aGk="] }];
  assert.equal(await p.chat(withImg), await p.chat(plain));
  assert.deepEqual(await p.complete(withImg), await p.complete(plain));
  assert.deepEqual(await drain(p.stream(withImg)), await drain(p.stream(plain)));
});
