import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, screen, userEvent, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";
import { schemaPayload } from "./settings-fixture";

const body = (c: { body?: string }) => JSON.parse(c.body ?? "null");
const row = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const text = (el: Element | null | undefined) => el?.textContent ?? "";

async function open(section = "demo", over = {}) {
  const b = boot({ section, ...over });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  return b;
}

// @spec DASH-SET-001
test("the navigation lists the schema's sections under its group names with Personality first in Identity, and not a section with page", async () => {
  await open();
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const groups = within(nav).getAllByRole("heading", { level: 2 }).map(text);
  assert.deepEqual(groups, ["Identity", "Brain", "System"]);
  const links = within(nav).getAllByRole("link").map(text);
  assert.deepEqual(links, ["Personality", "Plain", "Demo", "Account"]);
  assert.equal(within(nav).queryByRole("link", { name: "Extra" }), null, "Extra has page: demo");
  assert.equal(within(nav).getByRole("link", { name: "Demo" }).getAttribute("aria-current"), "page");
  assert.equal(within(nav).getByRole("link", { name: "Plain" }).getAttribute("href"), "#settings/plain");
  assert.equal(screen.getAllByRole("heading", { level: 1 }).length, 1);
});

// @spec DASH-SET-001, DASH-UI-015
test("while the schema loads the screen says so, and a failed load is an alert with Retry that reads it again", async () => {
  const b = boot({ routes: { "GET /config/schema": { status: 500, text: "boom" } } });
  assert.ok(screen.getByRole("status"), "loading");
  const alert = await screen.findByRole("alert");
  assert.match(text(alert), /500 boom/);
  b.app.fetch.on("GET /config/schema", { json: schemaPayload });
  await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { level: 1, name: "Demo" });
});

// @spec DASH-SET-002, DASH-SET-025
test("a page shows the title as its heading, the about line, the config path with the setting count and readers, and open collapsible groups", async () => {
  await open();
  assert.equal(text(screen.getByRole("heading", { level: 1 })), "Demo");
  assert.ok(screen.getByText("A section with one control of every kind."));
  const line = screen.getByText(/config\.yaml/);
  assert.match(text(line), /demo/);
  assert.match(text(line), /23 settings/);
  assert.match(text(line), /read by voice, mouth/);
  assert.match(text(line), /changes apply when they restart/);
  const groups = [...document.querySelectorAll("details")];
  assert.deepEqual(groups.map((g) => text(g.querySelector("summary"))), ["General", "Nested", "Extra"]);
  assert.ok(groups.every((g) => g.hasAttribute("open")), "open by default");
});

// @spec DASH-SET-002
test("a section no unit reads says it applies at the dashboard's next start; a section with page appears as a group on that page", async () => {
  await open("plain");
  assert.match(text(screen.getByText(/config\.yaml/)), /read by the dashboard itself .* next start/);
  document.body.innerHTML = "";
  const b = await open("extra"); // `extra` has page: demo, so it opens Demo with its keys as a group
  assert.equal(text(screen.getByRole("heading", { level: 1 })), "Demo");
  assert.ok(row("extra"), "the leaf section's key is on the page");
  b.unmount();
});

// @spec DASH-SET-003
test("a key with no metadata still shows, labelled from its path, with no help, and nothing is read-only", async () => {
  await open("plain");
  const r = row("speak_rate_ms");
  assert.ok(within(r).getByLabelText("Speak rate ms"));
  assert.equal(r.querySelectorAll("p.help").length, 1, "only the note: there is no help text to show");
  assert.equal(document.querySelectorAll("[readonly]").length, 0);
  assert.equal(within(r).queryByText(/environment/i), null);
});

// @spec DASH-SET-004
test("each row shows the label, the key path, its help, a note with range and default, and the source", async () => {
  await open();
  const r = row("temperature");
  assert.equal(text(r.querySelector("label, .label")), "Temperature");
  assert.equal(text(r.querySelector("code")), "demo.temperature");
  assert.ok(within(r).getByText("How adventurous."));
  assert.ok(within(r).getByText("Range 0 to 2. Default 0.7."));
  assert.equal(text(r.querySelector(".srow-s")), "config.yaml");
  assert.equal(text(row("provider").querySelector(".srow-s")), "default");
  assert.match(text(row("provider")), /Not in config\.yaml yet\. Saving a change adds it\./);
  assert.equal(text(row("api_key").querySelector(".srow-s")), "secret");
  const input = within(r).getByRole("spinbutton", { name: "Temperature value" });
  assert.match(input.getAttribute("aria-describedby") ?? "", /\S/);
  const help = document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!);
  assert.equal(text(help), "How adventurous.");
});

// @spec DASH-SET-016
test("a boolean is a switch showing On or Off beside it, and toggling it records an edit", async () => {
  await open();
  const sw = within(row("enabled")).getByRole("switch", { name: "Enabled" }) as HTMLInputElement;
  assert.equal(sw.checked, true);
  assert.ok(within(row("enabled")).getByText("On"));
  await userEvent.setup().click(sw);
  assert.ok(within(row("enabled")).getByText("Off"));
  assert.match(text(screen.getByText(/1 edit in/)), /1 edit/);
});

// @spec DASH-SET-017
test("an enum of up to four values is a segmented radio group with the key's option labels; a longer one is a select", async () => {
  await open();
  const group = within(row("mode")).getByRole("group", { name: "Mode" });
  assert.deepEqual(within(group).getAllByRole("radio").map((r) => (r.parentElement as HTMLElement).textContent), ["Calm", "Lively", "Wild"]);
  assert.equal((within(group).getByRole("radio", { name: "Calm" }) as HTMLInputElement).checked, true);
  await userEvent.setup().click(within(group).getByRole("radio", { name: "Wild" }));
  const select = within(row("provider")).getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
  assert.equal(select.options.length, 6);
  assert.equal(select.value, "ollama");
  assert.match(select.getAttribute("aria-describedby") ?? "", /\S/);
  await userEvent.setup().selectOptions(select, "claude");
  assert.match(text(screen.getByText(/2 edits in/)), /2 edits/);
});

// @spec DASH-SET-013
test("a value the enum does not list is an extra selected option and is never dropped", async () => {
  const read = { ...(await import("./settings-fixture")).demoRead, keys: { ...(await import("./settings-fixture")).demoRead.keys, provider: { source: "literal", editable: true, value: "legacy" } } };
  await open("demo", { routes: { "GET /config/demo": { json: read } } });
  const select = within(row("provider")).getByRole("combobox") as HTMLSelectElement;
  assert.equal(select.value, "legacy");
  assert.ok([...select.options].some((o) => o.value === "legacy"));
});

// @spec DASH-SET-018
test("a bounded number is a slider with printed ends and an exact number box; a wide or unbounded one is a number box", async () => {
  await open();
  const r = row("temperature");
  const slider = within(r).getByRole("slider", { name: "Temperature" });
  assert.equal(slider.getAttribute("min"), "0");
  assert.equal(slider.getAttribute("max"), "2");
  assert.equal(slider.getAttribute("step"), "0.01");
  assert.equal(within(row("top_k")).getByRole("slider").getAttribute("step"), "1");
  fireEvent.change(slider, { target: { value: "1.5" } });
  assert.equal((within(r).getByRole("spinbutton", { name: "Temperature value" }) as HTMLInputElement).value, "1.5");
  assert.equal(within(row("port")).queryByRole("slider"), null);
  assert.ok(within(row("port")).getByRole("spinbutton", { name: "Port" }));
  assert.ok(within(row("timeout_ms")).getByText("ms"));
});

// @spec DASH-SET-005
test("an invalid number is marked aria-invalid with its message in aria-describedby, and Check and Save are disabled while it is", async () => {
  await open();
  const user = userEvent.setup();
  const box = within(row("port")).getByRole("spinbutton", { name: "Port" }) as HTMLInputElement;
  await user.clear(box);
  await user.type(box, "70000");
  assert.equal(box.getAttribute("aria-invalid"), "true");
  const ids = box.getAttribute("aria-describedby")!.split(" ");
  assert.ok(ids.some((id) => /at most 65535/i.test(text(document.getElementById(id)))));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled, true);
  await user.clear(box);
  await user.type(box, "8080");
  assert.equal(box.getAttribute("aria-invalid"), null);
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false);
});

// @spec DASH-SET-004, DASH-SET-029
test("a string is a text box; a string with the textarea widget or a long default is a textarea", async () => {
  await open();
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" })).tagName, "INPUT");
  assert.equal((within(row("prompt")).getByRole("textbox", { name: "Prompt" })).tagName, "TEXTAREA");
  const longRead = (await import("./settings-fixture")).demoRead;
  const long = { ...longRead, keys: { ...longRead.keys, name: { source: "literal", editable: true, value: "x".repeat(90) } } };
  document.body.innerHTML = "";
  await open("demo", { routes: { "GET /config/demo": { json: long } } });
  assert.equal(within(row("name")).getByRole("textbox", { name: "Name" }).tagName, "TEXTAREA", "over 80 characters");
});

// @spec DASH-SET-019
test("a list of strings is a textarea with one value per line, and an array of enum values is chips", async () => {
  await open();
  const user = userEvent.setup();
  const area = within(row("ignore")).getByRole("textbox", { name: "Ignore" }) as HTMLTextAreaElement;
  await user.type(area, "bot{Enter}spam");
  assert.equal(area.value, "bot\nspam");
  const chips = within(row("senses")).getByRole("group", { name: "Senses" });
  assert.deepEqual(within(chips).getAllByRole("checkbox").map((c) => (c.parentElement as HTMLElement).textContent?.replace("✓", "")), ["Chat", "Speech", "Vision"]);
  await user.click(within(chips).getByRole("checkbox", { name: /Vision/ }));
  assert.equal((within(chips).getByRole("checkbox", { name: /Vision/ }) as HTMLInputElement).checked, true);
});

// @spec DASH-SET-024
test("the sources widget is a grid of checkbox tiles with a way to add another connector tag", async () => {
  await open();
  const user = userEvent.setup();
  const tiles = within(row("sources")).getByRole("group", { name: "Sources" });
  assert.ok(within(tiles).getByRole("checkbox", { name: /discord/ }));
  assert.equal((within(tiles).getByRole("checkbox", { name: /discord/ }) as HTMLInputElement).checked, false);
  assert.equal((within(tiles).getByRole("checkbox", { name: /chat/ }) as HTMLInputElement).checked, true, "a tag the list does not know is its own tile");
  await user.type(within(tiles).getByRole("textbox", { name: "Add a connector tag" }), "Mic-2");
  await user.click(within(tiles).getByRole("button", { name: "Add" }));
  assert.equal((within(tiles).getByRole("checkbox", { name: /mic-2/ }) as HTMLInputElement).checked, true);
});

// @spec DASH-SET-021
test("the timezone widget is a select of the browser's zones plus UTC and the current value; a text box where the browser has none", async () => {
  const intl = Intl as unknown as { supportedValuesOf?: unknown };
  const original = intl.supportedValuesOf;
  try {
    intl.supportedValuesOf = () => ["Europe/Paris", "America/New_York"];
    await open();
    const select = within(row("timezone")).getByRole("combobox", { name: "Timezone" }) as HTMLSelectElement;
    assert.deepEqual([...select.options].map((o) => o.value), ["Europe/Paris", "America/New_York", "UTC"]);
    assert.equal(select.value, "UTC");
    document.body.innerHTML = "";
    intl.supportedValuesOf = undefined;
    await open();
    assert.equal(within(row("timezone")).getByRole("textbox", { name: "Timezone" }).tagName, "INPUT");
  } finally { intl.supportedValuesOf = original; }
});

// @spec DASH-SET-022, DASH-OPT-002
test("the model widget is a free-text box suggesting the installed models first and then the curated list, and accepts any name", async () => {
  const b = await open();
  const user = userEvent.setup();
  const box = within(row("model")).getByRole("combobox", { name: "Model" }) as HTMLInputElement;
  const list = document.getElementById(box.getAttribute("list")!)!;
  const options = [...list.querySelectorAll("option")].map((o) => o.getAttribute("value"));
  assert.deepEqual(options.slice(0, 2), ["llama3.2:3b", "qwen2.5:7b"]);
  assert.ok(options.includes("mistral:7b"), "the curated list follows");
  assert.equal(new Set(options).size, options.length, "no duplicates");
  await user.type(box, "my-own-model");
  assert.equal(box.value, "my-own-model");
  assert.equal(b.app.fetch.callsTo("GET /options/models").length, 1, "asked once when the page opened");
});

// @spec DASH-SET-023, DASH-OPT-001
test("the voice widget is a select of the server's voices labelled with language and gender, with a custom-mix escape", async () => {
  await open();
  const user = userEvent.setup();
  const select = within(row("voice")).getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
  assert.deepEqual([...select.options].map((o) => o.textContent), ["af_heart · American, female", "bm_george · British, male", "Custom mix…"]);
  await user.selectOptions(select, "Custom mix…");
  const mix = within(row("voice")).getByRole("textbox", { name: "Custom mix" });
  await user.type(mix, "af_bella(2)+af_sky");
  assert.equal((mix as HTMLInputElement).value, "af_bella(2)+af_sky");
});

// @spec DASH-SET-010
test("when a pick-list route answers 502 the control is a plain text box holding the current value with a note, and nothing asks again", async () => {
  const b = await open("demo", { routes: { "GET /options/models": { status: 502, json: { ok: false, detail: "down" } }, "GET /options/voices": { status: 502, json: { ok: false, detail: "down" } } } });
  const model = within(row("model")).getByRole("textbox", { name: "Model" }) as HTMLInputElement;
  assert.equal(model.getAttribute("list"), null);
  assert.ok(within(row("model")).getByText("Could not reach the model server. Type the name instead."));
  const voice = within(row("voice")).getByRole("textbox", { name: "Voice" }) as HTMLInputElement;
  assert.equal(voice.value, "af_heart");
  assert.ok(within(row("voice")).getByText(/Could not reach the voice server/));
  await userEvent.setup().type(model, "x");
  await settle();
  assert.equal(b.app.fetch.callsTo("GET /options/models").length, 1);
  assert.equal(b.app.fetch.callsTo("GET /options/voices").length, 1);
});

// @spec DASH-SET-013
test("a widget the screen does not know leaves the generic control for the key's type and the key is not hidden", async () => {
  await open();
  assert.equal(within(row("mystery")).getByRole("textbox", { name: "Mystery" }).tagName, "INPUT");
});

// @spec DASH-SET-026
test("a shape with no control is a JSON textarea marked raw JSON; text that is not JSON blocks Check and Save", async () => {
  await open();
  const user = userEvent.setup();
  const area = within(row("extras")).getByRole("textbox", { name: "Extras" }) as HTMLTextAreaElement;
  assert.ok(within(row("extras")).getByText("raw JSON"));
  await user.clear(area);
  await user.type(area, "{{");
  assert.equal(area.getAttribute("aria-invalid"), "true");
  assert.ok(within(row("extras")).getByText(/Not valid JSON/));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
});

// @spec DASH-SET-020
test("an array of objects is a card per item with a numbered heading, per-property help, Add and Remove, and no raw JSON", async () => {
  await open();
  const user = userEvent.setup();
  const r = row("reflexes");
  assert.equal(within(r).queryByText(/raw JSON/), null);
  const card = within(r).getByRole("group", { name: "Reflex 1" });
  assert.equal((within(card).getByRole("textbox", { name: "Match" }) as HTMLInputElement).value, "gg");
  assert.ok(within(card).getByText("A pattern tested against each line."), "help from the item metadata");
  assert.ok(within(card).getByRole("group", { name: "Listens to" }), "chips for the enum array");
  assert.ok(within(card).getByRole("combobox", { name: "Emotion" }));
  assert.ok(within(card).getByText("ms"));
  await user.click(within(r).getByRole("button", { name: "Add reflex" }));
  const second = within(r).getByRole("group", { name: "Reflex 2" });
  assert.equal(within(second).getByRole("combobox", { name: "Emotion" }).getAttribute("aria-invalid"), null);
  assert.equal(within(second).getByRole("textbox", { name: "Match" }).getAttribute("aria-invalid"), "true", "a new card has an empty required property");
  assert.ok(within(second).getByText(/required/i));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
  await user.click(within(r).getByRole("button", { name: "Remove reflex 2" }));
  assert.equal(within(r).queryByRole("group", { name: "Reflex 2" }), null);
  await user.click(within(r).getByRole("button", { name: "Remove reflex 1" }));
  assert.ok(within(r).getByText(/No reflexes yet/));
});

// @spec DASH-SET-006
test("edits are counted in the nav and the save bar; Discard drops them and Check and Save are disabled without edits", async () => {
  await open();
  const user = userEvent.setup();
  const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  assert.equal(save().disabled, true);
  assert.equal((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled, true);
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "o");
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  assert.match(text(within(nav).getByRole("link", { name: /Demo/ })), /Demo.*1/);
  assert.ok(screen.getByText("1 edit in this section"));
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "x");
  assert.ok(screen.getByText("1 edit in this section"), "the same key is one edit");
  await user.click(screen.getByRole("button", { name: "Discard" }));
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Coco");
  assert.equal(save().disabled, true);
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "{Backspace}");
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "o");
  assert.equal(save().disabled, false);
  await user.keyboard("{Backspace}o");
  assert.ok(screen.getByText("1 edit in this section"));
});

// @spec DASH-SET-006, DASH-UI-015
test("Check sends only the changed keys with ?dryRun=1 and shows the warnings; Save sends them without it; edits stay when a request fails", async () => {
  const b = await open("demo", { routes: {
    "PUT /config/demo?dryRun=1": { json: { ok: true, dryRun: true, warnings: ["demo.port: x is running isolated"] } },
    "PUT /config/demo": { status: 500, text: "disk full" },
  } });
  const user = userEvent.setup();
  await user.click(within(row("enabled")).getByRole("switch"));
  const port = within(row("port")).getByRole("spinbutton", { name: "Port" });
  await user.clear(port); await user.type(port, "8080");
  await user.click(screen.getByRole("button", { name: "Check" }));
  await settle();
  const check = b.app.fetch.callsTo("PUT /config/demo?dryRun=1")[0]!;
  assert.deepEqual(body(check), { etag: "e1", values: { enabled: false, port: 8080 } });
  assert.ok(screen.getByText(/Check passed with warnings/));
  assert.ok(screen.getByText("demo.port: x is running isolated"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /config/demo")[0]!), { etag: "e1", values: { enabled: false, port: 8080 } });
  assert.match(text(screen.getByRole("alert")), /500 disk full/);
  assert.ok(screen.getByText("2 edits in this section"), "the edits are kept");
  assert.equal((within(row("port")).getByRole("spinbutton", { name: "Port" }) as HTMLInputElement).value, "8080");
  b.app.fetch.on("PUT /config/demo", { json: { ok: true, etag: "e2", restart: [], warnings: [] } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.ok(screen.getByText("Saved."));
  assert.equal(screen.queryByRole("alert"), null);
  assert.ok(screen.getByText("0 edits in this section"));
});

// @spec DASH-SET-005
test("a 400 attaches each issue to the field with that path and keeps an issue with no field in a summary above the save bar", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo": { status: 400, json: { ok: false, issues: [{ path: "demo.name", message: "name too odd" }, { path: "demo.reflexes[0].match", message: "bad pattern" }, { path: "", message: "file is not valid" }] } } } });
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const name = within(row("name")).getByRole("textbox", { name: "Name" });
  assert.equal(name.getAttribute("aria-invalid"), "true");
  assert.ok(name.getAttribute("aria-describedby")!.split(" ").some((id) => text(document.getElementById(id)) === "name too odd"));
  const card = within(row("reflexes")).getByRole("group", { name: "Reflex 1" });
  assert.ok(within(card).getByText("bad pattern"));
  const summary = screen.getByRole("alert");
  assert.match(text(summary), /file is not valid/);
  assert.equal(b.app.fetch.callsTo("PUT /config/demo").length, 1);
});

// @spec DASH-SET-011
test("a 409 keeps the edits, says config.yaml changed and offers Reload, which re-reads the section and drops them", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo": { status: 409, json: { ok: false, etag: "e9" } } } });
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.match(text(screen.getByRole("alert")), /config\.yaml changed since/);
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Cocoz", "nothing discarded yet");
  const before = b.app.fetch.callsTo("GET /config/demo").length;
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await settle();
  assert.equal(b.app.fetch.callsTo("GET /config/demo").length, before + 1);
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Coco");
  assert.equal(screen.queryByRole("button", { name: "Reload" }), null);
});

// @spec DASH-SET-012
test("a save whose answer is lost re-reads the section: done when every edited key holds its value, otherwise kept and not confirmed", async () => {
  const demo = (await import("./settings-fixture")).demoRead;
  const b = await open();
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  b.app.fetch.fail("PUT /config/demo");
  b.app.fetch.on("GET /config/demo", { json: { ...demo, etag: "e2", keys: { ...demo.keys, name: { source: "literal", editable: true, value: "Cocoz" } } } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.ok(screen.getByText("Saved."), "the file already holds the edited value");
  assert.ok(screen.getByText("0 edits in this section"));
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "q");
  b.app.fetch.fail("PUT /config/demo");
  b.app.fetch.on("GET /config/demo", { json: { ...demo, etag: "e3", keys: { ...demo.keys, name: { source: "literal", editable: true, value: "Cocoz" } } } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.match(text(screen.getByRole("alert")), /could not be confirmed/);
  assert.ok(screen.getByText("1 edit in this section"));
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Cocozq");
});

// @spec DASH-SET-027
test("a key a running unit overrides shows the runs-isolated notice and stays editable", async () => {
  const demo = (await import("./settings-fixture")).demoRead;
  const read = { ...demo, keys: { ...demo.keys, mode: { ...demo.keys.mode!, isolation: { name: "VOICE_ENGINE", overriddenBy: ["voice"] } } } };
  await open("demo", { routes: { "GET /config/demo": { json: read } } });
  const note = within(row("mode")).getByText(/runs isolated/);
  assert.match(text(note), /voice runs isolated: its VOICE_ENGINE override is set, and a restart keeps it\. Your saved value applies again once it is started without isolation\./);
  assert.equal(within(row("mode")).getByRole("radio", { name: "Calm" }).hasAttribute("disabled"), false);
  const none = { ...demo, keys: { ...demo.keys, mode: { ...demo.keys.mode!, isolation: { name: "VOICE_ENGINE", overriddenBy: [] } } } };
  document.body.innerHTML = "";
  await open("demo", { routes: { "GET /config/demo": { json: none } } });
  assert.equal(within(row("mode")).queryByText(/runs isolated/), null);
});

// @spec DASH-SET-007, DASH-SET-008
test("after a save with units to restart a banner names them and the warnings; Restart goes one after another, continues after a failure and keeps the failed unit", async () => {
  const b = await open("demo", { routes: {
    "PUT /config/demo": { json: { ok: true, etag: "e2", restart: ["voice", "mouth", "salience"], warnings: ["demo.port: moves"] } },
    "POST /services/voice/restart": { json: { ok: true } },
    "POST /services/mouth/restart": { status: 500, json: { ok: false, detail: "compose failed" } },
    "POST /services/salience/restart": { json: { ok: true } },
  } });
  const user = userEvent.setup();
  await user.click(within(row("enabled")).getByRole("switch"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const banner = screen.getByRole("region", { name: "Restart needed" });
  assert.match(text(banner), /Restart these services to apply: voice, mouth, salience/);
  assert.ok(within(banner).getByText("demo.port: moves"));
  await user.click(within(banner).getByRole("button", { name: "Restart" }));
  await settle(6);
  const calls = b.app.fetch.calls.filter((c) => /\/restart$/.test(c.path)).map((c) => [c.method, c.path, c.body]);
  assert.deepEqual(calls, [["POST", "/services/voice/restart", undefined], ["POST", "/services/mouth/restart", undefined], ["POST", "/services/salience/restart", undefined]]);
  const after = screen.getByRole("region", { name: "Restart needed" });
  assert.match(text(after), /Restart these services to apply: mouth/);
  assert.match(text(after), /mouth.*500 compose failed/);
  assert.match(text(after), /voice.*restarted/);
});

// @spec DASH-SET-007
test("the restart banner survives moving to another section and unmounting the screen", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo": { json: { ok: true, etag: "e2", restart: ["voice"], warnings: [] } } } });
  const user = userEvent.setup();
  await user.click(within(row("enabled")).getByRole("switch"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  b.unmount();
  const again = (await import("./helpers/render")).renderApp((await import("../../ui/src/screens/settings")).Screen({ route: { view: "settings", section: "plain" } }) as never, b.app);
  await settle();
  assert.match(text(screen.getByRole("region", { name: "Restart needed" })), /voice/);
  again.unmount();
});

// @spec DASH-SET-008
test("where control is disabled the banner names the units and the cohostctl command instead of a button", async () => {
  await open("demo", { control: false, routes: { "PUT /config/demo": { json: { ok: true, etag: "e2", restart: ["voice", "mouth"], warnings: [] } } } });
  const user = userEvent.setup();
  await user.click(within(row("enabled")).getByRole("switch"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const banner = screen.getByRole("region", { name: "Restart needed" });
  assert.equal(within(banner).queryByRole("button", { name: "Restart" }), null);
  assert.ok(within(banner).getByText("cohostctl restart voice"));
  assert.ok(within(banner).getByText("cohostctl restart mouth"));
});

// @spec DASH-SET-028, DASH-UI-006
test("a sensitive key carries a control-token note; saving it asks for the token naming the change, keeps the edits on Cancel and retries once unlocked", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo": { json: { ok: true, etag: "e2", restart: [], warnings: [] } } } });
  const user = userEvent.setup();
  assert.ok(within(row("url")).getByText(/Changing this needs the control token/));
  assert.equal(within(row("name")).queryByText(/needs the control token/), null);
  await user.type(within(row("url")).getByRole("textbox", { name: "Url" }), "x");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const prompt = b.app.rt.access.state.get().prompt;
  assert.ok(prompt, "the Access dialog is asked for the token");
  assert.match(prompt!.action, /demo\.url/);
  assert.equal(b.app.fetch.callsTo("PUT /config/demo").length, 0, "nothing was sent without a token");
  act(() => b.app.rt.access.resolvePrompt(false));
  await settle();
  assert.match(text(screen.getByRole("alert")), /not done: locked/);
  assert.ok(screen.getByText("1 edit in this section"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle(1);
  act(() => { b.app.rt.access.setToken("control", "tok", "tab"); b.app.rt.access.resolvePrompt(true); });
  await settle();
  const sent = b.app.fetch.callsTo("PUT /config/demo");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.authorization, "Bearer tok");
});

// @spec DASH-SET-028
test("Check never asks for the token, a 403 on save shows the control token as not set up, and a held token is sent", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo?dryRun=1": { status: 401, text: "unauthorized" }, "PUT /config/demo": { status: 403, json: { ok: false, detail: "set CONTROL_TOKEN and CONTROL_ENABLED", sensitive: ["demo.url"] } } } });
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  await user.click(screen.getByRole("button", { name: "Check" }));
  await settle();
  assert.equal(b.app.rt.access.state.get().prompt, null, "a dry run never opens the Access dialog");
  assert.match(text(screen.getByRole("alert")), /401/);
  b.app.rt.access.setToken("control", "tok", "tab");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.equal(b.app.fetch.callsTo("PUT /config/demo")[0]!.headers.authorization, "Bearer tok");
  assert.equal(b.app.rt.access.state.get().control.notSetUp, true);
  assert.match(text(screen.getByRole("alert")), /403/);
});

// @spec DASH-NAV-004
test("leaving the page with unsaved edits asks first (beforeunload); once they are saved or discarded it does not", async () => {
  await open();
  const ask = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(ask(), false);
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  assert.equal(ask(), true);
  await user.click(screen.getByRole("button", { name: "Discard" }));
  assert.equal(ask(), false);
});

// @spec DASH-SET-006
test("edits survive moving to another section and back", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.type(within(row("name")).getByRole("textbox", { name: "Name" }), "z");
  b.unmount();
  await settle();
  const { renderApp } = await import("./helpers/render");
  const { Screen } = await import("../../ui/src/screens/settings");
  const again = renderApp(<Screen route={{ view: "settings", section: "demo" }} />, b.app);
  await settle();
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Cocoz");
  assert.ok(screen.getByText("1 edit in this section"));
  again.unmount();
});

// @spec DASH-SET-006
test("a page that merges a section keeps one save bar that sends each section's edits to its own route", async () => {
  const b = await open("demo", { routes: { "PUT /config/demo": { json: { ok: true, etag: "e2", restart: [], warnings: [] } }, "PUT /config/extra": { json: { ok: true, etag: "x2", restart: ["voice"], warnings: [] } } } });
  const user = userEvent.setup();
  await user.click(within(row("enabled")).getByRole("switch"));
  const extra = within(row("extra")).getByRole("spinbutton", { name: "Extra events" });
  await user.clear(extra); await user.type(extra, "30");
  assert.ok(screen.getByText("2 edits in this section"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /config/extra")[0]!), { etag: "x1", values: { extra: 30 } });
  assert.deepEqual(body(b.app.fetch.callsTo("PUT /config/demo")[0]!), { etag: "e1", values: { enabled: false } });
});

// @spec DASH-UI-030
test("values reach the DOM as text: markup in a loaded value is shown literally", async () => {
  const demo = (await import("./settings-fixture")).demoRead;
  const read = { ...demo, keys: { ...demo.keys, name: { source: "literal", editable: true, value: "<img src=x onerror=alert(1)>" } } };
  await open("demo", { routes: { "GET /config/demo": { json: read } } });
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.equal((within(row("name")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "<img src=x onerror=alert(1)>");
});

// @spec DASH-UI-001
test("when a section cannot be read the page shows an alert with Retry and keeps the navigation", async () => {
  const b = await open("plain", { routes: { "GET /config/plain": { status: 500, text: "read failed" } } });
  const alert = await screen.findByRole("alert");
  assert.match(text(alert), /500 read failed/);
  assert.ok(screen.getByRole("navigation", { name: "Settings sections" }));
  b.app.fetch.on("GET /config/plain", { json: (await import("./settings-fixture")).plainRead });
  await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
  await settle();
  assert.ok(row("speak_rate_ms"));
});

// @spec DASH-SET-001
test("an unknown section path says so and keeps the navigation", async () => {
  await open("nope");
  assert.ok(screen.getByText(/No settings section named nope/));
  assert.ok(screen.getByRole("navigation", { name: "Settings sections" }));
});
