import "./helpers/dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, renderApp, makeApp, screen, userEvent, within, type TestApp } from "./helpers/render";
import { FakeStorage } from "./helpers/fakes";
import { AccessDialog } from "../../ui/src/app/AccessDialog";

const CONTROL_CMD = "grep ^CONTROL_TOKEN= .env";
const VIEWERS_CMD = 'echo "VIEWERS_TOKEN=$(openssl rand -hex 24)" >> .env';
const REJECTED = "The dashboard rejected this token. Nothing was changed.";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Mounts the dialog host beside an opener button that holds the focus, the way the header's Access button does. */
function mount(app: TestApp = makeApp()) {
  const r = renderApp(<><button>Opener</button><AccessDialog /></>, app);
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  return { ...r, opener };
}

/** Asks for a token as a waiting request would, and returns what the request will see. */
function ask(app: TestApp, kind: "control" | "viewers", action = "Restart voice") {
  let result: boolean | undefined;
  act(() => { void app.rt.access.ask(kind, action).then((v) => { result = v; }); });
  return () => result;
}

const dlg = () => screen.getByRole("dialog", { name: "Access" });
const field = () => within(dlg()).getByLabelText(/token$/i, { selector: "input" }) as HTMLInputElement;
const unlock = () => within(dlg()).getByRole("button", { name: /^(Unlock|Try again)/ });

const checkRoutes = (app: TestApp, good = "good") => {
  app.fetch.on("PUT /secrets/access-check", (c) => c.headers.authorization === `Bearer ${good}` ? { status: 404, json: { ok: false, detail: "unknown secret" } } : { status: 401, text: "unauthorized" });
  app.fetch.on("GET /viewers", (c) => c.headers.authorization === `Bearer ${good}` ? { json: { viewers: [] } } : { status: 401, text: "unauthorized" });
};

const consoleCalls: unknown[][] = [];
const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
function spyConsole() { for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { consoleCalls.push(a); }; }
afterEach(() => { Object.assign(console, orig); consoleCalls.length = 0; });

// @spec DASH-ACC-003
test("the dialog shows a masked field (password, autocomplete off) with Show, Hide and Paste, the variable's name, the command and what the token unlocks", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  ask(app, "control");
  const input = field();
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("autocomplete"), "off");
  const show = within(dlg()).getByRole("button", { name: "Show" });
  await user.click(show);
  assert.equal(field().type, "text");
  await user.click(within(dlg()).getByRole("button", { name: "Hide" }));
  assert.equal(field().type, "password");
  assert.ok(within(dlg()).getByRole("button", { name: "Paste" }));
  const text = dlg().textContent!;
  assert.match(text, /CONTROL_TOKEN/);
  assert.ok(text.includes(CONTROL_CMD), "the command is shown");
  assert.match(text, /mute, say lines, save settings, send test inputs and control services/i);
  assert.match(text, /Restart voice/);
});

// @spec DASH-ACC-003
test("the viewers token dialog shows the exact line to add to .env, says the installer does not generate it and that the dashboard must restart", () => {
  const { app } = mount();
  ask(app, "viewers", "Load viewers");
  const text = dlg().textContent!;
  assert.ok(text.includes(VIEWERS_CMD), "the line is shown");
  assert.match(text, /VIEWERS_TOKEN/);
  assert.match(text, /installer does not (generate|create)/i);
  assert.match(text, /restart the dashboard/i);
  assert.match(text, /read and edit viewer notes/i);
});

// @spec DASH-ACC-003
test("Copy writes the command to the clipboard when the API exists", async () => {
  const user = userEvent.setup();
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { written.push(t); }, readText: async () => "" } });
  try {
    const { app } = mount();
    ask(app, "control");
    await user.click(within(dlg()).getByRole("button", { name: /^Copy/ }));
    await flush();
    assert.deepEqual(written, [CONTROL_CMD]);
  } finally { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); }
});

// @spec DASH-ACC-003
test("without the clipboard API, Copy selects the command's text so it can be copied by hand", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const { app } = mount();
  ask(app, "control");
  await user.click(within(dlg()).getByRole("button", { name: /^Copy/ }));
  await flush();
  assert.equal(window.getSelection()!.toString().trim(), CONTROL_CMD);
  assert.match(dlg().textContent!, /copy it by hand|press Ctrl\+C/i);
});

// @spec DASH-ACC-003
test("Paste fills the field from the clipboard when it can, and says so when it cannot", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "from-clipboard", writeText: async () => {} } });
  try {
    const { app } = mount();
    ask(app, "control");
    await user.click(within(dlg()).getByRole("button", { name: "Paste" }));
    await flush();
    assert.equal(field().value, "from-clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await user.clear(field());
    await user.click(within(dlg()).getByRole("button", { name: "Paste" }));
    await flush();
    assert.equal(field().value, "");
    assert.match(dlg().textContent!, /paste.*(not available|cannot)/i);
  } finally { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); }
});

// @spec DASH-A11Y-004, DASH-ACC-003
test("the paste note is announced: the status region exists before the note and receives its text", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const { app } = mount();
  ask(app, "control");
  const region = within(dlg()).getAllByRole("status").find((el) => el.classList.contains("paste-note"));
  assert.ok(region, "a status region for the paste note is mounted before any note");
  assert.equal(region!.textContent, "");
  await user.click(within(dlg()).getByRole("button", { name: "Paste" }));
  await flush();
  assert.match(region!.textContent!, /not available/i);
  assert.ok(region!.isConnected, "the same region received the text");
});

// @spec DASH-ACC-004, DASH-ACC-002, DASH-ACC-012
test("a control token is trimmed and checked with PUT /secrets/access-check before it is stored; once accepted it is stored and the waiting request is released", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  checkRoutes(app);
  const result = ask(app, "control");
  await user.type(field(), "  good  ");
  assert.equal(app.session.getItem("cohost.controlToken"), null, "nothing is stored while typing");
  await user.click(unlock());
  await flush();
  const calls = app.fetch.callsTo("PUT /secrets/access-check");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.authorization, "Bearer good");
  assert.deepEqual(JSON.parse(calls[0]!.body!), { value: null });
  assert.equal(app.session.getItem("cohost.controlToken"), "good");
  assert.equal(result(), true);
  assert.ok(screen.queryByRole("dialog") === null, "the dialog closed");
  for (const c of app.fetch.calls) assert.ok(!c.path.includes("good"), `the token is in a URL: ${c.path}`);
});

// @spec DASH-ACC-004, DASH-ACC-005
test("a rejected control token is not stored: the dialog stays open, says so and lists the things to check", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  checkRoutes(app);
  const result = ask(app, "control");
  await user.type(field(), "wrong");
  await user.click(unlock());
  await flush();
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  assert.equal(app.local.getItem("cohost.controlToken"), null);
  assert.equal(result(), undefined, "the waiting request keeps waiting");
  assert.ok(dlg().textContent!.includes(REJECTED));
  assert.match(dlg().textContent!, /whole value after CONTROL_TOKEN=.*no spaces or quotes/i);
  assert.match(dlg().textContent!, /restart the dashboard/i);
  assert.equal(app.rt.access.state.get().control.present, false);
});

// @spec DASH-ACC-004
test("a 403 from the access check stores nothing and shows the control token as not set up, naming CONTROL_TOKEN and CONTROL_ENABLED", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.fetch.on("PUT /secrets/access-check", { status: 403, json: { ok: false, detail: "secrets cannot be written: no control token is configured. Set CONTROL_TOKEN in .env (CONTROL_ENABLED does not have to be 1) and restart the dashboard" } });
  ask(app, "control");
  await user.type(field(), "anything");
  await user.click(unlock());
  await flush();
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  const text = dlg().textContent!;
  assert.match(text, /Not set up on the server/);
  assert.match(text, /CONTROL_TOKEN/);
  assert.match(text, /CONTROL_ENABLED/);
  assert.equal(app.rt.access.state.get().control.notSetUp, true);
});

// @spec DASH-ACC-004
test("any other outcome of the check (a network error, a 5xx, a 403 that is not about the token) stores nothing and shows the failure", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  ask(app, "control");
  for (const [setup, expect] of [
    [() => app.fetch.fail("PUT /secrets/access-check"), /network error/i],
    [() => app.fetch.on("PUT /secrets/access-check", { status: 500, text: "boom" }), /500.*boom/],
    [() => app.fetch.on("PUT /secrets/access-check", { status: 403, text: "forbidden origin" }), /403.*forbidden origin/],
  ] as const) {
    setup();
    await user.clear(field());
    await user.type(field(), "t");
    await user.click(unlock());
    await flush();
    assert.equal(app.session.getItem("cohost.controlToken"), null);
    assert.match(within(dlg()).getByRole("alert").textContent!, expect);
    assert.ok(!dlg().textContent!.includes(REJECTED), "a failed check is not a rejection");
  }
});

// @spec DASH-ACC-004
test("a viewers token is checked with GET /viewers: 200 and 504 accept it, 401 rejects it", async () => {
  const user = userEvent.setup();
  for (const status of [200, 504]) {
    const { app, unmount } = mount();
    app.fetch.on("GET /viewers", (c) => c.headers.authorization === "Bearer vt" ? { status, json: status === 200 ? { viewers: [] } : { ok: false } } : { status: 401, text: "unauthorized" });
    const result = ask(app, "viewers", "Load viewers");
    await user.type(field(), "bad");
    await user.click(unlock());
    await flush();
    assert.ok(dlg().textContent!.includes(REJECTED), "401 rejects");
    assert.equal(app.session.getItem("cohost.viewersToken"), null);
    await user.clear(field());
    await user.type(field(), " vt ");
    await user.click(unlock());
    await flush();
    assert.equal(app.session.getItem("cohost.viewersToken"), "vt", `${status} accepts`);
    assert.equal(result(), true);
    unmount();
  }
});

// @spec DASH-ACC-004, DASH-ACC-009
test("a 403 from the viewers check shows the setup steps with the line to add, and stores nothing", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.fetch.on("GET /viewers", { status: 403, text: "The Viewers page is locked: set VIEWERS_TOKEN in .env" });
  ask(app, "viewers", "Load viewers");
  await user.type(field(), "x");
  await user.click(unlock());
  await flush();
  assert.equal(app.session.getItem("cohost.viewersToken"), null);
  assert.equal(app.rt.access.state.get().viewers.notSetUp, true);
  assert.match(dlg().textContent!, /Not set up on the server/);
  assert.ok(within(dlg()).getAllByRole("listitem").length >= 3, "numbered steps");
});

// @spec DASH-ACC-007
test("Stay unlocked is a radio group: This tab (the default) keeps the token in sessionStorage, This browser in localStorage, and the choice is not remembered", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  checkRoutes(app);
  const tab = () => within(dlg()).getByRole("radio", { name: /This tab/ }) as HTMLInputElement;
  const browser = () => within(dlg()).getByRole("radio", { name: /This browser/ }) as HTMLInputElement;
  ask(app, "control");
  assert.equal(tab().checked, true);
  assert.equal(browser().checked, false);
  assert.match(dlg().textContent!, /forgotten when this tab closes/i);
  await user.click(browser());
  assert.match(dlg().textContent!, /keeps the token until you lock the page/i);
  await user.type(field(), "good");
  await user.click(unlock());
  await flush();
  assert.equal(app.local.getItem("cohost.controlToken"), "good");
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  // Opening the dialog again for the same token starts at This tab: "this browser" is opt-in each time.
  act(() => app.rt.access.lock("control"));
  ask(app, "control");
  assert.equal(tab().checked, true);
});

// @spec DASH-ACC-007
test("when storage throws the token is kept in memory and the dialog says it will be asked for again after a reload", async () => {
  const user = userEvent.setup();
  const app = makeApp({ local: FakeStorage.throwing(), session: FakeStorage.throwing() });
  mount(app);
  checkRoutes(app);
  const result = ask(app, "control");
  await user.type(field(), "good");
  await user.click(unlock());
  await flush();
  assert.equal(app.rt.access.getToken("control"), "good");
  assert.match(dlg().textContent!, /asked for again after a reload/i);
  assert.equal(result(), undefined, "released once the operator has read the note");
  await user.click(within(dlg()).getByRole("button", { name: "Continue" }));
  await flush();
  assert.equal(result(), true);
  assert.ok(screen.queryByRole("dialog") === null, "closed");
});

// @spec DASH-ACC-002
test("Cancel runs nothing: the waiting request resolves as locked, reporting not done: locked", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.fetch.on("POST /control", { status: 401, text: "unauthorized" });
  let r: Awaited<ReturnType<typeof app.rt.api.control>> | undefined;
  act(() => { void app.rt.api.control({ cmd: "mute" }, "Mute co-host").then((v) => { r = v; }); });
  await flush();
  assert.match(dlg().textContent!, /Mute co-host/);
  await user.click(within(dlg()).getByRole("button", { name: "Cancel" }));
  await flush();
  assert.equal(r && !r.ok && r.detail, "not done: locked");
  assert.equal(app.fetch.callsTo("POST /control").length, 1, "nothing was retried");
});

// @spec DASH-ACC-002, DASH-UI-006
test("a request that hits 401 opens the dialog and, once a checked token is entered, is retried once with the bearer header", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  checkRoutes(app);
  app.fetch.on("POST /control", (c) => c.headers.authorization === "Bearer good" ? { status: 204 } : { status: 401, text: "unauthorized" });
  let r: Awaited<ReturnType<typeof app.rt.api.control>> | undefined;
  act(() => { void app.rt.api.control({ cmd: "mute" }, "Mute co-host").then((v) => { r = v; }); });
  await flush();
  await user.type(field(), "good");
  await user.click(unlock());
  await flush();
  assert.equal(r?.ok, true);
  assert.deepEqual(app.fetch.callsTo("POST /control").map((c) => c.headers.authorization ?? null), [null, "Bearer good"]);
});

// @spec DASH-ACC-006
test("a stored token the server rejects is cleared, the button state follows, and the dialog reopens saying it was rejected", async () => {
  const { app } = mount();
  app.rt.access.setToken("control", "old", "tab");
  app.fetch.on("POST /control", { status: 401, text: "unauthorized" });
  act(() => { void app.rt.api.control({ cmd: "mute" }, "Mute co-host"); });
  await flush();
  assert.equal(app.rt.access.state.get().control.present, false);
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  assert.match(dlg().textContent!, /rejected/i);
  assert.match(dlg().textContent!, /Mute co-host/);
  assert.match(dlg().textContent!, /restart the dashboard/i);
});

// @spec DASH-ACC-008
test("the Access panel lists both tokens with their state and what they unlock, with Change token and Lock", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.rt.access.setToken("control", "c", "browser");
  app.rt.access.markNotSetUp("viewers", true);
  act(() => app.rt.access.openPanel());
  const control = within(dlg()).getByRole("group", { name: "Control token" });
  const viewers = within(dlg()).getByRole("group", { name: "Viewers token" });
  assert.match(control.textContent!, /Unlocked/);
  assert.match(control.textContent!, /this browser/i);
  assert.match(control.textContent!, /mute, say lines, save settings/i);
  assert.match(viewers.textContent!, /Not set up on the server/);
  assert.match(viewers.textContent!, /read and edit viewer notes/i);
  for (const g of [control, viewers]) {
    assert.ok(within(g).getByRole("button", { name: /Change token/ }));
    assert.ok(within(g).getByRole("button", { name: /Lock/ }));
  }
  act(() => app.rt.access.markNotSetUp("viewers", false));
  assert.match(within(dlg()).getByRole("group", { name: "Viewers token" }).textContent!, /Locked/);
  assert.equal((within(viewers).getByRole("button", { name: /Lock/ }) as HTMLButtonElement).disabled, true, "nothing to lock");
  await user.click(within(dlg()).getByRole("button", { name: "Done" }));
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.equal(app.rt.access.state.get().panelOpen, false);
});

// @spec DASH-ACC-008, DASH-CTRL-007
test("a browser unlocked by the unlock link shows the control token as Unlocked (this browser); without the session it is Locked", async () => {
  const unlocked = makeApp();
  unlocked.fetch.on("GET /services/control", { json: { enabled: true, runtime: "compose", advanced: false, unlocked: true } });
  const a = mount(unlocked);
  act(() => unlocked.rt.access.openPanel());
  await within(within(dlg()).getByRole("group", { name: "Control token" })).findByText("Unlocked (this browser)");
  a.unmount();
  const locked = makeApp();
  locked.fetch.on("GET /services/control", { json: { enabled: true, runtime: "compose", advanced: false, unlocked: false } });
  mount(locked);
  act(() => locked.rt.access.openPanel());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(within(dlg()).getByRole("group", { name: "Control token" }).textContent!, /Locked/);
});

// @spec DASH-ACC-003
test("the control token's dialog points at the unlock link printed in the terminal", async () => {
  const { app } = mount();
  void ask(app, "control");
  await within(dlg()).findByText(/unlock link printed in the terminal running/);
  assert.match(dlg().textContent!, /mise run dashboard:unlock/);
});

// @spec DASH-ACC-007, DASH-ACC-008
test("Lock removes the token from both storages and the panel shows Locked", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.rt.access.setToken("control", "c", "tab");
  app.local.setItem("cohost.controlToken", "also");
  act(() => app.rt.access.openPanel());
  await user.click(within(within(dlg()).getByRole("group", { name: "Control token" })).getByRole("button", { name: /Lock/ }));
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  assert.equal(app.local.getItem("cohost.controlToken"), null);
  assert.match(within(dlg()).getByRole("group", { name: "Control token" }).textContent!, /Locked/);
});

// @spec DASH-ACC-008, DASH-ACC-004
test("Change token in the panel opens the field for that token, checks it, and replaces the stored one", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  checkRoutes(app, "new");
  app.rt.access.setToken("control", "old", "tab");
  act(() => app.rt.access.openPanel());
  await user.click(within(within(dlg()).getByRole("group", { name: "Control token" })).getByRole("button", { name: /Change token/ }));
  await user.type(field(), "new");
  await user.click(unlock());
  await flush();
  assert.equal(app.session.getItem("cohost.controlToken"), "new");
  assert.match(within(dlg()).getByRole("group", { name: "Control token" }).textContent!, /Unlocked/);
});

// @spec DASH-ACC-010
test("the dialog explains that the .env variables are read once at start and take effect after a restart", () => {
  const { app } = mount();
  ask(app, "control");
  const where = within(dlg()).getByText(/Where these are set/i).closest("details")!;
  for (const name of ["CONTROL_TOKEN", "CONTROL_ENABLED", "CONTROL_ADVANCED", "DASHBOARD_HOST", "VIEWERS_TOKEN"]) assert.ok(where.textContent!.includes(name), name);
  assert.match(where.textContent!, /\.env/);
  assert.match(where.textContent!, /once when the dashboard starts/i);
  assert.match(where.textContent!, /after it restarts|restart/i);
  assert.match(where.textContent!, /never sets|does not set|cannot set/i);
});

// @spec DASH-ACC-011
test("the dialog is modal, focuses its field on open, closes as a cancel on the cancel event (Esc), and returns focus to the control that opened it", async () => {
  const { app, opener } = mount();
  const result = ask(app, "control");
  assert.equal((dlg() as HTMLDialogElement).open, true);
  assert.ok(document.activeElement === field(), "focus is on the field");
  fireEvent(dlg(), new Event("cancel", { cancelable: true })); // what Esc fires in a browser
  await flush();
  assert.equal(result(), false);
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.ok(document.activeElement === opener, "focus returned to the opener");
});

// @spec DASH-ACC-011
test("a cancel event while the panel is open closes the panel", async () => {
  const { app } = mount();
  act(() => app.rt.access.openPanel());
  fireEvent(dlg(), new Event("cancel", { cancelable: true }));
  await flush();
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.equal(app.rt.access.state.get().panelOpen, false);
});

// @spec DASH-ACC-012
test("a token is only ever in the field: not in the page text, not in the console, cleared when the dialog closes", async () => {
  spyConsole();
  const user = userEvent.setup();
  const { app, container } = mount();
  checkRoutes(app);
  ask(app, "control");
  await user.type(field(), "wrong-secret");
  assert.ok(!document.body.textContent!.includes("wrong-secret"), "typed text is not rendered as text");
  await user.click(unlock());
  await flush();
  assert.ok(!document.body.textContent!.includes("wrong-secret"), "a failed check does not echo it");
  assert.equal(field().value, "wrong-secret", "kept in the field so it can be corrected");
  await user.click(within(dlg()).getByRole("button", { name: "Cancel" }));
  await flush();
  ask(app, "control");
  assert.equal(field().value, "", "cleared when the dialog closed");
  assert.deepEqual(consoleCalls, []);
  assert.ok(!container.innerHTML.includes("wrong-secret"));
  for (const c of app.fetch.calls) assert.ok(!c.path.includes("wrong-secret"));
});

// @spec DASH-ACC-004
test("an empty field cannot be submitted", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  ask(app, "control");
  assert.equal((unlock() as HTMLButtonElement).disabled, true);
  await user.type(field(), "   ");
  assert.equal((unlock() as HTMLButtonElement).disabled, true);
  assert.equal(app.fetch.calls.length, 0);
});

// @spec DASH-ACC-008, DASH-ACC-009
test("a viewers token that is not set up on the server shows the setup steps in the panel, and Check again clears the state once the server answers other than 403", async () => {
  const user = userEvent.setup();
  const { app } = mount();
  app.rt.access.markNotSetUp("viewers", true);
  app.fetch.on("GET /viewers", { status: 403, text: "locked: set VIEWERS_TOKEN" });
  act(() => app.rt.access.openPanel());
  const viewers = within(dlg()).getByRole("group", { name: "Viewers token" });
  assert.ok(viewers.textContent!.includes(VIEWERS_CMD));
  assert.equal(within(viewers).getAllByRole("listitem").length, 3);
  await user.click(within(viewers).getByRole("button", { name: "Check again" }));
  await flush();
  assert.equal(app.rt.access.state.get().viewers.notSetUp, true);
  app.fetch.on("GET /viewers", { status: 401, text: "unauthorized" });
  await user.click(within(viewers).getByRole("button", { name: "Check again" }));
  await flush();
  assert.equal(app.rt.access.state.get().viewers.notSetUp, false);
});

// @spec DASH-A11Y-005
test("a click on the backdrop closes neither the token prompt nor the Access panel: both hold input", async () => {
  const app = makeApp();
  mount(app);
  const result = ask(app, "control");
  await flush();
  await userEvent.setup().click(dlg());
  assert.ok(dlg(), "the prompt is still open");
  assert.equal(result(), undefined, "the waiting request was not released");
  act(() => { app.rt.access.resolvePrompt(false); });
  act(() => { app.rt.access.openPanel(); });
  await flush();
  await userEvent.setup().click(dlg());
  assert.ok(dlg(), "the panel is still open");
});
