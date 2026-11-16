import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, screen, userEvent, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";

const row = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const body = (c: { body?: string }) => JSON.parse(c.body ?? "null");

async function open(section: string, over = {}) {
  const b = boot({ section, ...over });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  return b;
}

// @spec DASH-SET-009
test("a secret key shows Set or Not set with a masked field and no value, and its edit state stays out of the save bar", async () => {
  await open("demo");
  const r = row("api_key");
  assert.ok(within(r).getByText("Set"));
  const input = within(r).getByLabelText("Api key") as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.value, "");
  assert.equal(text(r.querySelector(".srow-s")), "secret");
  assert.ok(screen.getByText("0 edits in this section"));
});

// @spec DASH-SET-009, DASH-SECRET-001
test("saving a secret sends PUT /secrets/<path> with the control token, never shows the value afterwards, leaves the edit count alone and feeds the restart banner", async () => {
  const b = await open("demo", { routes: { "PUT /secrets/demo.api_key": { json: { ok: true, set: true, restart: ["voice"] } } } });
  const user = userEvent.setup();
  await user.type(within(row("api_key")).getByLabelText("Api key"), "sk-SECRET-123");
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.click(within(row("api_key")).getByRole("button", { name: "Save" }));
  await settle();
  const call = b.app.fetch.callsTo("PUT /secrets/demo.api_key")[0]!;
  assert.deepEqual(body(call), { value: "sk-SECRET-123" });
  assert.equal(call.headers.authorization, "Bearer tok");
  assert.ok(!call.path.includes("SECRET"), "the value is not in the URL");
  assert.equal(document.body.innerHTML.includes("sk-SECRET-123"), false, "the value is nowhere in the DOM after saving");
  assert.equal((within(row("api_key")).getByLabelText("Api key") as HTMLInputElement).value, "");
  assert.ok(screen.getByText("0 edits in this section"));
  assert.match(text(screen.getByRole("region", { name: "Restart needed" })), /voice/);
});

// @spec DASH-SET-009, DASH-SECRET-003
test("a secret write asks for the control token through the Access dialog when none is held, and writes nothing on Cancel", async () => {
  const b = await open("demo", { routes: { "PUT /secrets/demo.api_key": { json: { ok: true, set: true, restart: [] } } } });
  const user = userEvent.setup();
  await user.type(within(row("api_key")).getByLabelText("Api key"), "abc");
  await user.click(within(row("api_key")).getByRole("button", { name: "Save" }));
  await settle();
  assert.ok(b.app.rt.access.state.get().prompt, "the Access dialog is asked for the token");
  assert.match(b.app.rt.access.state.get().prompt!.action, /demo\.api_key/);
  act(() => b.app.rt.access.resolvePrompt(false));
  await settle();
  assert.equal(b.app.fetch.callsTo("PUT /secrets/demo.api_key").length, 0);
  assert.match(text(row("api_key")), /not done: locked/);
  assert.equal((within(row("api_key")).getByLabelText("Api key") as HTMLInputElement).value, "abc", "what was typed stays so the operator can retry");
});

// @spec DASH-SET-009, DASH-SECRET-002
test("clearing a secret confirms first, then sends null and reads as Not set", async () => {
  const b = await open("demo", { routes: { "PUT /secrets/demo.api_key": { json: { ok: true, set: false, restart: [] } } } });
  const user = userEvent.setup();
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.click(within(row("api_key")).getByRole("button", { name: "Clear" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  await settle();
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /secrets/demo.api_key")[0]!), { value: null });
  assert.ok(within(row("api_key")).getByText("Not set"));
});

// @spec DASH-SET-009, DASH-UI-015
test("a failed secret write is shown beside the field with its status and detail, and the typed text is kept", async () => {
  const b = await open("demo", { routes: { "PUT /secrets/demo.api_key": { status: 500, json: { ok: false, detail: "cannot write secrets.yaml" } } } });
  const user = userEvent.setup();
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.type(within(row("api_key")).getByLabelText("Api key"), "abc");
  await user.click(within(row("api_key")).getByRole("button", { name: "Save" }));
  await settle();
  assert.match(text(row("api_key")), /500 cannot write secrets\.yaml/);
  assert.equal(document.body.innerHTML.includes("abc") && !(within(row("api_key")).getByLabelText("Api key") as HTMLInputElement).value, false);
});

// @spec DASH-SET-009, DASH-SECRET-011, DASH-SECRET-012
test("the two Bedrock keys are saved together with PUT /secrets so a half-set pair cannot be made, and a 400 shows on both fields", async () => {
  const b = await open("llm", { routes: { "PUT /secrets": { status: 400, json: { ok: false, detail: "llm.bedrock.access_key_id and llm.bedrock.secret_access_key must be set together", paths: ["llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"] } } } });
  const user = userEvent.setup();
  b.app.rt.access.setToken("control", "tok", "tab");
  const id = screen.getByLabelText("Bedrock access key id") as HTMLInputElement;
  const key = screen.getByLabelText("Bedrock secret access key") as HTMLInputElement;
  assert.equal(id.type, "password");
  const save = () => screen.getByRole("button", { name: "Save both Bedrock keys" }) as HTMLButtonElement;
  await user.type(id, "AKIA-ONLY");
  assert.equal(save().disabled, true, "one typed and the other not set: the pair would be half set");
  await user.type(key, "SECRETKEY");
  assert.equal(save().disabled, false);
  await user.click(save());
  await settle();
  const call = b.app.fetch.callsTo("PUT /secrets")[0]!;
  assert.deepEqual(body(call), { values: { "llm.bedrock.access_key_id": "AKIA-ONLY", "llm.bedrock.secret_access_key": "SECRETKEY" } });
  assert.equal(b.app.fetch.callsTo("PUT /secrets/llm.bedrock.access_key_id").length, 0);
  const errors = screen.getAllByText(/must be set together/);
  assert.equal(errors.length, 2, "the 400 is shown on both fields");
  assert.ok(id.getAttribute("aria-describedby"));
  assert.equal(id.getAttribute("aria-invalid"), "true");
  assert.equal(key.getAttribute("aria-invalid"), "true");
});

// @spec DASH-SET-009, DASH-SECRET-011
test("a successful Bedrock pair save clears both fields, shows both as Set and leaves no value in the DOM; Clear both sends two nulls", async () => {
  const b = await open("llm", { routes: { "PUT /secrets": (c) => ({ json: { ok: true, set: Object.fromEntries(Object.entries(JSON.parse(c.body!).values).map(([k, v]) => [k, v !== null])), restart: ["salience"] } }) } });
  const user = userEvent.setup();
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.type(screen.getByLabelText("Bedrock access key id"), "AKIA-1");
  await user.type(screen.getByLabelText("Bedrock secret access key"), "SECRET-2");
  await user.click(screen.getByRole("button", { name: "Save both Bedrock keys" }));
  await settle();
  assert.equal(document.body.innerHTML.includes("SECRET-2"), false);
  assert.equal(document.body.innerHTML.includes("AKIA-1"), false);
  assert.equal(within(row("bedrock.access_key_id")).getAllByText("Set").length, 1);
  assert.equal((screen.getByLabelText("Bedrock access key id") as HTMLInputElement).value, "");
  await user.click(screen.getByRole("button", { name: "Clear both Bedrock keys" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  await settle();
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /secrets")[1]!), { values: { "llm.bedrock.access_key_id": null, "llm.bedrock.secret_access_key": null } });
  assert.ok(within(row("bedrock.access_key_id")).getByText("Not set"));
});

// @spec DASH-SET-009, DASH-SECRET-012
test("rotating one Bedrock key while the other is set is a single-key write", async () => {
  const demo = (await import("./settings-fixture")).accountRead;
  const read = { ...demo, keys: { ...demo.keys, "bedrock.access_key_id": { editable: false, secret: true, set: true }, "bedrock.secret_access_key": { editable: false, secret: true, set: true } } };
  const b = await open("llm", { routes: { "GET /config/llm": { json: read }, "PUT /secrets/llm.bedrock.access_key_id": { json: { ok: true, set: true, restart: [] } } } });
  const user = userEvent.setup();
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.type(screen.getByLabelText("Bedrock access key id"), "AKIA-NEW");
  await user.click(screen.getByRole("button", { name: "Save both Bedrock keys" }));
  await settle();
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /secrets/llm.bedrock.access_key_id")[0]!), { value: "AKIA-NEW" });
  assert.equal(b.app.fetch.callsTo("PUT /secrets").length, 0);
});
