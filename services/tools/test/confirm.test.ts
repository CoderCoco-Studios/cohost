import { mock } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSource, def, hang, on, resultOf, search, startTools, text, waitFor } from "./helpers.js";

const acting = (over: Record<string, unknown> = {}) => ({
  servers: { search },
  allow: { search__post: on("post", { acts: true }, false), search__web: on("web") },
  timeout_ms: 5000,
  confirm_timeout_ms: 5000,
  ...over,
});
const post = () => new FakeSource("search", [def("post", {}, false), def("web")]);
const settle = () => new Promise((r) => setTimeout(r, 40));
const confirms = (s: { bus: { of: (t: "tool.confirm") => any[] } }) => s.bus.of("tool.confirm");

test("a call to an acting tool publishes tool.confirm with id, tool, arguments, origin and expiresAt and does not run; a read tool needs none", async () => { // @spec TOOL-CONF-001
  const src = post();
  const s = await startTools(acting(), [src]);
  const id = await s.request({ tool: "search__post", arguments: { to: "x" } });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  assert.deepEqual(Object.keys(confirms(s)[0]).sort(), ["arguments", "expiresAt", "id", "origin", "tool"]);
  assert.deepEqual({ ...confirms(s)[0], expiresAt: 0 }, { id, tool: "search__post", arguments: { to: "x" }, origin: "speech", expiresAt: 0 });
  await settle();
  assert.equal(src.calls.length, 0, "not sent before the owner allows it");
  assert.equal(s.results().length, 0);
  await resultOf(s, await s.request({ tool: "search__web" }));
  assert.equal(confirms(s).length, 1, "a read tool is not confirmed");
  await s.stop();
});

test("an injected request is confirmed whatever its confirm mark and listed", async () => { // @spec TOOL-CONF-001
  const src = post();
  const s = await startTools(acting({ allow: { search__post: on("post", { acts: true, confirm: false }, false) } }), [src]);
  const a = await s.request({ tool: "search__post", origin: "speech", listed: true, round: 1, injected: true });
  const b = await s.request({ tool: "search__post", origin: "dashboard", listed: false, round: 1, injected: true });
  await waitFor(() => confirms(s).length === 2, "both injected requests confirm");
  assert.deepEqual(confirms(s).map((c) => c.id).sort(), [a, b].sort());
  assert.equal(src.calls.length, 0);
  await s.stop();
});

test("expiresAt is the moment the request was read plus confirm_timeout_ms", async () => { // @spec TOOL-CONF-002
  const s = await startTools(acting({ confirm_timeout_ms: 7000 }), [post()]);
  const before = Date.now();
  await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  const after = Date.now();
  const at = confirms(s)[0].expiresAt;
  assert.ok(Number.isInteger(at));
  assert.ok(at >= before + 7000 && at <= after + 7000, `expiresAt ${at} not within [${before + 7000}, ${after + 7000}]`);
  await s.stop();
});

test("an Allow sends the call and the call limit starts then, not at the request", async () => { // @spec TOOL-CONF-003
  const src = new FakeSource("search", [def("post", {}, false)], hang);
  const s = await startTools(acting({ timeout_ms: 120, confirm_timeout_ms: 5000 }), [src]);
  const id = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  await new Promise((r) => setTimeout(r, 200)); // longer than the call limit, shorter than the window
  assert.equal(s.results().length, 0, "waiting for the owner is not a timeout");
  assert.equal(src.calls.length, 0);
  const allowedAt = Date.now();
  await s.answer(id, true);
  await waitFor(() => src.calls.length === 1, "the call is sent on Allow");
  const r = await resultOf(s, id);
  assert.equal(r.status, "timeout");
  assert.ok(Date.now() - allowedAt >= 100, "the limit ran from Allow");
  assert.ok(r.durationMs >= 300, `durationMs counts from the read: ${r.durationMs}`);
  await s.stop();
});

test("an Allow of a call that answers gives its ok result", async () => { // @spec TOOL-CONF-003
  const src = new FakeSource("search", [def("post", {}, false)], async () => text("sent"));
  const s = await startTools(acting(), [src]);
  const id = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  await s.answer(id, true);
  const r = await resultOf(s, id);
  assert.deepEqual([r.status, r.content], ["ok", "sent"]);
  await s.stop();
});

test("a Deny ends the request refused denied and the call is never sent", async () => { // @spec TOOL-CONF-004
  const src = post();
  const s = await startTools(acting(), [src]);
  const id = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  await s.answer(id, false);
  const r = await resultOf(s, id);
  assert.deepEqual([r.status, r.reason], ["refused", "denied"]);
  assert.equal(src.calls.length, 0);
  await s.stop();
});

test("with no answer by expiresAt the request is refused unconfirmed, never timeout, and its slot is freed", async () => { // @spec TOOL-CONF-005
  const src = post();
  const s = await startTools(acting({ confirm_timeout_ms: 60, max_concurrent: 1 }), [src]);
  const id = await s.request({ tool: "search__post" });
  const r = await resultOf(s, id);
  assert.deepEqual([r.status, r.reason], ["refused", "unconfirmed"]);
  assert.ok(r.durationMs >= 55);
  assert.equal(src.calls.length, 0);
  assert.equal((await resultOf(s, await s.request({ tool: "search__web" }))).status, "ok", "the slot is free again");
  await s.stop();
});

test("confirm:false skips the confirmation only in round 1 from the dashboard or from listed speech, never when injected", async () => { // @spec TOOL-CONF-006
  const src = post();
  const s = await startTools(acting({ allow: { search__post: on("post", { acts: true, confirm: false }, false) } }), [src]);
  const runs = (id: string) => s.results().some((r) => r.id === id) || src.calls.length > 0;
  let ran = 0;
  const skipped = async (over: Record<string, unknown>): Promise<boolean> => {
    const id = await s.request({ tool: "search__post", ...over });
    await waitFor(() => src.calls.length > ran || confirms(s).some((c) => c.id === id), `outcome ${JSON.stringify(over)}`);
    const did = src.calls.length > ran;
    ran = src.calls.length;
    if (!did) await s.answer(id, false);
    return did;
  };
  void runs;
  assert.equal(await skipped({ origin: "dashboard", round: 1, listed: false }), true, "dashboard, round 1");
  assert.equal(await skipped({ origin: "speech", round: 1, listed: true }), true, "listed speech, round 1");
  assert.equal(await skipped({ origin: "speech", round: 1, listed: false }), false, "unlisted speech");
  assert.equal(await skipped({ origin: "dashboard", round: 2, listed: false }), false, "dashboard, round 2");
  assert.equal(await skipped({ origin: "speech", round: 2, listed: true }), false, "listed speech, round 2");
  assert.equal(await skipped({ origin: "speech", round: 1, listed: true, injected: true }), false, "injected listed speech");
  assert.equal(await skipped({ origin: "dashboard", round: 1, listed: false, injected: true }), false, "injected dashboard");
  assert.equal(confirms(s).length, 5);
  await s.stop();
});

test("without confirm:false the confirmation is asked even in round 1 from the dashboard and from listed speech", async () => { // @spec TOOL-CONF-006
  const src = post();
  const s = await startTools(acting(), [src]); // the mark is absent: default true
  await s.request({ tool: "search__post", origin: "dashboard", round: 1 });
  await s.request({ tool: "search__post", origin: "speech", round: 1, listed: true });
  await waitFor(() => confirms(s).length === 2, "both ask");
  assert.equal(src.calls.length, 0);
  await s.stop();
});

test("an answer is accepted only for a pending call and only once; unknown, finished, answered and late answers are ignored", async () => { // @spec TOOL-CONF-007
  const src = new FakeSource("search", [def("post", {}, false)], async () => text("sent"));
  const s = await startTools(acting({ confirm_timeout_ms: 150 }), [src]);
  await s.answer("never-requested", true);
  const a = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm a");
  await s.answer(a, true);
  await s.answer(a, false); // a second answer for the same call
  await resultOf(s, a);
  await s.answer(a, true); // a finished call
  const b = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 2, "tool.confirm b");
  await resultOf(s, b); // unconfirmed after the window
  await s.answer(b, true); // after expiresAt
  await settle();
  assert.equal(src.calls.length, 1, "only a was ever sent");
  assert.deepEqual(s.results().filter((r) => r.id === a).map((r) => r.status), ["ok"]);
  assert.deepEqual(s.results().filter((r) => r.id === b).map((r) => r.reason), ["unconfirmed"]);
  await s.stop();
});

test("the first answer wins: a Deny then an Allow is a denial", async () => { // @spec TOOL-CONF-007
  const src = post();
  const s = await startTools(acting(), [src]);
  const id = await s.request({ tool: "search__post" });
  await waitFor(() => confirms(s).length === 1, "tool.confirm");
  await s.answer(id, false);
  await s.answer(id, true);
  await settle();
  assert.deepEqual(s.results().filter((r) => r.id === id).map((r) => r.reason), ["denied"]);
  assert.equal(src.calls.length, 0);
  await s.stop();
});

test("in mock mode a call that would wait for a confirmation runs at once with no tool.confirm", async () => { // @spec TOOL-CONF-008
  const s = await startTools({ mode: "mock", servers: { search }, allow: { search__post: { enabled: true, acts: true, effect: "acts" } } });
  const r = await resultOf(s, await s.request({ tool: "search__post", arguments: { a: 1 } }));
  assert.equal(r.status, "ok");
  assert.equal(r.mock, true);
  assert.equal(confirms(s).length, 0);
  await s.stop();
});

// ---- security review round 1: duplicate ids (TOOL-CALL-022)

test("a duplicate id while the first is pending publishes nothing: the first confirms, answers only it, and the duplicate does not free its slot", async () => { // @spec TOOL-CALL-022, TOOL-CONF-007, TOOL-CALL-009
  const src = new FakeSource("search", [def("post", {}, false), def("web")]);
  const s = await startTools(acting({ max_concurrent: 1, confirm_timeout_ms: 5000 }), [src]);
  const X = "dup-x";
  await s.send("tool.request", { id: X, tool: "search__post", arguments: { a: 1 }, origin: "speech", round: 1, listed: false });
  await waitFor(() => s.bus.of("tool.confirm").length === 1, "first confirmation");
  await s.send("tool.request", { id: X, tool: "search__post", arguments: { a: 2 }, origin: "speech", round: 1, listed: false });
  await settle();
  assert.equal(s.bus.of("tool.confirm").length, 1, "the duplicate asks nothing");
  assert.equal(s.results().filter((r) => r.id === X).length, 0, "the duplicate publishes no result");
  assert.equal(s.bus.of("tool.confirm")[0]!.arguments.a, 1, "the first request is the one pending");
  assert.equal((await resultOf(s, await s.request({ tool: "search__web" }))).reason, "busy", "the duplicate did not free the first's slot");
  assert.ok(s.log.lines.some((l) => l.level === "warn" && JSON.stringify(l.obj).includes(X)), "the duplicate is logged at warn");
  await s.answer(X, true);
  await waitFor(() => src.calls.length === 1, "the first call runs once");
  assert.deepEqual(src.calls[0]!.args, { a: 1 });
  await s.stop();
});

test("with max_concurrent 2 an answer for id X confirms only the first request, and a duplicate never runs", async () => { // @spec TOOL-CALL-022, TOOL-CONF-007
  const src = new FakeSource("search", [def("post", {}, false)], async () => text("ran"));
  const s = await startTools(acting({ max_concurrent: 2, confirm_timeout_ms: 5000 }), [src]);
  await s.send("tool.request", { id: "X", tool: "search__post", arguments: { a: 1 }, origin: "speech", round: 1, listed: false });
  await waitFor(() => s.bus.of("tool.confirm").length === 1, "first confirmation");
  await s.send("tool.request", { id: "X", tool: "search__post", arguments: { a: 2 }, origin: "speech", round: 1, listed: false });
  await settle();
  assert.equal(s.bus.of("tool.confirm").length, 1);
  await s.answer("X", true);
  const r = await resultOf(s, "X");
  assert.equal(r.status, "ok");
  await settle();
  assert.deepEqual(src.calls.map((c) => c.args), [{ a: 1 }], "only the first request's arguments ran");
  assert.equal(s.results().filter((x) => x.id === "X").length, 1, "one result for X");
  await s.stop();
});

test("shutdown refuses every live entry: each admitted or pending request gets one refused shutdown result", async () => { // @spec TOOL-CALL-022, TOOL-SVC-008
  const src = new FakeSource("search", [def("post", {}, false)]);
  const s = await startTools(acting({ max_concurrent: 3, confirm_timeout_ms: 60000 }), [src]);
  await s.send("tool.request", { id: "A", tool: "search__post", arguments: {}, origin: "speech", round: 1, listed: false });
  await s.send("tool.request", { id: "B", tool: "search__post", arguments: {}, origin: "speech", round: 1, listed: false });
  await s.send("tool.request", { id: "B", tool: "search__post", arguments: { dup: true }, origin: "speech", round: 1, listed: false });
  await waitFor(() => s.bus.of("tool.confirm").length === 2, "two pending");
  await s.stop();
  for (const id of ["A", "B"]) assert.deepEqual(s.results().filter((r) => r.id === id).map((r) => [r.status, r.reason]), [["refused", "shutdown"]], id);
  assert.equal(s.results().length, 2, "the duplicate published nothing");
});

test("an answer after expiresAt is ignored even before the window's timer fires, with a mocked clock", async () => { // @spec TOOL-CONF-007, TOOL-CONF-005
  mock.timers.enable({ apis: ["Date"] });
  try {
    const src = new FakeSource("search", [def("post", {}, false)], async () => text("ran"));
    const s = await startTools(acting({ confirm_timeout_ms: 60000 }), [src]);
    await s.request({ tool: "search__post" });
    await waitFor(() => confirms(s).length === 1, "tool.confirm");
    const id = confirms(s)[0]!.id;
    assert.equal(confirms(s)[0]!.expiresAt, Date.now() + 60000, "expiresAt is the read moment plus the window");
    mock.timers.setTime(confirms(s)[0]!.expiresAt + 1);
    await s.answer(id, true);
    await settle();
    assert.equal(src.calls.length, 0, "the late Allow does not run the call");
    assert.equal(s.results().filter((r) => r.id === id).length, 0, "the window's end has not been published yet either");
    await s.stop();
  } finally { mock.timers.reset(); }
});
