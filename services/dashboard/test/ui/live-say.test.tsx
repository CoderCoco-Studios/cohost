import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, userEvent, act, within, waitFor, fireEvent, type TestApp } from "./helpers/render";
import { App } from "../../ui/src/app/App";
import { Screen } from "../../ui/src/screens/live";

function boot(opts: { reply?: Parameters<TestApp["fetch"]["on"]>[1]; open?: boolean } = {}) {
  location.hash = "";
  const app = makeApp();
  app.fetch.on("POST /control", opts.reply ?? { status: 204 });
  renderApp(<Screen route={{ view: "live" }} />, app);
  if (opts.open !== false) act(() => { app.socket().open(); });
  return app;
}
const controls = (app: TestApp) => app.fetch.callsTo("POST /control").map((c) => JSON.parse(c.body!) as Record<string, unknown>);
const box = () => screen.getByRole("textbox", { name: "Say a line" }) as HTMLInputElement;
const sayBtn = () => screen.getByRole("button", { name: "Say" });
const region = () => screen.getByRole("region", { name: "Say" });

// @spec DASH-UI-005, DASH-UI-023
test("Say sends the trimmed text to POST /control and clears the field only after a 2xx, saying Sent beside it", async () => {
  const user = userEvent.setup();
  let release!: () => void;
  const app = boot({ reply: () => new Promise((r) => { release = () => r({ status: 204 }); }) });
  await user.type(box(), "  hello world  ");
  await user.click(sayBtn());
  assert.deepEqual(controls(app), [{ cmd: "say", text: "hello world" }]);
  assert.equal(sayBtn().getAttribute("aria-busy"), "true", "pending until the answer");
  assert.equal(box().value, "  hello world  ", "the text stays until the request succeeds");
  assert.equal(within(region()).getByRole("status").textContent, "", "no success before the answer");
  await act(async () => { release(); });
  await waitFor(() => assert.equal(box().value, ""));
  assert.equal(within(region()).getByRole("status").textContent, "Sent");
});

// @spec DASH-UI-005
test("Enter in the field sends, and a blank line sends nothing", async () => {
  const user = userEvent.setup();
  const app = boot();
  await user.type(box(), "   {Enter}");
  assert.equal(controls(app).length, 0);
  await user.type(box(), "go{Enter}");
  assert.deepEqual(controls(app), [{ cmd: "say", text: "go" }]);
});

// @spec DASH-UI-023
test("the optional outputs field sends the trimmed non-empty ids as route, and no route when blank", async () => {
  const user = userEvent.setup();
  const app = boot();
  const details = region().querySelector("details")!;
  assert.equal(details.open, false, "a disclosure, closed by default");
  assert.ok(within(details).getByText("Send to specific outputs").tagName === "SUMMARY");
  await user.click(within(details).getByText("Send to specific outputs"));
  const outputs = within(details).getByRole("textbox", { name: "Output ids" });
  await user.type(box(), "to the archive");
  await user.type(outputs, " file, http ,, ");
  await user.click(sayBtn());
  await waitFor(() => assert.equal(box().value, ""));
  await user.type(box(), "everywhere");
  await user.clear(outputs);
  await user.type(outputs, "  ");
  await user.click(sayBtn());
  await waitFor(() => assert.equal(controls(app).length, 2));
  assert.deepEqual(controls(app), [{ cmd: "say", text: "to the archive", route: ["file", "http"] }, { cmd: "say", text: "everywhere" }]);
});

// @spec DASH-UI-015
test("a refused say shows the status and the server's detail in an alert, keeps the text, and stays until dismissed", async () => {
  const user = userEvent.setup();
  const app = boot({ reply: { status: 503, text: "bus unavailable" } });
  await user.type(box(), "hello");
  await user.click(sayBtn());
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent!, /503 bus unavailable/);
  assert.equal(box().value, "hello");
  assert.equal(within(region()).getByRole("status").textContent, "");
  await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
  assert.ok(screen.queryByRole("alert") === null);
  assert.equal(controls(app).length, 1);
});

// @spec DASH-UI-015
test("a network failure is an alert with the error", async () => {
  const user = userEvent.setup();
  const app = boot();
  app.fetch.fail("POST /control");
  await user.type(box(), "hello");
  await user.click(sayBtn());
  assert.match((await screen.findByRole("alert")).textContent!, /network error/);
});

// @spec DASH-UI-005, DASH-A11Y-003
test("the field and the outputs field are labelled, the outputs field says what blank means", async () => {
  boot();
  await userEvent.setup().click(screen.getByText("Send to specific outputs"));
  const outputs = screen.getByRole("textbox", { name: "Output ids" });
  assert.match(document.getElementById(outputs.getAttribute("aria-describedby")!)!.textContent!, /Blank sends to every enabled output/);
});

// @spec DASH-NAV-003
test("the Say field is the target of the / shortcut", async () => {
  location.hash = "";
  const app = makeApp();
  renderApp(<App />, app);
  act(() => { app.socket().open(); });
  assert.equal(box().getAttribute("data-shortcut"), "say");
  await userEvent.setup().keyboard("/");
  assert.ok(document.activeElement === box(), "/ focuses the Say field");
});

// @spec DASH-UI-005
test("while muted the card says the co-host will not speak, and it clears on unmute", () => {
  const app = boot();
  assert.ok(!/muted/i.test(region().textContent!));
  act(() => { app.socket().message({ id: "m1", type: "control", ts: 1, source: "dashboard", data: { cmd: "mute" } }); });
  assert.match(region().textContent!, /The co-host is muted/);
  act(() => { app.socket().message({ id: "m2", type: "control", ts: 2, source: "dashboard", data: { cmd: "unmute" } }); });
  assert.ok(!/muted/i.test(region().textContent!));
});

// @spec DASH-UI-005
test("with audio off in this tab the card says the line will not be heard here, and turning audio on clears it", () => {
  const app = boot();
  assert.match(region().textContent!, /Audio is off in this tab/);
  act(() => { app.rt.audio.enable(); });
  assert.ok(!/Audio is off/.test(region().textContent!));
});

// @spec DASH-UI-018
test("with the bus unreachable the card says say cannot be sent", () => {
  const app = boot();
  act(() => { app.socket().message({ type: "stack", state: "up", docker: { ok: true }, bus: "unreachable", action: null, last: null, services: [] }); });
  assert.match(region().textContent!, /The bus is unreachable/);
});

// ---- Wipe context

const wipe = () => screen.getByRole("button", { name: "Wipe context" });
const wipeRegion = () => screen.getByRole("region", { name: "Wipe context" });

// @spec DASH-UI-028
test("the Wipe context card has a danger button and the sentence about what is forgotten and kept", () => {
  boot();
  assert.ok(wipe().className.split(" ").includes("btn-danger"));
  assert.match(wipeRegion().textContent!, /The co-host forgets the current conversation\. Viewer notes are kept\./);
});

// @spec DASH-UI-028
test("Wipe context opens a confirmation dialog saying what is lost, and sends forget_context only when confirmed", async () => {
  const user = userEvent.setup();
  const app = boot();
  await user.click(wipe());
  const dlg = screen.getByRole("dialog", { name: "Wipe context?" });
  assert.match(dlg.textContent!, /forgets the current conversation/);
  assert.match(dlg.textContent!, /viewer notes are kept/i);
  assert.equal(controls(app).length, 0, "nothing is sent by opening it");
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.ok(screen.queryByRole("dialog") === null);
  assert.equal(controls(app).length, 0, "cancel sends nothing");
  assert.ok(document.activeElement === wipe(), "focus returns to the button");
  await user.click(wipe());
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Wipe context" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  assert.deepEqual(controls(app), [{ cmd: "forget_context" }]);
  assert.equal(within(wipeRegion()).getByRole("status").textContent, "Context wiped");
});

// @spec DASH-UI-028, DASH-UI-015
test("a refused wipe keeps the dialog open with the status and detail inside it, and reports no success", async () => {
  const user = userEvent.setup();
  const app = boot({ reply: { status: 500, json: { detail: "boom" } } });
  await user.click(wipe());
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Wipe context" }));
  const dlg = await screen.findByRole("dialog", { name: "Wipe context?" });
  await waitFor(() => assert.match(dlg.textContent!, /500 boom/));
  assert.equal(within(wipeRegion()).getByRole("status").textContent, "");
  assert.equal(controls(app).length, 1);
});

// @spec DASH-UI-028
test("Esc closes the wipe dialog as a cancel without sending", async () => {
  const user = userEvent.setup();
  const app = boot();
  await user.click(wipe());
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true })); // what Esc sends in a browser
  assert.ok(screen.queryByRole("dialog") === null);
  assert.equal(controls(app).length, 0);
});
