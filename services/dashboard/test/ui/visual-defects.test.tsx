// Behaviour the first real-browser review found wrong (the defect ids D05 to D20 of the review): each test states the
// intended behaviour; the layout results themselves are checked by re-rendering in a browser.
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, render, renderApp, makeApp, screen, within } from "./helpers/render";
import { App } from "../../ui/src/app/App";
import { Meter } from "../../ui/src/components/Meter";
import { Status } from "../../ui/src/components/Status";
import { FilePicker } from "../../ui/src/components/FilePicker";
import { TokenPanel } from "../../ui/src/app/access/TokenPanel";
import { controlFor } from "../../ui/src/screens/settings/schemaModel";
import { mountServices, stackMsg } from "./services-fixtures";

function boot() {
  location.hash = "";
  const app = makeApp();
  app.fetch.on("GET /services/control", { json: { enabled: false } });
  document.head.innerHTML = `<meta name="cohost-name" content="Coco">`;
  const r = renderApp(<App sink={false} />, app);
  act(() => { app.socket().open(); });
  return { ...r, app };
}

// @spec DASH-UI-001
test("while the socket is closed the header status cluster is marked stale, aria-busy and explained, and it recovers on reconnect", () => {
  const { app } = boot();
  act(() => app.socket().message({ type: "event", id: "1-0", ts: 1, source: "cortex", event: { id: "1-0", type: "brain.status", ts: 1, source: "cortex", data: { state: "speaking" } } }));
  const cluster = () => screen.getByRole("group", { name: "Status" });
  assert.ok(!/\bstale\b/.test(cluster().className), "live while connected");
  act(() => { app.socket().serverClose(); });
  assert.match(cluster().className, /\bstale\b/);
  assert.equal(cluster().getAttribute("aria-busy"), "true");
  assert.match(cluster().textContent ?? "", /last known|live updates stopped/i, "a screen reader is told the status is old");
  act(() => { app.clock.tick(2000); });
  act(() => { app.socket().open(); });
  assert.ok(!/\bstale\b/.test(cluster().className), "live again");
});

// @spec DASH-NAV-002
test("the header's Audio, Mute and Access buttons keep their text in a .btn-text span, which the narrow stylesheet turns into an icon-only button", () => {
  boot();
  const controls = document.querySelector(".header-group.controls")!;
  for (const b of [...controls.querySelectorAll(":scope > button")].slice(0, 3)) assert.ok(b.querySelector(".btn-text"), `${b.textContent} has a .btn-text label`);
});

// @spec DASH-VIEWERS-011
test("the Meter's native meter has low and high set at the strength thresholds, so the browser's own good, fair and poor states match Strong, Fading and Weak", () => {
  render(<><Meter label="a" percent={95} /><Meter label="b" percent={50} /><Meter label="c" percent={10} /></>);
  for (const m of screen.getAllByRole("meter")) {
    assert.equal(m.getAttribute("low"), "30");
    assert.equal(m.getAttribute("high"), "69");
    assert.equal(m.getAttribute("optimum"), "100");
  }
});

// @spec DASH-THEME-004
test("a status carries its full label as a title, so a pill the header truncates on a phone can still be read", () => {
  render(<Status status="warn" label="Stack: Degraded" />);
  assert.equal(screen.getByText("Stack: Degraded").getAttribute("title"), "Stack: Degraded");
});

// @spec DASH-UI-034
test("the file picker is a real file input named by its label, plus a button face, and shows the chosen file's name and size", () => {
  const seen: (File | null)[] = [];
  render(<FilePicker id="f" accept="image/png" onChange={(f) => seen.push(f)} />);
  const input = document.getElementById("f") as HTMLInputElement;
  assert.equal(input.type, "file");
  assert.equal(input.getAttribute("accept"), "image/png");
  assert.ok(screen.getByText("No file chosen"));
  const file = new File([new Uint8Array(2048)], "cat.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  assert.ok(screen.getByText("cat.png · 2.0 KiB"));
  assert.deepEqual(seen, [file]);
  assert.ok(screen.getByText("Choose file"), "a button-looking face is shown");
});

// @spec DASH-ACC-008
test("a viewers token the server answered 403 for shows as Not set up on the server, even when a token is stored", () => {
  const app = makeApp();
  app.rt.access.setToken("viewers", "old", "tab");
  app.rt.access.markNotSetUp("viewers", true);
  renderApp(<TokenPanel />, app);
  const viewers = screen.getByRole("group", { name: /Viewers/ });
  assert.match(viewers.textContent ?? "", /Not set up on the server/);
  assert.ok(!/Unlocked/.test(viewers.textContent ?? ""), "no Unlocked beside a screen that says not set up");
});

// @spec DASH-UI-020
test("the running-action note's phase line starts with the phase, not a stray separator", async () => {
  const { app } = await mountServices({ control: { enabled: true, runtime: "compose", advanced: false }, stack: stackMsg({ state: "starting" }) });
  act(() => app.socket().message({ type: "stack", ...stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: app.clock.now - 1000 } }) }));
  const group = screen.getByRole("group", { name: "Running action" });
  const phase = [...group.querySelectorAll("span")].find((s) => /building images/.test(s.textContent ?? ""))!;
  assert.match(phase.textContent ?? "", /^building images/, "no leading separator");
});

// @spec DASH-SET-013
test("an enum with no default (an optional setting, such as a module's provider override) offers a Not set choice so it can be cleared", () => {
  const withDefault = controlFor({ type: "string", enum: ["a", "b"], default: "a" }, undefined);
  const without = controlFor({ type: "string", enum: ["a", "b"] }, undefined);
  assert.deepEqual(withDefault.kind === "segmented" ? withDefault.options.map((o) => o.value) : null, ["a", "b"]);
  assert.deepEqual(without.kind === "segmented" ? without.options.map((o) => [o.value, o.label]) : null, [["", "Not set"], ["a", "a"], ["b", "b"]]);
});
