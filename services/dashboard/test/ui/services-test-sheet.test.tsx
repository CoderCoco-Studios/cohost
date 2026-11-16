import { test } from "node:test";
import assert from "node:assert/strict";
import { EventPayloads } from "@cohost/bus";
import { act, fireEvent, screen, userEvent, waitFor, within } from "./helpers/render";
import { sampleFor } from "../../ui/src/screens/services/samples";
import { UNITS, mountServices, push, svc } from "./services-fixtures";

const ON = { enabled: true, runtime: "compose", advanced: false } as const;
const rowOf = (name: string): HTMLElement => {
  const row = within(screen.getByRole("table", { name: "Services" })).getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name }) !== null);
  assert.ok(row !== undefined, `no row for ${name}`);
  return row;
};
const all = () => UNITS.map((u) => svc(u.id));
const open = async (unit: string, control: typeof ON | { enabled: false } = { enabled: false }) => {
  const m = await mountServices({ control, services: all() });
  const opener = within(rowOf(unit)).getByRole("button", { name: `Test ${unit}` });
  await userEvent.setup().click(opener);
  return { ...m, opener, sheet: screen.getByRole("dialog", { name: `Test ${unit}` }) };
};
const feed = () => screen.getByRole("log", { name: "Live events" });
const frame = (type: string, data: Record<string, unknown>, id = `${type}-${Math.random()}`) => ({ id, type, ts: 1, source: "x", data });

// @spec MOD-TEST-001, DASH-UI-032
test("a Test button shows on each manifest unit that declares test inputs, with control enabled or not, and nowhere else", async () => {
  for (const control of [ON, { enabled: false } as const]) {
    const { unmount } = await mountServices({ control, services: [...all(), svc("dashboard"), svc("mystery")] });
    for (const u of UNITS) {
      const has = within(rowOf(u.id)).queryByRole("button", { name: `Test ${u.id}` }) !== null;
      assert.equal(has, (u.test as { inputs: string[] }).inputs.length > 0, u.id);
    }
    for (const o of ["dashboard", "mystery"]) assert.equal(within(rowOf(o)).queryAllByRole("button").length, 0, o);
    unmount();
  }
});

// @spec DASH-UI-032
test("Test opens a modal dialog side sheet that takes focus, and Esc closes it and returns focus to that Test button", async () => {
  const { opener, sheet } = await open("salience");
  assert.equal((sheet as HTMLDialogElement).open, true);
  assert.ok(sheet.classList.contains("sheet"));
  assert.ok(sheet.contains(document.activeElement), "focus is inside");
  fireEvent(sheet, new Event("cancel", { cancelable: true })); // what Esc fires; the shell's own handler is not mounted here
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.ok(document.activeElement === opener, "focus is back on the Test button");
});

// @spec MOD-TEST-001
test("the sheet offers one form per declared input, and the isolated start only with control enabled", async () => {
  const on = await open("salience", ON);
  for (const t of ["chat.message", "speech.heard", "vision.summary"]) assert.ok(within(on.sheet).getByRole("textbox", { name: `${t} data (JSON)` }) !== null, t);
  assert.equal(within(on.sheet).getAllByRole("button", { name: /^Send / }).length, 3);
  assert.ok(within(on.sheet).getByRole("button", { name: "Start salience isolated" }) !== null);
  on.unmount();
  const off = await open("salience");
  assert.ok(within(off.sheet).queryByRole("button", { name: /isolated/ }) === null);
  off.unmount();
  const chat = await open("chat");
  assert.ok(within(chat.sheet).getByRole("textbox", { name: "Message, sent as a chat message through the real pipeline" }) !== null);
  assert.equal(within(chat.sheet).getAllByRole("button", { name: /^Send / }).length, 1);
  chat.unmount();
  const eyes = await open("eyes");
  const img = within(eyes.sheet).getByLabelText("Image, through the real pipeline") as HTMLInputElement;
  assert.equal(img.type, "file");
  assert.equal(img.accept, "image/png,image/jpeg,image/webp");
});

// @spec MOD-TEST-001
test("a bus-event form starts with an editable sample, posts /inject/event {unit, type, data} and reports the bus id; a refusal is shown with its status", async () => {
  const { app, sheet } = await open("salience");
  app.fetch.on("POST /inject/event", { status: 202, json: { id: "17-0" } });
  const box = within(sheet).getByRole("textbox", { name: "chat.message data (JSON)" }) as HTMLTextAreaElement;
  assert.deepEqual(JSON.parse(box.value), sampleFor("chat.message"));
  fireEvent.change(box, { target: { value: JSON.stringify({ platform: "twitch", user: "bob", text: "hi" }) } });
  const user = userEvent.setup();
  await user.click(within(sheet).getByRole("button", { name: "Send chat.message" }));
  await waitFor(() => assert.match(within(sheet).getByRole("status").textContent ?? "", /published chat\.message.*17-0/i));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /inject/event")[0]!.body!), { unit: "salience", type: "chat.message", data: { platform: "twitch", user: "bob", text: "hi" } });
  app.fetch.on("POST /inject/event", { status: 409, json: { ok: false, detail: "service not running: salience" } });
  await user.click(within(sheet).getByRole("button", { name: "Send chat.message" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /409 service not running: salience/);
});

// @spec MOD-TEST-001
test("invalid JSON is not sent and the form says why", async () => {
  const { app, sheet } = await open("salience");
  fireEvent.change(within(sheet).getByRole("textbox", { name: "speech.heard data (JSON)" }), { target: { value: "{not json" } });
  await userEvent.setup().click(within(sheet).getByRole("button", { name: "Send speech.heard" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /not valid JSON/);
  assert.equal(app.fetch.callsTo("POST /inject/event").length, 0);
});

// @spec MOD-TEST-001
test("every bus input a manifest unit declares has a sample payload that its bus schema accepts", () => {
  const types = [...new Set(UNITS.flatMap((u) => (u.test as { inputs: string[] }).inputs).filter((t) => !["text", "image", "audio"].includes(t)))];
  assert.ok(types.length >= 5);
  for (const t of types) {
    const parsed = (EventPayloads as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>)[t]!.safeParse(sampleFor(t));
    assert.ok(parsed.success, `${t}: ${JSON.stringify(sampleFor(t))}`);
  }
  assert.deepEqual(sampleFor("unknown.type"), {});
});

// @spec MOD-TEST-001
test("the chat unit's text form posts a service-level /inject/text and its inject.result, and only its own, joins the live list", async () => {
  const { app, sheet } = await open("chat");
  app.fetch.on("POST /inject/text", { status: 202, json: { id: "req-1" } });
  const user = userEvent.setup();
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /Type some text first/);
  assert.equal(app.fetch.callsTo("POST /inject/text").length, 0);
  await user.type(within(sheet).getByRole("textbox", { name: "Message, sent as a chat message through the real pipeline" }), "hello there");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/text").length, 1));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /inject/text")[0]!.body!), { level: "service", text: "hello there" });
  await waitFor(() => assert.match(within(sheet).getByRole("status").textContent ?? "", /sent text.*req-1/i));
  push(app, frame("inject.result", { id: "other", ok: true }));
  assert.ok(within(feed()).queryByText(/other/) === null);
  push(app, frame("inject.result", { id: "req-1", ok: true, detail: "queued" }));
  assert.match(feed().textContent ?? "", /inject\.result/);
  assert.match(feed().textContent ?? "", /queued/);
});

// @spec MOD-TEST-001
test("an inject.result that arrives before the HTTP answer is shown once the answer names its id", async () => {
  const { app, sheet } = await open("chat");
  let release!: () => void;
  app.fetch.on("POST /inject/text", () => new Promise((res) => { release = () => res({ status: 202, json: { id: "req-9" } }); }));
  const user = userEvent.setup();
  await user.type(within(sheet).getByRole("textbox", { name: "Message, sent as a chat message through the real pipeline" }), "hi");
  await user.click(within(sheet).getByRole("button", { name: "Send text" }));
  push(app, frame("inject.result", { id: "req-9", ok: true, detail: "early" }));
  assert.ok(!/early/.test(feed().textContent ?? ""), "not shown before it is known to be ours");
  await act(async () => { release(); });
  await waitFor(() => assert.match(feed().textContent ?? "", /early/));
});

// @spec MOD-TEST-001
test("the live list shows the unit's test.observe types, including ones the main feed drops, and nothing else", async () => {
  const { app } = await open("salience");
  push(app, frame("attention.focus", { reason: "mentioned", score: 0.9 }));
  push(app, frame("brain.say", { id: "s", text: "hello", emotion: "happy" }));
  push(app, frame("affect.state", { valence: 0, arousal: 0, mood: "neutral" }));
  const t = feed().textContent ?? "";
  assert.match(t, /attention\.focus/);
  assert.match(t, /brain\.say/);
  assert.ok(!/affect\.state/.test(t));
});

// @spec MOD-TEST-001
test("a reply carrying the injected data's own id is tagged as answering the injection", async () => {
  const { app, sheet } = await open("cortex");
  app.fetch.on("POST /inject/event", { status: 202, json: { id: "5-0" } });
  fireEvent.change(within(sheet).getByRole("textbox", { name: "attention.focus data (JSON)" }), { target: { value: JSON.stringify({ id: "mine", reason: "t", score: 1 }) } });
  await userEvent.setup().click(within(sheet).getByRole("button", { name: "Send attention.focus" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/event").length, 1));
  await waitFor(() => assert.match(within(sheet).getByRole("status").textContent ?? "", /published/i));
  push(app, frame("brain.say", { id: "mine", text: "a", emotion: "neutral" }));
  push(app, frame("brain.say", { id: "else", text: "b", emotion: "neutral" }));
  const rows = within(feed()).getAllByRole("listitem");
  assert.equal(rows.length, 2);
  assert.ok(within(rows[0]!).queryByText("answers your injection") !== null);
  assert.ok(within(rows[1]!).queryByText("answers your injection") === null);
});

// @spec MOD-TEST-001, DASH-UI-030
test("event data in the live list is shown as text, truncated, and replayed events are not listed", async () => {
  const { app } = await open("salience");
  push(app, frame("brain.say", { id: "s", text: "<b>x</b>".padEnd(500, "y"), emotion: "happy" }));
  assert.ok(feed().querySelector("b") === null);
  assert.ok((within(feed()).getAllByRole("listitem")[0]!.textContent ?? "").length < 420);
  push(app, { ...frame("attention.focus", { reason: "old", score: 1 }), replay: true });
  assert.ok(!/old/.test(feed().textContent ?? ""));
});

// @spec MOD-TEST-001
test("the eyes unit's image form posts the chosen file raw to /inject/image at service level; with no file it says to choose one", async () => {
  const { app, sheet } = await open("eyes");
  app.fetch.on("POST /inject/image", { status: 202, json: { id: "img-1" } });
  const user = userEvent.setup();
  await user.click(within(sheet).getByRole("button", { name: "Send image" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /Choose an image first/);
  const file = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
  await user.upload(within(sheet).getByLabelText("Image, through the real pipeline"), file);
  await user.click(within(sheet).getByRole("button", { name: "Send image" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/image?level=service").length, 1));
  assert.equal(app.fetch.callsTo("POST /inject/image?level=service")[0]!.headers["content-type"], "image/png");
});

// @spec MOD-TEST-001
test("the ears unit's audio form posts to /inject/audio with the unit as target", async () => {
  const { app, sheet } = await open("ears");
  app.fetch.on("POST /inject/audio", { status: 202, json: { id: "aud-1" } });
  const user = userEvent.setup();
  await user.click(within(sheet).getByRole("button", { name: "Send audio" }));
  assert.match((await within(sheet).findByRole("alert")).textContent ?? "", /Choose an audio file first/);
  await user.upload(within(sheet).getByLabelText("Audio, through the real pipeline"), new File([new Uint8Array([1, 2])], "a.wav", { type: "audio/wav" }));
  await user.click(within(sheet).getByRole("button", { name: "Send audio" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /inject/audio?level=service&target=ears").length, 1));
});

// @spec MOD-TEST-001
test("the isolated start asks first, then posts the unit's start with isolated true; declining sends nothing", async () => {
  const { app, sheet } = await open("voice", ON);
  app.fetch.on("POST /services/voice/start", { json: { ok: true } });
  const user = userEvent.setup();
  await user.click(within(sheet).getByRole("button", { name: "Start voice isolated" }));
  const ask = screen.getByRole("dialog", { name: "Start voice isolated?" });
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  assert.equal(app.fetch.callsTo("POST /services/voice/start").length, 0);
  assert.ok(screen.getByRole("dialog", { name: "Test voice" }) !== null, "the sheet stays open");
  await user.click(within(sheet).getByRole("button", { name: "Start voice isolated" }));
  await user.click(within(screen.getByRole("dialog", { name: "Start voice isolated?" })).getByRole("button", { name: "Start voice isolated" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /services/voice/start").length, 1));
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /services/voice/start")[0]!.body!), { isolated: true });
  await waitFor(() => assert.match(within(screen.getByRole("dialog", { name: "Test voice" })).getByRole("status").textContent ?? "", /voice started isolated/));
});

// @spec MOD-TEST-001, DASH-UI-015
test("a refused isolated start is shown inside its dialog, which stays open; after Cancel the sheet's status line keeps it", async () => {
  const { app } = await open("voice", ON);
  app.fetch.on("POST /services/voice/start", { status: 409, json: { ok: false, detail: "busy: stack" } });
  const user = userEvent.setup();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start voice isolated" }));
  const ask = screen.getByRole("dialog", { name: "Start voice isolated?" });
  await user.click(within(ask).getByRole("button", { name: "Start voice isolated" }));
  assert.match((await within(screen.getByRole("dialog", { name: "Start voice isolated?" })).findByRole("alert")).textContent ?? "", /409 busy: stack/);
  await user.click(within(screen.getByRole("dialog", { name: "Start voice isolated?" })).getByRole("button", { name: "Cancel" }));
  assert.match(within(screen.getByRole("dialog", { name: "Test voice" })).getByRole("alert").textContent ?? "", /409 busy: stack/);
});

// @spec MOD-TEST-001, DASH-INJ-010
test("the Discord connector's row opens a sheet with an audio form that posts to /inject/audio with its own target, and its inject.result shows in the live list", async () => {
  const connector = { ...UNITS[0]!, id: "connector-discord", test: { inputs: ["audio"], observe: ["inject.result"] } };
  const m = await mountServices({ control: { enabled: false }, manifest: [...UNITS, connector], services: [...all(), svc("connector-discord")] });
  const user = userEvent.setup();
  await user.click(within(rowOf("connector-discord")).getByRole("button", { name: "Test connector-discord" }));
  const sheet = screen.getByRole("dialog", { name: "Test connector-discord" });
  assert.equal(within(sheet).getAllByRole("button", { name: "Send audio" }).length, 1);
  m.app.fetch.on("POST /inject/audio", { status: 202, json: { id: "req-9" } });
  await user.upload(within(sheet).getByLabelText("Audio, through the real pipeline"), new File([new Uint8Array([1, 2])], "a.wav", { type: "audio/wav" }));
  await user.click(within(sheet).getByRole("button", { name: "Send audio" }));
  await waitFor(() => assert.equal(m.app.fetch.callsTo("POST /inject/audio?level=service&target=connector-discord").length, 1));
  push(m.app, frame("inject.result", { id: "req-9", ok: true, detail: "played 3 frames" }));
  assert.match(feed().textContent ?? "", /played 3 frames/);
});

// @spec DASH-A11Y-005
test("a click on the backdrop of the test sheet does not close it or discard what was typed", async () => {
  const { sheet } = await open("voice");
  const user = userEvent.setup();
  const field = within(sheet).getAllByRole("textbox")[0] as HTMLTextAreaElement | HTMLInputElement;
  await user.type(field, "keep this");
  await user.click(sheet); // the dialog element itself is the backdrop area
  const still = screen.getByRole("dialog", { name: "Test voice" });
  assert.ok(still === sheet, "the sheet is still open");
  assert.match((within(still).getAllByRole("textbox")[0] as HTMLInputElement).value, /keep this$/);
});
