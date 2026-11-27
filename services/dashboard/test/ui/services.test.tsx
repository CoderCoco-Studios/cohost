import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { SERVICE_MANIFEST } from "@cohost/control";
import { act, makeApp, screen, userEvent, waitFor, within } from "./helpers/render";
import { UNITS, beat, mountServices, push, stackMsg, svc } from "./services-fixtures";

const table = () => screen.getByRole("table", { name: "Services" });
const rowOf = (name: string): HTMLElement => {
  const row = within(table()).getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name }) !== null);
  assert.ok(row !== undefined, `no row for ${name}`);
  return row;
};
const names = (): string[] => within(table()).getAllByRole("rowheader").map((h) => h.textContent ?? "");
// the row's own button comes first in the DOM; a dialog it opened sits after it in the same cell and may repeat the name
const btn = (row: HTMLElement, name: string): HTMLElement | null => within(row).queryAllByRole("button", { name })[0] ?? null;

// @spec DASH-UI-031
test("before the first services message the screen shows a loading state, and no list", async () => {
  await mountServices();
  assert.ok(screen.queryByRole("table") === null, "no table yet");
  assert.equal(screen.getByText("Loading services…").closest("[aria-busy]")?.getAttribute("aria-busy"), "true");
});

// @spec DASH-UI-007
test("with no services the screen says No services reported yet and still shows the stack card", async () => {
  await mountServices({ services: [], stack: stackMsg() });
  assert.ok(screen.getByText("No services reported yet") !== null);
  assert.ok(screen.getByRole("region", { name: "Stack" }) !== null);
  assert.ok(screen.queryByRole("table") === null, "an empty list renders no table");
});

// @spec DASH-UI-007, DASH-A11Y-003
test("the list is a real table with column headers, one row per service keyed by a row header, and one h1", async () => {
  await mountServices({ services: [svc("chat"), svc("voice")] });
  assert.equal(screen.getAllByRole("heading", { level: 1 }).length, 1);
  const heads = within(table()).getAllByRole("columnheader").map((h) => h.textContent);
  assert.deepEqual(heads, ["Service", "State", "Why", "Last seen", "Actions"]);
  assert.deepEqual(names(), ["chat", "voice"]);
});

// @spec DASH-UI-007, DASH-THEME-004
test("each state shows as a status: its word and its shape class, so colour is never the only cue", async () => {
  await mountServices({ services: [
    svc("chat", { state: "up" }), svc("voice", { state: "degraded" }), svc("cortex", { state: "stale" }),
    svc("salience", { state: "down" }), svc("eyes", { state: "crash-looping", restarts: 4 }), svc("ears", { state: "unknown", heartbeat: undefined, lastSeenAgeMs: undefined }),
    svc("memory", { state: "degraded", heartbeat: beat({ state: "starting" }) }),
  ] });
  const want: Record<string, [string, string]> = {
    chat: ["Up", "st-ok"], voice: ["Degraded", "st-warn"], cortex: ["Stale", "st-warn"], salience: ["Down", "st-bad"],
    eyes: ["Crash-looping", "st-bad"], ears: ["Unknown", "st-stopped"], memory: ["Starting", "st-building"],
  };
  for (const [name, [word, cls]] of Object.entries(want)) {
    const el = within(rowOf(name)).getByText(word, { selector: ".st" });
    assert.ok(el.classList.contains(cls), `${name}: ${word} carries ${cls}`);
    assert.ok(el.querySelector("svg") !== null, `${name}: a shape`);
  }
});

// @spec DASH-UI-007
test("the why cell leads with a crash-loop, then what the service needs, then the state, and always shows mode, dependencies and detail after it", async () => {
  await mountServices({ services: [
    svc("eyes", { state: "crash-looping", restarts: 4, needs: [{ service: "voice", state: "crash-looping" }], heartbeat: beat({ detail: "tts backend unreachable", deps: { redis: "ok" } }) }),
    svc("avatar", { state: "degraded", needs: [{ service: "voice", state: "down" }, { service: "tts", state: "unknown" }], heartbeat: beat({ deps: { redis: "ok" } }) }),
    svc("chat", { heartbeat: beat({ detail: "listening to twitch", deps: { twitch: "ok" } }) }),
    svc("cortex", { heartbeat: beat({ mode: "live", deps: { redis: "ok", llm: "ok" } }) }),
  ] });
  assert.ok(within(rowOf("eyes")).getByText("4 restarts in the last minute") !== null);
  assert.ok(within(rowOf("eyes")).getByText("live · deps: redis ok · tts backend unreachable") !== null);
  assert.ok(within(rowOf("avatar")).getByText("Needs voice (down), tts (unknown)") !== null);
  assert.ok(within(rowOf("avatar")).getByText("live · deps: redis ok") !== null);
  assert.ok(within(rowOf("chat")).getByText("live · deps: twitch ok · listening to twitch") !== null);
  assert.ok(within(rowOf("cortex")).getByText("live · deps: redis ok, llm ok") !== null);
  assert.equal(within(rowOf("cortex")).getAllByRole("cell")[1]!.children.length, 1, "an ok service has only the muted line");
});

// @spec DASH-UI-007
test("a non-ok state with nothing more specific still gets a plain sentence; a never-seen service and the dashboard's own row are said", async () => {
  await mountServices({ services: [
    svc("voice", { state: "stale", lastSeenAgeMs: 40000 }),
    svc("cortex", { state: "down", lastSeenAgeMs: 900000 }),
    svc("ears", { state: "unknown", heartbeat: undefined, lastSeenAgeMs: undefined }),
    svc("dashboard", { state: "up" }),
  ] });
  assert.match(within(rowOf("voice")).getByText(/heartbeats have stopped/i).textContent ?? "", /./);
  assert.match(within(rowOf("cortex")).getByText(/probably not running/i).textContent ?? "", /./);
  assert.ok(within(rowOf("voice")).getByText("live") !== null, "mode follows the sentence");
  assert.ok(within(rowOf("ears")).getByText("No heartbeat yet. It has not been started.") !== null);
  assert.ok(within(rowOf("dashboard")).getByText("This page. Runs on the host, so it has no controls here.") !== null);
  assert.ok(within(rowOf("dashboard")).getByText("now") !== null);
});

// @spec MOD-LIFE-002
test("a row with needs shows needs <service> (<state>) beside its own unchanged state; a row without needs shows none", async () => {
  await mountServices({ services: [
    svc("salience", { needs: [{ service: "affect", state: "down" }, { service: "cortex", state: "unknown" }] }),
    svc("cortex", { needs: [] }), svc("chat"),
  ] });
  const r = rowOf("salience");
  assert.ok(within(r).getByText("Up", { selector: ".st" }) !== null);
  assert.ok(within(r).getByText("needs affect (down)") !== null);
  assert.ok(within(r).getByText("needs cortex (unknown)") !== null);
  assert.ok(within(rowOf("cortex")).queryByText(/needs /) === null);
  assert.ok(within(rowOf("chat")).queryByText(/needs /) === null);
});

// @spec MOD-PAUSE-003
test("a unit shows as paused exactly while its heartbeat detail is paused; another detail shows in its place", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("salience", { heartbeat: beat({ detail: "paused" }) })] });
  assert.ok(within(rowOf("salience")).getByText("Paused", { selector: ".tag" }) !== null);
  push(app, { type: "services", services: [svc("salience", { heartbeat: beat({ detail: "degraded: scorer down" }) })] });
  assert.ok(within(rowOf("salience")).queryByText("Paused") === null);
  assert.ok(within(rowOf("salience")).getByText(/degraded: scorer down/) !== null);
  push(app, { type: "services", services: [svc("salience", { heartbeat: beat() })] });
  assert.ok(within(rowOf("salience")).queryByText(/paused/i) === null);
});

// @spec DASH-UI-007
test("services that are down, crash-looping or stale sort before the rest, keeping the snapshot order within each group, with a count", async () => {
  await mountServices({ services: [svc("chat"), svc("voice", { state: "down" }), svc("cortex"), svc("eyes", { state: "stale" }), svc("ears", { state: "crash-looping" }), svc("memory", { state: "degraded" })] });
  assert.deepEqual(names(), ["voice", "eyes", "ears", "chat", "cortex", "memory"]);
  assert.ok(screen.getByText("3 need attention") !== null);
});

// @spec DASH-UI-007
test("no count shows while nothing needs attention", async () => {
  await mountServices({ services: [svc("chat")] });
  assert.ok(screen.queryByText(/need attention|needs attention/) === null);
});

// @spec DASH-UI-025
test("a How to read these states link opens the docs in a new tab, above the list", async () => {
  await mountServices({ services: [svc("chat")] });
  const a = screen.getByRole("link", { name: "How to read these states" });
  assert.equal(a.getAttribute("href"), "/cohost/guide/operate/health#the-states");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("rel"), "noopener");
  assert.ok((a.compareDocumentPosition(table()) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, "the link comes before the table");
});

// @spec DASH-UI-007
test("last seen is the snapshot's age plus the time since it arrived, shown as never when none, and the rows are patched in place on the one-second tick", async () => {
  const { app } = await mountServices({ services: [svc("chat", { lastSeenAgeMs: 3000 }), svc("ears", { state: "unknown", heartbeat: undefined, lastSeenAgeMs: undefined })] });
  const chat = rowOf("chat"), head = within(chat).getByRole("rowheader");
  assert.ok(within(chat).getByText("3s ago") !== null);
  assert.ok(within(rowOf("ears")).getByText("never") !== null);
  app.clock.now += 5000;
  await waitFor(() => assert.ok(within(rowOf("chat")).queryByText("8s ago") !== null), { timeout: 3000 });
  assert.ok(rowOf("chat") === chat, "the row element is the same one");
  assert.ok(within(rowOf("chat")).getByRole("rowheader") === head, "its cells are the same elements");
});

// @spec DASH-UI-001, DASH-UI-007
test("while the socket is closed ages stop counting and the regions are busy and stale", async () => {
  const { app } = await mountServices({ services: [svc("chat", { lastSeenAgeMs: 3000 })], stack: stackMsg() });
  act(() => app.socket().serverClose());
  const region = screen.getByRole("region", { name: "Services" });
  assert.equal(region.getAttribute("aria-busy"), "true");
  assert.ok(region.classList.contains("stale"));
  assert.equal(screen.getByRole("region", { name: "Stack" }).getAttribute("aria-busy"), "true");
  app.clock.now += 20000;
  await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
  assert.ok(within(rowOf("chat")).queryByText("3s ago") !== null, "the age did not advance");
});

// @spec DASH-UI-030
test("a service id or detail holding markup renders as text, never as elements", async () => {
  await mountServices({ services: [svc("x<b>bold</b>", { heartbeat: beat({ detail: "<img src=x onerror=alert(1)>" }) })] });
  assert.ok(table().querySelector("b") === null && table().querySelector("img") === null, "no element was created");
  assert.ok(screen.getByText("x<b>bold</b>") !== null);
  assert.ok(screen.getByText(/<img src=x onerror=alert\(1\)>/) !== null);
});

// @spec DASH-UI-008, DASH-UI-017, MOD-PAUSE-001
test("service control is always offered: the lifecycle, pause and stack buttons show and no control-off note names CONTROL_ENABLED", async () => {
  await mountServices({ services: [svc("salience"), svc("chat")], stack: stackMsg() });
  assert.equal(screen.queryByRole("status", { name: /control is off/i }), null);
  assert.ok(!(document.body.textContent ?? "").includes("CONTROL_ENABLED"));
  for (const n of ["Restart salience", "Stop salience", "Pause salience", "Restart chat", "Stop chat", "Restart all", "Rebuild", "Stop stack"]) assert.ok(screen.getByRole("button", { name: n }), n);
});

// @spec DASH-UI-008, DASH-UI-021
test("Start, Restart, Stop and Test show on manifest unit rows only, named for their service; none on the dashboard row or an unlisted service", async () => {
  await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("chat"), svc("redis"), svc("dashboard"), svc("mystery"), svc("ears", { state: "down" }), svc("eyes", { state: "unknown", heartbeat: undefined, lastSeenAgeMs: undefined }), svc("voice", { state: "crash-looping", restarts: 4 })] });
  for (const unit of ["chat", "redis", "voice"]) {
    const r = rowOf(unit);
    for (const verb of ["Restart", "Stop"]) assert.ok(btn(r, `${verb} ${unit}`) !== null, `${verb} ${unit}`);
    assert.ok(btn(r, `Start ${unit}`) === null, `a running unit has no Start: ${unit}`);
  }
  for (const unit of ["ears", "eyes"]) {
    const r = rowOf(unit);
    assert.ok(btn(r, `Start ${unit}`) !== null, `Start ${unit}`);
    for (const verb of ["Restart", "Stop"]) assert.ok(btn(r, `${verb} ${unit}`) === null, `${verb} ${unit}`);
  }
  assert.ok(btn(rowOf("ears"), "Test ears") !== null);
  assert.ok(btn(rowOf("chat"), "Test chat") !== null);
  for (const other of ["dashboard", "mystery"]) assert.equal(within(rowOf(other)).queryAllByRole("button").length, 0, other);
});

// @spec MOD-PAUSE-001
test("a unit whose manifest pause is true shows the one control for its current state, Pause or Resume, and no other row shows either", async () => {
  await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: UNITS.map((u) => svc(u.id)) });
  for (const u of UNITS) {
    const r = rowOf(u.id);
    assert.equal(btn(r, `Pause ${u.id}`) !== null, u.pause, `${u.id} Pause`);
    assert.ok(btn(r, `Resume ${u.id}`) === null, `${u.id} shows no Resume while it is not paused`);
    if (!u.pause) assert.equal(within(r).queryAllByRole("button", { name: /^(Pause|Resume)/ }).length, 0, u.id);
  }
});

// @spec MOD-PAUSE-001
test("while a unit's heartbeat says paused its row shows Resume and no Pause, and Pause returns when it resumes", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("salience", { heartbeat: beat({ detail: "paused" }) })] });
  assert.ok(btn(rowOf("salience"), "Resume salience") !== null);
  assert.ok(btn(rowOf("salience"), "Pause salience") === null, "no Pause while paused");
  push(app, { type: "services", services: [svc("salience")] });
  assert.ok(btn(rowOf("salience"), "Pause salience") !== null);
  assert.ok(btn(rowOf("salience"), "Resume salience") === null, "no Resume once running");
});

// @spec MOD-PAUSE-002, DASH-UI-015
test("Pause and Resume post /control with the command and the unit as target, and report only after the answer", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("salience")] });
  app.fetch.on("POST /control", { status: 204 });
  const user = userEvent.setup();
  await user.click(btn(rowOf("salience"), "Pause salience")!);
  await waitFor(() => assert.ok(within(rowOf("salience")).queryByText("Pause sent") !== null));
  push(app, { type: "services", services: [svc("salience", { heartbeat: beat({ detail: "paused" }) })] });
  await user.click(btn(rowOf("salience"), "Resume salience")!);
  await waitFor(() => assert.ok(within(rowOf("salience")).queryByText("Resume sent") !== null));
  assert.deepEqual(app.fetch.callsTo("POST /control").map((c) => JSON.parse(c.body!)), [{ cmd: "pause", target: "salience" }, { cmd: "resume", target: "salience" }]);
});

// @spec MOD-PAUSE-002, DASH-UI-015
test("a failed pause shows the status and detail in an alert that stays until dismissed", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("salience")] });
  app.fetch.on("POST /control", { status: 500, json: { detail: "publish failed" } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("salience"), "Pause salience")!);
  const alert = await within(rowOf("salience")).findByRole("alert");
  assert.match(alert.textContent ?? "", /500 publish failed/);
  await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
  assert.ok(within(rowOf("salience")).queryByRole("alert") === null);
});

// @spec DASH-UI-008
test("Restart opens a dialog titled for the service with a backlog choice and an isolated switch, and posts the chosen options on confirm", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice")] });
  app.fetch.on("POST /services/voice/restart", { json: { ok: true, detail: "restarted" } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Restart voice")!);
  const dlg = screen.getByRole("dialog", { name: "Restart voice?" });
  const group = within(dlg).getByRole("group", { name: "Backlog" });
  assert.equal((within(group).getByRole("radio", { name: "Service default" }) as HTMLInputElement).checked, true);
  assert.ok(within(group).getByRole("radio", { name: "Resume keeping backlog" }) !== null);
  await user.click(within(group).getByRole("radio", { name: "Fresh skipping backlog" }));
  const sw = within(dlg).getByRole("switch", { name: "Isolated: only this service, with mock or off backends" });
  assert.equal((sw as HTMLInputElement).checked, false);
  await user.click(sw);
  await user.click(within(dlg).getByRole("button", { name: "Restart voice" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null, "the dialog closes after a 2xx"));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /services/voice/restart")[0]!.body!), { mode: "fresh", isolated: true });
  assert.ok((await within(rowOf("voice")).findByText(/Restarted voice/)) !== null);
});

// @spec DASH-UI-008
test("Start opens its own dialog, and with the defaults it sends an empty body", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice", { state: "down" })] });
  app.fetch.on("POST /services/voice/start", { json: { ok: true } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Start voice")!);
  const dlg = screen.getByRole("dialog", { name: "Start voice?" });
  await user.click(within(dlg).getByRole("button", { name: "Start voice" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /services/voice/start").length, 1));
  const body = app.fetch.callsTo("POST /services/voice/start")[0]!.body;
  assert.deepEqual(body === undefined ? {} : JSON.parse(body), {});
});

// @spec DASH-UI-008
test("Stop opens a plain yes or no dialog and sends nothing when cancelled", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice")] });
  app.fetch.on("POST /services/voice/stop", { json: { ok: true } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Stop voice")!);
  const dlg = screen.getByRole("dialog", { name: "Stop voice?" });
  assert.ok(within(dlg).queryByRole("switch") === null && within(dlg).queryByRole("group", { name: "Backlog" }) === null, "no options");
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.equal(app.fetch.callsTo("POST /services/voice/stop").length, 0);
  await user.click(btn(rowOf("voice"), "Stop voice")!);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop voice" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /services/voice/stop").length, 1));
});

// @spec DASH-UI-008, DASH-UI-015
test("while a lifecycle request is in flight the row shows its progress and disables its buttons; others stay usable", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice"), svc("chat")] });
  let release!: () => void;
  app.fetch.on("POST /services/voice/restart", () => new Promise((res) => { release = () => res({ json: { ok: true } }); }));
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Restart voice")!);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart voice" }));
  await waitFor(() => assert.ok(within(rowOf("voice")).queryByText("Restarting…") !== null));
  for (const verb of ["Restart", "Stop"]) assert.equal((btn(rowOf("voice"), `${verb} voice`) as HTMLButtonElement).disabled, true, verb);
  assert.equal((btn(rowOf("chat"), "Restart chat") as HTMLButtonElement).disabled, false);
  await act(async () => { release(); });
  await waitFor(() => assert.equal((btn(rowOf("voice"), "Restart voice") as HTMLButtonElement).disabled, false));
});

// @spec DASH-UI-008
test("the confirm button is disabled with the reason while a stack action runs or Docker is unavailable, and the open dialog follows the stack", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice")], stack: stackMsg() });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Restart voice")!);
  const confirm = () => within(screen.getByRole("dialog")).getByRole("button", { name: "Restart voice" }) as HTMLButtonElement;
  assert.equal(confirm().disabled, false);
  push(app, { type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: app.clock.now } }) });
  assert.equal(confirm().disabled, true);
  assert.match(screen.getByRole("dialog").textContent ?? "", /A stack action is running/);
  push(app, { type: "stack", ...stackMsg({ state: "docker-unavailable", docker: { ok: false, detail: "docker: command not found" } }) });
  assert.equal(confirm().disabled, true);
  assert.match(screen.getByRole("dialog").textContent ?? "", /Docker is unavailable/);
  push(app, { type: "stack", ...stackMsg() });
  assert.equal(confirm().disabled, false);
});

// @spec DASH-UI-008, DASH-UI-015
test("a refused request shows its status and detail inside the dialog, which stays open; after Cancel the row keeps the alert", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice")] });
  app.fetch.on("POST /services/voice/restart", { status: 409, json: { ok: false, detail: "busy: launch held by dashboard (pid 1)" } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Restart voice")!);
  const dlg = screen.getByRole("dialog");
  await user.click(within(dlg).getByRole("button", { name: "Restart voice" }));
  const alert = await within(screen.getByRole("dialog")).findByRole("alert");
  assert.match(alert.textContent ?? "", /409 busy: launch held by dashboard/);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  assert.ok(screen.queryByRole("dialog") === null);
  assert.match(within(rowOf("voice")).getByRole("alert").textContent ?? "", /409 busy/);
});

// @spec DASH-UI-008
test("a 200 whose body says ok false is a failure, not a success", async () => {
  const { app } = await mountServices({ control: { runtime: "compose", advanced: false, unlocked: false }, services: [svc("voice")] });
  app.fetch.on("POST /services/voice/restart", { json: { ok: false, detail: "controller refused" } });
  const user = userEvent.setup();
  await user.click(btn(rowOf("voice"), "Restart voice")!);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart voice" }));
  assert.match((await within(screen.getByRole("dialog")).findByRole("alert")).textContent ?? "", /controller refused/);
});

// @spec DASH-UI-035
test("a unit whose container runs with isolation overrides is marked as running isolated", async () => {
  await mountServices({
    services: [svc("voice"), svc("chat")],
    stack: stackMsg({ services: [{ service: "voice", status: "running", overrides: { VOICE_ENGINE: "stub" } }, { service: "chat", status: "running", overrides: {} }] }),
  });
  const tag = within(rowOf("voice")).getByText("Runs isolated");
  assert.match(tag.getAttribute("title") ?? "", /VOICE_ENGINE=stub/);
  assert.ok(within(rowOf("chat")).queryByText("Runs isolated") === null);
});

// @spec DASH-UI-031
test("when the manifest cannot be read the list is replaced by an error with Retry, and Retry loads it", async () => {
  const app = makeApp();
  await mountServices({ app, control: { runtime: "compose", advanced: false, unlocked: false }, manifest: "fail", services: [svc("chat")] });
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /manifest unreadable|Could not load/);
  assert.ok(screen.queryByRole("table") === null, "no list without buttons");
  app.fetch.on("GET /services/manifest", { json: { units: UNITS } });
  await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
  await screen.findByRole("table", { name: "Services" });
  assert.ok(btn(rowOf("chat"), "Restart chat") !== null);
});

// @spec DASH-UI-031
test("when the control read fails the screen shows the same error and Retry", async () => {
  await mountServices({ control: "fail", services: [svc("chat")] });
  const alert = await screen.findByRole("alert");
  assert.ok(within(alert).getByRole("button", { name: "Retry" }) !== null);
  assert.ok(screen.queryByRole("table") === null);
  assert.ok(screen.getByRole("region", { name: "Stack" }) !== null, "the stack card stays");
});

// @spec DASH-UI-021
test("the Services screen's source names no manifest unit as a literal (the dashboard's own row and the bus payload samples aside): the list of units comes from GET /services/manifest", () => {
  const dir = new URL("../../ui/src/screens/services/", import.meta.url);
  const source = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== "samples.ts").map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  const named = SERVICE_MANIFEST.map((d) => d.id).filter((id) => id !== "dashboard").filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(source));
  assert.deepEqual(named, [], "no unit id appears as a string literal");
});
