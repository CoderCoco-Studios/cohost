import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSource, def, on, search, startTools, waitFor } from "./helpers.js";
import { Clock, callTool, cohost, mockTools, startBuiltin } from "./builtin-helpers.js";

const BUILTINS = ["clock", "stream_info", "memory_lookup", "timer"];
const catalogOf = async (s: Awaited<ReturnType<typeof startBuiltin>>) => {
  await waitFor(() => s.catalogs().length > 0, "catalog");
  return s.catalogs().at(-1)!;
};

test("the built-in tools are listed under their bare names with no server and no hash, enabled or not", async () => { // @spec TOOL-CAT-001, TOOL-PIN-002
  const s = await startBuiltin({ clock: { enabled: true } });
  const c = await catalogOf(s);
  assert.deepEqual(c.tools.slice(0, 4).map((t) => t.name).sort(), [...BUILTINS].sort(), "built-ins come first");
  for (const name of BUILTINS) {
    const t = s.entry(name);
    assert.equal(t.server, undefined, `${name} has no server`);
    assert.equal(t.hash, undefined, `${name} has no hash`);
    assert.equal(typeof t.description, "string");
    assert.equal(t.parameters.type, "object");
  }
  assert.equal(s.entry("clock").offered, true);
  assert.equal(s.entry("stream_info").offered, false);
  assert.equal(s.entry("stream_info").reason, "not_enabled");
  assert.deepEqual(Object.keys(s.entry("memory_lookup").parameters.properties ?? {}).sort(), ["k", "query"]);
  assert.deepEqual(s.entry("memory_lookup").parameters.required, ["query"]);
  assert.deepEqual(Object.keys(s.entry("timer").parameters.properties ?? {}).sort(), ["minutes", "note"]);
  assert.deepEqual([...s.entry("timer").parameters.required].sort(), ["minutes", "note"]);
  assert.deepEqual(s.entry("stream_info").parameters.properties.platform.enum, ["twitch", "youtube"]);
  await s.stop();
});

test("timer is labelled acts; clock, stream_info and memory_lookup are labelled read", async () => { // @spec TOOL-CAT-004
  const s = await startBuiltin({});
  await catalogOf(s);
  assert.deepEqual(BUILTINS.map((n) => s.entry(n).label), ["read", "read", "read", "acts"]);
  assert.deepEqual(BUILTINS.map((n) => s.entry(n).effect), ["read", "read", "read", "acts"]);
  await s.stop();
});

test("the built-in tools count first in the limits and are not cut by tools.max_tools_per_server", async () => { // @spec TOOL-CAT-013
  const src = new FakeSource("search", [def("a"), def("b"), def("c")]);
  const s = await startTools({ servers: { search }, allow: {}, max_tools: 5, max_tools_per_server: 1 }, [src], cohost);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const names = s.catalogs().at(-1)!.tools.map((t) => t.name);
  assert.deepEqual(names.slice(0, 4).sort(), [...BUILTINS].sort());
  assert.deepEqual(names.slice(4), ["search__a"], "the one slot left, and the per-server limit of 1, go to the server");
  const s2 = await startTools({ servers: { search }, allow: {}, max_tools: 5 }, [new FakeSource("search", [def("a"), def("b"), def("c")])], cohost);
  await waitFor(() => s2.catalogs().length > 0, "catalog");
  const c2 = s2.catalogs().at(-1)!;
  assert.equal(c2.tools.length, 5, "built-ins plus one server tool fill max_tools");
  assert.match(c2.servers[0]!.detail, /2 left out/);
  await Promise.all([s.stop(), s2.stop()]);
});

test("a built-in tool is offered without a recorded hash and no hash is checked for it, in live and in mock mode", async () => { // @spec TOOL-PIN-005, TOOL-CALL-004
  const live = await startBuiltin({ clock: { enabled: true } });
  await catalogOf(live);
  assert.equal(live.entry("clock").offered, true);
  const r = await callTool(live, "clock");
  assert.equal(r.status, "ok", r.content);
  const clock = new Clock();
  const mock = await startTools(mockTools({ clock: { enabled: true } }), [], cohost, undefined, undefined, clock.env());
  const m = await callTool(mock, "clock");
  assert.equal(m.status, "ok");
  assert.equal(m.mock, true);
  await Promise.all([live.stop(), mock.stop()]);
});

test("a built-in tool that rejects its arguments gives a refused result with reason invalid_arguments and does nothing", async () => { // @spec TOOL-CALL-007, TOOL-STRM-010
  const s = await startBuiltin({
    stream_info: { enabled: true }, memory_lookup: { enabled: true }, timer: { enabled: true, acts: true },
  });
  const bad: [string, Record<string, unknown>][] = [
    ["stream_info", { platform: "tiktok" }],
    ["stream_info", { platform: 3 }],
    ["memory_lookup", {}],
    ["memory_lookup", { query: "x", k: 0 }],
    ["timer", { minutes: 0, note: "x" }],
    ["timer", { minutes: 5 }],
  ];
  for (const [tool, args] of bad) {
    const r = await callTool(s, tool, args);
    assert.equal(r.status, "refused", `${tool} ${JSON.stringify(args)}`);
    assert.equal(r.reason, "invalid_arguments");
    assert.ok(r.content.length > 0);
  }
  assert.equal(s.bus.of("memory.recall.request").length, 0);
  assert.equal(s.bus.timers.size, 0);
  await s.stop();
});

test("a built-in tool that fails for a reason of the service's own gives an error result with reason unavailable and a sentence the service wrote", async () => { // @spec TOOL-CALL-017, TOOL-MEM-005
  // stream_info with no platform configured, and memory_lookup with no answer from the memory service.
  const s = await startBuiltin({ stream_info: { enabled: true }, memory_lookup: { enabled: true } }, { extra: { chat: { twitch: { channel: "" } } } });
  const a = await callTool(s, "stream_info");
  assert.equal(a.status, "error");
  assert.equal(a.reason, "unavailable");
  const id = await s.request({ tool: "memory_lookup", arguments: { query: "x" } });
  await waitFor(() => s.bus.of("memory.recall.request").length === 1, "recall request");
  s.clock.run(s.clock.bounded(10_000)[0]!);
  await waitFor(() => s.results().some((r) => r.id === id), "memory result");
  const m = s.results().find((r) => r.id === id)!;
  assert.equal(m.status, "error");
  assert.equal(m.reason, "unavailable");
  await s.stop();
});

test("the built-in timer is not asked to confirm, and an unallowed timer is refused as acts_not_allowed", async () => { // @spec TOOL-CONF-001, TOOL-CALL-003, TOOL-ORIG-003
  const s = await startBuiltin({ timer: { enabled: true, acts: true } });
  const r = await callTool(s, "timer", { minutes: 5, note: "stretch" }, { origin: "speech", listed: false });
  assert.equal(r.status, "ok", r.content);
  assert.equal(s.bus.of("tool.confirm").length, 0, "the timer never waits for the owner");
  const rem = await callTool(s, "timer", { minutes: 5, note: "again" }, { origin: "reminder" });
  assert.equal(rem.reason, "origin_not_allowed", "a reminder reply can never set a timer");
  const off = await startBuiltin({ timer: { enabled: true } });
  assert.equal((await callTool(off, "timer", { minutes: 5, note: "x" })).reason, "acts_not_allowed");
  await Promise.all([s.stop(), off.stop()]);
});

test("a source tool named like a built-in cannot shadow it: only four built-in names exist and none cancels or lists timers", async () => { // @spec TOOL-TIMER-008, TOOL-CAT-001
  const s = await startBuiltin({});
  const c = await catalogOf(s);
  assert.deepEqual(c.tools.filter((t) => t.server === undefined).map((t) => t.name).sort(), [...BUILTINS].sort());
  for (const name of ["cancel_timer", "list_timers", "timers", "timer_cancel"]) {
    assert.equal((await callTool(s, name)).reason, "unknown_tool", name);
  }
  await s.stop();
});

test("an MCP tool still needs its hash while a built-in does not", async () => { // @spec TOOL-PIN-005
  const src = new FakeSource("search", [def("web")]);
  const s = await startTools({ servers: { search }, allow: { clock: { enabled: true }, search__web: { enabled: true } } }, [src], cohost);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.equal(s.entry("clock").offered, true);
  assert.equal(s.entry("search__web").reason, "not_approved");
  const ok = new FakeSource("search", [def("web")]);
  const s2 = await startTools({ servers: { search }, allow: { search__web: on("web") } }, [ok], cohost);
  await waitFor(() => s2.catalogs().length > 0, "catalog");
  assert.equal(s2.entry("search__web").offered, true);
  await Promise.all([s.stop(), s2.stop()]);
});
