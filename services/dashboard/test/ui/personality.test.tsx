import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, screen, userEvent, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";

const text = (el: Element | null | undefined) => el?.textContent ?? "";

async function open(over = {}) {
  const b = boot({ section: "personality", ...over });
  await screen.findByRole("heading", { level: 1, name: "Personality" });
  await settle();
  return b;
}
const editor = () => screen.getByRole("textbox", { name: "personality.md" }) as HTMLTextAreaElement;
const saveBtn = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

// @spec DASH-SET-001
test("Personality is the first entry of Identity and its page loads GET /personality into the editor", async () => {
  const b = await open();
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  assert.equal(text(within(nav).getAllByRole("link")[0]), "Personality");
  assert.equal(within(nav).getByRole("link", { name: "Personality" }).getAttribute("aria-current"), "page");
  assert.equal(editor().value, "# Coco\n");
  assert.equal(b.app.fetch.callsTo("GET /personality").length, 1);
  assert.ok(screen.getByText(/1 line\b/));
  assert.ok(screen.getByText(/0\.0 KiB of 64 KiB/));
});

// @spec DASH-SET-014
test("while GET /personality has not succeeded the editor is empty and locked with the reason and Retry, and Save is off; Retry loads it", async () => {
  const b = await open({ routes: { "GET /personality": { status: 500, text: "read failed" } } });
  assert.equal(editor().value, "");
  assert.equal(editor().readOnly || editor().disabled, true, "locked");
  assert.equal(saveBtn().disabled, true);
  const alert = screen.getByRole("alert");
  assert.match(text(alert), /500 read failed/);
  b.app.fetch.on("GET /personality", { text: "# back\n" });
  await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
  await settle();
  assert.equal(editor().value, "# back\n");
  assert.equal(editor().readOnly || editor().disabled, false);
});

// @spec DASH-SET-014
test("an empty personality file is a loaded, editable empty editor, not a failure", async () => {
  await open({ routes: { "GET /personality": { text: "" } } });
  assert.equal(editor().readOnly || editor().disabled, false);
  assert.equal(screen.queryByRole("alert"), null);
});

// @spec DASH-SET-014
test("over 64 KiB the editor shows the size against the cap and Save is disabled", async () => {
  await open({ routes: { "GET /personality": { text: "x".repeat(65 * 1024) } } });
  assert.ok(screen.getByText(/65\.0 KiB of 64 KiB/));
  assert.equal(saveBtn().disabled, true);
  assert.match(text(screen.getByText(/over the 64 KiB cap/)), /over the 64 KiB cap/i);
});

// @spec DASH-SET-015, DASH-UI-015
test("Save sends PUT /personality with the text and reports saved only after a 2xx; a failure is an alert with the status and detail", async () => {
  const b = await open({ routes: { "PUT /personality": { status: 204 } } });
  const user = userEvent.setup();
  assert.equal(saveBtn().disabled, true, "nothing to save yet");
  await user.type(editor(), "more");
  assert.equal(saveBtn().disabled, false);
  await user.click(saveBtn());
  assert.equal(b.app.fetch.callsTo("PUT /personality").length, 1);
  await settle();
  const call = b.app.fetch.callsTo("PUT /personality")[0]!;
  assert.equal(call.body, "# Coco\nmore");
  assert.ok(screen.getByText("saved · brain reloaded"));
  b.app.fetch.on("PUT /personality", { status: 500, text: "disk full" });
  await user.type(editor(), "!");
  await user.click(saveBtn());
  await settle();
  assert.match(text(screen.getByRole("alert")), /500 disk full/);
  assert.equal(screen.queryByText("saved · brain reloaded"), null);
  assert.equal(editor().value, "# Coco\nmore!", "the text is kept");
});

// @spec DASH-SET-015
test("Ctrl+S in the editor saves", async () => {
  const b = await open({ routes: { "PUT /personality": { status: 204 } } });
  const user = userEvent.setup();
  await user.type(editor(), "x");
  await user.keyboard("{Control>}s{/Control}");
  await settle();
  assert.equal(b.app.fetch.callsTo("PUT /personality").length, 1);
  assert.ok(screen.getByText("saved · brain reloaded"));
});

// @spec DASH-UI-006
test("saving the personality asks for the control token through the Access dialog on a 401 and says so on Cancel", async () => {
  const b = await open({ routes: { "PUT /personality": { status: 401, text: "unauthorized" } } });
  const user = userEvent.setup();
  await user.type(editor(), "x");
  await user.click(saveBtn());
  await settle(2);
  assert.ok(b.app.rt.access.state.get().prompt);
  act(() => b.app.rt.access.resolvePrompt(false));
  await settle();
  assert.match(text(screen.getByRole("alert")), /not done: locked/);
});

// @spec DASH-NAV-004
test("unsaved personality text asks before the page is closed; saved text does not", async () => {
  await open({ routes: { "PUT /personality": { status: 204 } } });
  const ask = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(ask(), false);
  const user = userEvent.setup();
  await user.type(editor(), "x");
  assert.equal(ask(), true);
  await user.click(saveBtn());
  await settle();
  assert.equal(ask(), false);
});
