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
  { file: "secrets", path: "voice.openai.api_key", message: "must be a string (write a value made only of digits in quotes)", kind: "secrets", secret: true, sensitive: false, resetPath: "voice.openai.api_key", repair: "quote", actions: { ...none, reset: true } },
];
const STATE: RecoveryState = { active: true, file: "/cohost/config/config.yaml", secretsFile: "/cohost/secrets/secrets.yaml", etag: "e1", problems: PROBLEMS };

const HERE = { protocol: "http:", hostname: "localhost", port: "3000" };

function open(initial: RecoveryState = STATE, reload: () => void = () => {}, o: { navigate?: (url: string) => void; probe?: (url: string) => Promise<void> } = {}) {
  const app = makeApp();
  const r = renderApp(<RecoveryScreen initial={initial} reload={reload} navigate={o.navigate ?? (() => {})} probe={o.probe ?? (async () => {})} here={HERE} pollMs={5} />, app);
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
  assert.ok(within(row("voice.openai.api_key")).getByRole("button", { name: "Quote it in secrets.yaml" }));
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
  b.app.fetch.on("GET /recovery", { json: { ...STATE, etag: "e5", problems: PROBLEMS.slice(3, 4) } });
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
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "e9", problems: [], valid: true, moved: true, port: 3100 } });
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
  app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "e9", problems: [], valid: true } });
  app.fetch.on("GET /recovery", { json: { active: false } });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await waitFor(() => assert.equal(reloads, 1));
  assert.deepEqual(probed, []);
  assert.equal(screen.queryByRole("link"), null);
});

// @spec DASH-RCV-015
test("on its own port the page names the address it waits for after ten unanswered polls", async () => {
  const b = open(STATE);
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "e9", problems: [], valid: true } });
  b.app.fetch.fail("GET /recovery");
  b.app.fetch.on("GET /recovery", { status: 503, text: "starting" });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByText(/Still waiting for the dashboard at http:\/\/localhost:3000\//);
});

// @spec DASH-RCV-013
test("reset-all without the token says which secrets.yaml keys wait for it", async () => {
  const b = open();
  b.app.fetch.on("POST /recovery/reset-all", { json: { ok: true, etag: "e2", problems: PROBLEMS.slice(3), valid: false, tokenNeeded: ["voice.openai.api_key"] } });
  await userEvent.click(screen.getByRole("button", { name: "Reset all failing keys" }));
  await screen.findByText(/voice\.openai\.api_key in secrets\.yaml need the control token/);
});
