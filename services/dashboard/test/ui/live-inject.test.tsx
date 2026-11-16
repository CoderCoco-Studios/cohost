import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, userEvent, act, within, waitFor, type TestApp } from "./helpers/render";
import { FakeClock } from "./helpers/fakes";
import { Screen } from "../../ui/src/screens/live";
import { TestInputs } from "../../ui/src/screens/live/TestInputs";

const MIB = 1024 * 1024;
const LIMITS = { json: { section: "dashboard", etag: "e", keys: { "inject.max_image_bytes": { editable: true, source: "default", value: 2 * MIB }, "inject.max_audio_bytes": { editable: true, source: "literal", value: 5 * MIB } }, unknown: [] } };

interface Opts { limits?: boolean | "fail"; text?: unknown; upload?: unknown; open?: boolean }
function boot(opts: Opts = {}, ui?: (clock: FakeClock) => React.ReactElement) {
  location.hash = "";
  const app = makeApp();
  if (opts.limits === "fail") app.fetch.on("GET /config/dashboard", { status: 500, text: "boom" });
  else if (opts.limits !== false) app.fetch.on("GET /config/dashboard", LIMITS);
  app.fetch.on("POST /inject/text", (opts.text as never) ?? { status: 202, json: { id: "r1" } });
  for (const k of ["image", "audio"]) app.fetch.on(`POST /inject/${k}`, (opts.upload as never) ?? { status: 202, json: { id: "r1" } });
  const r = renderApp(ui ? ui(app.clock) : <Screen route={{ view: "live" }} />, app);
  if (opts.open !== false) act(() => { app.socket().open(); });
  return Object.assign(r, { app });
}
const card = () => screen.getByRole("region", { name: "Test inputs" });
const kind = (name: string) => userEvent.setup().click(within(card()).getByRole("radio", { name }));
const send = () => within(card()).getByRole("button", { name: "Send" });
const status = () => within(card()).getByRole("status");
const alertText = () => within(card()).getByRole("alert").textContent!;
const result = (app: TestApp, data: Record<string, unknown>) => act(() => { app.socket().message({ id: `i${Math.random()}`, type: "inject.result", ts: 1, source: "chat", data }); });
const file = (name: string, type: string, size?: number) => { const f = new File(["x"], name, { type }); if (size !== undefined) Object.defineProperty(f, "size", { value: size }); return f; };
const bodyOf = (app: TestApp, key: string) => JSON.parse(app.fetch.callsTo(key)[0]!.body!) as Record<string, unknown>;

// @spec DASH-UI-009
test("the panel starts on Text with the viewer fields, remember off, one Send, one status line and the note that tests are treated as real", async () => {
  boot();
  assert.deepEqual(within(within(card()).getByRole("group", { name: "Input kind" })).getAllByRole("radio").map((r) => r.closest("label")!.textContent), ["Text", "Image", "Audio"]);
  assert.equal((within(card()).getByRole("radio", { name: "Text" }) as HTMLInputElement).checked, true);
  within(card()).getByRole("textbox", { name: "Message" });
  within(card()).getByRole("textbox", { name: "Viewer name" });
  const platform = within(card()).getByRole("combobox", { name: "Platform" }) as HTMLSelectElement;
  assert.deepEqual([...platform.options].map((o) => o.value), ["twitch", "youtube", "discord"]);
  assert.equal(platform.value, "twitch");
  for (const name of ["Moderator", "Subscriber", "Store in memory"]) assert.equal((within(card()).getByRole("switch", { name }) as HTMLInputElement).checked, false, name);
  assert.equal(within(card()).getAllByRole("button", { name: /^Send/ }).length, 1);
  assert.equal(status().tagName, "OUTPUT");
  assert.match(card().textContent!, /The co-host treats test inputs as real and may answer them aloud\./);
  const adv = card().querySelector("details")!;
  assert.equal(adv.open, false);
  assert.equal(adv.querySelector("summary")!.textContent, "Advanced: skip perception and publish straight to the bus");
});

// @spec DASH-UI-009
test("Image shows a PNG, JPEG and WebP picker only; Audio shows an audio picker and the viewer name", async () => {
  boot();
  await kind("Image");
  const img = within(card()).getByLabelText("Image file") as HTMLInputElement;
  assert.equal(img.type, "file");
  assert.equal(img.accept, "image/png,image/jpeg,image/webp");
  assert.ok(within(card()).queryByRole("textbox", { name: "Message" }) === null);
  assert.ok(within(card()).queryByRole("textbox", { name: "Viewer name" }) === null);
  assert.ok(within(card()).getByRole("switch", { name: "Store in memory" }), "every kind has remember");
  await kind("Audio");
  assert.equal((within(card()).getByLabelText("Audio file") as HTMLInputElement).accept, "audio/*");
  within(card()).getByRole("textbox", { name: "Viewer name" });
  assert.ok(within(card()).queryByLabelText("Image file") === null);
  assert.equal(within(card()).getAllByRole("button", { name: /^Send/ }).length, 1);
});

// @spec DASH-UI-009
test("a microphone record button is offered only where MediaRecorder and getUserMedia exist", async () => {
  const first = boot();
  await kind("Audio");
  assert.ok(within(card()).queryByRole("button", { name: /Record/ }) === null);
  first.unmount();
  const g = globalThis as unknown as { MediaRecorder?: unknown };
  const nav = navigator as unknown as { mediaDevices?: unknown };
  g.MediaRecorder = class {};
  Object.defineProperty(nav, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  try {
    const second = boot();
    await kind("Audio");
    within(card()).getByRole("button", { name: "Record from microphone" });
    second.unmount();
  } finally { delete g.MediaRecorder; Object.defineProperty(nav, "mediaDevices", { configurable: true, value: undefined }); }
});

// @spec DASH-UI-009, DASH-UI-010, DASH-UI-015
test("a service-level text injection posts the viewer fields, then waits for the inject.result of its id and shows it", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "hello cohost");
  await user.type(within(card()).getByRole("textbox", { name: "Viewer name" }), "ann");
  await user.selectOptions(within(card()).getByRole("combobox", { name: "Platform" }), "youtube");
  await user.click(within(card()).getByRole("switch", { name: "Moderator" }));
  await user.click(within(card()).getByRole("switch", { name: "Store in memory" }));
  await user.click(send());
  await waitFor(() => assert.equal(status().textContent, "sent to chat, waiting for result…"));
  assert.deepEqual(bodyOf(app, "POST /inject/text"), { level: "service", text: "hello cohost", remember: true, user: "ann", platform: "youtube", isMod: true, isSub: false });
  assert.equal(app.fetch.callsTo("POST /inject/text")[0]!.headers.authorization, undefined, "no token held, none sent");
  result(app, { id: "other", ok: false, detail: "not mine" });
  assert.equal(status().textContent, "sent to chat, waiting for result…", "a result for another id is ignored");
  result(app, { id: "r1", ok: true, detail: "queued" });
  assert.equal(status().textContent, "ok: queued");
});

// @spec DASH-UI-010
test("a result that arrives before the HTTP response is shown when the response arrives", async () => {
  const user = userEvent.setup();
  let release!: () => void;
  const { app } = boot({ text: () => new Promise((r) => { release = () => r({ status: 202, json: { id: "r2" } }); }) });
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "hi");
  await user.click(send());
  await waitFor(() => assert.ok(release));
  result(app, { id: "r2", ok: true, detail: "early" });
  await act(async () => { release(); });
  await waitFor(() => assert.equal(status().textContent, "ok: early"));
});

// @spec DASH-UI-010, DASH-UI-015
test("a failed inject.result is an alert with the service's detail", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "hi");
  await user.click(send());
  await waitFor(() => assert.match(status().textContent!, /waiting for result/));
  result(app, { id: "r1", ok: false, detail: "refused" });
  assert.equal(alertText().replace("Dismiss", ""), "failed: refused");
  await user.click(within(card()).getByRole("button", { name: "Dismiss" }));
  assert.ok(within(card()).queryByRole("alert") === null);
});

function withTimers(clock: FakeClock) { return <TestInputs timers={{ set: clock.setTimeout, clear: clock.clearTimeout }} />; }

// @spec DASH-UI-010
test("with no inject.result within 10 s the target is reported as not responding, and the timer is cleared on a result and on unmount", async () => {
  const user = userEvent.setup();
  const { app, unmount } = boot({}, withTimers);
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "hi");
  await user.click(send());
  await waitFor(() => assert.match(status().textContent!, /waiting for result/));
  assert.equal(app.clock.pending, 1, "one 10 s timer is armed");
  act(() => app.clock.tick(9_999));
  assert.ok(within(card()).queryByRole("alert") === null);
  act(() => app.clock.tick(1));
  assert.match(alertText(), /no response from chat after 10 s \(is it running\?\)/);

  await user.click(within(card()).getByRole("button", { name: "Dismiss" }));
  await user.click(send());
  await waitFor(() => assert.equal(app.clock.pending, 1));
  result(app, { id: "r1", ok: true });
  assert.equal(app.clock.pending, 0, "a result clears the timer");
  app.fetch.on("POST /inject/text", { status: 202, json: { id: "r3" } });
  await user.click(send());
  await waitFor(() => assert.equal(app.clock.pending, 1));
  unmount();
  assert.equal(app.clock.pending, 0, "unmounting clears the timer");
});

// @spec DASH-UI-009, DASH-UI-010
test("Advanced: Bus only limits the kind to Text, offers chat, speech and vision, says image and audio need the real pipeline, and reports no result expected", async () => {
  const user = userEvent.setup();
  const { app } = boot({ text: { status: 202, json: { id: "b1" } } }, withTimers);
  await user.click(within(card()).getByText(/^Advanced:/));
  assert.equal((within(card()).getByRole("radio", { name: "Real pipeline" }) as HTMLInputElement).checked, true);
  await kind("Image");
  await user.click(within(card()).getByRole("radio", { name: "Bus only" }));
  assert.deepEqual(within(card()).getAllByRole("radio", { name: /^(Text|Image|Audio)$/ }).map((r) => r.closest("label")!.textContent), ["Text"]);
  assert.ok(within(card()).getByRole("textbox", { name: "Message" }), "back on Text");
  assert.match(card().textContent!, /Image and audio need the real pipeline/);
  assert.deepEqual(within(card()).getAllByRole("radio", { name: /^(Chat|Speech|Vision)$/ }).map((r) => r.closest("label")!.textContent), ["Chat", "Speech", "Vision"]);
  await user.click(within(card()).getByRole("radio", { name: "Speech" }));
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "I heard that");
  await user.type(within(card()).getByRole("textbox", { name: "Viewer name" }), "ann");
  assert.ok(within(card()).queryByRole("combobox", { name: "Platform" }) === null, "platform is for chat");
  await user.click(send());
  await waitFor(() => assert.equal(status().textContent, "published at bus level (no service result)"));
  assert.deepEqual(bodyOf(app, "POST /inject/text"), { level: "bus", as: "speech", text: "I heard that", remember: false, user: "ann" });
  assert.equal(app.clock.pending, 0, "no timeout for a bus-level injection");
  await user.click(within(card()).getByRole("radio", { name: "Vision" }));
  assert.ok(within(card()).queryByRole("textbox", { name: "Viewer name" }) === null);
  await user.click(within(card()).getByRole("radio", { name: "Real pipeline" }));
  assert.equal(within(card()).getAllByRole("radio", { name: /^(Text|Image|Audio)$/ }).length, 3);
});

// @spec DASH-UI-009
test("sending with no message asks for one and sends nothing", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await user.click(send());
  assert.match(alertText(), /Type a message first/);
  assert.equal(app.fetch.callsTo("POST /inject/text").length, 0);
});

// @spec DASH-UI-015
test("a refused text injection is an alert with the status and detail", async () => {
  const user = userEvent.setup();
  boot({ text: { status: 400, json: { detail: "bad <b>level</b>" } } });
  await user.type(within(card()).getByRole("textbox", { name: "Message" }), "hi");
  await user.click(send());
  await waitFor(() => assert.match(alertText(), /400 bad <b>level<\/b>/));
  assert.ok(card().querySelector("b") === null, "the detail is text");
});

// @spec DASH-UI-009, DASH-UI-010
test("an image is posted raw with its content type, level=service and remember in the query, and waits for eyes", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await kind("Image");
  await user.click(send());
  assert.match(alertText(), /Choose an image file first/);
  assert.equal(app.fetch.callsTo("POST /inject/image").length, 0);
  await user.click(within(card()).getByRole("button", { name: "Dismiss" }));
  const png = file("a.png", "image/png");
  await user.upload(within(card()).getByLabelText("Image file"), png);
  await user.click(within(card()).getByRole("switch", { name: "Store in memory" }));
  await user.click(send());
  await waitFor(() => assert.equal(status().textContent, "sent to eyes, waiting for result…"));
  const call = app.fetch.callsTo("POST /inject/image?level=service&remember=1")[0]!;
  assert.equal(call.headers["content-type"], "image/png");
  assert.ok(call.raw instanceof Blob, "the file is the body");
  result(app, { id: "r1", ok: true, detail: "a cat" });
  assert.equal(status().textContent, "ok: a cat");
});

// @spec DASH-UI-009
test("an audio file is posted with the viewer name and waits for ears", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await kind("Audio");
  await user.type(within(card()).getByRole("textbox", { name: "Viewer name" }), "ann bo");
  await user.upload(within(card()).getByLabelText("Audio file"), file("a.wav", "audio/wav"));
  await user.click(send());
  await waitFor(() => assert.equal(status().textContent, "sent to ears, waiting for result…"));
  const call = app.fetch.calls.find((c) => c.path.startsWith("/inject/audio"))!;
  assert.equal(call.path, "/inject/audio?level=service&remember=0&user=ann+bo");
  assert.equal(call.headers["content-type"], "audio/wav");
});

// @spec DASH-UI-034
test("each picker states its size limit in MiB from GET /config/dashboard", async () => {
  const { app } = boot();
  assert.equal(app.fetch.callsTo("GET /config/dashboard").length, 1);
  await waitFor(async () => { await kind("Image"); assert.match(card().textContent!, /PNG, JPEG or WebP\. Limit: 2 MiB\./); });
  await kind("Audio");
  assert.match(card().textContent!, /Limit: 5 MiB\./);
});

// @spec DASH-UI-034
test("when the limits cannot be read the pickers show the defaults, 8 MiB and 25 MiB", async () => {
  const { app } = boot({ limits: "fail" });
  await waitFor(() => assert.equal(app.fetch.callsTo("GET /config/dashboard").length, 1));
  await kind("Image");
  assert.match(card().textContent!, /Limit: 8 MiB\./);
  await kind("Audio");
  assert.match(card().textContent!, /Limit: 25 MiB\./);
});

// @spec DASH-UI-034
test("a file larger than the limit is refused beside the picker before any request, and a smaller one is accepted", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await waitFor(() => assert.equal(app.fetch.callsTo("GET /config/dashboard").length, 1));
  await new Promise((r) => setTimeout(r, 0));
  await kind("Image");
  const picker = within(card()).getByLabelText("Image file");
  await user.upload(picker, file("big.png", "image/png", 3 * MIB));
  const msg = document.getElementById(picker.getAttribute("aria-describedby")!.split(" ").pop()!)!;
  assert.match(msg.textContent!, /big\.png is 3 MiB; the limit is 2 MiB\./);
  assert.equal(picker.getAttribute("aria-invalid"), "true");
  await user.click(send());
  assert.equal(app.fetch.calls.filter((c) => c.path.startsWith("/inject/")).length, 0, "nothing was sent");
  await user.upload(picker, file("ok.png", "image/png", 1 * MIB));
  assert.equal(picker.getAttribute("aria-invalid"), null);
  await user.click(send());
  await waitFor(() => assert.equal(app.fetch.calls.filter((c) => c.path.startsWith("/inject/image")).length, 1));
});

// @spec DASH-UI-034, DASH-UI-015
test("a file the server refuses with 413 or 415 shows the server's detail with its status", async () => {
  const user = userEvent.setup();
  const { app } = boot({ upload: { status: 415, json: { detail: "unsupported media type" } } });
  await kind("Image");
  await user.upload(within(card()).getByLabelText("Image file"), file("a.png", "image/png"));
  await user.click(send());
  await waitFor(() => assert.match(alertText(), /415 unsupported media type/));
  app.fetch.on("POST /inject/image", { status: 413, text: "too large" });
  await user.click(within(card()).getByRole("button", { name: "Dismiss" }));
  await user.click(send());
  await waitFor(() => assert.match(alertText(), /413 too large/));
});

class FakeRecorder {
  static last: FakeRecorder | undefined;
  mimeType = "audio/webm;codecs=opus";
  stopped = false;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) { FakeRecorder.last = this; }
  start() { /* recording */ }
  stop() { this.stopped = true; this.ondataavailable?.({ data: new Blob(["a"], { type: "audio/webm" }) }); this.onstop?.(); }
}
async function withMicrophone(run: (tracks: { stopped: number }) => Promise<void>, getUserMedia?: () => Promise<unknown>) {
  const g = globalThis as unknown as { MediaRecorder?: unknown };
  const nav = navigator as unknown as { mediaDevices?: unknown };
  const tracks = { stopped: 0 };
  g.MediaRecorder = FakeRecorder;
  Object.defineProperty(nav, "mediaDevices", { configurable: true, value: { getUserMedia: getUserMedia ?? (async () => ({ getTracks: () => [{ stop: () => { tracks.stopped++; } }] })) } });
  try { await run(tracks); } finally { delete g.MediaRecorder; FakeRecorder.last = undefined; Object.defineProperty(nav, "mediaDevices", { configurable: true, value: undefined }); }
}

// @spec DASH-UI-009
test("recording from the microphone stops on the second press, releases the microphone and sends the clip as audio", async () => {
  await withMicrophone(async (tracks) => {
    const user = userEvent.setup();
    const { app } = boot();
    await kind("Audio");
    await user.click(within(card()).getByRole("button", { name: "Record from microphone" }));
    await within(card()).findByRole("button", { name: "Stop and send" });
    assert.ok(FakeRecorder.last);
    await user.click(within(card()).getByRole("button", { name: "Stop and send" }));
    await waitFor(() => assert.equal(app.fetch.calls.filter((c) => c.path.startsWith("/inject/audio")).length, 1));
    assert.equal(tracks.stopped, 1, "the microphone is released");
    assert.equal(app.fetch.calls.find((c) => c.path.startsWith("/inject/audio"))!.headers["content-type"], "audio/webm");
    within(card()).getByRole("button", { name: "Record from microphone" });
  });
});

// @spec DASH-UI-009
test("a refused microphone is reported and unmounting while recording releases it without sending", async () => {
  await withMicrophone(async () => {
    const user = userEvent.setup();
    const first = boot();
    await kind("Audio");
    await user.click(within(card()).getByRole("button", { name: "Record from microphone" }));
    assert.match((await within(card()).findByRole("alert")).textContent!, /Microphone unavailable: denied/);
    first.unmount();
  }, async () => { throw new Error("denied"); });
  await withMicrophone(async (tracks) => {
    const user = userEvent.setup();
    const { app, unmount } = boot();
    await kind("Audio");
    await user.click(within(card()).getByRole("button", { name: "Record from microphone" }));
    await within(card()).findByRole("button", { name: "Stop and send" });
    unmount();
    assert.equal(tracks.stopped, 1);
    assert.equal(app.fetch.calls.filter((c) => c.path.startsWith("/inject/audio")).length, 0);
  });
});

// @spec DASH-A11Y-003
test("every control in the panel has an accessible name", async () => {
  boot();
  for (const k of ["Text", "Image", "Audio"]) {
    await kind(k);
    for (const el of card().querySelectorAll("input, select, textarea, button")) {
      const name = el.closest("label")?.textContent || el.getAttribute("aria-label") || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.getAttribute("aria-labelledby") || (el.tagName === "BUTTON" ? el.textContent : "");
      assert.ok(name, `${k}: an unnamed ${el.tagName.toLowerCase()}`);
    }
  }
});
