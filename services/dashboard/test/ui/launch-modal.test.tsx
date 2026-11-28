import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, fireEvent, makeApp, renderApp, screen, userEvent, waitFor, within } from "./helpers/render";
import { App } from "../../ui/src/app/App";
import { UNITS, stackMsg } from "./services-fixtures";
import type { StackSnapshot } from "../../ui/src/state/types";

/** The operator shell at `hash`, its socket open; the control and manifest reads answered. */
async function boot(hash = "#live", opts: { sink?: boolean } = {}) {
  location.hash = hash;
  const app = makeApp({ sink: opts.sink });
  app.fetch.on("GET /services/control", { json: { runtime: "compose", advanced: false, unlocked: false } });
  app.fetch.on("GET /services/manifest", { json: { units: UNITS } });
  document.head.innerHTML = `<meta name="cohost-name" content="Coco">`;
  const r = renderApp(<App sink={!!opts.sink} />, app);
  act(() => { app.socket().open(); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return { ...r, app };
}
const stack = (over: Partial<StackSnapshot> = {}) => ({ type: "stack", ...stackMsg(over) });
/**
 * Sends a frame; a `stack-progress` record goes after the `stack` message the server would have sent with it: the action the
 * record belongs to while it runs, none once it has ended.
 */
const push = (app: ReturnType<typeof makeApp>, frame: Record<string, unknown>) => act(() => {
  if (frame.type === "stack-progress") {
    const action = frame.running ? { kind: frame.kind, phase: "compose-build", startedAt: frame.startedAt } as StackSnapshot["action"] : null;
    app.socket().message(stack({ state: action ? "starting" : "up", action }));
  }
  app.socket().message(frame);
});
const raw = (app: ReturnType<typeof makeApp>, frame: Record<string, unknown>) => act(() => { app.socket().message(frame); });
const record = (over: Record<string, unknown> = {}) => ({ type: "stack-progress", kind: "launch", startedAt: 1, running: true, rows: [], lines: [], ...over });
const dialog = () => screen.getByRole("dialog") as HTMLDialogElement;
const queryDialog = () => screen.queryByRole("dialog") as HTMLDialogElement | null;
const go = (hash: string) => act(() => { location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

// @spec DASH-UI-060
test("a running record opens the launch progress dialog over the screen shown, and it stays open across a change of route", async () => {
  const { app } = await boot("#live");
  assert.equal(queryDialog(), null);
  push(app, record());
  const d = screen.getByRole("dialog", { name: "Launch running" });
  assert.equal((d as HTMLDialogElement).open, true);
  go("#settings");
  assert.ok(screen.getByRole("dialog", { name: "Launch running" }));
  go("#viewers");
  assert.ok(screen.getByRole("dialog", { name: "Launch running" }));
  push(app, record({ kind: "rebuild", startedAt: 2 }));
  assert.ok(screen.getByRole("dialog", { name: "Rebuild running" }));
});

// @spec DASH-UI-060
test("a page that connects while an action runs opens the dialog from the record it receives on connect; the sink view never shows it", async () => {
  const a = await boot("#services");
  push(a.app, stack({ state: "starting", action: { kind: "restart", phase: "restarting voice", startedAt: 1 } }));
  push(a.app, record({ kind: "restart" }));
  assert.ok(screen.getByRole("dialog", { name: "Restart all running" }));
  a.unmount();
  const s = await boot("", { sink: true });
  push(s.app, record());
  assert.equal(queryDialog(), null);
});

// @spec DASH-UI-061
test("while the action runs the dialog is modal and cannot be dismissed: no Close button, Escape and the backdrop do nothing, and a browser close reopens it", async () => {
  const { app } = await boot("#live");
  push(app, record({ rows: [{ service: "voice", state: "building" }], lines: ["#1 [voice 1/2] FROM cuda"] }));
  const d = dialog();
  assert.ok(d.contains(document.activeElement), "focus is inside the dialog, not on the log inside the closed disclosure or the page");
  assert.ok(!document.activeElement!.closest("details:not([open]) > pre"));
  assert.equal(d.getAttribute("aria-modal"), "true");
  assert.equal(within(d).queryByRole("button", { name: "Close" }), null);
  await userEvent.setup().keyboard("{Escape}");
  assert.equal(dialog().open, true, "Escape leaves it open");
  fireEvent(d, new Event("cancel", { cancelable: true }));
  assert.equal(dialog().open, true, "a cancel event leaves it open");
  fireEvent.mouseDown(d); fireEvent.click(d);
  assert.equal(dialog().open, true, "a backdrop click leaves it open");
  act(() => { d.close(); });
  await waitFor(() => assert.equal(dialog().open, true, "a browser close reopens it"));
  assert.ok(dialog().contains(document.activeElement), "focus is back inside the reopened dialog");
});

// @spec DASH-UI-060
test("a running record whose action the stack message does not report opens nothing", async () => {
  const { app } = await boot("#live");
  raw(app, stack({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: 9 } }));
  raw(app, record({ startedAt: 1 }));
  assert.equal(queryDialog(), null, "the record is not the running action's");
  raw(app, stack({ state: "up" }));
  raw(app, record({ startedAt: 2 }));
  assert.equal(queryDialog(), null, "no action is running");
});

// @spec DASH-UI-060, DASH-UI-070
test("a dashboard restarted mid-action: the dialog says live updates stopped, then the reconnect drops the old record and the dialog closes", async () => {
  const { app } = await boot("#live");
  push(app, record());
  assert.ok(screen.getByRole("dialog", { name: "Launch running" }));
  assert.doesNotMatch(dialog().textContent ?? "", /Live updates stopped/);
  act(() => { app.socket().serverClose(); });
  assert.match(within(dialog()).getByText(/Live updates stopped/).textContent ?? "", /out of date until the dashboard reconnects/);
  assert.equal(within(dialog()).getByText(/Live updates stopped/).getAttribute("role"), "status");
  act(() => { app.clock.tick(2000); });
  act(() => { app.socket().open(); }); // the new dashboard process has no record and sends none
  raw(app, stack({ state: "starting" }));
  assert.equal(queryDialog(), null, "the dialog is not held open by a record the server no longer has");
});

// @spec DASH-UI-069
test("the launch dialog holds the Mute button and the pending tool confirmations, and m toggles mute while it is open", async () => {
  const { app } = await boot("#live");
  app.fetch.on("POST /control", { status: 204 });
  app.fetch.on("POST /tools/answer", { status: 202, text: "" });
  app.rt.access.setToken("control", "tok", "tab");
  push(app, record());
  raw(app, { id: "1-0", type: "tool.confirm", ts: 0, source: "tools", data: { id: "c1", tool: "weather__post", arguments: { text: "hi" }, origin: "dashboard", expiresAt: 60000 } });
  const d = dialog();
  const bar = d.querySelector<HTMLElement>('[data-confirm="c1"]');
  assert.ok(bar, "the confirmation bar is inside the dialog");
  assert.equal(document.querySelectorAll('[data-confirm="c1"]').length, 1, "and only there");
  const user = userEvent.setup();
  await user.click(within(bar!).getByRole("button", { name: /Allow/ }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /tools/answer").length, 1));
  await user.click(within(d).getByRole("button", { name: "Mute co-host" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /control").length, 1));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /control")[0]!.body!), { cmd: "mute" });
  raw(app, { id: "2-0", type: "control", ts: 0, source: "dashboard", data: { cmd: "mute" } });
  await user.keyboard("m");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /control").length, 2));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /control")[1]!.body!), { cmd: "unmute" });
  push(app, record({ running: false, ok: true, finishedAt: 2 }));
  await user.click(within(dialog()).getAllByRole("button", { name: "Close" })[0]!);
  assert.ok(document.querySelector('[data-confirm="c1"]'), "the bar is back under the header once the dialog is closed");
  assert.equal(document.querySelector('[data-confirm="c1"]')!.closest("dialog"), null);
});

// @spec DASH-UI-062
test("when the action ends the dialog stays on the outcome, becomes closable by its Close buttons and Escape", async () => {
  const { app } = await boot("#live");
  push(app, record());
  push(app, record({ running: false, ok: true, finishedAt: 2 }));
  const d = screen.getByRole("dialog", { name: "Launch finished" });
  const closes = within(d).getAllByRole("button", { name: "Close" });
  assert.equal(closes.length, 2, "one in the header, one in the footer");
  await userEvent.setup().click(closes[1]!);
  assert.equal(queryDialog(), null);
  push(app, record({ startedAt: 5 }));
  push(app, record({ startedAt: 5, running: false, ok: false, finishedAt: 6, failure: { lines: ["boom"] } }));
  assert.ok(screen.getByRole("dialog", { name: "Launch failed" }));
  await userEvent.setup().keyboard("{Escape}");
  assert.equal(queryDialog(), null);
});

// @spec DASH-UI-062, DASH-A11Y-005
test("on close focus returns to the stack button that started the action, past the confirmation that has closed meanwhile", async () => {
  const { app } = await boot("#services");
  await screen.findByRole("heading", { level: 1, name: "Services" });
  push(app, stack({ state: "up" }));
  let release!: () => void;
  app.fetch.on("POST /stack/rebuild", () => new Promise((res) => { release = () => res({ status: 202, json: { ok: true, action: "rebuild" } }); }));
  const user = userEvent.setup();
  const rebuild = within(screen.getByRole("region", { name: "Stack" })).getByRole("button", { name: "Rebuild" });
  await user.click(rebuild);
  await user.click(within(screen.getByRole("dialog", { name: "Rebuild the stack?" })).getByRole("button", { name: "Rebuild" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/rebuild").length, 1));
  push(app, record({ kind: "rebuild" })); // the record arrives before the 202
  const launch = screen.getByRole("dialog", { name: "Rebuild running" });
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Rebuild the stack?" }), null));
  assert.ok(launch.contains(document.activeElement), "focus stays in the dialog on top, not on the inert page");
  push(app, record({ kind: "rebuild", running: false, ok: true, finishedAt: 2 }));
  await user.click(within(screen.getByRole("dialog", { name: "Rebuild finished" })).getAllByRole("button", { name: "Close" })[0]!);
  assert.ok(document.activeElement === within(screen.getByRole("region", { name: "Stack" })).getByRole("button", { name: "Rebuild" }), "focus is back on Rebuild");
});

// @spec DASH-UI-063
test("a record that has already ended opens nothing; the stack card's Last launch link reopens it, closable from the start", async () => {
  const { app } = await boot("#services");
  await screen.findByRole("heading", { level: 1, name: "Services" });
  push(app, stack({ state: "up" }));
  push(app, record({ running: false, ok: true, finishedAt: 2 }));
  assert.equal(queryDialog(), null);
  const card = screen.getByRole("region", { name: "Stack" });
  const link = within(card).getByRole("button", { name: "Last launch: details" });
  const user = userEvent.setup();
  await user.click(link);
  const d = screen.getByRole("dialog", { name: "Launch finished" });
  assert.equal(within(d).getAllByRole("button", { name: "Close" }).length, 2);
  await user.click(within(d).getAllByRole("button", { name: "Close" })[0]!);
  assert.equal(queryDialog(), null);
  assert.ok(document.activeElement === link, "focus returns to the link");
  push(app, record({ kind: "rebuild", startedAt: 3, running: false, ok: false, finishedAt: 4 }));
  assert.ok(within(screen.getByRole("region", { name: "Stack" })).getByRole("button", { name: "Last rebuild: details" }));
  push(app, record({ kind: "restart", startedAt: 5, running: false, ok: true, finishedAt: 6 }));
  assert.ok(within(screen.getByRole("region", { name: "Stack" })).getByRole("button", { name: "Last restart all: details" }));
});

// @spec DASH-UI-055
test("the dialog names the action and lists a row per service: a building row with its step, text and steps done; a finished row reads complete", async () => {
  const { app } = await boot("#live");
  push(app, record({ rows: [
    { service: "voice", state: "building", step: 2, of: 4, total: 6, done: 3, cached: 1, current: "RUN pip install -r requirements.txt" },
    { service: "chat", state: "cached", step: 3, of: 3, total: 3, done: 3, cached: 3 },
  ] }));
  const rows = within(dialog()).getAllByRole("row").slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent ?? "", /voice/);
  assert.match(rows[0]!.textContent ?? "", /building/);
  assert.match(rows[0]!.textContent ?? "", /step 2 of 4/);
  assert.match(rows[0]!.textContent ?? "", /RUN pip install -r requirements\.txt/);
  assert.match(rows[0]!.textContent ?? "", /3\/6 steps/);
  assert.match(rows[1]!.textContent ?? "", /chat.*cached/);
  assert.match(rows[1]!.textContent ?? "", /complete/);
  assert.doesNotMatch(rows[1]!.textContent ?? "", /step 3 of 3|3\/3 steps/);
  push(app, record({ running: false, ok: true, finishedAt: 2, rows: [{ service: "chat", state: "built", step: 6, of: 7, total: 15, done: 3, cached: 0, current: "RUN x" }] }));
  const built = within(dialog()).getAllByRole("row")[1]!;
  assert.match(built.textContent ?? "", /built/);
  assert.match(built.textContent ?? "", /complete/);
  assert.doesNotMatch(built.textContent ?? "", /step 6 of 7|3\/15 steps|RUN x/, "no stale mid-build step on a finished row");
  push(app, record({ kind: "restart", startedAt: 3, running: true, rows: [{ service: "voice", state: "done" }, { service: "chat", state: "restarting" }] }));
  const r = within(dialog()).getAllByRole("row").slice(1);
  assert.match(r[0]!.textContent ?? "", /voice.*done.*complete/);
  assert.match(r[1]!.textContent ?? "", /chat.*restarting/);
  assert.doesNotMatch(r[1]!.textContent ?? "", /complete/);
  push(app, record({ kind: "restart", startedAt: 3, running: false, ok: false, finishedAt: 4, rows: [{ service: "chat", state: "failed", detail: "boom" }] }));
  assert.match(within(dialog()).getAllByRole("row")[1]!.textContent ?? "", /chat.*failed.*boom/);
});

// @spec DASH-UI-056
test("a failure the page saw happen shows in an alert with the failing image and its last error lines", async () => {
  const { app } = await boot("#live");
  push(app, record({ rows: [{ service: "voice", state: "building", done: 1, total: 4, cached: 1 }] }));
  push(app, record({ running: false, ok: false, finishedAt: 2, rows: [{ service: "voice", state: "failed", done: 1, total: 4, cached: 1 }],
    failure: { service: "voice", lines: ["ERROR: No matching distribution found for torch==9.9.9", "ERROR: process did not complete successfully"] } }));
  const alert = within(dialog()).getByRole("alert");
  assert.match(alert.textContent ?? "", /voice failed to build/);
  assert.equal(alert.querySelector("pre")?.textContent, "ERROR: No matching distribution found for torch==9.9.9\nERROR: process did not complete successfully");
  push(app, record({ startedAt: 5, running: true }));
  push(app, record({ startedAt: 5, running: false, ok: false, finishedAt: 6, failure: { lines: ["Error response from daemon: no space left"] } }));
  assert.match(within(dialog()).getByRole("alert").textContent ?? "", /Launch failed/);
});

// @spec DASH-UI-056
test("a failure reopened from the stack card's link is a status, not an alert", async () => {
  const { app } = await boot("#services");
  await screen.findByRole("heading", { level: 1, name: "Services" });
  push(app, stack({ state: "down" }));
  push(app, record({ running: false, ok: false, finishedAt: 2, failure: { service: "voice", lines: ["ERROR: boom"] } }));
  await userEvent.setup().click(within(screen.getByRole("region", { name: "Stack" })).getByRole("button", { name: "Last launch: details" }));
  assert.equal(within(dialog()).queryByRole("alert"), null);
  const failure = dialog().querySelector(".launch-failure")!;
  assert.equal(failure.getAttribute("role"), "status");
  assert.match(failure.textContent ?? "", /voice failed to build/);
});

// @spec DASH-UI-057
test("the log is in a collapsed disclosure labelled with the line count, in a focusable preformatted region that follows its last line", async () => {
  const { app } = await boot("#live");
  push(app, record({ lines: ["#1 [voice 1/2] FROM cuda", "#1 CACHED", "#2 [voice 2/2] RUN pip install"] }));
  const details = dialog().querySelector("details")!;
  assert.equal(details.open, false);
  const summary = details.querySelector("summary")!;
  assert.match(summary.textContent ?? "", /^Build log \(3 lines\)$/);
  const pre = details.querySelector("pre")!;
  assert.equal(pre.textContent, "#1 [voice 1/2] FROM cuda\n#1 CACHED\n#2 [voice 2/2] RUN pip install");
  assert.equal(pre.getAttribute("tabindex"), "0");
  assert.ok(pre.getAttribute("aria-label"));
  Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 5000 });
  pre.scrollTop = 0;
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  assert.equal(pre.scrollTop, 5000);
  push(app, record({ kind: "restart", startedAt: 2, rows: [{ service: "voice", state: "restarting" }], lines: ["restarting voice"] }));
  assert.match(dialog().querySelector("summary")!.textContent ?? "", /^Output \(1 line\)$/);
});

// @spec DASH-UI-064
test("the rows sit in a fixed-height scrolling region before the failure block and the log, so a new row moves neither", async () => {
  const { app } = await boot("#live");
  push(app, record({ rows: [{ service: "voice", state: "building" }], lines: ["x"] }));
  const region = dialog().querySelector(".launch-rows")!;
  assert.ok(region, "the rows region exists while the record has rows");
  const details = dialog().querySelector("details")!;
  assert.ok(region.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING, "the log follows the rows");
  push(app, record({ rows: [{ service: "voice", state: "building" }, { service: "chat", state: "building" }], lines: ["x"] }));
  assert.ok(dialog().querySelector(".launch-rows") === region, "the same region, patched in place");
  assert.deepEqual(within(dialog()).getAllByRole("row").slice(1).map((r) => r.querySelector("th")?.textContent), ["voice", "chat"], "the record's order");
  push(app, record({ startedAt: 2, rows: [] }));
  assert.ok(dialog().querySelector(".launch-rows"), "the region keeps its place before the first row");
  const css = readFileSync(new URL("../../ui/src/styles/services.css", import.meta.url), "utf8");
  assert.match(css, /\.launch-rows\s*\{[^}]*\bheight:\s*[^;]+;[^}]*overflow-y:\s*auto/);
});
