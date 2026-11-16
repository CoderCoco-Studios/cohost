import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, userEvent, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";

// Saves whose answer is lost, and conflicts, against the fake file of settings-helpers (which behaves like
// services/dashboard/src/settings.ts: one etag for the file, 409 before validation, a read returns what was written).

const body = (c: { body?: string }) => JSON.parse(c.body ?? "null");
const row = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const bar = (name: string): HTMLButtonElement => within(screen.getByRole("group", { name: "Save settings" })).getByRole("button", { name }) as HTMLButtonElement;
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const nameBox = () => within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement;

async function open(section = "demo") {
  const b = boot({ section });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  return b;
}

// @spec DASH-SET-012, DASH-SET-031
test("a lost answer whose write did not land, while another client changed the file, keeps the etag the edits were made against: the next Save answers 409", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.type(nameBox(), "z");
  b.app.fetch.on("PUT /config/demo", async () => { b.file.otherClient("demo", { port: 9 }); throw new TypeError("network error"); });
  await user.click(bar("Save"));
  await settle();
  const msg = text(screen.getByRole("alert"));
  assert.match(msg, /outcome of the save is unknown/i, "the bar says the outcome of the save is unknown");
  assert.match(msg, /Name/, "and names what the file now holds for the edited key");
  assert.match(msg, /Coco/);
  assert.ok(screen.getByText("1 edit in this section"), "the edit is kept");
  b.app.fetch.on("PUT /config/demo", b.file.put("demo"));
  await user.click(bar("Save"));
  await settle();
  assert.equal(body(b.app.fetch.callsTo("PUT /config/demo")[1]!).etag, "e1", "the second save carries the etag the edit was made against");
  assert.match(text(screen.getByRole("alert")), /config\.yaml changed since/, "the other client's write is reported, not overwritten");
  assert.equal(b.file.written.demo?.name, undefined, "nothing was written");
  assert.equal(b.file.written.demo?.port, 9, "the other client's value stands");
});

// @spec DASH-SET-012, DASH-SET-031
test("a lost answer whose write did not land and nobody else wrote leaves the next Save working with the same etag", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.type(nameBox(), "z");
  b.app.fetch.on("PUT /config/demo", b.file.lost("demo", false));
  await user.click(bar("Save"));
  await settle();
  assert.match(text(screen.getByRole("alert")), /outcome of the save is unknown/i);
  b.app.fetch.on("PUT /config/demo", b.file.put("demo"));
  await user.click(bar("Save"));
  await settle();
  assert.ok(screen.getByText("Saved."));
  assert.equal(b.file.written.demo?.name, "Cocoz");
});

// @spec DASH-SET-012, DASH-SET-031
test("a lost answer whose write landed is confirmed by the re-read, and an etag from the re-read is not given to other sections", async () => {
  const b = await open("demo"); // the Demo page also holds the Extra section
  const user = userEvent.setup();
  await user.type(nameBox(), "z");
  const extra = within(row("extra")).getByRole("spinbutton") as HTMLInputElement;
  await user.clear(extra); await user.type(extra, "30");
  const real = b.file.put("demo");
  // The Demo write lands, then another client writes Extra, then the answer is lost: the file's etag now includes a write this page never saw.
  b.app.fetch.on("PUT /config/demo", async (call) => { real(call); b.file.otherClient("extra", { extra: 40 }); throw new TypeError("network error"); });
  b.app.fetch.on("PUT /config/extra", b.file.put("extra"));
  await user.click(bar("Save"));
  await settle();
  const put = b.app.fetch.callsTo("PUT /config/extra");
  assert.equal(put.length, 1);
  assert.equal(body(put[0]!).etag, "e1", "Extra still holds the etag it was read at, so its save is refused");
  assert.equal(b.file.written.extra?.extra, 40, "the other client's change to Extra was not overwritten");
  assert.match(text(screen.getByRole("alert")), /config\.yaml changed since|Extra/);
});

// @spec DASH-SET-011
test("Discard after a 409 clears the conflict and takes the file's current etag: the next edit saves", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.type(nameBox(), "z");
  b.file.otherClient("demo", { port: 9 });
  await user.click(bar("Save"));
  await settle();
  assert.match(text(screen.getByRole("alert")), /config\.yaml changed since/);
  await user.click(bar("Discard"));
  await settle();
  assert.ok(screen.queryByRole("alert") === null, "no alert");
  assert.equal(nameBox().value, "Coco");
  await user.type(nameBox(), "q");
  await user.click(bar("Save"));
  await settle();
  assert.ok(screen.queryByRole("alert") === null, "no second 409");
  assert.ok(screen.getByText("Saved."));
  assert.equal(b.file.written.demo?.name, "Cocoq");
  assert.equal(b.file.written.demo?.port, 9, "the other client's change is intact");
});
