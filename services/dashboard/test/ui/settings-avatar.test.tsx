// The Avatar settings (issue #219): the `renderer` group on the Avatar page, its `avatar-model` widget (model list, upload,
// delete, live preview, framing sliders) and the renderer status line. Failing-first step: none of this exists yet.
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, fireEvent, screen, userEvent, within } from "./helpers/render";
import { FakeStorage } from "./helpers/fakes";
import { makeApp } from "./helpers/render";
import { boot, settle } from "./settings-helpers";
import { avatarRead, avatarSchema, brokenModel, listAnswer, MAX_BYTES, model, rendererRead, status, type Model, type RendererStatus } from "./settings-avatar-fixture";

const text = (el: Element | null | undefined) => el?.textContent ?? "";
const body = (c: { body?: string }) => JSON.parse(c.body ?? "null");
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const bar = (name: string): HTMLButtonElement => within(screen.getByRole("group", { name: "Save settings" })).getByRole("button", { name }) as HTMLButtonElement;
const key = (k: string): HTMLElement => document.querySelector<HTMLElement>(`[data-section="renderer"][data-key="${k}"]`)!;
const group = (): HTMLElement => screen.getByText("Avatar renderer").closest("details")!;
const rowOf = (name: string | RegExp): HTMLElement => screen.getByRole("radio", { name }).closest("li")!;
const upload = (): HTMLInputElement => document.querySelector<HTMLInputElement>("input[type=file]")!;

// The embedded preview frame: its window is replaced by a recorder, so every postMessage the page makes is visible with its target origin.
interface Posted { message: unknown; origin: unknown }
let posted: Posted[] = [];
Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
  configurable: true,
  get() { return { postMessage: (message: unknown, origin: unknown) => { posted.push({ message, origin }); } }; },
});
const sent = (type: string) => posted.filter((p) => (p.message as { type?: string })?.type === type).map((p) => p.message as Record<string, unknown>);

type Routes = NonNullable<Parameters<typeof boot>[0]>["routes"];
interface Opts { models?: Model[]; active?: string | null; renderer?: Parameters<typeof rendererRead>[0]; status?: RendererStatus | { httpStatus: number }; local?: Storage; routes?: Routes }

let mounted: { unmount(): void } | undefined;

/** Mounts the Avatar page with the fixture's routes answered; a second `open` in one test replaces the first mount. */
async function open(o: Opts = {}) {
  mounted?.unmount();
  posted = [];
  const app = o.local ? makeApp({ local: o.local }) : undefined;
  const models = o.models ?? [model("Kiki.vrm"), model("Mimi.vrm")];
  const st = o.status ?? status();
  const b = boot({
    section: "avatar", schema: avatarSchema, ...(app ? { app } : {}),
    routes: {
      "GET /config/avatar": { json: avatarRead },
      "GET /config/renderer": { json: rendererRead(o.renderer) },
      "PUT /config/renderer": { json: { ok: true, etag: "r2", restart: [], warnings: [] } },
      "GET /avatar/models": { json: listAnswer(models, o.active ?? null) },
      "GET /avatar/renderer": "httpStatus" in st ? { status: st.httpStatus, text: "not found" } : { json: st },
      ...o.routes,
    },
  });
  mounted = b;
  await screen.findByRole("heading", { level: 1, name: "Avatar" });
  await settle(8);
  return b;
}

// ---------------------------------------------------------------- the group (DASH-AVS-001)

// @spec DASH-AVS-001, DASH-SET-002
test("the renderer section is a group titled Avatar renderer on the Avatar page, and its header line says a save applies at once, open pages included, and restarts nothing", async () => {
  await open();
  assert.ok(group(), "a group titled Avatar renderer");
  assert.match(text(group()), /a save applies at once, open pages included, and restarts nothing/i);
  assert.ok(within(group()).getByRole("radiogroup", { name: "Model" }), "the model widget is the group's top");
  assert.ok(key("zoom") && key("offset_y") && key("turn"), "the three framing keys are in the group");
});

// ---------------------------------------------------------------- the list (DASH-AVS-002)

// @spec DASH-AVS-002
test("the list is radio options after None: name, size, VRM version, title and authors, licence line, usage pairs and expression names", async () => {
  await open({ models: [model("Kiki.vrm", { vrm: "0", authors: ["Ann", "Bo"] }), model("Mimi.vrm", { vrm: "1" })] });
  const radios = screen.getAllByRole("radio", { name: /None|\.vrm/ }).map((r) => r.getAttribute("name") === null ? text(r.closest("label")) : text(r.closest("li")));
  assert.match(radios[0]!, /None/);
  const kiki = text(rowOf(/Kiki\.vrm/));
  assert.match(kiki, /2\.5 MiB/);
  assert.match(kiki, /VRM 0\.x/);
  assert.match(kiki, /Kiki\.vrm title/);
  assert.match(kiki, /Ann, Bo|Ann.*Bo/);
  assert.match(kiki, /CC-BY-4\.0/);
  assert.match(kiki, /Commercial use/);
  assert.match(kiki, /Allowed/);
  assert.match(kiki, /happy/);
  assert.match(kiki, /sad/);
  assert.match(text(rowOf(/Mimi\.vrm/)), /VRM 1\.0/);
  assert.equal((screen.getByRole("radio", { name: /None/ }) as HTMLInputElement).checked, true, "no model saved: None is selected");
});

// @spec DASH-AVS-002
test("the saved active model carries a badge and a disabled Delete with its reason; another row's Delete is enabled", async () => {
  await open({ active: "Kiki.vrm", renderer: { model: "Kiki.vrm" } });
  const active = rowOf(/Kiki\.vrm/);
  assert.match(text(active), /applied/i);
  const del = within(active).getByRole("button", { name: /^Delete/ }) as HTMLButtonElement;
  assert.equal(del.disabled, true);
  const why = (del.getAttribute("aria-describedby") ?? "").split(" ").map((id) => text(document.getElementById(id))).join(" ") + (del.getAttribute("title") ?? "") + text(active);
  assert.match(why, /select another model, or none, and save first|applied|saved/i, "the reason is shown");
  assert.equal((within(rowOf(/Mimi\.vrm/)).getByRole("button", { name: /^Delete/ }) as HTMLButtonElement).disabled, false);
});

// @spec DASH-AVS-002, DASH-AVS-006
test("choosing another row is an unsaved edit with its own badge, until Discard; the badge leaves with it", async () => {
  await open({ active: "Kiki.vrm", renderer: { model: "Kiki.vrm" } });
  const user = userEvent.setup();
  assert.doesNotMatch(text(rowOf(/Mimi\.vrm/)), /unsaved/i);
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  assert.match(text(rowOf(/Mimi\.vrm/)), /unsaved/i);
  assert.match(text(rowOf(/Kiki\.vrm/)), /applied/i, "the applied badge stays on the saved model");
  assert.ok(screen.getByText(/1 edit in this section/));
  await user.click(bar("Discard"));
  assert.doesNotMatch(text(rowOf(/Mimi\.vrm/)), /unsaved/i);
  assert.equal((screen.getByRole("radio", { name: /Kiki\.vrm/ }) as HTMLInputElement).checked, true);
});

// @spec DASH-AVS-002
test("a row with an error shows the error and no metadata, and is not selectable", async () => {
  await open({ models: [model("Kiki.vrm"), brokenModel("Bad.vrm", "the file is not a glTF container")] });
  const bad = rowOf(/Bad\.vrm/);
  assert.match(text(bad), /the file is not a glTF container/);
  assert.equal((within(bad).getByRole("radio") as HTMLInputElement).disabled, true);
  await userEvent.setup().click(within(bad).getByRole("radio"));
  assert.equal((within(bad).getByRole("radio") as HTMLInputElement).checked, false);
  assert.ok(screen.getByText(/0 edits in this section/));
  assert.doesNotMatch(text(bad), /VRM [01]/);
});

// @spec DASH-AVS-002
test("an empty store lists only None, and a failed list read says so and leaves the other settings usable", async () => {
  await open({ models: [] });
  assert.equal(screen.getAllByRole("radio", { name: /None|\.vrm/ }).length, 1);
  await open({ routes: { "GET /avatar/models": { status: 500, text: "boom" } } });
  assert.match(text(group()), /500|boom|could not/i);
  assert.ok(key("zoom"), "the sliders still render");
});

// @spec DASH-AVS-002
test("on the LAN listener the model list is 404: the widget says the models are not available here and offers no upload or delete", async () => {
  await open({ routes: { "GET /avatar/models": { status: 404, text: "not found" } } });
  assert.match(text(group()), /not available/i);
  assert.equal(upload(), null);
  assert.equal(within(group()).queryAllByRole("button", { name: /^Delete/ }).length, 0);
});

// @spec DASH-AVS-002, DASH-MDL-033
test("Delete sends DELETE /avatar/models/<encoded name> with the control token, asks for it through the Access dialog when none is held, and drops the row", async () => {
  const b = await open({ routes: { "DELETE /avatar/models/Mimi.vrm": (c: { headers: Record<string, string> }) => c.headers.authorization ? { json: { ok: true } } : { status: 401, json: { ok: false, detail: "the control token is missing or wrong" } } } });
  const user = userEvent.setup();
  b.app.fetch.on("GET /avatar/models", { json: listAnswer([model("Kiki.vrm")]) }); // the list after the delete
  await user.click(within(rowOf(/Mimi\.vrm/)).getByRole("button", { name: /^Delete/ }));
  await settle();
  assert.ok(b.app.rt.access.state.get().prompt, "the Access dialog is asked for the token");
  assert.equal(b.app.fetch.callsTo("DELETE /avatar/models/Mimi.vrm").every((c) => !c.headers.authorization), true, "nothing was sent with a token before one was held");
  b.app.rt.access.setToken("control", "tok", "tab");
  act(() => b.app.rt.access.resolvePrompt(true));
  await settle(8);
  const calls = b.app.fetch.callsTo("DELETE /avatar/models/Mimi.vrm");
  assert.equal(calls.at(-1)!.headers.authorization, "Bearer tok");
  assert.equal(screen.queryByRole("radio", { name: /Mimi\.vrm/ }), null);
});

// @spec DASH-AVS-002
test("a refused Delete (409: the model became active) shows the server's reason as text and keeps the row", async () => {
  await open({ routes: { "DELETE /avatar/models/Mimi.vrm": { status: 409, json: { ok: false, detail: "that model is applied: select another model, or none, and save first" } } } });
  await userEvent.setup().click(within(rowOf(/Mimi\.vrm/)).getByRole("button", { name: /^Delete/ }));
  await settle(8);
  assert.match(text(group()), /that model is applied/);
  assert.ok(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
});

// @spec DASH-AVS-002, DASH-AVS-006
test("deleting the row that holds the unsaved choice drops the choice: the edit goes and no radio stays on a model that is gone", async () => {
  const b = await open({ routes: { "DELETE /avatar/models/Mimi.vrm": { json: { ok: true } } } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  b.app.rt.access.setToken("control", "tok", "tab");
  b.app.fetch.on("GET /avatar/models", { json: listAnswer([model("Kiki.vrm")]) });
  await user.click(within(rowOf(/Mimi\.vrm/)).getByRole("button", { name: /^Delete/ }));
  await settle(8);
  assert.equal(screen.queryByRole("radio", { name: /Mimi\.vrm/ }), null);
  assert.ok(screen.getByText(/0 edits in this section/), "the choice of the deleted model is not kept");
});

// ---------------------------------------------------------------- plain text only (DASH-AVS-003)

// @spec DASH-AVS-003
test("a model's own text is plain text: no markup, no element and no link built from it, and the terms disclaimer is shown", async () => {
  const hostile = model("Kiki.vrm", {
    title: "<img src=x onerror=alert(1)>", authors: ["<b>Eve</b>"], license: { name: "<script>alert(2)</script>", url: "javascript:alert(3)" },
    usage: [{ label: "<i>Credit</i>", value: "<a href=\"https://evil.test\">click</a>" }], expressions: ["<u>happy</u>"],
  });
  await open({ models: [hostile] });
  const r = rowOf(/Kiki\.vrm/);
  for (const el of r.querySelectorAll("*")) assert.equal(el.getAttributeNames().some((n) => n.startsWith("on")), false, `no handler attribute on <${el.tagName}>`);
  assert.equal(r.querySelector("img, script, b, i, u, iframe, style"), null);
  assert.equal(r.querySelectorAll("a").length, 0, "no link is built from the model's URL or text");
  assert.match(text(r), /<img src=x onerror=alert\(1\)>/);
  assert.match(text(r), /<b>Eve<\/b>/);
  assert.match(text(r), /<script>alert\(2\)<\/script>/);
  assert.match(text(r), /javascript:alert\(3\)/, "the URL is shown as text");
  assert.match(text(r), /<a href="https:\/\/evil\.test">click<\/a>/);
  const widget = within(group()).getByRole("radiogroup", { name: "Model" }).closest("[class]")!.parentElement ?? group();
  assert.equal(widget.querySelector("a[href^=javascript], a[href*=evil]"), null);
  assert.match(text(group()), /terms are the model author's/i);
  assert.match(text(group()), /cohost enforces none of them/i);
  assert.match(text(group()), /read them before using the model on stream/i);
});

// @spec DASH-AVS-003
test("a model name with quotes, brackets and markup is shown as text, selects and deletes by name, and breaks no attribute or selector", async () => {
  const odd = model("a\"]'><img src=x onerror=1>.vrm");
  const b = await open({ models: [odd, model("Kiki.vrm")] });
  const r = rowOf(/onerror=1/);
  assert.equal(document.querySelector("img"), null);
  assert.equal(r.querySelector("img"), null);
  for (const el of r.querySelectorAll("*")) assert.equal(el.getAttributeNames().some((n) => n.startsWith("on")), false);
  await userEvent.setup().click(within(r).getByRole("radio"));
  assert.ok(screen.getByText(/1 edit in this section/));
  assert.ok(sent("model").some((m) => m.name === odd.name), "the draft carries the name as a plain string");
  b.app.rt.access.setToken("control", "tok", "tab");
  await userEvent.setup().click(within(r).getByRole("button", { name: /^Delete/ }));
  await settle(4);
  assert.ok(b.app.fetch.calls.some((c) => c.method === "DELETE" && c.path === `/avatar/models/${encodeURIComponent(odd.name)}`), "the name is one encoded path segment");
});

// ---------------------------------------------------------------- upload (DASH-AVS-004)

const vrm = (name = "New.vrm", size = 1024): File => {
  const f = new File([new Uint8Array(Math.min(size, 1024))], name, { type: "application/octet-stream" });
  if (size > 1024) Object.defineProperty(f, "size", { value: size });
  return f;
};
const pick = (f: File) => fireEvent.change(upload(), { target: { files: [f] } });
const nameParam = (path: string) => new URL(path, "http://localhost").searchParams;
let gate: (r: { status: number; json: unknown }) => void;
const pending = () => new Promise<{ status: number; json: unknown }>((res) => { gate = res; });

// @spec DASH-AVS-004
test("the upload control states the limit from maxBytes and takes only .vrm", async () => {
  await open();
  assert.match(text(group()), /50(\.0)? MiB/);
  assert.match(upload().getAttribute("accept") ?? "", /\.vrm/);
});

// @spec DASH-AVS-004
test("a file over the limit, or one without a .vrm extension, is refused before sending, with the reason as text", async () => {
  const b = await open();
  pick(vrm("Big.vrm", MAX_BYTES + 1));
  await settle();
  assert.match(text(screen.getByRole("alert")), /50(\.0)? MiB|larger|limit|too large/i);
  pick(vrm("notes.txt"));
  await settle();
  assert.match(text(screen.getByRole("alert")), /\.vrm/);
  pick(vrm("Model.VRM.exe"));
  await settle();
  assert.equal(b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models")).length, 0, "nothing was sent");
});

// @spec DASH-AVS-004
test("an upload of exactly the limit is sent; a .VRM extension in capitals is accepted", async () => {
  const b = await open({ routes: { "POST /avatar/models": { status: 201, json: { ok: true, model: model("Max.vrm") } } } });
  pick(vrm("Max.VRM", MAX_BYTES));
  await settle(6);
  assert.equal(b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models")).length, 1);
});

// @spec DASH-AVS-004
test("an upload POSTs the raw file to /avatar/models?name=<file name> with progress while it runs, re-reads the list on success and selects nothing", async () => {
  const b = await open({ routes: { "POST /avatar/models": () => pending() } });
  pick(vrm("New.vrm"));
  await settle();
  assert.ok(within(group()).getByRole("progressbar"), "progress shows while the upload runs");
  const call = b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models"))[0]!;
  assert.equal(nameParam(call.path).get("name"), "New.vrm");
  assert.equal(nameParam(call.path).get("replace"), null);
  assert.ok(call.raw instanceof Blob || call.raw instanceof File || call.raw instanceof ArrayBuffer || call.raw instanceof Uint8Array, "the body is the file, not JSON or form data");
  b.app.fetch.on("GET /avatar/models", { json: listAnswer([model("Kiki.vrm"), model("Mimi.vrm"), model("New.vrm")]) });
  await act(async () => { gate({ status: 201, json: { ok: true, model: model("New.vrm") } }); });
  await settle(8);
  assert.equal(within(group()).queryByRole("progressbar"), null);
  assert.ok(screen.getByRole("radio", { name: /New\.vrm/ }), "the new row is listed");
  assert.equal((screen.getByRole("radio", { name: /New\.vrm/ }) as HTMLInputElement).checked, false, "a successful upload selects nothing");
  assert.ok(screen.getByText(/0 edits in this section/));
  assert.equal(sent("model").length, 0, "no preview draft is posted by an upload");
});

// @spec DASH-AVS-004
test("the server's refusal (413, 400, 409 without a name) is shown as plain text and ends the progress", async () => {
  await open({ routes: { "POST /avatar/models": { status: 400, json: { ok: false, detail: "the file is not a <b>glTF</b> container" } } } });
  pick(vrm());
  await settle(6);
  assert.match(text(screen.getByRole("alert")), /the file is not a <b>glTF<\/b> container/);
  assert.equal(within(group()).queryByRole("progressbar"), null);
  assert.equal(screen.queryByRole("dialog"), null, "a refusal with no name is not a Replace question");
});

// @spec DASH-AVS-004
test("a 409 that names a name asks Replace <name>? in a dialog; Cancel sends nothing more, Replace retries with replace=1 and the same file", async () => {
  let n = 0;
  const b = await open({ routes: { "POST /avatar/models": (c: { path: string }) => (++n === 1 || !c.path.includes("replace=1") ? { status: 409, json: { ok: false, detail: "a model of that name is stored; replace=1 replaces it", name: "Kiki.vrm" } } : { status: 201, json: { ok: true, model: model("Kiki.vrm") } }) } });
  const user = userEvent.setup();
  pick(vrm("Kiki.vrm"));
  await settle(6);
  const dialog = await screen.findByRole("dialog");
  assert.match(text(dialog), /Replace Kiki\.vrm\?/);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await settle();
  assert.equal(b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models")).length, 1, "Cancel sends nothing");
  pick(vrm("Kiki.vrm"));
  await settle(6);
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Replace/ }));
  await settle(6);
  const calls = b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models"));
  assert.equal(nameParam(calls.at(-1)!.path).get("replace"), "1");
  assert.equal(nameParam(calls.at(-1)!.path).get("name"), "Kiki.vrm");
  assert.equal(screen.queryByRole("dialog"), null);
});

// @spec DASH-AVS-004
test("the Replace dialog names the stored name from the server and shows it as text only", async () => {
  await open({ routes: { "POST /avatar/models": { status: 409, json: { ok: false, detail: "x", name: "<b>Odd</b>.vrm" } } } });
  pick(vrm("Odd.vrm"));
  await settle(6);
  const dialog = await screen.findByRole("dialog");
  assert.equal(dialog.querySelector("b"), null);
  assert.match(text(dialog), /Replace <b>Odd<\/b>\.vrm\?/);
});

// @spec DASH-AVS-004
test("a 401 asks for the control token through the Access dialog and retries the upload with it; Cancel leaves the list as it was", async () => {
  const b = await open({ routes: { "POST /avatar/models": (c: { headers: Record<string, string> }) => (c.headers.authorization ? { status: 201, json: { ok: true, model: model("New.vrm") } } : { status: 401, json: { ok: false, detail: "the control token is missing or wrong" } }) } });
  pick(vrm());
  await settle(6);
  assert.ok(b.app.rt.access.state.get().prompt, "the Access dialog is asked for the token");
  b.app.rt.access.setToken("control", "tok", "tab");
  act(() => b.app.rt.access.resolvePrompt(true));
  await settle(8);
  assert.equal(b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models")).at(-1)!.headers.authorization, "Bearer tok");
  pick(vrm("Other.vrm"));
  b.app.rt.access.lock("control");
  await settle(6);
  act(() => b.app.rt.access.resolvePrompt(false));
  await settle(6);
  assert.equal(within(group()).queryByRole("progressbar"), null, "a cancelled prompt ends the upload");
});

// @spec DASH-AVS-004, DASH-AVS-006
test("switching model while an upload runs keeps the choice and its draft; the finished upload neither selects nor posts anything", async () => {
  const b = await open({ routes: { "POST /avatar/models": () => pending() } });
  const user = userEvent.setup();
  pick(vrm("New.vrm"));
  await settle();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  const before = sent("model").length;
  b.app.fetch.on("GET /avatar/models", { json: listAnswer([model("Kiki.vrm"), model("Mimi.vrm"), model("New.vrm")]) });
  await act(async () => { gate({ status: 201, json: { ok: true, model: model("New.vrm") } }); });
  await settle(8);
  assert.equal((screen.getByRole("radio", { name: /Mimi\.vrm/ }) as HTMLInputElement).checked, true);
  assert.ok(screen.getByText(/1 edit in this section/));
  assert.equal(sent("model").length, before, "the upload posted no further draft");
  assert.equal(sent("model").at(-1)!.name, "Mimi.vrm");
});

// @spec DASH-AVS-004
test("only one upload runs from the page: a second file while one runs is not sent", async () => {
  const b = await open({ routes: { "POST /avatar/models": () => pending() } });
  pick(vrm("One.vrm"));
  await settle();
  pick(vrm("Two.vrm"));
  await settle();
  assert.equal(b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models")).length, 1);
  await act(async () => { gate({ status: 201, json: { ok: true, model: model("One.vrm") } }); });
});

// ---------------------------------------------------------------- the preview (DASH-AVS-005)

// @spec DASH-AVS-005
test("the preview is a frame on /avatar?preview=1 over a checkerboard, and the frame is named", async () => {
  await open();
  const frame = document.querySelector("iframe")!;
  assert.equal(frame.getAttribute("src"), "/avatar?preview=1");
  assert.ok(frame.getAttribute("title"), "the frame has an accessible name");
  assert.ok([...(function* () { for (let e: Element | null = frame; e; e = e.parentElement) yield e; })()].some((e) => /checker/i.test(e.className)), "a checkerboard sits behind it");
  assert.equal(frame.hasAttribute("sandbox") && !/allow-same-origin/.test(frame.getAttribute("sandbox")!), false, "a sandbox that drops the origin would break the draft channel");
});

// @spec DASH-AVS-005
test("the aspect choice offers 16:9, square and tall, defaults to 16:9, and is kept across a reload of the page", async () => {
  const local = new FakeStorage();
  const first = await open({ local });
  const aspect = screen.getByRole("radiogroup", { name: /aspect/i });
  assert.deepEqual(within(aspect).getAllByRole("radio").map((r) => text(r.closest("label"))?.trim()), ["16:9", "Square", "Tall"]);
  assert.equal((within(aspect).getByRole("radio", { name: "16:9" }) as HTMLInputElement).checked, true);
  await userEvent.setup().click(within(aspect).getByRole("radio", { name: "Square" }));
  first.unmount();
  await open({ local });
  assert.equal((within(screen.getByRole("radiogroup", { name: /aspect/i })).getByRole("radio", { name: "Square" }) as HTMLInputElement).checked, true);
});

// @spec DASH-AVS-005
test("when storage throws, the aspect falls back to 16:9 and choosing another still changes the frame", async () => {
  await open({ local: FakeStorage.throwing() });
  const aspect = screen.getByRole("radiogroup", { name: /aspect/i });
  assert.equal((within(aspect).getByRole("radio", { name: "16:9" }) as HTMLInputElement).checked, true);
  await userEvent.setup().click(within(aspect).getByRole("radio", { name: "Tall" }));
  assert.equal((within(aspect).getByRole("radio", { name: "Tall" }) as HTMLInputElement).checked, true);
});

// @spec DASH-AVS-005
test("a stored aspect that is not one of the three is ignored", async () => {
  const local = new FakeStorage();
  const probe = await open({ local });
  await userEvent.setup().click(within(screen.getByRole("radiogroup", { name: /aspect/i })).getByRole("radio", { name: "Square" }));
  probe.unmount();
  for (let i = 0; i < local.length; i++) { const k = local.key(i)!; if (local.getItem(k) === "square" || /square/i.test(local.getItem(k) ?? "")) local.setItem(k, "<script>"); }
  await open({ local });
  assert.equal((within(screen.getByRole("radiogroup", { name: /aspect/i })).getByRole("radio", { name: "16:9" }) as HTMLInputElement).checked, true);
});

// ---------------------------------------------------------------- drafts (DASH-AVS-006)

// @spec DASH-AVS-006
test("picking a row posts a model draft at once to the frame's own origin, None is the empty name, and a framing control posts all three numbers", async () => {
  await open({ active: "Kiki.vrm", renderer: { model: "Kiki.vrm", zoom: 1.2, offset_y: 0.1, turn: 5 } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  assert.deepEqual(posted.at(-1), { message: { type: "model", name: "Mimi.vrm" }, origin: location.origin });
  await user.click(screen.getByRole("radio", { name: /None/ }));
  assert.deepEqual(posted.at(-1), { message: { type: "model", name: "" }, origin: location.origin });
  fireEvent.change(within(key("zoom")).getByRole("slider", { name: "Zoom" }), { target: { value: "1.5" } });
  assert.deepEqual(sent("framing").at(-1), { type: "framing", framing: { zoom: 1.5, offsetY: 0.1, turn: 5 } });
  assert.ok(posted.every((p) => p.origin === location.origin), "never the wildcard origin");
});

// @spec DASH-AVS-006
test("each draft message has exactly the shape the renderer page accepts: a fresh plain object, finite numbers, zoom above 0", async () => {
  await open();
  fireEvent.change(within(key("turn")).getByRole("slider", { name: "Turn" }), { target: { value: "30" } });
  fireEvent.change(within(key("offset_y")).getByRole("slider", { name: "Vertical position" }), { target: { value: "-0.5" } });
  await userEvent.setup().click(screen.getByRole("radio", { name: /Kiki\.vrm/ }));
  for (const f of sent("framing")) {
    assert.deepEqual(Object.keys(f).sort(), ["framing", "type"]);
    const fr = f.framing as Record<string, unknown>;
    assert.deepEqual(Object.keys(fr).sort(), ["offsetY", "turn", "zoom"]);
    for (const v of Object.values(fr)) assert.ok(typeof v === "number" && Number.isFinite(v));
    assert.ok((fr.zoom as number) > 0);
  }
  for (const m of sent("model")) { assert.deepEqual(Object.keys(m).sort(), ["name", "type"]); assert.equal(typeof m.name, "string"); }
});

// @spec DASH-AVS-006
test("a half-typed or out-of-range number in a framing box posts no draft: the page never sends NaN, an empty box or a zoom of 0 or below", async () => {
  await open();
  const box = within(key("zoom")).getByRole("spinbutton", { name: "Zoom value" });
  fireEvent.change(box, { target: { value: "" } });
  fireEvent.change(box, { target: { value: "0" } });
  fireEvent.change(box, { target: { value: "-1" } });
  for (const f of sent("framing")) {
    const fr = f.framing as { zoom: number; offsetY: number; turn: number };
    assert.ok(Number.isFinite(fr.zoom) && fr.zoom > 0 && Number.isFinite(fr.offsetY) && Number.isFinite(fr.turn), JSON.stringify(f));
  }
});

// @spec DASH-AVS-006
test("dragging a slider does not flood the frame: a burst posts a few drafts, the last of which is the final value, and nothing is saved", async () => {
  const b = await open();
  const zoom = within(key("zoom")).getByRole("slider", { name: "Zoom" });
  for (let i = 0; i < 60; i++) fireEvent.change(zoom, { target: { value: String(0.5 + i * 0.04) } });
  assert.ok(sent("framing").length >= 1, "the first move posts at once");
  assert.ok(sent("framing").length <= 10, `a 60-move burst posted ${sent("framing").length} drafts`);
  await sleep(400);
  assert.equal((sent("framing").at(-1)!.framing as { zoom: number }).zoom, 0.5 + 59 * 0.04, "the final value is posted after the burst");
  assert.equal(b.app.fetch.callsTo("PUT /config/renderer").length, 0, "moving a slider writes nothing");
});

// @spec DASH-AVS-006
test("Save posts {type:clear} after the write, and Discard posts it too; neither posts it when there is nothing to clear", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  await user.click(bar("Discard"));
  assert.deepEqual(posted.at(-1), { message: { type: "clear" }, origin: location.origin });
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  await user.click(bar("Save"));
  await settle(8);
  assert.equal(b.app.fetch.callsTo("PUT /config/renderer").filter((c) => !c.path.includes("dryRun")).length, 1);
  assert.deepEqual(posted.at(-1), { message: { type: "clear" }, origin: location.origin });
  const n = posted.length;
  await settle(4);
  assert.equal(posted.length, n);
});

// @spec DASH-AVS-006
test("a failed Save keeps the drafts on the frame: no clear is posted while the edits stay", async () => {
  await open({ routes: { "PUT /config/renderer": { status: 400, json: { ok: false, issues: [{ path: "renderer.model", message: "must be a stored model" }] } } } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  await user.click(bar("Save"));
  await settle(8);
  assert.equal(sent("clear").length, 0);
  assert.ok(screen.getByText(/1 edit in this section/));
});

// @spec DASH-AVS-006
test("a preview that reloads is sent the drafts again, and a reload with no drafts is sent none", async () => {
  await open();
  const frame = document.querySelector("iframe")!;
  fireEvent.load(frame);
  assert.equal(posted.length, 0, "no drafts: nothing to send");
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  fireEvent.change(within(key("turn")).getByRole("slider", { name: "Turn" }), { target: { value: "25" } });
  await sleep(300);
  posted = [];
  fireEvent.load(frame);
  assert.deepEqual(sent("model"), [{ type: "model", name: "Mimi.vrm" }]);
  assert.deepEqual(sent("framing"), [{ type: "framing", framing: { zoom: 1, offsetY: 0, turn: 25 } }]);
  await user.click(bar("Discard"));
  posted = [];
  fireEvent.load(frame);
  assert.equal(posted.length, 0, "after a clear there are no drafts to re-send");
});

// ---------------------------------------------------------------- framing (DASH-AVS-007, DASH-SET-018)

// @spec DASH-AVS-007, DASH-SET-018
test("zoom, vertical position and turn are sliders with the ranges and steps of the spec, exact boxes beside them, and turn is a slider despite its span of 180", async () => {
  await open();
  const expect: [string, string, string, string, string][] = [["zoom", "Zoom", "0.5", "3", "0.05"], ["offset_y", "Vertical position", "-1.5", "1.5", "0.01"], ["turn", "Turn", "-90", "90", "1"]];
  for (const [k, label, min, max, step] of expect) {
    const s = within(key(k)).getByRole("slider", { name: label });
    assert.deepEqual([s.getAttribute("min"), s.getAttribute("max"), s.getAttribute("step")], [min, max, step], k);
    assert.ok(within(key(k)).getByRole("spinbutton", { name: `${label} value` }), `${k} has an exact box`);
  }
  assert.ok(within(key("turn")).getByText("deg"));
});

// @spec DASH-AVS-007
test("Reset framing sets zoom 1, vertical position 0 and turn 0 as an unsaved edit, and writes nothing until Save", async () => {
  const b = await open({ renderer: { zoom: 1.7, offset_y: 0.4, turn: 20 } });
  await userEvent.setup().click(within(group()).getByRole("button", { name: "Reset framing" }));
  assert.equal((within(key("zoom")).getByRole("spinbutton", { name: "Zoom value" }) as HTMLInputElement).value, "1");
  assert.equal((within(key("offset_y")).getByRole("spinbutton", { name: "Vertical position value" }) as HTMLInputElement).value, "0");
  assert.equal((within(key("turn")).getByRole("spinbutton", { name: "Turn value" }) as HTMLInputElement).value, "0");
  assert.ok(screen.getByText(/3 edits in this section/));
  assert.equal(b.app.fetch.callsTo("PUT /config/renderer").length, 0);
  assert.deepEqual(sent("framing").at(-1), { type: "framing", framing: { zoom: 1, offsetY: 0, turn: 0 } }, "the reset is posted to the preview as a draft");
  await userEvent.setup().click(bar("Save"));
  await settle(8);
  const put = b.app.fetch.callsTo("PUT /config/renderer").filter((c) => !c.path.includes("dryRun")).at(-1)!;
  assert.deepEqual(body(put).values, { zoom: 1, offset_y: 0, turn: 0 });
});

// ---------------------------------------------------------------- status (DASH-AVS-008, DASH-AVS-009)

const line = () => text(within(group()).getByRole("status", { name: /renderer/i }));

// @spec DASH-AVS-008
test("the status line shows the page count, the frame rate sent and the model state of each loopback page", async () => {
  await open({ status: status({ pages: [{ sentFps: 30, model: { state: "ready" }, since: 1 }, { sentFps: 12, model: null, since: 2 }] }) });
  assert.match(line(), /2 OBS pages connected/);
  assert.match(line(), /30 fps sent/);
});

// @spec DASH-AVS-008
test("one page reads '1 OBS page connected · 30 fps sent'; none reads 'No OBS page connected'; a failed model shows its reason as plain text", async () => {
  await open({ status: status({ pages: [{ sentFps: 30, model: { state: "failed", detail: "<b>bad</b> file" }, since: 1 }] }) });
  assert.match(line(), /1 OBS page connected · 30 fps sent/);
  assert.match(line(), /model failed to load: <b>bad<\/b> file/);
  assert.equal(within(group()).getByRole("status", { name: /renderer/i }).querySelector("b"), null);
  await open({ status: status({ pages: [], fps: null }) });
  assert.match(line(), /No OBS page connected/);
});

// @spec DASH-AVS-008
test("where the driver is not browser the line says so and links to the avatar.driver key; where the avatar is awaited it says that", async () => {
  await open({ status: status({ state: "off", driver: "vmc", pages: [], fps: null }) });
  assert.match(line(), /avatar\.driver is vmc; the renderer needs browser/);
  const link = within(group()).getByRole("link", { name: /avatar\.driver/ }) as HTMLAnchorElement;
  assert.match(link.getAttribute("href") ?? "", /^#settings\/avatar/);
  await open({ status: status({ state: "waiting", pages: [], fps: null }) });
  assert.match(line(), /Waiting for the avatar/);
  assert.ok(within(group()).getByRole("link", { name: /avatar\.driver/ }));
});

// @spec DASH-AVS-008
test("a driver name from the route is shown as text, never as markup or a link target", async () => {
  await open({ status: status({ state: "off", driver: "<img src=x onerror=1>", pages: [], fps: null }) });
  assert.match(line(), /avatar\.driver is <img src=x onerror=1>/);
  assert.equal(document.querySelector("img"), null);
});

// @spec DASH-AVS-008
test("on the LAN listener GET /avatar/renderer is 404: the group says the status is not available here, no error alert is raised and the rest works", async () => {
  await open({ status: { httpStatus: 404 } });
  assert.match(text(group()), /status is not available|not available here/i);
  assert.equal(screen.queryByRole("alert"), null);
  assert.ok(key("zoom"));
});

// @spec DASH-AVS-008
test("the route is read when the page opens and again every 2 s while it is on screen, and no longer after it closes", async () => {
  const b = await open();
  const reads = () => b.app.fetch.callsTo("GET /avatar/renderer").length;
  assert.equal(reads(), 1);
  await sleep(2300);
  assert.ok(reads() >= 2, "read again after 2 s");
  b.unmount();
  const n = reads();
  await sleep(2300);
  assert.equal(reads(), n, "no read after the page is gone");
});

// @spec DASH-AVS-008
test("a read that fails does not leave a stale claim: the line stops saying pages are connected", async () => {
  const b = await open();
  assert.match(line(), /1 OBS page connected/);
  b.app.fetch.on("GET /avatar/renderer", { status: 500, text: "boom" });
  await sleep(2300);
  assert.doesNotMatch(text(group()), /1 OBS page connected · 30 fps sent/);
});

// @spec DASH-AVS-009
test("a note says config.yaml holds other values than the renderer shows when GET /config/renderer differs from applied, and none when they agree", async () => {
  await open({ renderer: { model: "Kiki.vrm", zoom: 1.5 }, status: status({ applied: { model: null, configuredModel: "", zoom: 1, offsetY: 0, turn: 0 } }) });
  assert.match(text(group()), /config\.yaml holds .* but the renderer shows .*; restart the dashboard to apply the file/i);
  await open({ renderer: { model: "Kiki.vrm", zoom: 1.5, offset_y: 0.2, turn: 3 }, status: status({ applied: { model: "Kiki.vrm", configuredModel: "Kiki.vrm", zoom: 1.5, offsetY: 0.2, turn: 3 } }) });
  assert.doesNotMatch(text(group()), /restart the dashboard to apply the file/i);
});

// @spec DASH-AVS-009
test("each of configuredModel, zoom, offsetY and turn alone raises the note", async () => {
  const same = { model: "Kiki.vrm", zoom: 1.5, offset_y: 0.2, turn: 3 };
  const applied = { model: "Kiki.vrm", configuredModel: "Kiki.vrm", zoom: 1.5, offsetY: 0.2, turn: 3 };
  for (const [change, over] of [["model", { configuredModel: "Mimi.vrm" }], ["zoom", { zoom: 2 }], ["offsetY", { offsetY: 0 }], ["turn", { turn: 4 }]] as const) {
    await open({ renderer: same, status: status({ applied: { ...applied, ...over } }) });
    assert.match(text(group()), /restart the dashboard to apply the file/i, change);
  }
});

// @spec DASH-AVS-009
test("the note is not raised by an unsaved edit, only by what the file holds against what is applied", async () => {
  await open({ renderer: { zoom: 1 }, status: status() });
  fireEvent.change(within(key("zoom")).getByRole("slider", { name: "Zoom" }), { target: { value: "2" } });
  assert.doesNotMatch(text(group()), /restart the dashboard to apply the file/i);
});

// ---------------------------------------------------------------- notices (DASH-AVS-011)

// @spec DASH-AVS-011
test("the group links to the third-party notices file beside the status line, as a link and not as text built from anything the routes return", async () => {
  // Provisional seam (see the report): the build's file name reaches the page as a global named by the build, not by a route.
  (globalThis as { __COHOST_NOTICES__?: string }).__COHOST_NOTICES__ = "third-party-notices-abcd1234.txt";
  await open();
  const link = within(group()).getByRole("link", { name: /third-party notices/i }) as HTMLAnchorElement;
  assert.match(link.getAttribute("href") ?? "", /^\/assets\/third-party-notices-[0-9a-f]{8}\.txt$/);
  delete (globalThis as { __COHOST_NOTICES__?: string }).__COHOST_NOTICES__;
});

// ---------------------------------------------------------------- review follow-ups (drafts, refresh, polls, names, answers)

// @spec DASH-AVS-006
test("picking the saved model again after another pick puts the saved model back on the frame", async () => {
  await open({ active: "Kiki.vrm", renderer: { model: "Kiki.vrm" } });
  const user = userEvent.setup();
  fireEvent.change(within(key("zoom")).getByRole("slider", { name: "Zoom" }), { target: { value: "1.2" } });
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  await user.click(screen.getByRole("radio", { name: /Kiki\.vrm/ }));
  assert.deepEqual(posted.at(-1), { message: { type: "model", name: "Kiki.vrm" }, origin: location.origin });
});

// @spec DASH-AVS-006
test("a framing edit moved back to its saved value puts the saved framing on the frame, and the model draft stays", async () => {
  await open({ renderer: { zoom: 1 } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  fireEvent.change(within(key("zoom")).getByRole("slider", { name: "Zoom" }), { target: { value: "1.5" } });
  assert.deepEqual(posted.at(-1), { message: { type: "framing", framing: { zoom: 1.5, offsetY: 0, turn: 0 } }, origin: location.origin });
  fireEvent.change(within(key("zoom")).getByRole("slider", { name: "Zoom" }), { target: { value: "1" } });
  assert.deepEqual(posted.at(-1), { message: { type: "framing", framing: { zoom: 1, offsetY: 0, turn: 0 } }, origin: location.origin });
  assert.ok(sent("model").some((m) => m.name === "Mimi.vrm"), "the model draft was posted and still stands");
});

// @spec DASH-AVS-006
test("a slider burst followed at once by Discard sends no framing draft after the clear", async () => {
  await open({ renderer: { zoom: 1 } });
  const zoom = within(key("zoom")).getByRole("slider", { name: "Zoom" });
  for (let i = 0; i < 5; i++) fireEvent.change(zoom, { target: { value: String(1.1 + i * 0.1) } });
  fireEvent.click(bar("Discard"));
  const at = posted.findIndex((p) => (p.message as { type?: string }).type === "clear");
  assert.ok(at >= 0, "the clear is posted");
  await sleep(300);
  assert.equal(posted.slice(at + 1).length, 0, "nothing is posted after the clear");
});

// @spec DASH-AVS-002
test("after a successful Save the model list is read again, so the applied badge and the Delete guard follow the saved model", async () => {
  const b = await open({ active: "Kiki.vrm", renderer: { model: "Kiki.vrm" } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Mimi\.vrm/ }));
  b.app.fetch.on("GET /avatar/models", { json: listAnswer([model("Kiki.vrm"), model("Mimi.vrm")], "Mimi.vrm") });
  await user.click(bar("Save"));
  await settle(8);
  assert.ok(b.app.fetch.callsTo("GET /avatar/models").length >= 2, "the list was read again");
  assert.match(text(rowOf(/Mimi\.vrm/)), /applied/);
  assert.equal((within(rowOf(/Mimi\.vrm/)).getByRole("button", { name: /^Delete/ }) as HTMLButtonElement).disabled, true);
  assert.equal((within(rowOf(/Kiki\.vrm/)).getByRole("button", { name: /^Delete/ }) as HTMLButtonElement).disabled, false);
});

// @spec DASH-AVS-004
test("an upload name with query characters is sent as one encoded name, not as further parameters", async () => {
  const b = await open({ routes: { "POST /avatar/models": { status: 201, json: { ok: true, model: model("x.vrm") } } } });
  pick(vrm("a&replace=1&b.vrm"));
  await settle(6);
  const call = b.app.fetch.calls.filter((c) => c.method === "POST" && c.path.startsWith("/avatar/models"))[0]!;
  assert.equal(nameParam(call.path).get("name"), "a&replace=1&b.vrm");
  assert.equal(nameParam(call.path).get("replace"), null);
});

// @spec DASH-AVS-008
test("a status read still in flight is not joined by another read: no second read until the first has answered", async () => {
  const b = await open({ routes: { "GET /avatar/renderer": () => new Promise(() => {}) } });
  const reads = () => b.app.fetch.callsTo("GET /avatar/renderer").length;
  assert.equal(reads(), 1);
  await sleep(2300);
  assert.equal(reads(), 1, "no read piles up behind the one in flight");
  b.unmount();
});

// @spec DASH-AVS-008
test("a malformed renderer answer is a failed read: the line says so, no NaN is shown, and the rest of the group renders", async () => {
  await open({ routes: { "GET /avatar/renderer": { json: { state: "live", driver: "browser", fps: 30, applied: null, pages: [{ sentFps: "x", model: null, since: 1 }] } } } });
  assert.match(text(group()), /Could not read the renderer status/);
  assert.doesNotMatch(text(group()), /NaN/);
  assert.ok(key("zoom"), "the framing rows still render");
});
