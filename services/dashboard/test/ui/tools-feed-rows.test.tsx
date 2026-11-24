import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, act, within, type TestApp } from "./helpers/render";
import { Screen } from "../../ui/src/screens/live";

// The Activity feed's Tool rows and the `tools` cut suffix. Everything a tool server or a tool's arguments can put in an
// event is untrusted text: it is rendered as text and never as markup.

function boot() {
  location.hash = "";
  const app = makeApp();
  renderApp(<Screen route={{ view: "live" }} />, app);
  act(() => { app.socket().open(); });
  return app;
}
let seq = 0;
const frame = (app: TestApp, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  act(() => { app.socket().message({ id: `${++seq}-0`, type, ts: app.clock.now, source: "t", data, ...extra }); });
const log = () => screen.getByRole("log", { name: "Bus activity" });
const rows = () => within(log()).queryAllByRole("article");
const para = (row: HTMLElement) => row.querySelector("p")!.textContent!;

const request = { id: "c1", tool: "stream_info", arguments: { q: "x" }, origin: "speech", round: 1, listed: true };

// @spec DASH-UI-002, DASH-UI-027
test("tool.request, tool.result and tool.timer each get one Tool row, with the event type as tooltip and in the accessible name", () => {
  const app = boot();
  frame(app, "tool.request", request);
  frame(app, "tool.result", { id: "c1", tool: "stream_info", status: "ok", content: "Playing Chess", durationMs: 42 });
  frame(app, "tool.timer", { id: "t1", note: "tea", setAt: 1, dueAt: 2 });
  assert.equal(rows().length, 3);
  for (const [i, type] of ["tool.request", "tool.result", "tool.timer"].entries()) {
    const row = rows()[i]!;
    assert.ok(row.getAttribute("aria-label")!.startsWith("Tool"), type);
    assert.ok(row.getAttribute("aria-label")!.includes(type), type);
    assert.equal(within(row).getByText("Tool").getAttribute("title"), type);
  }
});

// @spec DASH-UI-002, DASH-TOOL-024
test("tool.catalog and tool.confirm add no row, silently, whatever they carry", () => {
  const app = boot();
  frame(app, "tool.catalog", { intervalMs: 30000, mode: "live", servers: [], tools: [] });
  frame(app, "tool.confirm", { id: "c1", tool: "post", arguments: { text: "hi" }, origin: "dashboard", expiresAt: app.clock.now + 20000 });
  frame(app, "tool.answer", { id: "c1", allow: true });
  assert.equal(rows().length, 0);
  assert.match(log().textContent!, /No activity yet/);
});

// @spec DASH-UI-002
test("the 300-row limit counts tool rows like any other", () => {
  const app = boot();
  for (let i = 0; i < 310; i++) frame(app, "tool.request", { ...request, id: `c${i}`, tool: `tool_${i}` });
  assert.equal(rows().length, 300);
  assert.ok(!log().textContent!.includes("tool_9 "), "the oldest went first");
});

// @spec DASH-UI-002, DASH-TOOL-024
test("a tool.request row says which tool was asked for", () => {
  const app = boot();
  frame(app, "tool.request", request);
  assert.match(para(rows()[0]!), /stream_info/);
});

// @spec DASH-UI-002
test("a tool.result row says the status, how long it took and the start of its text; a long result is cut, not printed whole", () => {
  const app = boot();
  frame(app, "tool.result", { id: "c1", tool: "stream_info", status: "ok", content: "Playing Chess with viewers. " + "z".repeat(4000), durationMs: 42 });
  const p = para(rows()[0]!);
  assert.match(p, /stream_info/);
  assert.match(p, /\bok\b/);
  assert.match(p, /42 ?ms/);
  assert.match(p, /Playing Chess with viewers\./);
  assert.ok(p.length < 700, `the row holds the start of the text, not all of it (${p.length})`);
});

// @spec DASH-UI-002
test("a refused or failed result says why in words, never the raw reason code", () => {
  const app = boot();
  frame(app, "tool.result", { id: "a", tool: "post", status: "refused", reason: "not_approved", content: "", durationMs: 0 });
  frame(app, "tool.result", { id: "b", tool: "post", status: "refused", reason: "definition_changed", content: "", durationMs: 0 });
  frame(app, "tool.result", { id: "c", tool: "post", status: "error", reason: "tool_error", content: "boom", durationMs: 9 });
  frame(app, "tool.result", { id: "d", tool: "post", status: "timeout", content: "", durationMs: 10000 });
  const [a, b, c, d] = rows().map(para);
  assert.match(a!, /refused/i);
  assert.match(a!, /not approved/i);
  assert.match(b!, /changed/i);
  assert.match(c!, /error/i);
  assert.match(d!, /time ?out|timed out/i);
  for (const t of [a, b, c, d]) assert.doesNotMatch(t!, /[a-z]_[a-z]/, "no snake_case reason code");
});

// @spec DASH-TOOL-024
test("a tool.timer row says a timer went off with its note, and one with missed true says it was missed", () => {
  const app = boot();
  frame(app, "tool.timer", { id: "t1", note: "check the oven", setAt: 1, dueAt: 2 });
  frame(app, "tool.timer", { id: "t2", note: "stretch break", setAt: 1, dueAt: 2, missed: true });
  const [off, missed] = rows().map(para);
  assert.match(off!, /went off/i);
  assert.match(off!, /check the oven/);
  assert.doesNotMatch(off!, /missed/i);
  assert.match(missed!, /missed/i);
  assert.match(missed!, /stretch break/);
  assert.doesNotMatch(missed!, /went off/i);
});

// @spec DASH-UI-002, DASH-TOOL-024
test("a timer that went off and then the same timer re-published as missed are two events and two rows, each worded for its own", () => {
  const app = boot();
  frame(app, "tool.timer", { id: "t1", note: "tea", setAt: 1, dueAt: 2 });
  frame(app, "tool.timer", { id: "t1", note: "tea", setAt: 1, dueAt: 2, missed: true });
  assert.equal(rows().length, 2);
});

// @spec DASH-UI-002, DASH-UI-030
test("what a tool server or an argument puts in an event is text: markup, markdown and links in a tool name, result, reason, note or arguments never become elements", () => {
  const app = boot();
  const evil = '<img src=x onerror="alert(1)"><b>bold</b><script>alert(2)</script><a href="javascript:alert(3)">x</a> **md** [l](http://evil.example)';
  frame(app, "tool.request", { ...request, tool: "lookup", arguments: { [evil]: evil } });
  frame(app, "tool.result", { id: "c1", tool: evil, status: "ok", content: evil, durationMs: 1 });
  frame(app, "tool.timer", { id: "t1", note: evil, setAt: 1, dueAt: 2 });
  assert.equal(rows().length, 3);
  for (const row of rows()) {
    assert.equal(row.querySelector("img, b, script, a, iframe, svg, style"), null, row.getAttribute("aria-label")!);
    assert.equal(row.querySelectorAll("[onerror], [onclick]").length, 0);
  }
  assert.ok(para(rows()[1]!).includes("<img src=x"), "the markup is shown as the characters it is");
  assert.ok(para(rows()[2]!).includes("<script>alert(2)</script>"));
});

// @spec DASH-UI-002
test("a malformed tool event (missing members, wrong types) still makes a row and never throws", () => {
  const app = boot();
  frame(app, "tool.request", {});
  frame(app, "tool.result", { id: 7, tool: null, status: {}, content: ["x"], durationMs: "soon" });
  frame(app, "tool.timer", { id: "t", note: 5 });
  assert.equal(rows().length, 3);
});

// @spec DASH-UI-041, DASH-UI-039
test("a closing brain.clause that carries a cut adds a muted suffix naming it to the line's row, for each of the nine cuts, and the line's text is unchanged", () => {
  const app = boot();
  const cuts = ["repeat", "muted", "busy", "failed", "length", "stopped", "timeout", "vetoed", "tools"];
  for (const cut of cuts) {
    frame(app, "brain.say", { id: `L-${cut}`, text: `line ${cut}.`, emotion: "happy", more: true });
    frame(app, "brain.clause", { id: `L-${cut}`, seq: 1, text: "", last: true, through: 0, cut });
  }
  assert.equal(rows().length, cuts.length, "the clauses add no rows");
  cuts.forEach((cut, i) => {
    const row = rows()[i]!;
    assert.match(para(row), new RegExp(`^line ${cut}\\.`));
    const suffix = [...row.querySelectorAll<HTMLElement>("*")].find((e) => e.children.length === 0 && (e.textContent ?? "").includes(cut) && e !== row.querySelector("p"));
    assert.ok(suffix, `${cut}: an element of its own names the cut`);
    assert.match(suffix!.className, /muted|faint/, `${cut}: the suffix is muted`);
  });
});

// @spec DASH-UI-041
test("a closing clause with no cut adds no suffix, and a cut on a line with no row adds nothing", () => {
  const app = boot();
  frame(app, "brain.say", { id: "L", text: "Fine.", emotion: "happy", more: true });
  frame(app, "brain.clause", { id: "L", seq: 1, text: "", last: true, through: 0 });
  assert.equal(rows()[0]!.querySelector(".muted, .faint"), null);
  frame(app, "brain.clause", { id: "ghost", seq: 1, text: "", last: true, through: 0, cut: "tools" });
  assert.equal(rows().length, 1);
});
