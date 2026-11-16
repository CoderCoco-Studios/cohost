import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, userEvent, act, within, fireEvent, type TestApp } from "./helpers/render";
import { App } from "../../ui/src/app/App";
import { Screen } from "../../ui/src/screens/live";

const route = { view: "live" as const };

function boot(open = true) {
  location.hash = "";
  const app = makeApp();
  renderApp(<Screen route={route} />, app);
  if (open) act(() => { app.socket().open(); });
  return app;
}
let seq = 0;
const frame = (app: TestApp, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  act(() => { app.socket().message({ id: `${++seq}-0`, type, ts: app.clock.now, source: "t", data, ...extra }); });
const log = () => screen.getByRole("log", { name: "Bus activity" });
const rows = () => within(log()).queryAllByRole("article");
const filter = (name: string) => userEvent.setup().click(within(screen.getByRole("group", { name: "Show" })).getByRole("radio", { name }));

// @spec DASH-UI-001
test("before the first open the feed shows a loading state, not an empty list", () => {
  boot(false);
  assert.equal(screen.getByText("Connecting to the feed…").getAttribute("aria-busy"), "true");
  assert.match(document.body.textContent!, /Connecting to the feed/);
  assert.ok(screen.queryByRole("log") === null, "no log while loading");
});

test("once open with nothing yet, the feed says there is no activity", () => {
  boot();
  assert.match(log().textContent!, /No activity yet/);
  assert.equal(rows().length, 0);
});

// @spec DASH-UI-002, DASH-UI-027
test("each rendered type gets a row with a plain kind label, the event type as tooltip and in its accessible name, and the old page's text", () => {
  const app = boot();
  const cases: [string, Record<string, unknown>, string, string, RegExp][] = [
    ["chat.message", { user: "ann", text: "hello" }, "Chat", "chat", /^ann: hello/],
    ["brain.say", { emotion: "happy", text: "hi there", reason: "greet" }, "Co-host", "say", /^hi there/],
    ["vision.summary", { text: "a red car" }, "Vision", "vision", /^a red car/],
    ["speech.heard", { speaker: "bob", text: "hey" }, "Speech", "speech", /^bob: hey/],
    ["brain.status", { state: "thinking", detail: "why" }, "Status", "status", /^thinking · why/],
    ["control", { cmd: "say", target: "voice", text: "x" }, "Control", "status", /^say → voice "x"/],
    ["service.lifecycle", { action: "restart", service: "voice", by: "dashboard", ok: false, detail: "boom" }, "Service", "status", /^restart voice by dashboard · FAILED \(boom\)/],
    ["inject.request", { target: "chat", kind: "text", text: "yo", remember: true }, "Test", "status", /^→ chat text "yo" \(remember\)/],
    ["inject.result", { id: "r", ok: true, detail: "queued" }, "Test", "status", /^ok · queued/],
    ["voice.utterance", { id: "u", durationMs: 1234.4 }, "Voice", "status", /^audio ready 1234ms/],
    ["voice.playing", { id: "u", sink: "obs" }, "Voice", "status", /^obs/],
    ["voice.done", { id: "u", sink: "obs" }, "Voice", "status", /^obs/],
  ];
  for (const [type, data] of cases) frame(app, type, data);
  frame(app, "affect.state", { x: 1 });
  frame(app, "attention.focus", {});
  assert.equal(rows().length, cases.length, "types outside the rendered set are dropped");
  cases.forEach(([type, , label, cls, text], i) => {
    const row = rows()[i]!;
    assert.ok(row.className.split(" ").includes(cls), `${type} has class ${cls}: ${row.className}`);
    assert.ok(row.getAttribute("aria-label")!.includes(type), `${type} is in the accessible name`);
    assert.ok(row.getAttribute("aria-label")!.startsWith(label), `${type} is named ${label}`);
    const kind = within(row).getByText(label);
    assert.equal(kind.getAttribute("title"), type);
    assert.match(row.querySelector("p")!.textContent!, text);
  });
  assert.ok(screen.getByRole("article", { name: /Co-host.*brain\.say/ }), "found by role and name");
});

// @spec DASH-UI-027
test("a chat row tags its platform and a co-host row tags its emotion and says why it spoke", () => {
  const app = boot();
  frame(app, "chat.message", { user: "ann", text: "hi", platform: "twitch" });
  frame(app, "brain.say", { emotion: "excited", text: "yes", reason: "chat mention" });
  const [chat, say] = rows();
  assert.equal(within(chat!).getByText("twitch").className, "tag");
  assert.equal(within(say!).getByText("excited").className, "tag");
  assert.ok(within(say!).getByText("because: chat mention"));
});

// @spec DASH-UI-002
test("the feed keeps the last 300 rows, replayed events are shown, and an injected row carries the injected and remembered badges", () => {
  const app = boot();
  for (let i = 0; i < 310; i++) frame(app, "brain.status", { state: `s${i}` });
  assert.equal(rows().length, 300);
  assert.match(rows()[0]!.textContent!, /s10\b/);
  frame(app, "chat.message", { user: "u", text: "hi", injected: true, remember: true });
  frame(app, "chat.message", { user: "v", text: "yo", injected: true });
  frame(app, "chat.message", { user: "w", text: "replayed" }, { replay: true });
  const last3 = rows().slice(-3);
  assert.ok(within(last3[0]!).getByText("injected") && within(last3[0]!).getByText("remembered"));
  assert.ok(within(last3[1]!).getByText("injected") && within(last3[1]!).queryByText("remembered") === null);
  assert.ok(within(last3[2]!).queryByText("injected") === null);
  assert.match(last3[2]!.textContent!, /replayed/, "a replayed row is shown");
});

// @spec DASH-UI-003
test("a brain.status event shows its state in the header status cluster and a feed row with the state then the detail", () => {
  location.hash = "";
  const app = makeApp();
  renderApp(<App />, app);
  act(() => { app.socket().open(); });
  const cluster = screen.getByRole("group", { name: "Status" });
  assert.match(cluster.textContent!, /Waiting for the co-host/);
  frame(app, "brain.status", { state: "thinking", detail: "why" });
  assert.match(cluster.textContent!, /Thinking/);
  assert.match(rows()[0]!.textContent!, /thinking · why/);
});

// @spec DASH-UI-026
test("the filter offers All, Conversation, Vision and System with the stated membership", async () => {
  const app = boot();
  for (const t of ["chat.message", "brain.say", "speech.heard"]) frame(app, t, { text: t, user: "u", speaker: "s" });
  frame(app, "vision.summary", { text: "v" });
  for (const t of ["brain.status", "control", "service.lifecycle", "inject.request", "inject.result", "voice.utterance", "voice.playing", "voice.done"]) frame(app, t, { state: "x" });
  const labels = within(screen.getByRole("group", { name: "Show" })).getAllByRole("radio").map((r) => r.closest("label")!.textContent);
  assert.deepEqual(labels, ["All", "Conversation", "Vision", "System"]);
  assert.equal(rows().length, 12);
  await filter("Conversation");
  assert.deepEqual(rows().map((r) => r.getAttribute("aria-label")!.split(" ").pop()), ["chat.message", "brain.say", "speech.heard"]);
  await filter("Vision");
  assert.equal(rows().length, 1);
  await filter("System");
  assert.equal(rows().length, 8);
  assert.ok(rows().every((r) => !/chat\.message|brain\.say|speech\.heard|vision\.summary/.test(r.getAttribute("aria-label")!)));
  await filter("All");
  assert.equal(rows().length, 12);
});

// @spec DASH-UI-026
test("a filter with no matching rows says so, and new matching rows appear", async () => {
  const app = boot();
  frame(app, "chat.message", { user: "u", text: "hi" });
  await filter("Vision");
  assert.match(log().textContent!, /No vision activity yet/);
  frame(app, "vision.summary", { text: "tree" });
  assert.equal(rows().length, 1);
});

// @spec DASH-UI-026
test("the feed states that times are local with the zone abbreviation, and shows the date only on a row that is not from today", () => {
  const app = boot();
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(app.clock.now)).find((p) => p.type === "timeZoneName")!.value;
  assert.ok(screen.getByText(`Times are local (${zone}).`));
  const old = app.clock.now - 3 * 86_400_000;
  frame(app, "brain.status", { state: "today" });
  frame(app, "brain.status", { state: "old" }, { ts: old });
  const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const [today, older] = rows();
  assert.ok(!today!.querySelector("time")!.textContent!.includes(date(app.clock.now)), "no date on today's row");
  assert.ok(older!.querySelector("time")!.textContent!.includes(date(old)), "the date on an older row");
  assert.equal(older!.querySelector("time")!.getAttribute("datetime"), new Date(old).toISOString());
});

function scrollGeometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  for (const [k, v] of Object.entries(g)) Object.defineProperty(el, k, { configurable: true, writable: true, value: v });
}

// @spec DASH-UI-026
test("the feed follows new rows while its end is within 24 px, stops following beyond that and offers Jump to latest while rows arrive", async () => {
  const user = userEvent.setup();
  const app = boot();
  frame(app, "brain.status", { state: "one" });
  const el = log();
  scrollGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
  const toggle = () => screen.getByRole("button", { name: /Following latest|Jump to latest/ });
  assert.equal(toggle().textContent, "Following latest");
  assert.equal(toggle().getAttribute("aria-pressed"), "true");

  // within 24 px of the end (1000 - 680 - 300 = 20): still following; a new row scrolls to the end
  scrollGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 680 });
  fireEvent.scroll(el);
  assert.equal(toggle().textContent, "Following latest");
  scrollGeometry(el, { scrollHeight: 1100, clientHeight: 300, scrollTop: 680 });
  frame(app, "brain.status", { state: "two" });
  assert.equal(el.scrollTop, 1100, "the end is kept in view while following");

  // 25 px away: stop following; with no new row the label is unchanged but the toggle is off
  scrollGeometry(el, { scrollHeight: 1100, clientHeight: 300, scrollTop: 775 });
  fireEvent.scroll(el);
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  assert.equal(toggle().textContent, "Following latest");
  frame(app, "brain.status", { state: "three" });
  assert.equal(toggle().textContent, "Jump to latest");
  assert.equal(toggle().getAttribute("aria-pressed"), null);
  assert.equal(el.scrollTop, 775, "the view does not move while the operator is reading");

  await user.click(toggle());
  assert.equal(toggle().textContent, "Following latest");
  assert.equal(toggle().getAttribute("aria-pressed"), "true");
  assert.equal(el.scrollTop, el.scrollHeight);
});

// @spec DASH-UI-026
test("pressing Following latest turns following off", async () => {
  const app = boot();
  frame(app, "brain.status", { state: "one" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Following latest" }));
  assert.equal(screen.getByRole("button", { name: "Following latest" }).getAttribute("aria-pressed"), "false");
  frame(app, "brain.status", { state: "two" });
  assert.ok(screen.getByRole("button", { name: "Jump to latest" }));
});

// @spec DASH-UI-030
test("a bus event holding markup renders as text and creates no element", () => {
  const app = boot();
  frame(app, "chat.message", { user: "<b>x</b>", text: '<img src=x onerror="alert(1)">' });
  frame(app, "brain.say", { emotion: "<i>e</i>", text: "<script>alert(1)</script>", reason: "<u>r</u>" });
  assert.ok(log().querySelector("img, script, b, i, u") === null, "no element was built from a string");
  assert.match(rows()[0]!.textContent!, /<b>x<\/b>: <img src=x onerror="alert\(1\)">/);
  assert.match(rows()[1]!.textContent!, /<script>alert\(1\)<\/script>/);
});

// @spec DASH-UI-001
test("while the socket is closed the feed is aria-busy and dimmed, keeps its rows, and recovers on reconnect", () => {
  const app = boot();
  frame(app, "brain.status", { state: "one" });
  assert.equal(log().getAttribute("aria-busy"), null);
  act(() => { app.socket().serverClose(); });
  assert.equal(log().getAttribute("aria-busy"), "true");
  assert.ok(log().className.split(" ").includes("stale"));
  assert.equal(rows().length, 1);
  app.clock.tick(2000);
  act(() => { app.socket().open(); });
  assert.equal(log().getAttribute("aria-busy"), null);
  assert.ok(!log().className.split(" ").includes("stale"));
});

// @spec DASH-A11Y-004
test("the feed is a role=log region the keyboard can reach", () => {
  boot();
  assert.equal(log().getAttribute("tabindex"), "0");
});
