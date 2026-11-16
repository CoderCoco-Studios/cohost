import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, renderApp, makeApp, screen, userEvent, within, waitFor, type TestApp } from "./helpers/render";
import { Screen } from "../../ui/src/screens/viewers";
import { AccessDialog } from "../../ui/src/app/AccessDialog";
import type { FakeFetch } from "./helpers/fakes";

type Plain = { status?: number; json?: unknown; text?: string };
type Call = FakeFetch["calls"][number];

const LIST = {
  viewers: [
    { key: "1", display: "Alice", regular: true, regularManual: true, msgCount: 12, noteCount: 2 },
    { key: "2", display: "Bob <b>", regular: true, regularManual: false, msgCount: 40, noteCount: 0 },
    { key: "3", display: "Cy", regular: false, regularManual: false, msgCount: 1, noteCount: 0 },
  ],
};
const note = (id: string, layer: "core" | "recent", text: string, strength: number, category = "general") => ({ id, layer, category, text, hint: null, strength });
const DETAIL = {
  viewer: LIST.viewers[0],
  core: [note("5", "core", "has a <i>sister</i>", 0.8, "family")],
  recent: [note("6", "recent", "playing chess", 0.25)],
  deletions: [
    { id: "9", layer: "recent", category: "general", text: "hates mondays", reason: "off topic", deletedAt: 1 },
    { id: "10", layer: "recent", category: "health", text: "has a cold", reason: null, deletedAt: 2 },
  ],
};
const CONFIG = {
  section: "brain.memory", etag: "e",
  keys: {
    "notes.recent_half_life_days": { value: 7 }, "notes.core_half_life_days": { value: 60 }, "notes.promote_mentions": { value: 3 },
    "notes.max_notes_per_viewer": { value: 5 }, "notes.drop_below": { value: 0.1 }, "notes.demote_below": { value: 0.3 },
  },
};

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const authed = (reply: (c: Call) => Plain | Promise<Plain>, good = "tok"): ((c: Call) => Plain | Promise<Plain>) => (c) => c.headers.authorization === `Bearer ${good}` ? reply(c) : { status: 401, text: "unauthorized" };

interface Boot { list?: unknown; details?: Record<string, unknown>; config?: unknown | false; token?: string | false; access?: boolean }
function boot(o: Boot = {}) {
  const app: TestApp = makeApp();
  if (o.token !== false) app.rt.access.setToken("viewers", o.token ?? "tok", "tab");
  app.fetch.on("GET /viewers", authed(() => ({ json: o.list ?? LIST })));
  for (const [key, d] of Object.entries(o.details ?? { "1": DETAIL })) app.fetch.on(`GET /viewers/${encodeURIComponent(key)}`, authed(() => ({ json: d })));
  if (o.config !== false) app.fetch.on("GET /config/brain.memory", { json: o.config ?? CONFIG });
  const r = renderApp(<>{o.access ? <AccessDialog /> : null}<Screen route={{ view: "viewers" }} /></>, app);
  return r;
}
const vcalls = (app: TestApp) => app.fetch.calls.filter((c) => c.path.startsWith("/viewers"));
const listEl = () => screen.getByRole("list", { name: "Viewers" });
const rowBtn = (name: RegExp | string) => within(listEl()).getByRole("button", { name });
const panel = () => screen.getByRole("region", { name: /Viewer details/ });
const open = async (user: ReturnType<typeof userEvent.setup>, name: RegExp | string = /Alice/) => { await user.click(await within(await screen.findByRole("list", { name: "Viewers" })).findByRole("button", { name })); await within(await screen.findByRole("region", { name: /Viewer details/ })).findByRole("heading", { level: 2 }); };

// @spec DASH-VIEWERS-010, DASH-UI-030
test("opening the screen loads the list with the viewers token: rows are buttons with name, REGULAR, set by you, VOICE and counts, all as text", async () => {
  const { app } = boot({ list: { viewers: [...LIST.viewers, { key: "discord:7", display: "Vox", regular: false, regularManual: false, msgCount: 0, noteCount: 1, voice: true, discordId: "7" }] } });
  assert.equal(screen.getAllByRole("heading", { level: 1 }).length, 1);
  await screen.findByRole("list", { name: "Viewers" });
  assert.deepEqual(vcalls(app).map((c) => c.headers.authorization), ["Bearer tok"]);
  assert.match(vcalls(app)[0]!.path, /^\/viewers(\?q=)?$/);
  const rows = within(listEl()).getAllByRole("button");
  assert.equal(rows.length, 4);
  const alice = rowBtn(/Alice/);
  assert.match(alice.textContent!, /REGULAR/);
  assert.match(alice.textContent!, /set by you/);
  assert.match(alice.textContent!, /12 messages/);
  assert.match(alice.textContent!, /2 notes/);
  assert.ok(alice.querySelector(".wrap")?.textContent === "Alice", "the name is in an element with the class wrap");
  const bob = rowBtn(/Bob/);
  assert.match(bob.textContent!, /Bob <b>/, "markup in a name stays text");
  assert.ok(bob.querySelector("b") === null, "no element was created from the name");
  assert.match(bob.textContent!, /REGULAR/);
  assert.ok(!/set by you/.test(bob.textContent!), "a regular by message count is not 'set by you'");
  assert.ok(!/REGULAR/.test(rowBtn(/Cy/).textContent!));
  assert.match(rowBtn(/Vox/).textContent!, /VOICE/);
  assert.equal(within(listEl()).getAllByText("VOICE").length, 1);
});

// @spec DASH-VIEWERS-010
test("search reloads the list 200 ms after typing stops, as one request, and ignores the answer to a superseded search", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await screen.findByRole("list", { name: "Viewers" });
  const first = vcalls(app).length;
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const answer = (q: string) => ({ json: { viewers: [{ key: q, display: `hit ${q}`, regular: false, regularManual: false, msgCount: 1, noteCount: 0 }] } });
  app.fetch.on("GET /viewers?q=al", async (c) => { await slow; return authed(() => answer("al"))(c); });
  app.fetch.on("GET /viewers?q=ali%20%26%20co", authed(() => answer("ali & co")));
  await user.type(screen.getByRole("searchbox", { name: /Search viewers/ }), "al");
  assert.equal(vcalls(app).length, first, "nothing is sent while typing");
  await waitFor(() => assert.ok(vcalls(app).some((c) => c.path === "/viewers?q=al")), { timeout: 2000 });
  assert.equal(vcalls(app).filter((c) => c.path.startsWith("/viewers?q=")).length, 1, "one request for the whole word");
  await user.type(screen.getByRole("searchbox", { name: /Search viewers/ }), "i & co");
  await waitFor(() => assert.ok(vcalls(app).some((c) => c.path === "/viewers?q=ali%20%26%20co")), { timeout: 2000 });
  await screen.findByText("hit ali & co");
  release();
  await settle();
  assert.ok(screen.queryByText("hit al") === null, "the older, slower answer did not overwrite the newer one");
  assert.ok(screen.getByText("hit ali & co"));
});

// @spec DASH-VIEWERS-023, DASH-VIEWERS-017
test("states: loading while the list loads, No viewers yet when empty, No viewer matches with the search text, Select a viewer while none is selected", async () => {
  const user = userEvent.setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = makeApp();
  app.rt.access.setToken("viewers", "tok", "tab");
  app.fetch.on("GET /viewers", async (c) => { await gate; return c.path.includes("zzz") ? { json: { viewers: [] } } : { json: { viewers: [] } }; });
  renderApp(<Screen route={{ view: "viewers" }} />, app);
  const loading = screen.getByText(/Loading viewers/);
  assert.match(loading.textContent!, /Loading viewers/);
  assert.equal(loading.getAttribute("aria-busy"), "true");
  release();
  await screen.findByText("No viewers yet");
  assert.match(document.body.textContent!, /first time someone chats or speaks/);
  assert.ok(screen.getByText("Select a viewer"));
  await user.type(screen.getByRole("searchbox", { name: /Search viewers/ }), "zzz");
  await screen.findByText(/No viewer matches/, undefined, { timeout: 2000 });
  assert.match(screen.getByText(/No viewer matches/).textContent!, /zzz/);
});

// @spec DASH-VIEWERS-017, DASH-VIEWERS-023
test("a failed load shows an alert with the status and a Retry that repeats it, and keeps the data that was already shown", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await screen.findByRole("list", { name: "Viewers" });
  app.fetch.on("GET /viewers", authed(() => ({ status: 500, json: { detail: "boom" } })));
  await user.type(screen.getByRole("searchbox", { name: /Search viewers/ }), "x");
  await waitFor(() => assert.match(screen.getByRole("alert").textContent!, /500.*boom/), { timeout: 2000 });
  assert.ok(rowBtn(/Alice/), "the earlier rows stay");
  app.fetch.on("GET /viewers", authed(() => ({ json: LIST })));
  const before = vcalls(app).length;
  await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
  await settle();
  assert.ok(vcalls(app).length > before);
  assert.ok(screen.queryByRole("alert") === null, "the alert clears once the retry succeeds");
});

// @spec DASH-VIEWERS-010
test("the list is keyboard navigable: the rows are buttons and the arrow keys move between them", async () => {
  const user = userEvent.setup();
  boot();
  await screen.findByRole("list", { name: "Viewers" });
  rowBtn(/Alice/).focus();
  await user.keyboard("{ArrowDown}");
  assert.ok(document.activeElement === rowBtn(/Bob/), "focus moved to the next row");
  await user.keyboard("{ArrowDown}{ArrowDown}");
  assert.ok(document.activeElement === rowBtn(/Cy/), "stops at the last row");
  await user.keyboard("{ArrowUp}");
  assert.ok(document.activeElement === rowBtn(/Bob/));
  await user.keyboard("{Home}");
  assert.ok(document.activeElement === rowBtn(/Alice/));
  await user.keyboard("{End}");
  assert.ok(document.activeElement === rowBtn(/Cy/));
  await user.keyboard("{Enter}");
  await settle();
  assert.equal(rowBtn(/Cy/).getAttribute("aria-current"), "true");
});

// @spec DASH-VIEWERS-011
test("a viewer key is URL-encoded in the detail request", async () => {
  const user = userEvent.setup();
  const odd = { viewer: { key: "a/b 1", display: "Odd", regular: false, regularManual: false, msgCount: 1, noteCount: 0 }, core: [], recent: [], deletions: [] };
  const { app } = boot({ list: { viewers: [{ ...odd.viewer }] }, details: { "a/b 1": odd } });
  await user.click(await within(await screen.findByRole("list", { name: "Viewers" })).findByRole("button", { name: /Odd/ }));
  await settle();
  assert.ok(vcalls(app).some((c) => c.path === "/viewers/a%2Fb%201"));
});

// @spec DASH-VIEWERS-011
test("selecting a viewer loads GET /viewers/:key with the bearer token and shows Core and Recent notes with text, category tag and a labelled meter", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await open(user);
  assert.ok(vcalls(app).some((c) => c.path === "/viewers/1" && c.headers.authorization === "Bearer tok"));
  const p = within(panel());
  assert.ok(p.getByRole("heading", { name: "Core" }));
  assert.ok(p.getByRole("heading", { name: "Recent" }));
  const core = p.getByText("has a <i>sister</i>").closest("li")!;
  assert.ok(core.querySelector("i") === null, "note text is text");
  assert.equal(within(core).getByText("family").className.includes("tag"), true);
  const m = within(core).getByRole("meter");
  assert.equal(m.getAttribute("aria-label"), "Memory strength: Strong 80%");
  assert.equal(m.getAttribute("value"), "80");
  assert.match(core.textContent!, /Strong · 80%/);
  assert.ok(within(core).getByRole("button", { name: /Delete/ }));
  const recent = p.getByText("playing chess").closest("li")!;
  assert.equal(within(recent).getByRole("meter").getAttribute("aria-label"), "Memory strength: Weak 25%");
});

// @spec DASH-VIEWERS-011
test("strength words are Strong at 70% or more, Fading from 30% up to 70%, Weak below 30%", async () => {
  const user = userEvent.setup();
  const strengths = [0.7, 0.69, 0.3, 0.29, 1, 0];
  const detail = { ...DETAIL, core: strengths.map((s, i) => note(`c${i}`, "core", `n${i}`, s)), recent: [] };
  boot({ details: { "1": detail } });
  await open(user);
  const words = strengths.map((_, i) => within(panel()).getByText(`n${i}`).closest("li")!.textContent!.match(/(Strong|Fading|Weak) · (\d+)%/)!.slice(1, 3).join(" "));
  assert.deepEqual(words, ["Strong 70", "Fading 69", "Fading 30", "Weak 29", "Strong 100", "Weak 0"]);
});

// @spec DASH-VIEWERS-011
test("each note says what happens next: a core note halves every N days (and drops to recent under the demote threshold when below 50%), a recent note says when it is forgotten", async () => {
  const user = userEvent.setup();
  const detail = { ...DETAIL, core: [note("c1", "core", "strong core", 0.9), note("c2", "core", "low core", 0.4), note("c3", "core", "floor core", 0.2)], recent: [note("r1", "recent", "weak recent", 0.25), note("r2", "recent", "fresh recent", 1), note("r3", "recent", "gone recent", 0.05)] };
  boot({ details: { "1": detail } });
  await open(user);
  const text = (t: string) => within(panel()).getByText(t).closest("li")!.textContent!;
  assert.match(text("strong core"), /halves every 60 days/);
  assert.ok(!/drops to recent/.test(text("strong core")));
  assert.match(text("low core"), /halves every 60 days/);
  assert.match(text("low core"), /drops to recent under 30%/);
  assert.match(text("floor core"), /halves every 60 days/);
  assert.match(text("weak recent"), /forgotten under 10%, in about 9 days/);
  assert.match(text("fresh recent"), /forgotten under 10%, in about 23 days/);
  assert.match(text("gone recent"), /forgotten/);
  assert.ok(!/in about/.test(text("gone recent")), "already under the floor: no countdown");
});

// @spec DASH-VIEWERS-022
test("the memory strength explainer sits above the notes and quotes the figures from GET /config/brain.memory", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await open(user);
  assert.equal(app.fetch.callsTo("GET /config/brain.memory").length >= 1, true);
  const ex = within(panel()).getByRole("region", { name: /What .memory strength. means/ });
  const t = ex.textContent!;
  assert.match(t, /how firmly the co-host remembers a note/);
  assert.match(t, /from 0 to 100%/);
  assert.match(t, /fades.*every 7 days.*every 60 days/s);
  assert.match(t, /jumps back up.*topic up again/s);
  assert.match(t, /After 3 mentions/);
  assert.match(t, /strongest notes first, 5 at most/);
  assert.match(t, /under 10%.*forgotten/s);
  assert.match(t, /under 30%.*recent/s);
  assert.match(t, /Strong.*70%/s);
  const explainerFirst = ex.compareDocumentPosition(within(panel()).getByRole("heading", { name: "Core" })) & Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(explainerFirst > 0, "the explainer comes before the notes");
});

// @spec DASH-VIEWERS-022
test("when the config read fails the explainer keeps its sentences and leaves the figures out", async () => {
  const user = userEvent.setup();
  boot({ config: false });
  await open(user);
  const t = within(panel()).getByRole("region", { name: /What .memory strength. means/ }).textContent!;
  assert.match(t, /how firmly the co-host remembers a note/);
  assert.match(t, /fades/);
  assert.match(t, /jumps back up/);
  assert.match(t, /decides what gets used/);
  assert.ok(!/\d+ days|5 at most|after \d+ mentions|under \d+%/i.test(t), `figures left out: ${t}`);
  assert.ok(!/halves every \d+/.test(within(panel()).getByText("has a <i>sister</i>").closest("li")!.textContent!), "a note does not quote a figure either");
});

// @spec DASH-VIEWERS-012
test("Delete opens a dialog with an optional reason and what a reason does; Cancel sends nothing; confirm sends the trimmed reason and reloads the panel", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/1/notes/5/delete", authed(() => ({ json: {} })));
  await open(user);
  const del = () => within(within(panel()).getByText("has a <i>sister</i>").closest("li")!).getByRole("button", { name: /Delete/ });
  await user.click(del());
  let dlg = screen.getByRole("dialog");
  assert.ok(within(dlg).getByLabelText(/Reason \(optional\)/));
  assert.match(dlg.textContent!, /stops re-learning similar notes/i);
  assert.match(dlg.textContent!, /Without one.*topic.*come back.*weakly/is);
  await user.click(within(dlg).getByRole("button", { name: "Keep note" }));
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.ok(document.activeElement === del(), "focus returns to the Delete button");
  assert.equal(app.fetch.callsTo("POST /viewers/1/notes/5/delete").length, 0);
  await user.click(del());
  dlg = screen.getByRole("dialog");
  await user.type(within(dlg).getByLabelText(/Reason/), "  too personal ");
  const before = app.fetch.callsTo("GET /viewers/1").length;
  await user.click(within(dlg).getByRole("button", { name: "Delete note" }));
  await settle();
  const sent = app.fetch.callsTo("POST /viewers/1/notes/5/delete");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(sent[0]!.body!), { reason: "too personal" });
  assert.ok(app.fetch.callsTo("GET /viewers/1").length > before, "the panel was reloaded");
  assert.ok(screen.queryByRole("dialog") === null);
  // No reason: an empty body.
  await user.click(del());
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete note" }));
  await settle();
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /viewers/1/notes/5/delete")[1]!.body!), {});
});

// @spec DASH-VIEWERS-012
test("a failed delete keeps the dialog open and shows the server's reason", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/1/notes/5/delete", authed(() => ({ status: 404, json: { detail: "no note 5" } })));
  await open(user);
  await user.click(within(within(panel()).getByText("has a <i>sister</i>").closest("li")!).getByRole("button", { name: /Delete/ }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete note" }));
  await settle();
  const dlg = screen.getByRole("dialog");
  assert.match(within(dlg).getByRole("alert").textContent!, /404.*no note 5/);
});

// @spec DASH-VIEWERS-013
test("the Always a regular switch reflects the owner's flag, sends POST /viewers/regular with the key, and reloads; the regular status and its source show", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/regular", authed(() => ({ json: {} })));
  await open(user);
  const sw = within(panel()).getByRole("switch", { name: "Always a regular" }) as HTMLInputElement;
  assert.equal(sw.checked, true);
  assert.match(panel().textContent!, /Regular: set by you/);
  const before = vcalls(app).length;
  await user.click(sw);
  await settle();
  const sent = app.fetch.callsTo("POST /viewers/regular");
  assert.deepEqual(JSON.parse(sent[0]!.body!), { key: "1", regular: false });
  assert.ok(vcalls(app).slice(before).some((c) => c.method === "GET" && c.path === "/viewers/1"), "the panel reloaded");
  assert.ok(vcalls(app).slice(before).some((c) => c.method === "GET" && c.path.startsWith("/viewers") && c.path !== "/viewers/1"), "the list reloaded");
});

// @spec DASH-VIEWERS-013
test("a regular by message count says so, and a failed switch change puts the switch back and reports it", async () => {
  const user = userEvent.setup();
  const bob = { viewer: LIST.viewers[1], core: [], recent: [], deletions: [] };
  const { app } = boot({ details: { "2": bob } });
  app.fetch.on("POST /viewers/regular", authed(() => ({ status: 500, text: "boom" })));
  await open(user, /Bob/);
  assert.match(panel().textContent!, /Regular: by message count/);
  const sw = within(panel()).getByRole("switch", { name: "Always a regular" }) as HTMLInputElement;
  assert.equal(sw.checked, false);
  await user.click(sw);
  await settle();
  assert.equal((within(panel()).getByRole("switch", { name: "Always a regular" }) as HTMLInputElement).checked, false);
  assert.match(within(panel()).getByRole("alert").textContent!, /500 boom/);
});

// @spec DASH-VIEWERS-013
test("the name field and Mark regular mark a name as regular before they have chatted, then clear the field and refresh the list; an empty name does nothing", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/regular", authed(() => ({ json: {} })));
  await screen.findByRole("list", { name: "Viewers" });
  await user.click(screen.getByRole("button", { name: "Mark regular" }));
  assert.equal(app.fetch.callsTo("POST /viewers/regular").length, 0);
  const field = screen.getByLabelText(/Mark someone as a regular/) as HTMLInputElement;
  const before = vcalls(app).length;
  await user.type(field, "  Newbie ");
  await user.click(screen.getByRole("button", { name: "Mark regular" }));
  await settle();
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /viewers/regular")[0]!.body!), { name: "Newbie", regular: true });
  assert.equal(field.value, "");
  assert.ok(vcalls(app).slice(before).some((c) => c.method === "GET" && c.path.startsWith("/viewers")), "the list refreshed");
  await user.type(field, "Other{Enter}");
  await settle();
  assert.equal(app.fetch.callsTo("POST /viewers/regular").length, 2, "Enter submits too");
});

// @spec DASH-VIEWERS-014
test("Clear all notes asks for confirmation with an optional reason, sends POST /viewers/:key/clear only when confirmed, and reloads the panel", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/1/clear", authed(() => ({ json: { cleared: 2 } })));
  await open(user);
  await user.click(within(panel()).getByRole("button", { name: "Clear all notes" }));
  let dlg = screen.getByRole("dialog");
  assert.ok(within(dlg).getByLabelText(/Reason \(optional\)/));
  assert.match(dlg.textContent!, /can be undone/i);
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.equal(app.fetch.callsTo("POST /viewers/1/clear").length, 0);
  await user.click(within(panel()).getByRole("button", { name: "Clear all notes" }));
  dlg = screen.getByRole("dialog");
  await user.type(within(dlg).getByLabelText(/Reason/), "reset");
  const before = app.fetch.callsTo("GET /viewers/1").length;
  await user.click(within(dlg).getByRole("button", { name: "Clear all notes" }));
  await settle();
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /viewers/1/clear")[0]!.body!), { reason: "reset" });
  assert.ok(app.fetch.callsTo("GET /viewers/1").length > before);
});

// @spec DASH-VIEWERS-015
test("deleted notes list their reasons (or no reason), and Undo sends POST /viewers/deletions/:id/restore and reloads the panel", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  app.fetch.on("POST /viewers/deletions/9/restore", authed(() => ({ json: { note: {} } })));
  await open(user);
  const deleted = within(panel()).getByRole("heading", { name: "Deleted notes" }).parentElement!;
  const mondays = within(deleted).getByText("hates mondays").closest("li")!;
  assert.match(mondays.textContent!, /off topic/);
  assert.match(within(deleted).getByText("has a cold").closest("li")!.textContent!, /no reason/);
  const before = app.fetch.callsTo("GET /viewers/1").length;
  await user.click(within(mondays).getByRole("button", { name: /Undo/ }));
  await settle();
  assert.equal(app.fetch.callsTo("POST /viewers/deletions/9/restore").length, 1);
  assert.ok(app.fetch.callsTo("GET /viewers/1").length > before);
});

// @spec DASH-VIEWERS-023
test("a viewer with no notes shows an empty state, and very long names wrap in the list and the panel", async () => {
  const user = userEvent.setup();
  const long = "W".repeat(200);
  const v = { key: "9", display: long, regular: false, regularManual: false, msgCount: 0, noteCount: 0 };
  boot({ list: { viewers: [v] }, details: { "9": { viewer: v, core: [], recent: [], deletions: [] } } });
  await open(user, new RegExp("W{20}"));
  assert.ok(screen.getByText(/No notes yet/));
  assert.ok(within(panel()).getByRole("heading", { level: 2, name: long }).classList.contains("wrap"));
  assert.ok(rowBtn(new RegExp("W{20}")).querySelector(".wrap"));
});

// @spec DASH-VIEWERS-016
test("a 401 opens the Access dialog for the viewers token naming the action, then retries once with the bearer header; the token is kept under its own key", async () => {
  const user = userEvent.setup();
  const app = makeApp();
  app.fetch.on("GET /viewers", authed(() => ({ json: LIST }), "vt"));
  app.fetch.on("GET /viewers/1", authed(() => ({ json: DETAIL }), "vt"));
  renderApp(<><AccessDialog /><Screen route={{ view: "viewers" }} /></>, app);
  const dlg = await screen.findByRole("dialog", { name: "Access" });
  assert.match(dlg.textContent!, /Load viewers/);
  assert.match(dlg.textContent!, /VIEWERS_TOKEN/);
  await user.type(within(dlg).getByLabelText(/Viewers token/), " vt ");
  await user.click(within(dlg).getByRole("button", { name: /^Unlock/ }));
  await screen.findByRole("list", { name: "Viewers" });
  assert.equal(app.session.getItem("cohost.viewersToken"), "vt");
  assert.equal(app.session.getItem("cohost.controlToken"), null);
  const real = vcalls(app).filter((c) => c.method === "GET" && c.path === "/viewers");
  assert.deepEqual(real.map((c) => c.headers.authorization ?? null), [null, "Bearer vt", "Bearer vt"], "first without a token, the check, the one retry");
});

// @spec DASH-VIEWERS-016
test("cancelling the Access dialog leaves a locked state with a button that asks again, and Lock empties the screen", async () => {
  const user = userEvent.setup();
  const app = makeApp();
  app.fetch.on("GET /viewers", authed(() => ({ json: LIST }), "vt"));
  renderApp(<><AccessDialog /><Screen route={{ view: "viewers" }} /></>, app);
  const dlg = await screen.findByRole("dialog", { name: "Access" });
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  await settle();
  assert.ok(screen.queryByRole("dialog") === null);
  assert.ok(screen.getByText(/The viewers list is locked/));
  assert.ok(screen.queryByRole("list", { name: "Viewers" }) === null);
  await user.click(screen.getByRole("button", { name: "Unlock viewers" }));
  assert.ok(await screen.findByRole("dialog", { name: "Access" }), "asks again");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  await settle();
  // Unlocked elsewhere (the panel): the screen loads. Then Lock empties it without asking.
  act(() => app.rt.access.setToken("viewers", "vt", "tab"));
  await screen.findByRole("list", { name: "Viewers" });
  const asked = app.fetch.callsTo("GET /viewers").length;
  act(() => app.rt.access.lock("viewers"));
  await settle();
  assert.ok(screen.queryByRole("list", { name: "Viewers" }) === null, "notes are not left on screen after Lock");
  assert.ok(screen.queryByRole("dialog") === null, "Lock does not itself prompt");
  assert.equal(app.fetch.callsTo("GET /viewers").length, asked);
});

// @spec DASH-VIEWERS-016, DASH-ACC-009
test("a 403 shows the setup steps, the copyable line and Check again in place of the list, with no field to paste a token into", async () => {
  const user = userEvent.setup();
  const app = makeApp();
  app.fetch.on("GET /viewers", { status: 403, text: "The Viewers page is locked: set VIEWERS_TOKEN in .env" });
  renderApp(<><AccessDialog /><Screen route={{ view: "viewers" }} /></>, app);
  await screen.findByText(/not set up/i);
  assert.ok(screen.queryByRole("dialog") === null, "403 does not open the Access dialog");
  const steps = screen.getAllByRole("listitem");
  assert.equal(steps.length, 3);
  assert.ok(document.body.textContent!.includes('echo "VIEWERS_TOKEN=$(openssl rand -hex 24)" >> .env'));
  assert.ok(screen.queryByRole("list", { name: "Viewers" }) === null);
  assert.ok(screen.queryByRole("searchbox") === null, "no list controls");
  assert.ok(document.querySelector("input") === null, "no field at all");
  assert.equal(app.rt.access.state.get().viewers.notSetUp, true);
  const before = app.fetch.callsTo("GET /viewers").length;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await settle();
  assert.equal(app.fetch.callsTo("GET /viewers").length, before + 1);
  assert.ok(screen.getByText(/not set up/i), "still set up as not");
  act(() => app.rt.access.setToken("viewers", "tok", "tab"));
  app.fetch.on("GET /viewers", authed(() => ({ json: LIST })));
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("list", { name: "Viewers" });
  assert.equal(app.rt.access.state.get().viewers.notSetUp, false);
});

// @spec DASH-VIEWERS-020
test("a voice viewer is tagged and its panel links it to a chat viewer: a labelled name field, nothing sent when cancelled or empty, POST /viewers/links on confirm, then the list and panel reload", async () => {
  const user = userEvent.setup();
  const vox = { key: "discord:77", display: "Vox", regular: false, regularManual: false, msgCount: 0, noteCount: 1, voice: true, discordId: "77" };
  const target = { key: "1", display: "Alice", regular: true, regularManual: true, msgCount: 3, noteCount: 1 };
  const { app } = boot({ list: { viewers: [vox, target] }, details: { "discord:77": { viewer: vox, core: [], recent: [note("1", "recent", "plays bass", 1)], deletions: [] }, "1": { ...DETAIL, viewer: target } } });
  app.fetch.on("POST /viewers/links", authed(() => ({ json: { viewer: target, moved: 1 } })));
  await open(user, /Vox/);
  assert.match(panel().textContent!, /voice channel/i);
  const link = () => within(panel()).getByRole("button", { name: "Link to a chat viewer" });
  await user.click(link());
  let dlg = screen.getByRole("dialog");
  assert.equal((within(dlg).getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled, true, "empty: nothing to send");
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.equal(app.fetch.callsTo("POST /viewers/links").length, 0);
  await user.click(link());
  dlg = screen.getByRole("dialog");
  await user.type(within(dlg).getByLabelText(/Chat viewer/), "  Alice ");
  const listBefore = app.fetch.callsTo("GET /viewers").length;
  await user.click(within(dlg).getByRole("button", { name: "Link" }));
  await settle();
  assert.deepEqual(JSON.parse(app.fetch.callsTo("POST /viewers/links")[0]!.body!), { discordId: "77", name: "Alice" });
  assert.ok(app.fetch.callsTo("GET /viewers").length > listBefore, "the list reloaded");
  await waitFor(() => assert.ok(within(panel()).getByRole("heading", { level: 2, name: "Alice" })), { timeout: 2000 });
});

// @spec DASH-VIEWERS-021, DASH-UI-030
test("a chat viewer lists its linked Discord ids with their display names; Unlink asks first, saying what is lost, then sends POST /viewers/links/:id/delete and reloads", async () => {
  const user = userEvent.setup();
  const detail = { ...DETAIL, links: [{ discordId: "88", discordDisplay: "Ali <b>" }] };
  const { app } = boot({ details: { "1": detail } });
  app.fetch.on("POST /viewers/links/88/delete", authed(() => ({ json: {} })));
  await open(user);
  const li = within(panel()).getByText(/88/).closest("li")!;
  assert.match(li.textContent!, /Ali <b>/);
  assert.ok(li.querySelector("b") === null);
  await user.click(within(li).getByRole("button", { name: /Unlink/ }));
  let dlg = screen.getByRole("dialog");
  assert.match(dlg.textContent!, /separate voice viewer|no longer/i);
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.equal(app.fetch.callsTo("POST /viewers/links/88/delete").length, 0);
  await user.click(within(li).getByRole("button", { name: /Unlink/ }));
  dlg = screen.getByRole("dialog");
  const before = app.fetch.callsTo("GET /viewers/1").length;
  await user.click(within(dlg).getByRole("button", { name: "Unlink" }));
  await settle();
  assert.equal(app.fetch.callsTo("POST /viewers/links/88/delete").length, 1);
  assert.ok(app.fetch.callsTo("GET /viewers/1").length > before);
});

// @spec DASH-VIEWERS-011, DASH-A11Y-007
test("on a narrow screen the panes stack with a Back button that returns to the list and its row", async () => {
  const user = userEvent.setup();
  boot();
  await open(user);
  const panes = document.querySelector(".viewers-panes")!;
  assert.equal(panes.getAttribute("data-selected"), "true");
  await user.click(within(panel()).getByRole("button", { name: /Back to viewers/ }));
  assert.equal(panes.getAttribute("data-selected"), "false");
  assert.ok(screen.getByText("Select a viewer"));
  assert.ok(document.activeElement === rowBtn(/Alice/), "focus is back on the row");
});

// @spec DASH-VIEWERS-017
test("a failed viewer panel load shows the failure and a Retry, keeping the panel that was shown", async () => {
  const user = userEvent.setup();
  const { app } = boot();
  await open(user);
  app.fetch.on("GET /viewers/1", authed(() => ({ status: 504, text: "memory did not answer" })));
  await user.click(within(within(panel()).getByText("has a <i>sister</i>").closest("li")!).getByRole("button", { name: /Delete/ }));
  app.fetch.on("POST /viewers/1/notes/5/delete", authed(() => ({ json: {} })));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete note" }));
  await settle();
  assert.match(within(panel()).getByRole("alert").textContent!, /504.*memory did not answer/);
  assert.ok(within(panel()).getByText("has a <i>sister</i>"), "the earlier panel stays");
  app.fetch.on("GET /viewers/1", authed(() => ({ json: DETAIL })));
  await user.click(within(within(panel()).getByRole("alert")).getByRole("button", { name: "Retry" }));
  await settle();
  assert.ok(within(panel()).queryByRole("alert") === null);
});

// @spec DASH-VIEWERS-011
test("notes data is never taken from the /ws feed: a viewers reply on the socket draws nothing", async () => {
  const { app } = boot();
  await screen.findByRole("list", { name: "Viewers" });
  act(() => app.socket().open());
  act(() => app.socket().message({ id: "1-0", type: "memory.viewers.reply", ts: 1, source: "memory", data: { id: "x", ok: true, data: { viewers: [{ key: "z", display: "FromFeed", regular: false, regularManual: false, msgCount: 0, noteCount: 0 }] } } }));
  assert.ok(screen.queryByText("FromFeed") === null);
});
