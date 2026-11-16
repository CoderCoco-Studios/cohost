import { test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, renderApp, screen, userEvent, within, makeApp } from "./helpers/render";
import { App } from "../../ui/src/app/App";
import { SCREENS } from "../../ui/src/app/screens";

const ids = () => SCREENS.map((s) => s.id);

function boot(hash = "", opts: { sink?: boolean; control?: boolean } = {}) {
  location.hash = hash;
  const app = makeApp({ sink: opts.sink });
  app.fetch.on("GET /services/control", { json: opts.control ? { enabled: true, runtime: "compose", advanced: false } : { enabled: false } });
  app.fetch.on("POST /control", { status: 204 });
  document.head.innerHTML = `<meta name="cohost-name" content="Coco">`;
  const r = renderApp(<App sink={!!opts.sink} />, app);
  act(() => { app.socket().open(); });
  return { ...r, app };
}
const frame = (app: ReturnType<typeof makeApp>, payload: unknown) => act(() => { app.socket().message(payload); });

test("the registry holds the four screens in nav order, each a module the screen agents fill in", () => {
  assert.deepEqual(ids(), ["live", "services", "viewers", "settings"]);
  assert.deepEqual(SCREENS.map((s) => s.shortcut), ["1", "2", "3", "4"]);
  for (const s of SCREENS) assert.equal(typeof s.Screen, "function");
});

// @spec DASH-A11Y-001
test("the first focusable element is a skip link to the main content, which moves focus there", async () => {
  const user = userEvent.setup();
  boot();
  const focusables = [...document.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])")];
  assert.equal(focusables[0]!.textContent, "Skip to main content");
  await user.click(focusables[0]!);
  assert.ok(document.activeElement === document.getElementById("main"), "focus is on the expected element");
  assert.equal(location.hash, "", "the skip link does not change the view");
});

// @spec DASH-NAV-002
test("the header holds, in order and each as a header-group: the brand, the nav, the status cluster and the controls", () => {
  boot();
  const header = document.querySelector("header")!;
  const groups = [...header.querySelectorAll(":scope > .header-group")];
  assert.equal(groups.length, 4);
  assert.equal(groups[0]!.classList.contains("brand"), true);
  assert.equal(groups[1]!.tagName, "NAV");
  assert.equal(groups[2]!.classList.contains("cluster"), true);
  assert.equal(groups[3]!.classList.contains("controls"), true);
  assert.equal(within(groups[0] as HTMLElement).getByText("Coco").tagName, "SPAN");
  assert.ok(within(groups[0] as HTMLElement).getByText("cohost"));
  const names = within(groups[3] as HTMLElement).getAllByRole("button").map((b) => b.textContent);
  assert.deepEqual(names.slice(0, 3), ["Audio off", "Mute co-host", "Locked"]);
});

// @spec DASH-NAV-002, DASH-UI-024
test("the nav lists Live, Services, Viewers, Settings and then a Docs link that opens /cohost/ in a new tab", () => {
  boot();
  const nav = screen.getByRole("navigation", { name: "Main" });
  const items = [...nav.querySelectorAll("a")];
  assert.deepEqual(items.map((a) => a.textContent), ["Live", "Services", "Viewers", "Settings", "Docs"]);
  const docs = items[4]!;
  assert.equal(docs.getAttribute("href"), "/cohost/");
  assert.equal(docs.getAttribute("target"), "_blank");
  assert.equal(docs.getAttribute("rel"), "noopener");
  assert.ok(docs.querySelector("svg"), "an external-link icon");
  assert.equal(docs.hasAttribute("aria-current"), false);
  for (const a of items.slice(0, 4)) assert.match(a.getAttribute("href")!, /^#/);
});

// @spec DASH-UI-024
test("in sink mode the Docs link, the nav and every control are absent: only the sink view renders", () => {
  boot("", { sink: true });
  assert.ok(screen.queryByRole("link", { name: "Docs" }) === null, "expected nothing to be found");
  assert.ok(screen.queryByRole("navigation") === null, "expected nothing to be found");
  assert.ok(document.querySelector("header") === null, "expected nothing to be found");
});

// @spec DASH-NAV-001
test("the hash picks the view, the nav marks it aria-current=page and nothing else, and back and forward follow the hash", async () => {
  boot("#viewers");
  const current = () => [...document.querySelectorAll("nav [aria-current]")].map((a) => a.textContent);
  assert.deepEqual(current(), ["Viewers"]);
  assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Viewers");
  act(() => { location.hash = "#services"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  assert.deepEqual(current(), ["Services"]);
  assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Services");
  act(() => { location.hash = "#bogus"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  assert.deepEqual(current(), ["Live"]);
});

// @spec DASH-NAV-001
test("clicking a nav item changes the hash and the screen; the settings section is handed to the screen", async () => {
  const user = userEvent.setup();
  boot("#settings/brain.salience");
  assert.match(document.querySelector("main")!.textContent!, /brain\.salience/);
  await user.click(screen.getByRole("link", { name: "Services" }));
  assert.equal(location.hash, "#services");
  assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Services");
});

// @spec DASH-A11Y-005
test("after a navigation focus moves to the new screen's heading; on first load it is left alone", async () => {
  const user = userEvent.setup();
  boot("#live");
  assert.notEqual(document.activeElement, screen.getByRole("heading", { level: 1 }));
  await user.click(screen.getByRole("link", { name: "Viewers" }));
  assert.ok(document.activeElement === screen.getByRole("heading", { level: 1, name: "Viewers" }), "focus is on the expected element");
});

// @spec DASH-NAV-003
test("1 to 4 open the four views, / opens Live and focuses the Say field, ? opens the shortcut list, Esc closes it", async () => {
  const user = userEvent.setup();
  boot("#settings");
  await user.keyboard("1");
  assert.equal(location.hash, "#live");
  await user.keyboard("2"); assert.equal(location.hash, "#services");
  await user.keyboard("3"); assert.equal(location.hash, "#viewers");
  await user.keyboard("4"); assert.equal(location.hash, "#settings");
  await user.keyboard("?");
  const dlg = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  for (const k of ["/", "1\u20134", "m", "Esc", "?"]) assert.ok(within(dlg).getByText(k, { selector: "kbd" }), k);
  // Esc closes it; the emulated DOM has no native Escape, so the shell's handler dispatches the cancel a browser would.
  await user.keyboard("{Escape}");
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
});

// @spec DASH-NAV-003
test("/ opens Live and focuses the element marked data-shortcut=say once Live has rendered it", async () => {
  const user = userEvent.setup();
  boot("#services");
  const input = document.createElement("input"); input.setAttribute("data-shortcut", "say"); input.setAttribute("aria-label", "Say");
  // The Live screen's Say field carries the marker; stand it in for the placeholder screen.
  document.querySelector("main")!.append(input);
  await user.keyboard("/");
  assert.equal(location.hash, "#live");
  assert.ok(document.activeElement === input, "focus is on the expected element");
});

// @spec DASH-NAV-003
test("a shortcut does nothing while typing, with Ctrl, Alt or Meta held, or while a modal dialog is open (except Esc)", async () => {
  const user = userEvent.setup();
  const { app } = boot("#live");
  const box = document.createElement("textarea"); document.body.append(box);
  box.focus();
  await user.keyboard("2");
  assert.equal(location.hash, "#live", "typing in a textarea");
  box.blur();
  document.body.focus();
  for (const mod of ["Control", "Alt", "Meta"]) { await user.keyboard(`{${mod}>}2{/${mod}}`); assert.equal(location.hash, "#live", mod); }
  await user.keyboard("?");
  assert.ok(screen.getByRole("dialog"));
  await user.keyboard("2");
  assert.equal(location.hash, "#live", "a modal dialog is open");
  await user.keyboard("m");
  assert.equal(app.fetch.callsTo("POST /control").length, 0);
  await user.keyboard("{Escape}");
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
  box.remove();
});

// @spec DASH-NAV-003, DASH-UI-005
test("m toggles mute: it sends mute, the button shows pending until the control event arrives, then reads Unmute co-host", async () => {
  const user = userEvent.setup();
  const { app } = boot("#live");
  assert.ok(screen.getByRole("button", { name: "Mute co-host" }));
  await user.keyboard("m");
  const sent = app.fetch.callsTo("POST /control");
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!.body!), { cmd: "mute" });
  assert.equal(screen.getByRole("button", { name: "Mute co-host" }).getAttribute("aria-busy"), "true");
  frame(app, { id: "9-0", type: "control", ts: 1, source: "dashboard", data: { cmd: "mute" } });
  const btn = screen.getByRole("button", { name: "Unmute co-host" });
  assert.equal(btn.getAttribute("aria-busy"), null);
  assert.equal(btn.getAttribute("aria-pressed"), "true");
});

// @spec DASH-UI-005
test("the mute button follows a mute event in the connect replay, and a failed request ends the pending state with the failure shown", async () => {
  const user = userEvent.setup();
  const { app } = boot("#live");
  frame(app, { id: "1-0", type: "control", ts: 1, source: "dashboard", data: { cmd: "mute" }, replay: true });
  assert.ok(screen.getByRole("button", { name: "Unmute co-host" }));
  app.fetch.on("POST /control", { status: 500, text: "boom" });
  await user.click(screen.getByRole("button", { name: "Unmute co-host" }));
  assert.equal(screen.getByRole("button", { name: "Unmute co-host" }).getAttribute("aria-busy"), null);
  assert.match(screen.getByRole("alert").textContent!, /500 boom/);
});

// @spec DASH-ACC-001
test("the Access button reads Locked without a control token and Unlocked with one, and opens the Access panel", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  const btn = () => screen.getByRole("button", { name: /^(Locked|Unlocked)$/ });
  assert.equal(btn().textContent, "Locked");
  act(() => app.rt.access.setToken("control", "t", "tab"));
  assert.equal(btn().textContent, "Unlocked");
  await user.click(btn());
  assert.equal(app.rt.access.state.get().panelOpen, true);
  assert.ok(screen.getByRole("dialog", { name: "Access" }));
});

// @spec DASH-UI-006
test("a request that needs a token opens the Access dialog naming the waiting action", async () => {
  const { app } = boot();
  let done = false;
  app.fetch.on("POST /control", { status: 401, text: "unauthorized" });
  void app.rt.api.control({ cmd: "say", text: "hi" }, "Say a line").then(() => { done = true; });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.ok(screen.getByRole("dialog", { name: "Access" }));
  assert.match(document.querySelector("dialog")!.textContent!, /Say a line/);
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(done, true);
});

// @spec DASH-THEME-002
test("the theme control offers Auto, Light and Dark as a radio group and applies the choice to <html>", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  const group = screen.getByRole("group", { name: "Theme" });
  assert.deepEqual(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).labels![0]!.textContent), ["Auto", "Light", "Dark"]);
  assert.equal((within(group).getByRole("radio", { name: "Auto" }) as HTMLInputElement).checked, true);
  await user.click(within(group).getByRole("radio", { name: "Dark" }));
  assert.equal(app.rt.theme.state.get().preference, "dark");
  assert.equal(app.local.getItem("cohost.theme"), "dark");
});

// @spec DASH-UI-003, DASH-UI-018
test("the status cluster shows what the co-host is doing from brain.status and the stack state, each a status with a word", () => {
  const { app } = boot();
  const cluster = () => document.querySelector(".header-group.cluster")!;
  assert.match(cluster().textContent!, /Waiting for the co-host/);
  frame(app, { id: "1-0", type: "brain.status", ts: 1, source: "cortex", data: { state: "speaking" } });
  assert.match(cluster().textContent!, /Speaking/);
  frame(app, { type: "stack", state: "degraded", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] });
  assert.match(cluster().textContent!, /Stack: Degraded/);
  assert.ok(cluster().querySelector(".st-warn"));
});

// @spec DASH-UI-007
test("the Services nav item carries a count of services that are down, crash-looping or stale, with an accessible label", () => {
  const { app } = boot();
  assert.ok(document.querySelector("nav .count") === null, "expected nothing to be found");
  frame(app, { type: "services", services: [
    { service: "voice", state: "down", restarts: 0 }, { service: "ears", state: "stale", restarts: 0 },
    { service: "mouth", state: "crash-looping", restarts: 3 }, { service: "chat", state: "up", restarts: 0 }, { service: "eyes", state: "unknown", restarts: 0 },
  ] });
  const count = document.querySelector("nav .count")!;
  assert.equal(count.textContent, "3");
  assert.equal(count.getAttribute("aria-label"), "3 need attention");
});

// @spec DASH-UI-001
test("when the socket closes a banner says live updates stopped, when, and when the next attempt is; it clears on reconnect", () => {
  const { app } = boot();
  assert.ok(screen.queryByText(/Live updates stopped/) === null, "expected nothing to be found");
  act(() => { app.clock.tick(1000); app.socket().serverClose(); });
  const banner = screen.getByRole("status", { name: "Connection" });
  assert.match(banner.textContent!, /Live updates stopped at \d\d?:\d\d:\d\d/);
  assert.match(banner.textContent!, /trying again at \d\d?:\d\d:\d\d/);
  act(() => { app.clock.tick(2000); });
  act(() => { app.socket().open(); });
  assert.ok(screen.queryByText(/Live updates stopped/) === null, "expected nothing to be found");
});

// @spec DASH-UI-001
test("useStale marks a region aria-busy with the class stale while the socket is closed, and not otherwise", async () => {
  const { useStale } = await import("../../ui/src/app/connection");
  const { app } = boot();
  function Region() { const stale = useStale(); return <section aria-label="Feed" {...stale}>x</section>; }
  const r = renderApp(<Region />, app);
  const region = () => r.getByRole("region", { name: "Feed" });
  assert.equal(region().getAttribute("aria-busy"), null);
  act(() => { app.socket().serverClose(); });
  assert.equal(region().getAttribute("aria-busy"), "true");
  assert.match(region().className, /\bstale\b/);
});

// @spec DASH-UI-011
test("the sink view shows the brand, the audio state and a one-line status, with audio on and no request but the socket", async () => {
  const { app } = boot("", { sink: true });
  assert.ok(screen.getByText("Coco"));
  assert.match(document.body.textContent!, /Audio on/);
  assert.match(document.body.textContent!, /Connected/);
  assert.deepEqual(app.fetch.calls, [], "the sink page issues no HTTP request of its own");
  act(() => { app.socket().serverClose(); });
  assert.match(document.body.textContent!, /Reconnecting/);
});

// @spec DASH-UI-012, DASH-UI-011
test("on the sink page an utterance is fetched from /audio/<id>.wav and reported through POST /sink only", async () => {
  const { FakeAudio } = await import("./helpers/fakes");
  FakeAudio.reset();
  const app = makeApp({ sink: true, createAudio: (src) => new FakeAudio(src) as unknown as HTMLAudioElement });
  app.fetch.on("POST /sink", { status: 204 });
  location.hash = "";
  renderApp(<App sink />, app);
  act(() => { app.socket().open(); });
  frame(app, { id: "3-0", type: "voice.utterance", ts: 1, source: "voice", data: { id: "u9" } });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(FakeAudio.instances[0]!.src, "/audio/u9.wav");
  assert.deepEqual(app.fetch.calls.map((c) => `${c.method} ${c.path}`), ["POST /sink"]);
});

// @spec DASH-UI-012
test("the header's Audio button toggles audio and its label says which", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  const btn = () => screen.getByRole("button", { name: /^Audio (on|off)$/ });
  assert.equal(btn().textContent, "Audio off");
  assert.equal(btn().getAttribute("aria-pressed"), "false");
  await user.click(btn());
  assert.equal(app.rt.audio.state.get().enabled, true);
  assert.equal(btn().textContent, "Audio on");
  assert.equal(btn().getAttribute("aria-pressed"), "true");
});
void fireEvent;
