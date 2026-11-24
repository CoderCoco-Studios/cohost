import { test } from "node:test";
import assert from "node:assert/strict";
import { act, renderApp, screen, userEvent, waitFor, within, makeApp, type TestApp } from "./helpers/render";
import { App } from "../../ui/src/app/App";

// The confirmation bar: a pending tool.confirm is shown on every screen with the tool, its arguments as plain text cut at
// 200 characters per value, who asked in words, a countdown the page counts down by its own clock, and Allow and Deny.
// Contract these tests set for the markup: each pending call is one element `[data-confirm="<call id>"]` inside the
// shell (outside `<main>`, under the header); the countdown reads `<n>s`; the buttons are named Allow and Deny.
// The countdown runs on the runtime's injected timers and clock (app.clock), never on window timers.

type Screen = "live" | "services" | "viewers" | "settings";

function boot(view: Screen = "live", control = true) {
  location.hash = view === "live" ? "" : `#${view}`;
  const app = makeApp();
  app.fetch.on("GET /services/control", { json: control ? { enabled: true, runtime: "compose", advanced: false } : { enabled: false } });
  app.fetch.on("POST /tools/answer", { status: 202, text: "" });
  document.head.innerHTML = `<meta name="cohost-name" content="Coco">`;
  renderApp(<App />, app);
  act(() => { app.socket().open(); });
  return app;
}
let seq = 0;
const send = (app: TestApp, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  act(() => { app.socket().message({ id: `${++seq}-0`, type, ts: HOST_NOW, source: "tools", data, ...extra }); });
/** The host's clock, which differs from the browser's by a lot: only differences counted by the page's own clock matter. */
let HOST_NOW = 0;
const bar = (id: string) => document.querySelector<HTMLElement>(`[data-confirm="${id}"]`);
const bars = () => [...document.querySelectorAll<HTMLElement>("[data-confirm]")];
const confirm = (app: TestApp, over: Record<string, unknown> = {}, id = "c1") => {
  send(app, "tool.confirm", { id, tool: "weather__post", arguments: { text: "hello" }, origin: "dashboard", expiresAt: HOST_NOW + 20000, ...over });
};
const skewed = (app: TestApp, ms: number) => { HOST_NOW = app.clock.now + ms; };

// @spec DASH-TOOL-003
test("a pending tool.confirm shows one bar on every screen, under the header and outside the screen, with the tool, its arguments, who asked in words, a countdown, Allow and Deny", () => {
  for (const view of ["live", "services", "viewers", "settings"] as const) {
    const app = boot(view);
    skewed(app, 0);
    confirm(app, { tool: "weather__post", arguments: { city: "Oslo", n: 3 }, origin: "speech" });
    const b = bar("c1");
    assert.ok(b, `${view}: a bar`);
    assert.equal(bars().length, 1, view);
    assert.ok(!document.querySelector("main")!.contains(b), `${view}: the bar is the shell's, not the screen's`);
    assert.ok(document.querySelector("header")!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING, `${view}: after the header`);
    assert.ok(b!.compareDocumentPosition(document.querySelector("main")!) & Node.DOCUMENT_POSITION_FOLLOWING, `${view}: before the screen`);
    const t = b!.textContent!;
    assert.match(t, /weather__post/);
    assert.match(t, /city/); assert.match(t, /Oslo/);
    assert.match(t, /\bn\b/); assert.match(t, /\b3\b/);
    assert.match(t, /your voice/i, "the origin in words");
    assert.match(t, /\b20s\b/);
    assert.ok(within(b!).getByRole("button", { name: "Allow" }));
    assert.ok(within(b!).getByRole("button", { name: "Deny" }));
    document.body.innerHTML = "";
  }
});

// @spec DASH-TOOL-003
test("the origin is told in words: the dashboard for origin dashboard, your voice for speech, and never the raw enum alone", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app, { origin: "dashboard" }, "a");
  confirm(app, { origin: "speech" }, "b");
  assert.match(bar("a")!.textContent!, /the dashboard/i);
  assert.match(bar("b")!.textContent!, /your voice/i);
});

// @spec DASH-TOOL-003
test("every pending call has its own bar, in arrival order, each with its own buttons", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app, { tool: "first" }, "a");
  confirm(app, { tool: "second" }, "b");
  assert.deepEqual(bars().map((b) => b.dataset.confirm), ["a", "b"]);
  assert.match(bar("a")!.textContent!, /first/);
  assert.match(bar("b")!.textContent!, /second/);
});

// @spec DASH-TOOL-003
test("each argument value is cut at 200 characters: a longer string, a number-like string and a nested object are shown only to 200", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app, { arguments: { exact: "e".repeat(200), long: "a".repeat(200) + "TAILMARK", nested: { deep: "d".repeat(300) }, list: Array.from({ length: 200 }, (_, i) => `item${i}`) } });
  const t = bar("c1")!.textContent!;
  assert.ok(t.includes("e".repeat(200)), "a value of exactly 200 is whole");
  assert.ok(t.includes("a".repeat(200)));
  assert.equal(t.includes("TAILMARK"), false, "the 201st character on is not shown");
  assert.equal(t.includes("d".repeat(201)), false, "a nested value is cut as well");
  assert.equal(t.includes("item199"), false, "a long list is cut as well");
});

// @spec DASH-TOOL-003
test("arguments are plain text: markup, markdown and links from the model or a server never become elements, and the characters are shown", () => {
  const app = boot();
  skewed(app, 0);
  const evil = '<img src=x onerror="alert(1)"><b>b</b><script>alert(2)</script><a href="javascript:alert(3)">x</a> **md** [l](http://evil.example) http://auto.example';
  confirm(app, { tool: evil, arguments: { [evil]: evil, plain: "ok" } });
  const b = bar("c1")!;
  assert.equal(b.querySelector("img, script, iframe, svg, style, form, input"), null);
  assert.equal(b.querySelector("b, a"), null, "no bold, no link");
  assert.equal(b.querySelectorAll("[onerror], [onclick], [href], [src]").length, 0);
  assert.ok(b.textContent!.includes("<script>alert(2)</script>"), "shown as the characters they are");
  assert.ok(b.textContent!.includes("**md**"));
  assert.equal(document.querySelector("[data-confirm] button")!.textContent, "Allow", "the only controls are Allow and Deny");
  assert.deepEqual([...b.querySelectorAll("button")].map((x) => x.textContent), ["Allow", "Deny"]);
});

// @spec DASH-TOOL-003
test("a malformed tool.confirm (no arguments object, odd types) still makes a bar and never throws", () => {
  const app = boot();
  skewed(app, 0);
  send(app, "tool.confirm", { id: "odd", tool: 5, arguments: null, origin: "dashboard", expiresAt: HOST_NOW + 20000 });
  assert.ok(bar("odd"));
});

// @spec DASH-TOOL-004
test("the countdown counts from the time between the event and its expiresAt by the page's own clock: a browser clock an hour ahead of or behind the host shows the same 20 s", () => {
  for (const offset of [3_600_000, -3_600_000, 0]) {
    const app = boot();
    skewed(app, offset);
    confirm(app);
    assert.match(bar("c1")!.textContent!, /\b20s\b/, `offset ${offset}`);
    act(() => app.clock.tick(5000));
    assert.match(bar("c1")!.textContent!, /\b15s\b/, `offset ${offset} after 5 s`);
    act(() => app.clock.tick(14000));
    assert.match(bar("c1")!.textContent!, /\b1s\b/, `offset ${offset} after 19 s`);
    document.body.innerHTML = "";
  }
});

// @spec DASH-TOOL-004, DASH-TOOL-005
test("the bar goes away when the countdown ends, not before, and a bar whose expiresAt is not after its event is never shown", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app, {}, "live");
  act(() => app.clock.tick(19_999));
  assert.ok(bar("live"), "still there a millisecond early");
  act(() => app.clock.tick(1));
  assert.equal(bar("live"), null);
  confirm(app, { expiresAt: HOST_NOW }, "past");
  confirm(app, { expiresAt: HOST_NOW - 5000 }, "older");
  assert.equal(bars().length, 0);
});

// @spec DASH-TOOL-004
test("two pending calls count down separately by their own remaining time", () => {
  const app = boot();
  skewed(app, 777);
  confirm(app, { expiresAt: HOST_NOW + 30000 }, "long");
  act(() => app.clock.tick(10_000));
  confirm(app, { expiresAt: HOST_NOW + 20000 }, "short");
  assert.match(bar("long")!.textContent!, /\b20s\b/);
  assert.match(bar("short")!.textContent!, /\b20s\b/);
  act(() => app.clock.tick(20_000));
  assert.equal(bar("short"), null);
  assert.equal(bar("long"), null);
});

// @spec DASH-TOOL-005, DASH-TOOL-001
test("Allow posts /tools/answer {id, allow: true} with the control token and Deny posts allow: false; the bar stays until the call's tool.result", async () => {
  const app = boot();
  skewed(app, 0);
  app.rt.access.setToken("control", "tok", "tab");
  confirm(app, {}, "call-9");
  const user = userEvent.setup();
  await user.click(within(bar("call-9")!).getByRole("button", { name: "Allow" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /tools/answer").length, 1));
  const call = app.fetch.callsTo("POST /tools/answer")[0]!;
  assert.deepEqual(JSON.parse(call.body!), { id: "call-9", allow: true });
  assert.equal(call.headers.authorization, "Bearer tok");
  assert.ok(bar("call-9"), "answering does not remove the bar: the result does");
  send(app, "tool.result", { id: "other", tool: "x", status: "ok", content: "", durationMs: 1 });
  assert.ok(bar("call-9"), "another call's result leaves it");
  send(app, "tool.result", { id: "call-9", tool: "weather__post", status: "ok", content: "done", durationMs: 12 });
  assert.equal(bar("call-9"), null);

  confirm(app, {}, "call-10");
  await user.click(within(bar("call-10")!).getByRole("button", { name: "Deny" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /tools/answer").length, 2));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /tools/answer")[1]!.body!), { id: "call-10", allow: false });
});

// @spec DASH-TOOL-005, DASH-TOOL-002
test("the route needs the token whether or not control mode is on: without one held the Access dialog is asked first and no request is sent; Cancel sends nothing and the bar stays", async () => {
  for (const control of [true, false]) {
    const app = boot("live", control);
    skewed(app, 0);
    confirm(app);
    const user = userEvent.setup();
    await user.click(within(bar("c1")!).getByRole("button", { name: "Allow" }));
    await waitFor(() => assert.ok(app.rt.access.state.get().prompt, `control ${control}: asks for the token`));
    assert.equal(app.fetch.callsTo("POST /tools/answer").length, 0, "nothing is sent without a token");
    assert.match(app.rt.access.state.get().prompt!.action, /tool|allow/i);
    act(() => app.rt.access.resolvePrompt(false));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(app.fetch.callsTo("POST /tools/answer").length, 0);
    assert.ok(bar("c1"), "the bar stays: the call will end unconfirmed");
    document.body.innerHTML = "";
  }
});

// @spec DASH-TOOL-005, DASH-TOOL-026
test("a refused or failed answer (403 no token configured, 401, a network error) leaves the bar and shows the failure; the bar is never removed by a failed press", async () => {
  for (const reply of [{ status: 403, json: { ok: false, detail: "no control token is configured: set CONTROL_TOKEN" } }, { status: 401, text: "unauthorized" }] as const) {
    const app = boot();
    skewed(app, 0);
    app.rt.access.setToken("control", "tok", "tab");
    app.fetch.on("POST /tools/answer", reply);
    confirm(app);
    await userEvent.setup().click(within(bar("c1")!).getByRole("button", { name: "Allow" }));
    await waitFor(() => assert.ok(app.fetch.callsTo("POST /tools/answer").length >= 1));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.ok(bar("c1"), String(reply.status));
    document.body.innerHTML = "";
  }
  const app = boot();
  skewed(app, 0);
  app.rt.access.setToken("control", "tok", "tab");
  app.fetch.fail("POST /tools/answer");
  confirm(app);
  await userEvent.setup().click(within(bar("c1")!).getByRole("button", { name: "Allow" }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.ok(bar("c1"));
  assert.ok(within(bar("c1")!).queryByRole("alert") ?? screen.queryByRole("alert"), "the failure is told");
});

// @spec DASH-TOOL-005, DASH-TOOL-026
test("a tool.result that arrives before its bar's countdown ends removes it, and its timer is cancelled: nothing is left to fire later", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app);
  assert.ok(bar("c1"), "pending first");
  send(app, "tool.result", { id: "c1", tool: "weather__post", status: "refused", reason: "denied", content: "", durationMs: 0 });
  assert.equal(bar("c1"), null);
  act(() => app.clock.tick(60_000));
  assert.equal(bar("c1"), null);
});

// @spec DASH-TOOL-003, DASH-TOOL-005
test("a confirm replayed on connect whose tool.result is replayed after it makes no bar", () => {
  const app = boot();
  skewed(app, 0);
  confirm(app, {}, "old");
  assert.ok(bar("old"), "a live confirm is a bar");
  send(app, "tool.result", { id: "old", tool: "weather__post", status: "refused", reason: "unconfirmed", content: "", durationMs: 0 }, { replay: true });
  assert.equal(bar("old"), null);
  const replayedBoth = boot();
  skewed(replayedBoth, 0);
  send(replayedBoth, "tool.confirm", { id: "older", tool: "t", arguments: {}, origin: "dashboard", expiresAt: HOST_NOW + 20000 }, { replay: true });
  send(replayedBoth, "tool.result", { id: "older", tool: "t", status: "refused", reason: "unconfirmed", content: "", durationMs: 0 }, { replay: true });
  assert.equal(bar("older"), null);
});

// @spec DASH-TOOL-003
test("the same event delivered twice (a replay of a live one) makes one bar", () => {
  const app = boot();
  skewed(app, 0);
  const ev = { id: "dup-1", type: "tool.confirm", ts: HOST_NOW, source: "tools", data: { id: "c1", tool: "t", arguments: {}, origin: "dashboard", expiresAt: HOST_NOW + 20000 } };
  act(() => { app.socket().message(ev); app.socket().message({ ...ev, replay: true }); });
  assert.equal(bars().length, 1);
});

// @spec DASH-TOOL-003
test("a replayed tool.confirm never makes a bar, even one whose countdown is still open and whose result was not replayed", () => {
  const app = boot();
  skewed(app, 0);
  send(app, "tool.confirm", { id: "old", tool: "t", arguments: {}, origin: "dashboard", expiresAt: HOST_NOW + 20000 }, { replay: true });
  assert.equal(bars().length, 0);
  act(() => app.clock.tick(1000));
  assert.equal(bars().length, 0);
});

// @spec DASH-TOOL-026
test("Allow and Deny are disabled while the answer request is in flight, and the bar stays when it ends", async () => {
  const app = boot();
  skewed(app, 0);
  app.rt.access.setToken("control", "tok", "tab");
  let release!: () => void;
  app.fetch.on("POST /tools/answer", () => new Promise((resolve) => { release = () => resolve({ status: 403, json: { ok: false, detail: "no control token is configured: set CONTROL_TOKEN" } }); }));
  confirm(app);
  const b = bar("c1")!;
  await userEvent.setup().click(within(b).getByRole("button", { name: "Allow" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /tools/answer").length, 1));
  assert.equal((within(b).getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled, true);
  assert.equal((within(b).getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled, true);
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  await waitFor(() => assert.match(within(bar("c1")!).getByRole("alert").textContent ?? "", /403/));
  assert.equal((within(bar("c1")!).getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled, false, "a refused answer can be tried again");
});
