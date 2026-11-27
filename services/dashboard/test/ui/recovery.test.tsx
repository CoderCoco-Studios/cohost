import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, renderApp, screen, userEvent, waitFor, within } from "./helpers/render";
import { RecoveryScreen, recoveryState, type RecoveryProblem, type RecoveryState } from "../../ui/src/app/RecoveryScreen";

const none = { set: false, reset: false };
const PROBLEMS: RecoveryProblem[] = [
  { path: "llm.temperature", message: "Too big: expected number to be <=2", sensitive: false, section: { path: "llm", title: "Language model" }, actions: { set: true, reset: true } },
  { path: "llm.retired_key", message: "not a setting of this build", sensitive: false, section: { path: "llm", title: "Language model" }, actions: { ...none, reset: true } },
  { path: "chat.ignore_users[1]", message: "Invalid input: expected string, received number", sensitive: false, actions: { set: true, reset: true } },
  { path: "llm.__proto__", message: "not a setting of this build", sensitive: false, actions: none },
];
const STATE: RecoveryState = { active: true, cause: "invalid-settings", etag: "7", problems: PROBLEMS, backups: [], gated: true };
const BACKUPS = [{ name: "cohost-20261127T080000Z.db", time: "2026-11-27T08:00:00Z" }, { name: "cohost-20261126T080000Z.db", time: "2026-11-26T08:00:00Z" }];
const one = (message: string): RecoveryProblem[] => [{ path: "", message, sensitive: false, actions: none }];
const DAMAGED: RecoveryState = { active: true, cause: "damaged-store", etag: "7", problems: one("the settings store /d/store/cohost.db is damaged: not a database"), backups: BACKUPS, gated: true };
const NEWER: RecoveryState = { active: true, cause: "newer-store", etag: "7", problems: one("the settings store was written by a newer build. Nothing on this page changes the store: update cohost (git pull), then start the dashboard again."), backups: [], gated: true };
const MISSING: RecoveryState = { active: true, cause: "missing-key", etag: "7", problems: one("the master key file /k/master.key is missing"), backups: [], gated: true };

const HERE = { protocol: "http:", hostname: "localhost", port: "3000" };

function open(initial: RecoveryState = STATE, reload: () => void = () => {}, o: { navigate?: (url: string) => void; probe?: (url: string) => Promise<void> } = {}) {
  const app = makeApp();
  const r = renderApp(<RecoveryScreen initial={initial} reload={reload} navigate={o.navigate ?? (() => {})} probe={o.probe ?? (async () => {})} here={HERE} pollMs={5} />, app);
  return { ...r, app };
}

const row = (path: string): HTMLElement => screen.getByRole("heading", { level: 2, name: path }).closest("li")!;
const text = (): string => document.body.textContent ?? "";

// @spec DASH-RCV-013
test("recoveryState is the recovery state in recovery mode and null in normal mode or on a failure", async () => {
  const app = makeApp();
  app.fetch.on("GET /recovery", { json: STATE });
  assert.deepEqual(await recoveryState(app.rt.api), STATE);
  app.fetch.on("GET /recovery", { json: { active: false, recoveryKeyUnconfirmed: true } });
  assert.equal(await recoveryState(app.rt.api), null);
  app.fetch.on("GET /recovery", { status: 500, text: "boom" });
  assert.equal(await recoveryState(app.rt.api), null);
});

// @spec DASH-RCV-013
test("invalid settings: the cause sentence, Reset all, and one row per failing key with its section, message and only the actions it allows", () => {
  open();
  assert.ok(screen.getByRole("heading", { level: 1, name: "Config recovery" }));
  assert.match(text(), /because the stored settings do not pass this build's checks\. Services cannot be started until it is fixed/);
  assert.ok(screen.getByRole("button", { name: "Reset all failing keys" }));
  assert.ok(screen.getByRole("button", { name: "Check again" }));
  assert.ok(screen.getByRole("button", { name: "Stop the stack" }));
  const temp = row("llm.temperature");
  assert.ok(within(temp).getByText("Language model"));
  assert.ok(within(temp).getByText("Too big: expected number to be <=2"));
  assert.ok(within(temp).getByRole("textbox", { name: "New value for llm.temperature" }));
  assert.ok(within(temp).getByRole("button", { name: "Set" }));
  assert.ok(within(temp).getByRole("button", { name: "Reset to default" }));
  const retired = row("llm.retired_key");
  assert.equal(within(retired).queryByRole("textbox"), null, "a key the schema does not define is never set");
  assert.ok(within(retired).getByRole("button", { name: "Reset to default" }));
  assert.ok(within(row("chat.ignore_users[1]")).getByRole("button", { name: "Reset the list" }));
  const stuck = row("llm.__proto__");
  assert.equal(within(stuck).queryAllByRole("button").length, 0);
  assert.match(stuck.textContent ?? "", /cannot be changed here on its own/);
  assert.equal(screen.queryByRole("region", { name: "Restore or import" }), null);
  assert.equal(screen.queryByRole("region", { name: "Master key" }), null);
});

// @spec DASH-RCV-005, DASH-RCV-006, DASH-RCV-013
test("Set sends what was typed with the etag, Reset sends the path, and the list becomes the response's", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/set", { json: { ok: true, etag: "8", problems: PROBLEMS.slice(1), valid: false } });
  await userEvent.type(within(row("llm.temperature")).getByRole("textbox"), "0.5");
  await userEvent.click(within(row("llm.temperature")).getByRole("button", { name: "Set" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { level: 2, name: "llm.temperature" }), null));
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/set")[0]!.body!), { etag: "7", path: "llm.temperature", value: "0.5" });
  b.app.fetch.on("POST /recovery/reset", { json: { ok: true, etag: "9", problems: PROBLEMS.slice(2), valid: false } });
  await userEvent.click(within(row("llm.retired_key")).getByRole("button", { name: "Reset to default" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { level: 2, name: "llm.retired_key" }), null));
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/reset")[0]!.body!), { etag: "8", path: "llm.retired_key" });
});

// @spec DASH-RCV-013
test("a refused write shows its issues as an alert in the row and changes nothing else", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/set", { status: 400, json: { ok: false, issues: [{ path: "llm.temperature", message: "Too big" }] } });
  await userEvent.click(within(row("llm.temperature")).getByRole("button", { name: "Set" }));
  const alert = await within(row("llm.temperature")).findByRole("alert");
  assert.match(alert.textContent ?? "", /llm\.temperature: Too big/);
  assert.equal(screen.getAllByRole("listitem").length, PROBLEMS.length);
});

// @spec DASH-RCV-013
test("a stale etag re-reads the list and says the settings changed", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/set", { status: 409, json: { ok: false, etag: "12" } });
  b.app.fetch.on("GET /recovery", { json: { ...STATE, etag: "12" } });
  await userEvent.click(within(row("llm.temperature")).getByRole("button", { name: "Set" }));
  assert.match((await within(row("llm.temperature")).findByRole("alert")).textContent ?? "", /The settings changed since this list was read/);
  b.app.fetch.on("POST /recovery/set", { json: { ok: true, etag: "13", problems: PROBLEMS, valid: false } });
  await userEvent.click(within(row("llm.temperature")).getByRole("button", { name: "Set" }));
  await waitFor(() => assert.equal(b.app.fetch.callsTo("POST /recovery/set").length, 2));
  assert.equal((JSON.parse(b.app.fetch.callsTo("POST /recovery/set")[1]!.body!) as { etag: string }).etag, "12", "the next write carries the fresh etag");
});

// @spec DASH-RCV-013, DASH-RCV-015
test("when a write says valid the screen says the dashboard is starting, polls GET /recovery and reloads once it is inactive", async () => {
  let reloads = 0;
  const b = open(STATE, () => { reloads++; });
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "9", problems: [], valid: true } });
  b.app.fetch.on("GET /recovery", { json: STATE });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByText("The settings are valid. Starting the dashboard…");
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/reset-all")[0]!.body!), { etag: "7" });
  await waitFor(() => assert.ok(b.app.fetch.callsTo("GET /recovery").length >= 1));
  assert.equal(reloads, 0, "still in recovery: no reload");
  b.app.fetch.on("GET /recovery", { json: { active: false } });
  await waitFor(() => assert.equal(reloads, 1));
});

// @spec DASH-RCV-013
test("Check again replaces the list from GET /recovery, and a 401 asks for the control token", async () => {
  const b = open();
  b.app.fetch.on("GET /recovery", { json: { ...STATE, etag: "8", problems: PROBLEMS.slice(0, 1) } });
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => assert.equal(screen.getAllByRole("listitem").length, 1));
  b.app.fetch.on("POST /recovery/reset-all", { status: 401, text: "unauthorized" });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByRole("dialog", { name: "Access" });
});

// @spec DASH-RCV-013, DASH-RCV-015
test("when the valid answer names another port the page waits for the dashboard there and goes to it, naming it after ten misses", async () => {
  const went: string[] = [];
  let up = false;
  const probed: string[] = [];
  const b = open(STATE, () => assert.fail("no reload on a new port"), { navigate: (u) => went.push(u), probe: async (u) => { probed.push(u); if (!up) throw new TypeError("down"); } });
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "9", problems: [], valid: true, moved: true, port: 3100 } });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  const link = await screen.findByRole("link", { name: "http://localhost:3100/" });
  assert.equal(link.getAttribute("href"), "http://localhost:3100/");
  await screen.findByText(/Still waiting for the dashboard at http:\/\/localhost:3100\//);
  assert.ok(probed.length >= 10 && probed.every((u) => u === "http://localhost:3100/health"));
  assert.deepEqual(went, []);
  up = true;
  await waitFor(() => assert.deepEqual(went, ["http://localhost:3100/"]));
  assert.ok(screen.getByRole("link", { name: "http://localhost:3100/" }), "the link stays");
});

// @spec DASH-RCV-015
test("a valid answer that does not say moved reloads in place, even when the page's port is not the dashboard's (a tunnel or a proxy)", async () => {
  let reloads = 0;
  const app = makeApp();
  const probed: string[] = [];
  renderApp(<RecoveryScreen initial={STATE} reload={() => { reloads++; }} navigate={() => assert.fail("no move")} probe={async (u) => { probed.push(u); }} here={{ protocol: "http:", hostname: "localhost", port: "13000" }} pollMs={5} />, app);
  app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "9", problems: [], valid: true } });
  app.fetch.on("GET /recovery", { json: { active: false } });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await waitFor(() => assert.equal(reloads, 1));
  assert.deepEqual(probed, []);
  assert.equal(screen.queryByRole("link"), null);
});

// @spec DASH-RCV-015
test("on its own port the page names the address it waits for after ten unanswered polls", async () => {
  const b = open(STATE);
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "9", problems: [], valid: true } });
  b.app.fetch.on("GET /recovery", { status: 503, text: "starting" });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByText(/Still waiting for the dashboard at http:\/\/localhost:3000\//);
});

// @spec DASH-RCV-013, DASH-RCV-024, DASH-RCV-025
test("a damaged store: the backups with Restore each and an Import taking an export file and its passphrase; no failing-key rows", async () => {
  const b = open(DAMAGED);
  assert.match(text(), /because the settings store is damaged/);
  assert.match((screen.getAllByRole("alert")[0]!.textContent ?? ""), /is damaged: not a database/);
  assert.equal(screen.queryByRole("button", { name: "Reset all failing keys" }), null);
  assert.equal(screen.queryByRole("list", { name: "Failing keys" }), null);
  const backups = within(screen.getByRole("list", { name: "Backups" })).getAllByRole("listitem");
  assert.deepEqual(backups.map((li) => li.textContent?.replace("Restore", "")), BACKUPS.map((x) => x.time));
  b.app.fetch.on("POST /recovery/restore", { json: { ok: true, etag: "3", problems: [], valid: true } });
  await userEvent.click(within(backups[1]!).getByRole("button", { name: "Restore" }));
  await screen.findByText("The settings are valid. Starting the dashboard…");
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/restore")[0]!.body!), { backup: "cohost-20261126T080000Z.db" });
});

// @spec DASH-RCV-013, DASH-RCV-025
test("Import sends the chosen file's text with the passphrase, asks for a file first, and shows a refusal's issues", async () => {
  const b = open(DAMAGED);
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
  assert.match((await screen.findByText("Choose an export file first.")).textContent ?? "", /Choose/);
  assert.equal(b.app.fetch.callsTo("POST /recovery/import").length, 0);
  const file = new File(["cohost_export: 1\nsettings: {}\n"], "cohost-export.yaml", { type: "application/yaml" });
  await userEvent.upload(screen.getByLabelText("Export file"), file);
  await userEvent.type(screen.getByLabelText("Passphrase (when the export holds credentials)"), "a long passphrase");
  b.app.fetch.on("POST /recovery/import", { status: 400, json: { ok: false, issues: [{ path: "secrets", message: "the passphrase does not open the credentials" }] } });
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
  assert.match((await screen.findByText(/the passphrase does not open the credentials/)).textContent ?? "", /secrets: /);
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/import")[0]!.body!), { text: "cohost_export: 1\nsettings: {}\n", passphrase: "a long passphrase" });
});

// @spec DASH-RCV-013, DASH-RCV-026, DASH-RCV-027
test("a missing key: Save key sends the recovery key; Discard stays disabled until delete credentials is typed, then sends it", async () => {
  const b = open(MISSING);
  assert.match(text(), /because the settings store's master key is missing or wrong/);
  b.app.fetch.on("POST /recovery/key", { status: 400, json: { ok: false, detail: "that recovery key is the key abc, not the store's" } });
  await userEvent.type(screen.getByLabelText("Recovery key"), "cohost-key-1:XXXX");
  await userEvent.click(screen.getByRole("button", { name: "Save key" }));
  assert.match((await screen.findByText(/not the store's/)).textContent ?? "", /recovery key/);
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/key")[0]!.body!), { recoveryKey: "cohost-key-1:XXXX" });
  const discard = screen.getByRole("button", { name: "Discard the stored credentials" }) as HTMLButtonElement;
  assert.equal(discard.disabled, true);
  await userEvent.type(screen.getByLabelText("Confirmation"), "delete credential");
  assert.equal(discard.disabled, true, "only the exact words");
  await userEvent.type(screen.getByLabelText("Confirmation"), "s");
  assert.equal(discard.disabled, false);
  b.app.fetch.on("POST /recovery/discard-credentials", { json: { ok: true, etag: "9", problems: [], valid: true } });
  await userEvent.click(discard);
  await screen.findByText("The settings are valid. Starting the dashboard…");
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/discard-credentials")[0]!.body!), { confirm: "delete credentials" });
});

// @spec DASH-RCV-013
test("a newer store says to update cohost and offers no fix but Check again and Stop", () => {
  open(NEWER);
  assert.match(text(), /because the settings store was made by a newer build of cohost/);
  assert.match(text(), /git pull/);
  assert.equal(screen.queryByRole("button", { name: "Reset all failing keys" }), null);
  assert.equal(screen.queryByRole("button", { name: "Restore" }), null);
  assert.equal(screen.queryByRole("button", { name: "Save key" }), null);
  assert.deepEqual(screen.getAllByRole("button").map((x) => x.textContent), ["Check again", "Stop the stack"]);
});

// @spec DASH-RCV-028, DASH-RCV-013
test("while the token cannot be checked (gated false) the screen shows the host commands instead of the controls", () => {
  open({ ...DAMAGED, gated: false, etag: undefined });
  const host = screen.getByText("Fix this on the host").closest("[role=status]")!;
  assert.ok(host);
  for (const c of ["mise run config:restore -- <backup>", "mise run config:import -- <export file>", "mise run config:key -- --restore"]) {
    assert.ok(within(host as HTMLElement).getByText(c), c);
  }
  assert.equal(screen.queryByRole("button", { name: "Restore" }), null);
  assert.equal(screen.queryByRole("button", { name: "Import" }), null);
  assert.equal(screen.queryByRole("button", { name: "Reset all failing keys" }), null);
});

// @spec DASH-RCV-021
test("Stop the stack is always offered, with no control-info read first, and reports its result", async () => {
  const app = makeApp();
  renderApp(<RecoveryScreen initial={STATE} reload={() => {}} navigate={() => {}} probe={async () => {}} here={HERE} pollMs={5} />, app);
  const stop = screen.getByRole("button", { name: "Stop the stack" });
  assert.equal(app.fetch.callsTo("GET /services/control").length, 0);
  app.fetch.on("POST /stack/stop", { status: 502, json: { ok: false, detail: "Cannot connect to the Docker daemon" } });
  await userEvent.click(stop);
  assert.match((await screen.findByRole("alert")).textContent ?? "", /Cannot connect to the Docker daemon/);
  app.fetch.on("POST /stack/stop", { json: { ok: true, action: "stop" } });
  await userEvent.click(screen.getByRole("button", { name: "Stop the stack" }));
  await screen.findByText("The stack is stopped.");
  assert.equal(app.fetch.callsTo("POST /stack/stop").length, 2);
  app.fetch.on("POST /stack/stop", { status: 401, text: "unauthorized" });
  await userEvent.click(screen.getByRole("button", { name: "Stop the stack" }));
  await screen.findByRole("dialog", { name: "Access" });
});
