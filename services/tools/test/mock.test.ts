import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSource, def, resultOf, search, startTools, waitFor } from "./helpers.js";

const mockCfg = (allow: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  mode: "mock", servers: { search, other: { url: "https://other.example.com/mcp", token: "tok-secret" } }, allow, ...over,
});

test("in mock mode the service opens no connection, publishes no memory.recall.request and touches no Redis key beyond the stream and its group", async () => { // @spec TOOL-MOCK-001
  const live = new FakeSource("search", [def("web")]);
  const s = await startTools(mockCfg({ search__web: { enabled: true } }), [live]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  await resultOf(s, await s.request());
  await resultOf(s, await s.request({ tool: "nothing" }));
  assert.equal(s.sourcesBuilt, 0, "no MCP source is built, so no connection is opened");
  assert.equal(live.calls.length, 0);
  assert.equal(s.bus.of("memory.recall.request").length, 0);
  assert.deepEqual(s.bus.calls.filter((c) => !/^(resetGroup|subscribe|bus\.stop)/.test(c)), [], "no timer hash call, no other Redis key");
  assert.equal(s.bus.timers.size, 0);
  await s.stop();
});

test("in mock mode every configured server is in the catalog with the state mock", async () => { // @spec TOOL-MOCK-002
  const s = await startTools(mockCfg());
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const c = s.catalogs().at(-1)!;
  assert.equal(c.mode, "mock");
  assert.deepEqual(c.servers.map((x) => [x.name, x.state]), [["search", "mock"], ["other", "mock"]]);
  await s.stop();
});

test("each allow entry <server>__<tool> of a configured server is a mock tool: 'a mock tool', any-object schema, label from the effect key", async () => { // @spec TOOL-MOCK-003
  const s = await startTools(mockCfg({
    search__web: { enabled: true },
    search__post: { enabled: true, acts: true, effect: "acts" },
    other__mystery: { enabled: true, effect: "unlabelled" },
    ghost__thing: { enabled: true }, // a server that is not configured
  }));
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const tools = s.catalogs().at(-1)!.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["other__mystery", "search__post", "search__web"]);
  for (const t of tools) {
    assert.equal(t.description, "a mock tool");
    assert.equal(t.parameters.type, "object");
    assert.equal(t.parameters.additionalProperties === false, false, "accepts any object");
    assert.equal(t.parameters.required, undefined);
  }
  assert.deepEqual(["search__web", "search__post", "other__mystery"].map((n) => s.entry(n).label), ["read", "acts", "unlabelled"]);
  assert.deepEqual(["search__web", "other__mystery"].map((n) => s.entry(n).server), ["search", "other"]);
  await s.stop();
});

test("a call to a mock MCP tool answers 'mock <name> answered' followed by the arguments as JSON", async () => { // @spec TOOL-MOCK-004
  const s = await startTools(mockCfg({ search__web: { enabled: true } }));
  const r = await resultOf(s, await s.request({ arguments: { q: "cats", n: 2 } }));
  assert.equal(r.status, "ok");
  assert.ok(r.content.startsWith("mock search__web answered"), r.content);
  assert.ok(r.content.slice("mock search__web answered".length).includes('{"q":"cats","n":2}'), r.content);
  await s.stop();
});

test("in mock mode every tool.result carries mock true: ok, refused and error alike", async () => { // @spec TOOL-MOCK-007
  const s = await startTools(mockCfg({ search__web: { enabled: true }, search__off: { enabled: false } }));
  const ids = [
    await s.request(),
    await s.request({ tool: "search__off" }),
    await s.request({ tool: "nothing" }),
    await s.request({ origin: "idle" }),
  ];
  for (const id of ids) assert.equal((await resultOf(s, id)).mock, true, id);
  assert.deepEqual(s.results().map((r) => r.status), ["ok", "refused", "refused", "refused"]);
  await s.stop();
});

test("a mock tool is offered only for an enabled entry, with no pin check, and the marks, origin rules and result limit apply as live", async () => { // @spec TOOL-MOCK-008
  const s = await startTools(mockCfg({
    search__web: { enabled: true }, // no hash recorded: still offered
    search__off: { enabled: false },
    search__post: { enabled: true, effect: "acts" }, // acts without the acts mark
    search__talk: { enabled: true, chat: true },
  }, { max_result_chars: 64 }));
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(["search__web", "search__off", "search__post", "search__talk"].map((n) => [s.entry(n).offered, s.entry(n).reason]), [
    [true, undefined], [false, "not_enabled"], [false, "acts_not_allowed"], [true, undefined],
  ]);
  assert.equal((await resultOf(s, await s.request({ tool: "search__off" }))).reason, "not_enabled");
  assert.equal((await resultOf(s, await s.request({ tool: "search__post" }))).reason, "acts_not_allowed");
  assert.equal((await resultOf(s, await s.request({ origin: "chat" }))).reason, "origin_not_allowed");
  assert.equal((await resultOf(s, await s.request({ tool: "search__talk", origin: "chat" }))).status, "ok");
  const long = await resultOf(s, await s.request({ arguments: { q: "x".repeat(300) } }));
  assert.equal(long.content.length, 64);
  assert.equal(long.truncated, true);
  assert.equal(long.content.endsWith("…"), true);
  await s.stop();
});

test("a mock server's token and URL appear nowhere in the catalog or the results", async () => { // @spec TOOL-MOCK-001, TOOL-MOCK-008
  const s = await startTools(mockCfg({ other__x: { enabled: true } }));
  await resultOf(s, await s.request({ tool: "other__x" }));
  const dump = JSON.stringify([s.catalogs(), s.results()]);
  assert.equal(/tok-secret|other\.example\.com/.test(dump), false);
  await s.stop();
});
