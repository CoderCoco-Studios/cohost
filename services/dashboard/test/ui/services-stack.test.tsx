import { test } from "node:test";
import assert from "node:assert/strict";
import { act, screen, userEvent, waitFor, within } from "./helpers/render";
import type { StackSnapshot } from "../../ui/src/state/types";
import { mountServices, push, stackMsg, svc } from "./services-fixtures";

const ON = { enabled: true, runtime: "compose", advanced: false } as const;
const card = () => screen.getByRole("region", { name: "Stack" });
const buttons = () => within(card()).queryAllByRole("button").map((b) => b.textContent);
const press = async (name: string) => userEvent.setup().click(within(card()).getByRole("button", { name }));
const confirm = (name: string) => userEvent.setup().click(within(screen.getByRole("dialog")).getByRole("button", { name }));

// @spec DASH-UI-018
test("the card shows the stack state as a status with a sentence of cause, with control on or off", async () => {
  for (const control of [{ enabled: false } as const, ON]) {
    const { unmount } = await mountServices({ control, stack: stackMsg({ state: "up" }), services: [] });
    assert.ok(within(card()).getByText("Up", { selector: ".st" }) !== null);
    assert.match(card().textContent ?? "", /Docker is running\. The bus \(Redis\) is connected\./);
    unmount();
  }
});

// @spec DASH-UI-018
test("the card says how many services are healthy and sums up the last action in one plain line", async () => {
  const { app } = await mountServices({ services: [svc("chat"), svc("voice", { state: "down" }), svc("ears")], stack: stackMsg({ state: "degraded" }) });
  const before = app.clock.now;
  app.clock.now += 14 * 60_000;
  push(app, { type: "stack", ...stackMsg({ state: "degraded", last: { kind: "launch", ok: true, finishedAt: before } }) });
  assert.ok(within(card()).getByText("2 of 3 services healthy") !== null);
  assert.match(card().textContent ?? "", /Last action: launch finished 14 minutes ago, ok\./);
});

// @spec DASH-UI-018
test("with Docker unavailable the card gives the probe's detail; with the stack down it says nothing is running; with the bus unreachable it says what cannot be sent", async () => {
  const { app } = await mountServices({ stack: stackMsg({ state: "docker-unavailable", docker: { ok: false, detail: "docker: command not found" } }) });
  assert.ok(within(card()).getByText("Docker unavailable", { selector: ".st" }) !== null);
  assert.match(card().textContent ?? "", /docker: command not found/);
  push(app, { type: "stack", ...stackMsg({ state: "down" }) });
  assert.ok(within(card()).getByText("Down", { selector: ".st" }) !== null);
  assert.match(card().textContent ?? "", /Nothing is running\. The stack is down\./);
  push(app, { type: "stack", ...stackMsg({ state: "up", bus: "unreachable" }) });
  assert.match(card().textContent ?? "", /bus \(Redis\) is not reachable/);
  assert.match(card().textContent ?? "", /Mute, say and test inputs cannot be sent/);
  push(app, { type: "stack", ...stackMsg({ state: "up" }) });
  assert.ok(!/cannot be sent/.test(card().textContent ?? ""));
});

// @spec DASH-UI-018
test("before the first stack message the card says it is waiting, and offers no button", async () => {
  await mountServices({ control: ON, services: [] });
  assert.match(card().textContent ?? "", /Waiting for the stack status/);
  assert.deepEqual(buttons(), []);
});

// @spec DASH-UI-017, DASH-UI-029
test("with control off the card has no buttons and says how to turn control on", async () => {
  await mountServices({ control: { enabled: false }, stack: stackMsg({ state: "down" }) });
  assert.deepEqual(buttons(), []);
  assert.match(screen.getByRole("status", { name: "Service control is off" }).textContent ?? "", /CONTROL_ENABLED=1/);
});

// @spec DASH-UI-017
test("Launch shows while the stack is down; Restart all, Rebuild and Stop stack show while it is up, degraded or starting", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "down" }) });
  assert.deepEqual(buttons(), ["Launch"]);
  for (const state of ["up", "degraded", "starting"] as const) {
    push(app, { type: "stack", ...stackMsg({ state }) });
    assert.deepEqual(buttons(), ["Restart all", "Rebuild", "Stop stack"], state);
  }
});

// @spec DASH-UI-017
test("Launch asks first and says the images are rebuilt; confirming posts /stack/launch with the token and reports after the 202", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "down" }) });
  app.fetch.on("POST /stack/launch", { status: 202, json: { ok: true, action: "launch" } });
  await press("Launch");
  const dlg = screen.getByRole("dialog", { name: "Launch the stack?" });
  assert.match(dlg.textContent ?? "", /images are rebuilt/i);
  assert.equal(app.fetch.callsTo("POST /stack/launch").length, 0, "nothing is sent before confirming");
  await confirm("Launch");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/launch").length, 1));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  assert.ok((await within(card()).findByText(/Launch started/)) !== null);
});

// @spec DASH-UI-017
test("Rebuild says the images are rebuilt first; Restart all and Stop stack each ask, then post their route; Cancel sends nothing", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "up" }) });
  for (const k of ["rebuild", "restart", "stop"]) app.fetch.on(`POST /stack/${k}`, { status: 202, json: { ok: true, action: k } });
  await press("Rebuild");
  assert.match(screen.getByRole("dialog", { name: "Rebuild the stack?" }).textContent ?? "", /images are rebuilt first/i);
  await confirm("Cancel");
  assert.equal(app.fetch.callsTo("POST /stack/rebuild").length, 0);
  await press("Rebuild"); await confirm("Rebuild");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/rebuild").length, 1));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  await press("Restart all");
  assert.ok(screen.getByRole("dialog", { name: "Restart every running service?" }) !== null);
  await confirm("Restart all");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/restart").length, 1));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  await press("Stop stack");
  assert.match(screen.getByRole("dialog", { name: "Stop the whole stack?" }).textContent ?? "", /Redis and Postgres/);
  await confirm("Stop stack");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/stop").length, 1));
});

// @spec DASH-UI-017
test("a non-2xx answer shows its detail in the dialog, which stays open; a later 2xx clears it", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "down" }) });
  app.fetch.on("POST /stack/launch", { status: 409, json: { ok: false, detail: "busy: launch held by cohostctl (pid 4)" } });
  await press("Launch"); await confirm("Launch");
  const alert = await within(screen.getByRole("dialog")).findByRole("alert");
  assert.match(alert.textContent ?? "", /409 busy: launch held by cohostctl/);
  app.fetch.on("POST /stack/launch", { status: 202, json: { ok: true, action: "launch" } });
  await confirm("Launch");
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  assert.ok(within(card()).queryByRole("alert") === null);
});

// @spec DASH-UI-017
test("the stack buttons are disabled with the reason while an action runs or Docker is unavailable", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "up" }) });
  const disabled = () => ["Restart all", "Rebuild", "Stop stack"].map((n) => (within(card()).getByRole("button", { name: n }) as HTMLButtonElement).disabled);
  assert.deepEqual(disabled(), [false, false, false]);
  push(app, { type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: app.clock.now } }) });
  assert.deepEqual(disabled(), [true, true, true]);
  push(app, { type: "stack", ...stackMsg({ state: "docker-unavailable", docker: { ok: false, detail: "no daemon" } }) });
  assert.deepEqual(buttons(), ["Launch"]);
  assert.equal((within(card()).getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled, true);
  push(app, { type: "stack", ...stackMsg({ state: "down" }) });
  assert.equal((within(card()).getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled, false);
});

// @spec DASH-UI-017
test("a confirm dialog open when an action starts stays open with its confirm disabled and the reason shown", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "up" }) });
  await press("Stop stack");
  push(app, { type: "stack", ...stackMsg({ state: "stopping", action: { kind: "stop", phase: "stopping", startedAt: app.clock.now } }) });
  const dlg = screen.getByRole("dialog");
  assert.equal((within(dlg).getByRole("button", { name: "Stop stack" }) as HTMLButtonElement).disabled, true);
  assert.match(dlg.textContent ?? "", /A stack action is running/);
});

// @spec DASH-UI-019
test("after a successful stop, and only then, the card offers Run consolidation pass, which asks and posts /stack/consolidate", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg() });
  app.fetch.on("POST /stack/consolidate", { status: 202, json: { ok: true, action: "consolidate" } });
  const shown = () => within(card()).queryByRole("button", { name: "Run consolidation pass" }) !== null;
  const last = (over: Record<string, unknown>) => ({ kind: "stop", ok: true, finishedAt: 1, ...over }) as StackSnapshot["last"];
  assert.equal(shown(), false);
  push(app, { type: "stack", ...stackMsg({ last: last({ kind: "launch" }) }) });
  assert.equal(shown(), false);
  push(app, { type: "stack", ...stackMsg({ state: "down", last: last({ ok: false, detail: "boom" }) }) });
  assert.equal(shown(), false);
  push(app, { type: "stack", ...stackMsg({ state: "down", last: last({}) }) });
  assert.equal(shown(), true);
  await press("Run consolidation pass");
  assert.match(screen.getByRole("dialog", { name: "Run the consolidation pass?" }).textContent ?? "", /30 minutes/);
  await confirm("Run consolidation pass");
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /stack/consolidate").length, 1));
  push(app, { type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: 4 }, last: last({}) }) });
  assert.equal(shown(), false, "not while another action runs");
});

// @spec DASH-UI-019
test("with control off the consolidation button never shows", async () => {
  await mountServices({ control: { enabled: false }, stack: stackMsg({ state: "down", last: { kind: "stop", ok: true, finishedAt: 1 } }) });
  assert.equal(within(card()).queryAllByRole("button").length, 0);
});

// @spec DASH-UI-020
test("a running launch shows its kind, phase in words, the step and the elapsed time, which advances with the page clock", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg({ state: "starting" }) });
  const start = app.clock.now - 125_000;
  push(app, { type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: start } }) });
  const t = () => within(card()).getByRole("group", { name: "Running action" }).textContent ?? "";
  assert.match(t(), /Launch/);
  assert.match(t(), /building images and starting containers/);
  assert.match(t(), /step 1 of 2/);
  assert.match(t(), /Started 2m 05s ago\. Stack actions are locked until this finishes\./);
  push(app, { type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: start } }) });
  assert.match(t(), /waiting for every service/);
  assert.match(t(), /step 2 of 2/);
  app.clock.now += 10_000;
  await waitFor(() => assert.match(t(), /2m 15s/), { timeout: 3000 });
});

// @spec DASH-UI-020
test("the other kinds show their phase words and no step: stopping, restarting <service>, running; rebuild has steps", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg() });
  const show = (kind: string, phase: string) => push(app, { type: "stack", ...stackMsg({ action: { kind, phase, startedAt: app.clock.now } as StackSnapshot["action"] }) });
  const t = () => within(card()).getByRole("group", { name: "Running action" }).textContent ?? "";
  show("stop", "stopping"); assert.match(t(), /Stop.*stopping/); assert.ok(!/step/.test(t()));
  show("restart", "restarting voice"); assert.match(t(), /Restart.*restarting voice/); assert.ok(!/step/.test(t()));
  show("consolidate", "running"); assert.match(t(), /Consolidation.*running/); assert.ok(!/step/.test(t()));
  show("rebuild", "compose-build"); assert.match(t(), /Rebuild.*step 1 of 2/);
  show("launch", "starting"); assert.match(t(), /step 1 of 2/);
});

// @spec DASH-UI-020
test("when last changes the card shows the result and every service it lists as not ready, with its status, as text; a later result replaces it", async () => {
  const { app } = await mountServices({ control: ON, stack: stackMsg() });
  push(app, { type: "stack", ...stackMsg({ state: "degraded", last: { kind: "launch", ok: false, detail: "not ready after 180s", finishedAt: app.clock.now - 60_000, services: [{ service: "voice", status: "running", health: "starting" }, { service: "x<b>", status: "exited" }] } }) });
  const c = card();
  assert.match(c.textContent ?? "", /Last action: launch finished 1 minute ago, failed: not ready after 180s\./);
  assert.ok(within(c).getByText("voice") !== null);
  assert.ok(within(c).getByText("running, starting") !== null);
  assert.ok(within(c).getByText("x<b>") !== null && c.querySelector("b") === null, "rendered as text");
  push(app, { type: "stack", ...stackMsg({ last: { kind: "stop", ok: true, finishedAt: app.clock.now } }) });
  assert.match(card().textContent ?? "", /Last action: stop finished .*, ok\./);
  assert.ok(within(card()).queryByText("voice") === null);
});

// @spec DASH-UI-018
test("containers that send no heartbeat are listed on the card with their status", async () => {
  await mountServices({ services: [svc("chat")], stack: stackMsg({ services: [{ service: "chat", status: "running" }, { service: "redis", status: "running", health: "healthy" }, { service: "postgres", status: "exited" }] }) });
  const list = within(card()).getByRole("list", { name: "Other containers" });
  const items = within(list).getAllByRole("listitem").map((i) => i.textContent);
  assert.deepEqual(items, ["redis: running, healthy", "postgres: exited"]);
});

// @spec DASH-UI-001
test("the card is busy and stale while the socket is closed", async () => {
  const { app } = await mountServices({ stack: stackMsg() });
  act(() => app.socket().serverClose());
  assert.equal(card().getAttribute("aria-busy"), "true");
  assert.ok(card().classList.contains("stale"));
});
