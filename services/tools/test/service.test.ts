import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLoggingForTest } from "@cohost/config";
import { FakeSource, SERVER_URL, def, hang, on, resultOf, search, startTools, text, waitFor, ToolsFakeBus } from "./helpers.js";

const live = (over: Record<string, unknown> = {}) => ({ servers: { search }, allow: { search__web: on("web") }, timeout_ms: 5000, ...over });

test("it runs on runService as `tools` in group tools, start mode latest, subscribed to exactly the four types, and not to control", async () => { // @spec TOOL-SVC-001, TOOL-SVC-003
  const s = await startTools(live(), [new FakeSource("search", [def("web")])]);
  assert.deepEqual(s.bus.calls.slice(0, 2), ["resetGroup:tools", "subscribe:tools"], "the group exists before the subscription");
  assert.equal(s.bus.subscribed.length, 1);
  const sub = s.bus.subscribed[0]!;
  assert.equal(sub.group, "tools");
  assert.equal(sub.start, "latest");
  assert.deepEqual([...sub.types].toSorted(), ["inject.request", "memory.recall.reply", "tool.answer", "tool.request"]);
  assert.equal(s.bus.health[0]!.service, "tools");
  await s.stop();
});

test("it publishes only tool.result, tool.catalog, tool.confirm, tool.timer, memory.recall.request and inject.result, never brain or attention events", async () => { // @spec TOOL-SVC-002
  const src = new FakeSource("search", [def("web"), def("post", {}, false)]);
  const s = await startTools(live({ allow: { search__web: on("web"), search__post: on("post", { acts: true }, false) }, confirm_timeout_ms: 40 }), [src]);
  await resultOf(s, await s.request({ arguments: { text: "say hello" } }));
  await resultOf(s, await s.request({ tool: "search__post" })); // confirm, then unconfirmed
  await s.send("inject.request", { id: "i1", target: "tools", kind: "text", text: JSON.stringify({ tool: "search__web", arguments: {} }), remember: false } as never);
  await waitFor(() => s.bus.of("inject.result").length === 1, "inject.result");
  const allowed = new Set(["tool.result", "tool.catalog", "tool.confirm", "tool.timer", "memory.recall.request", "inject.result"]);
  assert.deepEqual([...new Set(s.bus.types())].filter((t) => !allowed.has(t)), []);
  assert.ok(s.bus.types().includes("tool.confirm") && s.bus.types().includes("tool.catalog"));
  await s.stop();
});

test("on stop it publishes refused shutdown for each call in flight and each pending confirmation, then closes its sources and the bus, and leaves pending timers", async () => { // @spec TOOL-SVC-008
  const order: string[] = [];
  const bus = new ToolsFakeBus();
  const src = new FakeSource("search", [def("web"), def("post", {}, false)], hang, () => order.push(`close(results=${bus.of("tool.result").length})`));
  const due = JSON.stringify({ id: "t1", note: "later", setAt: Date.now(), dueAt: Date.now() + 3_600_000 });
  bus.timers.set("t1", due);
  const s = await startTools(live({ allow: { search__web: on("web"), search__post: on("post", { acts: true }, false) }, confirm_timeout_ms: 60000 }), [src], {}, bus);
  const inFlight = await s.request();
  const pending = await s.request({ tool: "search__post" });
  await waitFor(() => src.calls.length === 1 && bus.of("tool.confirm").length === 1, "one call in flight, one confirmation pending");
  await s.stop();
  const byId = (id: string) => s.results().filter((r) => r.id === id).map((r) => [r.status, r.reason]);
  assert.deepEqual(byId(inFlight), [["refused", "shutdown"]], "exactly one result");
  assert.deepEqual(byId(pending), [["refused", "shutdown"]]);
  assert.equal(src.closed, true);
  assert.deepEqual(order, ["close(results=2)"], "sources close after the refusals are published");
  assert.equal(bus.calls.at(-1), "bus.stop");
  assert.equal(bus.timers.get("t1"), due, "a pending timer stays in Redis");
});

test("a call that ends after the service stopped publishes no second result", async () => { // @spec TOOL-SVC-008, TOOL-SVC-007
  let release!: () => void;
  const src = new FakeSource("search", [def("web")], () => new Promise((res) => { release = () => res(text("late")); }));
  const s = await startTools(live(), [src]);
  const id = await s.request();
  await waitFor(() => src.calls.length === 1, "in flight");
  await s.stop();
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.results().filter((r) => r.id === id).map((r) => r.reason), ["shutdown"]);
});

test("when a call ends the log has tool, origin, status and duration at info and never an argument, result text, token or URL userinfo/query", async () => { // @spec TOOL-SVC-009
  const url = "https://user:pw@search.example.com/mcp?key=URLSECRET";
  const src = new FakeSource("search", [def("web")], async () => text("RESULT-SECRET"));
  const s = await startTools(
    { servers: { search: { url: SERVER_URL + "?key=URLSECRET", token: "TOKEN-SECRET" } }, allow: { search__web: on("web") }, timeout_ms: 5000 },
    [src],
  );
  await resultOf(s, await s.request({ arguments: { q: "ARG-SECRET" } }));
  await s.stop();
  const ended = s.log.lines.filter((l) => l.level === "info" && typeof l.obj === "object" && JSON.stringify(l.obj).includes("search__web"));
  assert.equal(ended.length, 1, "one info line for the call");
  const o = ended[0]!.obj as Record<string, unknown>;
  assert.equal(o.tool, "search__web");
  assert.equal(o.origin, "speech");
  assert.equal(o.status, "ok");
  assert.equal(typeof o.durationMs, "number");
  const everything = JSON.stringify(s.log.lines);
  for (const secret of ["ARG-SECRET", "RESULT-SECRET", "TOKEN-SECRET", "URLSECRET", "user:pw", url]) {
    assert.equal(everything.includes(secret), false, `log leaks ${secret}`);
  }
});

test("the log of a refused or failed call also carries only tool, origin, status and duration", async () => { // @spec TOOL-SVC-009
  const src = new FakeSource("search", [def("web")], async () => { throw new Error("boom TOKEN-SECRET ?key=URLSECRET"); });
  const s = await startTools({ servers: { search: { url: SERVER_URL + "?key=URLSECRET", token: "TOKEN-SECRET" } }, allow: { search__web: on("web") }, timeout_ms: 5000 }, [src]);
  await resultOf(s, await s.request({ arguments: { q: "ARG-SECRET" } }));
  await resultOf(s, await s.request({ tool: "nothing", arguments: { q: "ARG-SECRET" } }));
  await s.stop();
  const everything = JSON.stringify(s.log.lines);
  for (const secret of ["ARG-SECRET", "TOKEN-SECRET", "URLSECRET"]) assert.equal(everything.includes(secret), false, `log leaks ${secret}`);
  assert.equal(s.log.lines.filter((l) => l.level === "info" && JSON.stringify(l.obj).includes('"status"')).length >= 2, true);
});

// ---- test injection

const inject = (text: string, id = "inj-1") => ({ id, target: "tools", kind: "text", text, remember: false }) as never;

test("an inject.request to tools runs {tool, arguments} through the pipeline as origin dashboard, round 1, listed false", async () => { // @spec TOOL-INJ-001
  const src = new FakeSource("search", [def("web"), def("post", {}, false)]);
  const s = await startTools(live({ allow: { search__web: on("web"), search__post: on("post", { acts: true }, false) }, confirm_timeout_ms: 5000 }), [src]);
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__web", arguments: { q: "x" } })));
  await waitFor(() => s.results().length === 1, "tool.result");
  assert.deepEqual(src.calls.map((c) => [c.tool, c.args]), [["web", { q: "x" }]]);
  // an acting call (confirm mark absent) asks for confirmation as origin dashboard
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__post", arguments: {} }), "inj-2"));
  await waitFor(() => s.bus.of("tool.confirm").length === 1, "tool.confirm");
  assert.equal(s.bus.of("tool.confirm")[0]!.origin, "dashboard");
  assert.equal(s.bus.of("tool.confirm")[0]!.tool, "search__post");
  await s.stop();
});

test("an injected call is judged by the origin dashboard: a tool in the catalog that is not enabled is refused as for any request", async () => { // @spec TOOL-INJ-001
  const src = new FakeSource("search", [def("web"), def("off")]);
  const s = await startTools(live({ allow: { search__web: on("web") } }), [src]);
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__off", arguments: {} })));
  await waitFor(() => s.results().length === 1, "tool.result");
  assert.deepEqual([s.results()[0]!.status, s.results()[0]!.reason], ["refused", "not_enabled"]);
  assert.equal(src.calls.length, 0);
  await s.stop();
});

test("the inject.result is ok true with the status and the duration, whatever the status", async () => { // @spec TOOL-INJ-002
  const src = new FakeSource("search", [def("web")]);
  const s = await startTools(live(), [src]);
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__web", arguments: {} }), "a"));
  await s.send("inject.request", inject(JSON.stringify({ tool: "nothing", arguments: {} }), "b"));
  await waitFor(() => s.bus.of("inject.result").length === 2, "two inject.result");
  const [a, b] = ["a", "b"].map((id) => s.bus.of("inject.result").find((r) => r.id === id)!);
  assert.equal(a.ok, true);
  assert.match(a.detail ?? "", /ok/);
  assert.match(a.detail ?? "", /\d+\s*ms/);
  assert.equal(b.ok, true, "a refusal is a correct answer");
  assert.match(b.detail ?? "", /refused/);
  assert.match(b.detail ?? "", /\d+\s*ms/);
  await s.stop();
});

test("the inject.result of a call follows its tool.result, so ok means a result was published", async () => { // @spec TOOL-INJ-002
  const src = new FakeSource("search", [def("web")]);
  const s = await startTools(live(), [src]);
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__web", arguments: {} })));
  await waitFor(() => s.bus.of("inject.result").length === 1, "inject.result");
  assert.ok(s.bus.types().indexOf("tool.result") >= 0 && s.bus.types().indexOf("tool.result") < s.bus.types().indexOf("inject.result"));
  await s.stop();
});

test("text that is not the JSON {tool, arguments} is answered ok false with a detail and publishes no tool.result", async () => { // @spec TOOL-INJ-003
  const s = await startTools(live(), [new FakeSource("search", [def("web")])]);
  const bad = ["not json", "[1,2]", "42", "{}", '{"arguments":{}}', '{"tool":7,"arguments":{}}', ""];
  let i = 0;
  for (const t of bad) await s.send("inject.request", inject(t, `bad-${i++}`));
  await waitFor(() => s.bus.of("inject.result").length === bad.length, "an inject.result for each");
  for (const r of s.bus.of("inject.result")) {
    assert.equal(r.ok, false, `bad-input ${r.id}`);
    assert.ok((r.detail ?? "").length > 0);
  }
  assert.equal(s.results().length, 0);
  await s.stop();
});

test("an inject.request for another target is ignored", async () => { // @spec TOOL-INJ-001
  const s = await startTools(live(), [new FakeSource("search", [def("web")])]);
  await s.send("inject.request", { id: "x", target: "chat", kind: "text", text: JSON.stringify({ tool: "search__web", arguments: {} }), remember: false } as never);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.results().length + s.bus.of("inject.result").length, 0);
  await s.stop();
});

test("an inject-driven acting call asks for confirmation even when its confirm mark is false", async () => { // @spec TOOL-INJ-001, TOOL-CONF-006
  const src = new FakeSource("search", [def("post", {}, false)]);
  const s = await startTools(live({ allow: { search__post: on("post", { acts: true, confirm: false }, false) }, confirm_timeout_ms: 5000 }), [src]);
  await s.send("inject.request", inject(JSON.stringify({ tool: "search__post", arguments: {} }), "cf"));
  await waitFor(() => s.bus.of("tool.confirm").length === 1, "tool.confirm");
  assert.equal(src.calls.length, 0, "not run before the owner allows it");
  await s.stop();
});

test("without an injected logger it logs as tools through a sink with no file, whatever logging.file.enabled holds", async () => { // @spec TOOL-SVC-012
  const root = mkdtempSync(join(tmpdir(), "cohost-tools-log-"));
  writeFileSync(join(root, "config.yaml"), "logging:\n  file: { enabled: true }\n");
  const saved = { CONFIG_DIR: process.env.CONFIG_DIR, COHOST_DATA_DIR: process.env.COHOST_DATA_DIR, COHOST_ENV_FILE: process.env.COHOST_ENV_FILE };
  Object.assign(process.env, { CONFIG_DIR: root, COHOST_DATA_DIR: join(root, "data"), COHOST_ENV_FILE: join(root, "none.env") });
  const chunks: string[] = [];
  resetLoggingForTest({ write: (t) => { chunks.push(t); }, isTTY: false });
  try {
    const s = await startTools(live(), [new FakeSource("search", [def("web")])], {}, undefined, undefined, { log: undefined });
    await waitFor(() => chunks.join("").includes("tools: tools online"), "the online line on the terminal");
    await s.stop();
    assert.equal(existsSync(join(root, "data", "logs")), false, "no log file");
  } finally {
    resetLoggingForTest();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
