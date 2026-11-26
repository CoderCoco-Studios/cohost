import { test } from "node:test";
import assert from "node:assert/strict";
import { act, screen, userEvent, waitFor, within } from "./helpers/render";
import { UNITS, mountServices, push, svc } from "./services-fixtures";
import type { ControlInfo, UnitDescriptor } from "../../ui/src/state/types";

// The Test sheet of the `tools` unit is a text injection naming a tool and its arguments. Its text goes out as
// `as: "tool"`, never as a chat message: a `tools` row that sent plain `text` would feed chat. The tool route is always
// gated like every mutation (DASH-INJ-011). Contract for the form: a textbox named for the tool (/tool/i) and one for its arguments
// (/argument/i), and the button `Send text`.

const toolsUnit: UnitDescriptor = { id: "tools", config: [], uses: [], requires: [], pause: false, infra: false, defaultMode: "fresh", test: { inputs: ["text"], observe: ["tool.result", "inject.result"] } };
const manifest = [...UNITS, toolsUnit];
const open = async (control: ControlInfo) => {
  const m = await mountServices({ control, manifest, services: [...UNITS, toolsUnit].map((u) => svc(u.id)) });
  const row = within(screen.getByRole("table", { name: "Services" })).getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name: "tools" }) !== null)!;
  await userEvent.setup().click(within(row).getByRole("button", { name: "Test tools" }));
  return { ...m, sheet: screen.getByRole("dialog", { name: "Test tools" }) };
};
const ON = { enabled: true, runtime: "compose", advanced: false, tokenRequired: false } as const;
const OFF = { enabled: false, tokenRequired: false } as const;

async function fill(sheet: HTMLElement, toolName: string, args: string) {
  const user = userEvent.setup();
  const tool = within(sheet).getByRole("textbox", { name: /tool/i });
  const argsBox = within(sheet).getByRole("textbox", { name: /argument/i });
  await user.clear(tool); await user.type(tool, toolName);
  await user.clear(argsBox);
  await user.click(argsBox);
  await user.paste(args);
  return user;
}

// @spec MOD-MAN-010, MOD-TEST-005, DASH-INJ-011
test("a tools Test sheet sends service-level text as: tool, never as a chat message, with the text being the JSON {tool, arguments} of one call", async () => {
  const { app, sheet } = await open(ON);
  app.rt.access.setToken("control", "tok", "tab");
  app.fetch.on("POST /inject/text", { status: 202, json: { id: "req-1" } });
  const user = await fill(sheet, "stream_info", '{"verbose": true}');
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/text").length, 1));
  const call = app.fetch.callsTo("POST /inject/text")[0]!;
  const body = JSON.parse(call.body!) as { level: string; as?: string; text: string };
  assert.equal(body.level, "service");
  assert.equal(body.as, "tool");
  assert.deepEqual(JSON.parse(body.text), { tool: "stream_info", arguments: { verbose: true } });
  assert.equal(call.headers.authorization, "Bearer tok");
  assert.equal(app.fetch.callsTo("POST /inject/event").length, 0);
});

// @spec MOD-MAN-010, DASH-INJ-011, DASH-UI-006
test("the tool call goes out without a token when none is held: on loopback it is sent with no Access dialog; a 401 asks for one, and Cancel sends nothing more", async () => {
  const { app, sheet } = await open(OFF);
  app.fetch.on("POST /inject/text", { status: 202, json: { id: "req-2" } });
  const user = await fill(sheet, "stream_info", "{}");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/text").length, 1));
  assert.equal(app.fetch.callsTo("POST /inject/text")[0]!.headers.authorization, undefined);
  assert.equal(app.rt.access.state.get().prompt, null);
  document.body.innerHTML = "";

  const remote = await open(ON);
  remote.app.fetch.on("POST /inject/text", { status: 401, text: "unauthorized" });
  const u2 = await fill(remote.sheet, "stream_info", "{}");
  await u2.click(within(remote.sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.ok(remote.app.rt.access.state.get().prompt, "the Access dialog is asked after the 401"));
  act(() => remote.app.rt.access.resolvePrompt(false));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(remote.app.fetch.callsTo("POST /inject/text").length, 1, "the refused try only");
});

// @spec MOD-MAN-010, MOD-TEST-005
test("arguments that are not a JSON object, or a blank tool, are refused on the page with nothing sent", async () => {
  const { app, sheet } = await open(ON);
  app.rt.access.setToken("control", "tok", "tab");
  const user = await fill(sheet, "stream_info", "not json");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  assert.ok(await within(sheet).findByRole("alert"));
  await fill(sheet, "stream_info", "[1,2]");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await fill(sheet, "   ", "{}");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  assert.equal(app.fetch.callsTo("POST /inject/text").length, 0);
});

// @spec MOD-MAN-010, MOD-TEST-005
test("a 409 service not running is shown with its status, and the answer is the tool.result row that carries the call's request id", async () => {
  const { app, sheet } = await open(ON);
  app.rt.access.setToken("control", "tok", "tab");
  app.fetch.on("POST /inject/text", { status: 409, json: { ok: false, detail: "service not running: tools" } });
  const user = await fill(sheet, "stream_info", "{}");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /409.*not running: tools|service not running: tools/);
  app.fetch.on("POST /inject/text", { status: 202, json: { id: "req-3" } });
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.match(within(sheet).getByRole("status").textContent ?? "", /req-3/));
  push(app, { id: "r1", type: "inject.result", ts: 1, source: "tools", data: { id: "req-3", ok: true, detail: "ran" } });
  push(app, { id: "r2", type: "tool.result", ts: 1, source: "tools", data: { id: "req-3", tool: "stream_info", status: "ok", content: "Playing", durationMs: 3 } });
  const live = within(sheet).getByRole("log", { name: "Live events" });
  assert.match(live.textContent ?? "", /tool\.result/);
  assert.match(live.textContent ?? "", /Playing/);
});

// @spec MOD-MAN-010
test("every other unit's text form is unchanged: chat sends plain service-level text with no as", async () => {
  const m = await mountServices({ control: OFF, manifest, services: [...UNITS, toolsUnit].map((u) => svc(u.id)) });
  const row = within(screen.getByRole("table", { name: "Services" })).getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name: "chat" }) !== null)!;
  await userEvent.setup().click(within(row).getByRole("button", { name: "Test chat" }));
  const sheet = screen.getByRole("dialog", { name: "Test chat" });
  m.app.fetch.on("POST /inject/text", { status: 202, json: { id: "x" } });
  const user = userEvent.setup();
  await user.type(within(sheet).getByRole("textbox", { name: /Message/ }), "hello");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.equal(m.app.fetch.callsTo("POST /inject/text").length, 1));
  assert.deepEqual(JSON.parse(m.app.fetch.callsTo("POST /inject/text")[0]!.body!), { level: "service", text: "hello" });
});
