import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, renderApp, screen, userEvent, waitFor, within } from "./helpers/render";
import { RecoveryScreen, recoveryState, type RecoveryProblem, type RecoveryState } from "../../ui/src/app/RecoveryScreen";

const none = { set: false, reset: false, fallback: false };
const PROBLEMS: RecoveryProblem[] = [
  { file: "config", path: "cohost.name", message: "uses the placeholder ${COHOST_NAME}", kind: "placeholder", secret: false, sensitive: false, fallback: "Mika", resetPath: "cohost.name", actions: { set: true, reset: true, fallback: true } },
  { file: "config", path: "llm.claude.api_key", message: "uses the placeholder ${KEY}; write the credential in secrets.yaml", kind: "placeholder", secret: true, sensitive: false, section: { path: "llm", title: "Language model" }, resetPath: "llm.claude.api_key", actions: { ...none, reset: true } },
  { file: "config", path: "chat.ignore_users[1]", message: "uses the placeholder ${BOT}", kind: "placeholder", secret: false, sensitive: false, resetPath: "chat.ignore_users", actions: { ...none, reset: true } },
  { file: "secrets", path: "", message: "not valid YAML at line 2, column 1", kind: "secrets", secret: true, sensitive: false, actions: none },
];
const STATE: RecoveryState = { active: true, file: "/cohost/config/config.yaml", secretsFile: "/cohost/secrets/secrets.yaml", etag: "e1", problems: PROBLEMS };

function open(initial: RecoveryState = STATE, reload: () => void = () => {}) {
  const app = makeApp();
  const r = renderApp(<RecoveryScreen initial={initial} reload={reload} pollMs={5} />, app);
  return { ...r, app };
}

const row = (path: string): HTMLElement => screen.getByRole("heading", { level: 2, name: path }).closest("li")!;

// @spec DASH-RCV-013
test("recoveryState is the recovery state in recovery mode and null in normal mode or on a failure", async () => {
  const app = makeApp();
  app.fetch.on("GET /recovery", { json: STATE });
  assert.deepEqual(await recoveryState(app.rt.api), STATE);
  app.fetch.on("GET /recovery", { json: { active: false } });
  assert.equal(await recoveryState(app.rt.api), null);
  app.fetch.on("GET /recovery", { status: 500, text: "boom" });
  assert.equal(await recoveryState(app.rt.api), null);
});

// @spec DASH-RCV-013, DASH-RCV-014
test("the recovery screen lists every failing key with its kind, message and only the actions it allows", () => {
  open();
  assert.ok(screen.getByRole("heading", { level: 1, name: "Config recovery" }));
  assert.match(document.body.textContent ?? "", /\/cohost\/config\/config\.yaml and \/cohost\/secrets\/secrets\.yaml does not validate/);
  assert.ok(screen.getByRole("button", { name: "Reset all failing keys" }));
  assert.ok(screen.getByRole("button", { name: "Check again" }));
  const name = row("cohost.name");
  assert.ok(within(name).getByText("Placeholder"));
  assert.ok(within(name).getByRole("textbox", { name: "New value for cohost.name" }));
  assert.ok(within(name).getByRole("button", { name: "Set" }));
  assert.ok(within(name).getByRole("button", { name: "Use Mika" }));
  assert.ok(within(name).getByRole("button", { name: "Reset to default" }));
  const secret = row("llm.claude.api_key");
  assert.equal(within(secret).queryByRole("textbox"), null);
  assert.ok(within(secret).getByRole("button", { name: "Remove from config.yaml" }));
  assert.match(secret.textContent ?? "", /This is a credential\. Remove it from config\.yaml here, then set it in Settings, Language model, with its masked field/);
  assert.ok(within(row("chat.ignore_users[1]")).getByRole("button", { name: "Reset the list" }));
  const file = row("/cohost/secrets/secrets.yaml");
  assert.ok(within(file).getByText("Secrets file"));
  assert.equal(within(file).queryAllByRole("button").length, 0);
  assert.match(file.textContent ?? "", /Fix this by hand in \/cohost\/secrets\/secrets\.yaml/);
});

// @spec DASH-RCV-013
test("Set sends what was typed with the etag, and the list becomes the response's", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/set", { json: { ok: true, etag: "e2", problems: PROBLEMS.slice(1), valid: false } });
  await userEvent.type(within(row("cohost.name")).getByRole("textbox"), "Coco");
  await userEvent.click(within(row("cohost.name")).getByRole("button", { name: "Set" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { level: 2, name: "cohost.name" }), null));
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/set")[0]!.body!), { etag: "e1", path: "cohost.name", value: "Coco" });
  b.app.fetch.on("POST /recovery/reset", { json: { ok: true, etag: "e3", problems: PROBLEMS.slice(2), valid: false } });
  await userEvent.click(within(row("llm.claude.api_key")).getByRole("button", { name: "Remove from config.yaml" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { level: 2, name: "llm.claude.api_key" }), null));
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/reset")[0]!.body!), { etag: "e2", path: "llm.claude.api_key" });
});

// @spec DASH-RCV-013
test("a refused write shows its issues as an alert in the row and changes nothing else", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/set", { status: 400, json: { ok: false, issues: [{ path: "cohost.name", message: "must not be empty" }] } });
  await userEvent.click(within(row("cohost.name")).getByRole("button", { name: "Set" }));
  const alert = await within(row("cohost.name")).findByRole("alert");
  assert.match(alert.textContent ?? "", /cohost\.name: must not be empty/);
  assert.equal(screen.getAllByRole("listitem").length, PROBLEMS.length);
});

// @spec DASH-RCV-013, DASH-RCV-015
test("when a write says valid the screen says the dashboard is starting, polls GET /recovery and reloads once it is inactive", async () => {
  let reloads = 0;
  const b = open(STATE, () => { reloads++; });
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "e9", problems: [], valid: true } });
  b.app.fetch.on("GET /recovery", { json: STATE });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByText("The config is valid. Starting the dashboard…");
  assert.deepEqual(JSON.parse(b.app.fetch.callsTo("POST /recovery/reset-all")[0]!.body!), { etag: "e1" });
  await waitFor(() => assert.ok(b.app.fetch.callsTo("GET /recovery").length >= 1));
  assert.equal(reloads, 0, "still in recovery: no reload");
  b.app.fetch.on("GET /recovery", { json: { active: false } });
  await waitFor(() => assert.equal(reloads, 1));
});

// @spec DASH-RCV-013
test("Check again replaces the list from GET /recovery, and a 401 asks for the control token", async () => {
  const b = open();
  b.app.fetch.on("GET /recovery", { json: { ...STATE, etag: "e5", problems: PROBLEMS.slice(3) } });
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => assert.equal(screen.getAllByRole("listitem").length, 1));
  b.app.fetch.on("POST /recovery/reset-all", { status: 401, text: "unauthorized" });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByRole("dialog", { name: "Access" });
});
