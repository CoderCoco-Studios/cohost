import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { EventPayloads } from "@cohost/bus";
import { SERVICE_MANIFEST, unitDescriptors } from "@cohost/control";

/**
 * The page's inline <script> run under a hand-written stub DOM (no browser dependency). The script's
 * top-level const/let/function bindings stay reachable from later `run()` calls in the same context.
 */
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;

class El {
  textContent = ""; value = ""; checked = false; disabled = false; innerHTML = ""; className = "";
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; files: unknown[] = [];
  children: El[] = []; parent?: El; scrollTop = 0; scrollHeight = 0;
  onclick?: (e?: unknown) => unknown; onchange?: () => unknown; onkeydown?: (e: unknown) => unknown;
  classes = new Set<string>();
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, force?: boolean) => { if (force ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
  };
  get firstChild() { return this.children[0]; }
  appendChild(c: El) { c.parent = this; this.children.push(c); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute() {}
  listeners: Record<string, ((e: unknown) => unknown)[]> = {};
  addEventListener(type: string, fn: (e: unknown) => unknown) { (this.listeners[type] ??= []).push(fn); }
  closest() { return null; }
}

interface FakeRes { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }
const res = (status: number, body: unknown = ""): FakeRes => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

type Handler = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => FakeRes | Promise<FakeRes>;

async function boot(opts: { manifestFails?: boolean; search?: string; handler?: Handler; control?: boolean; token?: string | null; prompt?: (msg: string) => string | null; confirm?: (msg: string) => boolean; viewersToken?: string; rejectPlay?: boolean; playRejects?: () => boolean } = {}) {
  const prompts: string[] = [], confirms: string[] = [];
  const els = new Map<string, El>();
  const get = (sel: string) => { let e = els.get(sel); if (!e) els.set(sel, (e = new El())); return e; };
  const calls: { path: string; method: string; body?: string; auth?: string }[] = [];
  const sockets: { url: string; onmessage?: (m: { data: string }) => void; onclose?: () => void }[] = [];
  const audios: { src: string; onplay?: () => void; onended?: () => void; onerror?: () => void; played: boolean }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const store = new Map<string, string>();
  const fetchStub = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body, auth: init.headers?.authorization });
    if (path === "/personality" && !init.method) return res(200, "# Coco\n");
    if (path === "/services/manifest") return opts.manifestFails ? res(500) : res(200, { units: unitDescriptors() });
    if (path === "/services/control") return res(200, opts.control ? { enabled: true } : { enabled: false });
    return opts.handler ? opts.handler(path, init) : res(204);
  };
  class Audio {
    src: string; played = false;
    onplay?: () => void; onended?: () => void; onerror?: () => void;
    constructor(src: string) { this.src = src; audios.push(this); }
    async play() { if (opts.rejectPlay || opts.playRejects?.()) throw new Error("NotAllowedError"); this.played = true; }
  }
  class WebSocket {
    url: string; onmessage?: (m: { data: string }) => void; onclose?: () => void;
    constructor(url: string) { this.url = url; sockets.push(this); }
  }
  const sandbox = {
    document: { querySelector: get, createElement: () => new El(), body: get("body") },
    location: { search: opts.search ?? "", protocol: "http:", host: "dash.test" },
    fetch: fetchStub, WebSocket, Audio, URLSearchParams,
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    prompt: (msg: string) => { prompts.push(msg); return opts.prompt ? opts.prompt(msg) : opts.token === undefined ? null : opts.token; },
    confirm: (msg: string) => { confirms.push(msg); return opts.confirm ? opts.confirm(msg) : true; },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: () => 0,
    navigator: {}, window: {}, console,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx);
  if (opts.viewersToken) store.set("viewersToken", opts.viewersToken);
  const tick = () => new Promise<void>((r) => setImmediate(r));
  await tick();
  const run = (code: string) => vm.runInContext(code, ctx) as unknown;
  const deliver = (ev: Record<string, unknown>) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(ev) });
  /** Fires the click listeners of `sel` as if `button` (a bag of data-* values) had been clicked inside it. */
  const click = async (sel: string, button: Record<string, string>) => {
    for (const fn of get(sel).listeners.click ?? []) await fn({ target: { closest: () => ({ dataset: button }) } });
    await tick();
  };
  return { els, get, calls, sockets, audios, timers, run, deliver, tick, prompts, confirms, store, click };
}

const utterance = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${id}-0`, type: "voice.utterance", ts: 1, source: "voice", data: { id, durationMs: 1200 }, ...extra });
const status = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "brain.status", ts: 1, source: "cortex", data: { state: "idle" }, ...extra });

// @spec DASH-UI-016
test("esc() escapes & < > \" and ' so a value cannot break out of an attribute", async () => {
  const p = await boot();
  assert.equal(p.run(`esc(${JSON.stringify(`a&b<c>d"e'f`)})`), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
  assert.equal(p.run("esc(7)"), "7");
});

// @spec DASH-UI-016
test("a service id with quotes is escaped in the services table (buttons, and so data-svc, exist only for the fixed manifest ids)", async () => {
  const p = await boot({ control: true });
  p.deliver({ type: "services", services: [{ service: `x" onmouseover="alert(1)`, state: "up", restarts: 0 }] });
  const rows = p.get("#svcRows").innerHTML;
  assert.match(rows, /<td>x&quot; onmouseover=&quot;alert\(1\)<\/td>/);
  assert.doesNotMatch(rows, /onmouseover="/);
  assert.doesNotMatch(rows, /data-svc=/);
});

// @spec DASH-UI-013
test("a replayed voice.utterance is shown in the feed but not played and not reported to /sink", async () => {
  const p = await boot({ search: "?sink=1" });
  p.deliver(utterance("old", { replay: true }));
  assert.equal(p.get("#feed").children.length, 1);
  assert.equal(p.audios.length, 0);
  assert.equal(p.run("queue.length"), 0);
  assert.deepEqual(p.calls.filter((c) => c.path === "/sink"), []);
});

// @spec DASH-UI-013, DASH-UI-012
test("a live utterance plays after earlier ones, posting playing then done to /sink", async () => {
  const p = await boot({ search: "?sink=1" });
  p.deliver(utterance("u1"));
  p.deliver(utterance("u2"));
  assert.deepEqual(p.audios.map((a) => a.src), ["/audio/u1.wav"]); // u2 waits for u1
  p.audios[0]!.onplay!();
  p.audios[0]!.onended!();
  assert.deepEqual(p.audios.map((a) => a.src), ["/audio/u1.wav", "/audio/u2.wav"]);
  await p.tick();
  assert.deepEqual(p.calls.filter((c) => c.path === "/sink").map((c) => JSON.parse(c.body!)), [
    { event: "playing", id: "u1" },
    { event: "done", id: "u1" },
  ]);
});

// @spec DASH-UI-013
test("an event delivered twice (live, then again in a reconnect replay) is shown and played once", async () => {
  const p = await boot({ search: "?sink=1" });
  p.deliver(utterance("u1"));
  p.deliver(status("5-0"));
  p.deliver(utterance("u1", { replay: true }));
  p.deliver(status("5-0", { replay: true }));
  assert.equal(p.get("#feed").children.length, 2);
  assert.equal(p.audios.length, 1);
});

// @spec DASH-UI-014
test("while audio is off, utterances are not queued; enabling audio does not play a backlog", async () => {
  const p = await boot();
  for (const id of ["a", "b", "c"]) p.deliver(utterance(id));
  assert.equal(p.run("queue.length"), 0);
  assert.equal(p.get("#feed").children.length, 3); // still shown
  p.get("#audio").onclick!();
  assert.equal(p.audios.length, 0);
  p.deliver(utterance("d"));
  assert.deepEqual(p.audios.map((a) => a.src), ["/audio/d.wav"]);
  // switching audio off drops what had not started
  p.deliver(utterance("e"));
  assert.equal(p.run("queue.length"), 1);
  p.get("#audio").onclick!();
  assert.equal(p.run("queue.length"), 0);
});

// @spec DASH-UI-022
test("a browser that blocks playback gets a done for that utterance, audio goes off, and the waiting queue plays after audio is re-enabled", async () => {
  let blocked = true;
  const p = await boot({ search: "?sink=1", playRejects: () => blocked });
  p.deliver(utterance("u1"));
  p.deliver(utterance("u2"));
  await p.tick();
  assert.deepEqual(p.calls.filter((c) => c.path === "/sink").map((c) => JSON.parse(c.body!)), [{ event: "done", id: "u1" }]);
  assert.equal(p.run("audioOn"), false);
  assert.equal(p.run("playing"), false);
  assert.equal(p.run("queue.length"), 1); // u2 is still waiting
  blocked = false;
  p.get("#audio").onclick!();
  assert.deepEqual(p.audios.map((a) => a.src), ["/audio/u1.wav", "/audio/u2.wav"]);
  assert.equal(p.run("queue.length"), 0);
});

// @spec DASH-UI-015
test("mute flips its label only after a 2xx; a failure leaves it and says so", async () => {
  let status = 500;
  const p = await boot({ handler: () => res(status) });
  await p.get("#mute").onclick!();
  assert.equal(p.get("#mute").textContent, ""); // never flipped
  assert.equal(p.run("muted"), false);
  assert.match(p.get("#muteMsg").textContent, /mute failed/);
  status = 204;
  await p.get("#mute").onclick!();
  assert.equal(p.get("#mute").textContent, "unmute");
  assert.equal(p.run("muted"), true);
  assert.equal(p.get("#muteMsg").textContent, "");
  status = 401; // token prompt cancelled
  await p.get("#mute").onclick!();
  assert.equal(p.get("#mute").textContent, "unmute");
  assert.equal(p.run("muted"), true);
  assert.match(p.get("#muteMsg").textContent, /unmute failed/);
});

// @spec DASH-UI-015
test("personality save reports success only after a 2xx, and shows a failure otherwise", async () => {
  let next: () => FakeRes = () => res(204);
  const p = await boot({ handler: () => next() });
  p.get("#pers").value = "# new";
  await p.get("#savePers").onclick!();
  assert.equal(p.get("#persMsg").textContent, "saved · brain reloaded");
  assert.deepEqual(p.calls.at(-1), { path: "/personality", method: "PUT", body: "# new", auth: undefined });
  next = () => res(401); // token prompt cancelled
  await p.get("#savePers").onclick!();
  assert.equal(p.get("#persMsg").textContent, "save failed (401)");
  next = () => res(500);
  await p.get("#savePers").onclick!();
  assert.equal(p.get("#persMsg").textContent, "save failed (500)");
  next = () => { throw new Error("offline"); };
  await p.get("#savePers").onclick!();
  assert.match(p.get("#persMsg").textContent, /save failed: offline/);
});

// @spec DASH-UI-006
test("a 401 prompts once for the control token, remembers it and retries with a bearer header", async () => {
  const p = await boot({ token: " tok ", handler: (_p, init) => res(init.headers?.authorization === "Bearer tok" ? 204 : 401) });
  await p.get("#forget").onclick!();
  const posts = p.calls.filter((c) => c.path === "/control");
  assert.deepEqual(posts.map((c) => c.auth), [undefined, "Bearer tok"]);
  await p.get("#forget").onclick!();
  assert.deepEqual(p.calls.filter((c) => c.path === "/control").map((c) => c.auth).slice(2), ["Bearer tok"]);
});

// @spec DASH-UI-001
test("the page connects to /ws and reconnects 2 s after the socket closes", async () => {
  const p = await boot();
  assert.equal(p.sockets[0]!.url, "ws://dash.test/ws");
  p.sockets[0]!.onclose!();
  assert.equal(p.get("#status").textContent, "reconnecting…");
  const t = p.timers.at(-1)!;
  assert.equal(t.ms, 2000);
  t.fn();
  assert.equal(p.sockets.length, 2);
});

// @spec DASH-UI-002, DASH-UI-003
test("feed rows are drawn only for the listed event types, capped at 300; brain.status sets the pill", async () => {
  const p = await boot();
  p.deliver({ id: "1-0", type: "affect.state", ts: 1, source: "affect", data: {} });
  assert.equal(p.get("#feed").children.length, 0);
  p.deliver(status("2-0", { data: { state: "thinking", detail: "why" } }));
  assert.equal(p.get("#status").textContent, "thinking");
  assert.match(p.get("#feed").children[0]!.innerHTML, /thinking · why/);
  for (let i = 0; i < 310; i++) p.deliver(status(`${10 + i}-0`));
  assert.equal(p.get("#feed").children.length, 300);
  p.deliver({ id: "999-0", type: "chat.message", ts: 1, source: "chat", data: { user: "u", text: "hi", injected: true, remember: true } });
  assert.match(p.get("#feed").children.at(-1)!.innerHTML, /injected.*remembered/);
});

// ---------- Viewers page
const VIEWERS = {
  viewers: [
    { key: "1", display: "Alice", regular: true, regularManual: true, msgCount: 12, noteCount: 2 },
    { key: "2", display: "Bob <b>", regular: true, regularManual: false, msgCount: 40, noteCount: 0 },
    { key: "3", display: "Cy", regular: false, regularManual: false, msgCount: 1, noteCount: 0 },
  ],
};
const DETAIL = {
  viewer: VIEWERS.viewers[0],
  core: [{ id: "5", layer: "core", category: "family", text: "has a <i>sister</i>", hint: null, strength: 0.8 }],
  recent: [{ id: "6", layer: "recent", category: "general", text: "playing chess", hint: null, strength: 0.25 }],
  deletions: [
    { id: "9", layer: "recent", category: "general", text: "hates mondays", reason: "off topic", deletedAt: 1 },
    { id: "10", layer: "recent", category: "health", text: "has a <u>cold</u>", reason: null, deletedAt: 2 },
  ],
};
const viewersApi = (over: Record<string, () => FakeRes> = {}): Handler => (path, init) => {
  const m = init.method ?? "GET";
  const hit = over[`${m} ${path}`];
  if (hit) return hit();
  if (m === "GET" && (path.startsWith("/viewers?") || path === "/viewers")) return res(200, VIEWERS);
  if (m === "GET" && path.startsWith("/viewers/")) return res(200, DETAIL);
  return res(200, {});
};
const vcalls = (p: { calls: { path: string; method: string; body?: string; auth?: string }[] }) => p.calls.filter((c) => c.path.startsWith("/viewers"));

// @spec DASH-VIEWERS-010
test("opening the Viewers tab loads the list: name, REGULAR badge, 'set by you', message and note counts, all escaped", async () => {
  const p = await boot({ handler: viewersApi(), viewersToken: "tok" });
  await p.get("#tabViewers").onclick!();
  await p.tick();
  assert.deepEqual(vcalls(p).map((c) => c.auth), ["Bearer tok"]);
  assert.match(vcalls(p)[0]!.path, /^\/viewers(\?q=)?$/);
  const rows = p.get("#vRows").innerHTML;
  assert.match(rows, /Alice/);
  assert.equal((rows.match(/REGULAR/g) ?? []).length, 2, "Alice and Bob are regulars, Cy is not");
  assert.equal((rows.match(/set by you/g) ?? []).length, 1, "only Alice's flag is the owner's");
  assert.match(rows, /12 msgs/);
  assert.match(rows, /2 notes/);
  assert.match(rows, /Bob &lt;b&gt;/);
  assert.doesNotMatch(rows, /Bob <b>/);
  assert.match(rows, /data-key="1"/);
  assert.equal(p.get("#viewers").classes.has("show"), true);
});

// @spec DASH-VIEWERS-010
test("typing in the search box reloads the list filtered by the text; a slower earlier answer cannot overwrite a newer one", async () => {
  const gates: (() => void)[] = [];
  const answer = (path: string) => res(200, { viewers: [{ key: path, display: `hit ${path}`, regular: false, regularManual: false, msgCount: 1, noteCount: 0 }] });
  const p = await boot({
    handler: (path) => new Promise<FakeRes>((r) => gates.push(() => r(answer(path)))),
    viewersToken: "tok",
  });
  p.get("#vSearch").value = "al";
  const first = p.run("loadViewers()") as Promise<void>;
  p.get("#vSearch").value = "ali & co";
  const second = p.run("loadViewers()") as Promise<void>;
  await p.tick();
  assert.deepEqual(vcalls(p).map((c) => c.path), ["/viewers?q=al", `/viewers?q=${encodeURIComponent("ali & co")}`]);
  gates[1]!(); await second;
  gates[0]!(); await first;
  assert.match(p.get("#vRows").innerHTML, /ali &amp; co|ali %26 co|ali%20%26%20co/);
  assert.doesNotMatch(p.get("#vRows").innerHTML, /q=al"|q=al&|q=al</);
});

// @spec DASH-VIEWERS-011
test("selecting a viewer shows Core and Recent notes with text, category tag, strength bar and delete link, escaped", async () => {
  const p = await boot({ handler: viewersApi(), viewersToken: "tok" });
  await p.run('selectViewer("a/b 1")');
  assert.equal(vcalls(p)[0]!.path, "/viewers/a%2Fb%201");
  const html = p.get("#vDetail").innerHTML;
  assert.ok(html.indexOf("Core") >= 0 && html.indexOf("Core") < html.indexOf("Recent"));
  assert.match(html, /has a &lt;i&gt;sister&lt;\/i&gt;/);
  assert.doesNotMatch(html, /<i>sister/);
  assert.match(html, /playing chess/);
  assert.match(html, /family/);
  assert.match(html, /width:80%/);
  assert.match(html, /width:25%/);
  assert.equal((html.match(/data-act="delete"/g) ?? []).length, 2);
  assert.match(html, /data-note="5"/);
  assert.match(html, /Alice/);
});

// @spec DASH-VIEWERS-012
test("delete asks for an optional reason (explaining its effect), sends it, and reloads the panel after a 2xx", async () => {
  const p = await boot({ handler: viewersApi(), viewersToken: "tok", prompt: () => "  too personal " });
  await p.run('selectViewer("1")');
  p.calls.length = 0;
  await p.run('deleteNote("1", "5")');
  assert.match(p.prompts.at(-1)!, /re-learn/i);
  assert.match(p.prompts.at(-1)!, /come back/i);
  const [del, ...reload] = vcalls(p);
  assert.deepEqual([del!.method, del!.path, JSON.parse(del!.body!)], ["POST", "/viewers/1/notes/5/delete", { reason: "too personal" }]);
  assert.ok(reload.some((c) => c.method === "GET" && c.path === "/viewers/1"), "the viewer panel is reloaded");
});

// @spec DASH-VIEWERS-012
test("delete with a blank reason sends none; cancelling does nothing; a failure reloads nothing and is reported", async () => {
  let answer: string | null = "";
  const p = await boot({ handler: viewersApi(), viewersToken: "tok", prompt: () => answer });
  await p.run('selectViewer("1")');
  p.calls.length = 0;
  await p.run('deleteNote("1", "5")');
  assert.deepEqual(JSON.parse(vcalls(p)[0]!.body!), {});
  p.calls.length = 0;
  answer = null;
  await p.run('deleteNote("1", "5")');
  assert.deepEqual(vcalls(p), []);
  const failing = await boot({ handler: viewersApi({ "POST /viewers/1/notes/5/delete": () => res(404, { detail: "no note 5" }) }), viewersToken: "tok", prompt: () => "x" });
  await failing.run('selectViewer("1")');
  failing.calls.length = 0;
  await failing.run('deleteNote("1", "5")');
  assert.equal(vcalls(failing).length, 1, "no reload after a failure");
  assert.match(failing.get("#vMsg").textContent, /404/);
});

// @spec DASH-VIEWERS-013
test("the Mark as regular toggle reflects the owner's flag and posts the opposite; the name field marks a name before it has chatted", async () => {
  const p = await boot({ handler: viewersApi(), viewersToken: "tok" });
  await p.run('selectViewer("1")');
  assert.match(p.get("#vDetail").innerHTML, /Mark as regular/);
  assert.match(p.get("#vDetail").innerHTML, /data-act="regular"[^>]*checked|checked[^>]*data-act="regular"/, "Alice's flag is set, so the toggle is on");
  p.calls.length = 0;
  await p.run('toggleRegular("1", false)');
  assert.deepEqual(JSON.parse(vcalls(p)[0]!.body!), { key: "1", regular: false });
  assert.equal(vcalls(p)[0]!.path, "/viewers/regular");
  assert.ok(vcalls(p).some((c) => c.method === "GET" && c.path.startsWith("/viewers?")), "the list is refreshed");
  p.calls.length = 0;
  p.get("#vName").value = "  Newcomer ";
  await p.run("markName()");
  assert.deepEqual(JSON.parse(vcalls(p)[0]!.body!), { name: "Newcomer", regular: true });
  assert.equal(p.get("#vName").value, "");
  assert.ok(vcalls(p).some((c) => c.method === "GET"), "the list is refreshed");
  p.calls.length = 0;
  p.get("#vName").value = "   ";
  await p.run("markName()");
  assert.deepEqual(vcalls(p), [], "a blank name posts nothing");
});

// @spec DASH-VIEWERS-014
test("Clear all notes asks for confirmation and an optional reason, posts only when confirmed, then reloads", async () => {
  let ok = false;
  const p = await boot({ handler: viewersApi(), viewersToken: "tok", confirm: () => ok, prompt: () => "reset" });
  await p.run('selectViewer("1")');
  assert.match(p.get("#vDetail").innerHTML, /Clear all notes/);
  p.calls.length = 0;
  await p.run('clearNotes("1")');
  assert.equal(p.confirms.length >= 1, true);
  assert.deepEqual(vcalls(p), [], "not confirmed: nothing sent");
  ok = true;
  await p.run('clearNotes("1")');
  const [clear, ...rest] = vcalls(p);
  assert.deepEqual([clear!.method, clear!.path, JSON.parse(clear!.body!)], ["POST", "/viewers/1/clear", { reason: "reset" }]);
  assert.ok(rest.some((c) => c.method === "GET" && c.path === "/viewers/1"));
});

// @spec DASH-VIEWERS-015
test("deleted notes are listed with their reason (or 'no reason') and an undo that restores and reloads", async () => {
  const p = await boot({ handler: viewersApi(), viewersToken: "tok" });
  await p.run('selectViewer("1")');
  const html = p.get("#vDetail").innerHTML;
  assert.match(html, /hates mondays/);
  assert.match(html, /off topic/);
  assert.match(html, /no reason/);
  assert.match(html, /has a &lt;u&gt;cold&lt;\/u&gt;/);
  assert.equal((html.match(/data-act="restore"/g) ?? []).length, 2);
  p.calls.length = 0;
  await p.run('restoreNote("1", "9")');
  const [restore, ...rest] = vcalls(p);
  assert.deepEqual([restore!.method, restore!.path], ["POST", "/viewers/deletions/9/restore"]);
  assert.ok(rest.some((c) => c.method === "GET" && c.path === "/viewers/1"));
});

// @spec DASH-VIEWERS-016
test("a 401 prompts once for the viewers token, keeps it under its own sessionStorage key, and retries with a bearer header", async () => {
  const p = await boot({
    prompt: (m) => (/viewers/i.test(m) ? " vtok " : "control-token"),
    handler: (path, init) => (path.startsWith("/viewers") && init.headers?.authorization !== "Bearer vtok" ? res(401, "unauthorized") : viewersApi()(path, init)),
  });
  await p.get("#tabViewers").onclick!();
  await p.tick();
  assert.deepEqual(vcalls(p).map((c) => c.auth), [undefined, "Bearer vtok"]);
  assert.equal(p.prompts.length, 1);
  assert.match(p.prompts[0]!, /VIEWERS_TOKEN/);
  assert.equal(p.store.get("viewersToken"), "vtok");
  assert.equal(p.store.has("controlToken"), false, "separate from the control token");
  assert.match(p.get("#vRows").innerHTML, /Alice/);
  await p.run("loadViewers()");
  assert.equal(p.prompts.length, 1, "remembered: no second prompt");
});

// @spec DASH-VIEWERS-016
test("a 403 shows the server's message in the Viewers tab instead of the list", async () => {
  const p = await boot({ handler: () => res(403, "set VIEWERS_TOKEN in .env"), viewersToken: "t" });
  await p.run("loadViewers()");
  assert.match(p.get("#vRows").innerHTML, /set VIEWERS_TOKEN in \.env/);
  assert.equal(p.prompts.length, 0);
});

// @spec DASH-VIEWERS-017
test("a failed /viewers request shows a failure message and keeps the data that was already shown", async () => {
  let mode: "ok" | "504" | "net" = "ok";
  const p = await boot({
    viewersToken: "t",
    handler: (path, init) => {
      if (mode === "504") return res(504, { ok: false, detail: "memory did not answer" });
      if (mode === "net") throw new Error("offline");
      return viewersApi()(path, init);
    },
  });
  await p.run("loadViewers()");
  await p.run('selectViewer("1")');
  const rows = p.get("#vRows").innerHTML, detail = p.get("#vDetail").innerHTML;
  assert.ok(rows.includes("Alice") && detail.includes("playing chess"));
  mode = "504";
  await p.run("loadViewers()");
  assert.match(p.get("#vMsg").textContent, /504/);
  assert.match(p.get("#vMsg").textContent, /memory did not answer/);
  assert.equal(p.get("#vRows").innerHTML, rows);
  await p.run('selectViewer("1")');
  assert.equal(p.get("#vDetail").innerHTML, detail);
  mode = "net";
  await p.run("loadViewers()");
  assert.match(p.get("#vMsg").textContent, /offline/);
  assert.equal(p.get("#vRows").innerHTML, rows);
  mode = "ok";
  await p.run("loadViewers()");
  assert.equal(p.get("#vMsg").textContent, "", "the message clears after a success");
});

// @spec DASH-VIEWERS-001
test("notes data is never taken from the /ws feed: a viewers event on the socket draws nothing", async () => {
  const p = await boot();
  p.deliver({ id: "1-0", type: "memory.viewers.reply", ts: 1, source: "memory", data: { id: "x", ok: true, data: DETAIL } });
  assert.equal(p.get("#feed").children.length, 0);
  assert.equal(p.get("#vDetail").innerHTML, "");
});

// ---------- stack panel and lifecycle buttons
const stackMsg = (over: Record<string, unknown> = {}) =>
  ({ type: "stack", state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...over });
const svcRow = (service: string) => ({ service, state: "up", restarts: 0 });

// @spec DASH-UI-008
test("lifecycle buttons appear on manifest-unit rows only: none on the dashboard's row or any other non-unit service", async () => {
  const p = await boot({ control: true });
  p.deliver({ type: "services", services: [svcRow("chat"), svcRow("redis"), svcRow("dashboard"), svcRow("mystery")] });
  const rows = p.get("#svcRows").innerHTML.split("</tr>");
  const row = (name: string) => rows.find((r) => r.includes(`<td>${name}</td>`))!;
  for (const unit of ["chat", "redis"]) assert.equal((row(unit).match(/data-act="/g) ?? []).length, 3, unit);
  for (const other of ["dashboard", "mystery"]) assert.doesNotMatch(row(other), /data-act=/, other);
  assert.match(row("dashboard"), /<td class="act"><\/td>/); // the cell stays so the columns line up
});

// @spec DASH-UI-008
test("the page's unit list is exactly the control plane's manifest", async () => {
  const p = await boot({ control: true });
  assert.deepEqual((JSON.parse(p.run("JSON.stringify(UNITS)") as string) as string[]).sort(), SERVICE_MANIFEST.map((d) => d.id).sort());
});

// @spec DASH-UI-008
test("with service control disabled no row has a button", async () => {
  const p = await boot();
  p.deliver({ type: "services", services: [svcRow("chat")] });
  assert.doesNotMatch(p.get("#svcRows").innerHTML, /data-act=/);
});

// @spec DASH-UI-017
test("the stack panel is shown only where control is enabled", async () => {
  const on = await boot({ control: true });
  on.deliver(stackMsg());
  assert.notEqual(on.get("#stackPanel").style.display, "none");
  const off = await boot();
  off.deliver(stackMsg());
  assert.equal(off.get("#stackPanel").style.display, "none");
});

// @spec DASH-UI-017
test("Launch, Stop and Restart-all each ask for confirmation, then POST their route through the authenticated fetch", async () => {
  const p = await boot({ control: true, token: "tok", handler: (_p, init) => res(init.headers?.authorization === "Bearer tok" ? 202 : 401, { ok: true }) });
  p.deliver(stackMsg());
  for (const [btn, route] of [["#stLaunch", "launch"], ["#stStop", "stop"], ["#stRestart", "restart"]] as const) {
    p.calls.length = 0; p.confirms.length = 0;
    await p.get(btn).onclick!();
    assert.equal(p.confirms.length, 1, btn);
    // the first 401 prompts for the token and retries; the token is then remembered for the tab
    const expected = btn === "#stLaunch" ? [[`/stack/${route}`, "POST", undefined], [`/stack/${route}`, "POST", "Bearer tok"]] : [[`/stack/${route}`, "POST", "Bearer tok"]];
    assert.deepEqual(p.calls.map((c) => [c.path, c.method, c.auth]), expected, btn);
  }
});

// @spec DASH-UI-017
test("declining the confirmation sends nothing", async () => {
  const p = await boot({ control: true, confirm: () => false });
  p.deliver(stackMsg());
  p.calls.length = 0;
  await p.get("#stLaunch").onclick!();
  assert.deepEqual(p.calls.filter((c) => c.path.startsWith("/stack")), []);
});

// @spec DASH-UI-017
test("a non-2xx answer shows the response's detail; a 2xx clears it", async () => {
  let next: FakeRes = res(503, { ok: false, detail: "docker: command not found" });
  const p = await boot({ control: true, token: "tok", handler: () => next });
  p.deliver(stackMsg());
  await p.get("#stLaunch").onclick!();
  assert.match(p.get("#stackMsg").textContent, /docker: command not found/);
  next = res(409, { ok: false, detail: "busy: launch" });
  await p.get("#stStop").onclick!();
  assert.match(p.get("#stackMsg").textContent, /busy: launch/);
  next = res(202, { ok: true, action: "launch" });
  await p.get("#stLaunch").onclick!();
  assert.doesNotMatch(p.get("#stackMsg").textContent, /busy|docker/);
});

// @spec DASH-UI-017
test("the three buttons are disabled while an action runs or Docker is unavailable, and enabled otherwise", async () => {
  const p = await boot({ control: true });
  const states = () => ["#stLaunch", "#stStop", "#stRestart"].map((b) => p.get(b).disabled);
  p.deliver(stackMsg());
  assert.deepEqual(states(), [false, false, false]);
  p.deliver(stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: Date.now() } }));
  assert.deepEqual(states(), [true, true, true]);
  p.deliver(stackMsg({ state: "docker-unavailable", docker: { ok: false, detail: "docker: command not found" } }));
  assert.deepEqual(states(), [true, true, true]);
  p.deliver(stackMsg({ state: "down" }));
  assert.deepEqual(states(), [false, false, false]);
});

// @spec DASH-UI-018
test("the header badge and the panel show the stack state; docker detail, a down stack and an unreachable bus are each said", async () => {
  const p = await boot({ control: true });
  p.deliver(stackMsg({ state: "degraded" }));
  assert.match(p.get("#stackBadge").textContent, /degraded/);
  p.deliver(stackMsg({ state: "docker-unavailable", docker: { ok: false, detail: "docker: command not found" } }));
  assert.match(p.get("#stackState").textContent, /docker: command not found/);
  assert.match(p.get("#stackBadge").textContent, /docker/i);
  p.deliver(stackMsg({ state: "down" }));
  assert.match(p.get("#stackState").textContent, /stack is down/i);
  p.deliver(stackMsg({ state: "up", bus: "unreachable" }));
  assert.match(p.get("#stackBus").textContent, /unreachable/i);
  p.deliver(stackMsg({ state: "up" }));
  assert.equal(p.get("#stackBus").textContent, "");
});

// @spec DASH-UI-018
test("the badge also shows where control is disabled (read-only state)", async () => {
  const p = await boot();
  p.deliver(stackMsg({ state: "up" }));
  assert.match(p.get("#stackBadge").textContent, /up/);
});

// @spec DASH-UI-019
test("after a successful stop the page offers the consolidation pass, which asks for confirmation and POSTs /stack/consolidate; never at any other time", async () => {
  const p = await boot({ control: true, handler: () => res(202, { ok: true, action: "consolidate" }) });
  const shown = () => p.get("#stConsolidate").style.display !== "none";
  p.deliver(stackMsg());
  assert.equal(shown(), false);
  p.deliver(stackMsg({ last: { kind: "launch", ok: true, finishedAt: 1 } }));
  assert.equal(shown(), false);
  p.deliver(stackMsg({ state: "down", last: { kind: "stop", ok: false, detail: "boom", finishedAt: 2 } }));
  assert.equal(shown(), false);
  p.deliver(stackMsg({ state: "down", last: { kind: "stop", ok: true, finishedAt: 3 } }));
  assert.equal(shown(), true);
  p.calls.length = 0; p.confirms.length = 0;
  await p.get("#stConsolidate").onclick!();
  assert.equal(p.confirms.length, 1);
  assert.deepEqual(p.calls.map((c) => [c.path, c.method]), [["/stack/consolidate", "POST"]]);
  p.deliver(stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-up", startedAt: 4 }, last: { kind: "stop", ok: true, finishedAt: 3 } }));
  assert.equal(shown(), false); // not while another action runs
  p.deliver(stackMsg({ last: { kind: "launch", ok: true, finishedAt: 9 } }));
  assert.equal(shown(), false);
});

// @spec DASH-UI-020
test("a running action shows its kind, phase and elapsed time", async () => {
  const p = await boot({ control: true });
  p.deliver(stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: Date.now() - 125_000 } }));
  const t = p.get("#stackAction").textContent;
  assert.match(t, /launch/);
  assert.match(t, /waiting/);
  assert.match(t, /2m ?0\ds/);
  p.deliver(stackMsg());
  assert.equal(p.get("#stackAction").textContent, "");
});

// @spec DASH-UI-020
test("a changed last result is shown with every not-ready service the result lists and its status, escaped", async () => {
  const p = await boot({ control: true });
  p.deliver(stackMsg({ state: "degraded", last: { kind: "launch", ok: false, detail: "not ready after 180s", finishedAt: 1, services: [{ service: "voice", status: "running", health: "starting" }, { service: "x<b>", status: "exited" }] } }));
  const html = p.get("#stackLast").innerHTML;
  assert.match(html, /launch/);
  assert.match(html, /not ready after 180s/);
  assert.match(html, /voice/);
  assert.match(html, /running, starting/);
  assert.match(html, /x&lt;b&gt;/);
  assert.doesNotMatch(html, /x<b>/);
  p.deliver(stackMsg({ last: { kind: "stop", ok: true, finishedAt: 2 } }));
  assert.match(p.get("#stackLast").innerHTML, /stop/);
  assert.doesNotMatch(p.get("#stackLast").innerHTML, /voice/);
});

// @spec DASH-UI-021
test("the page script names no unit of its own: its list comes from /services/manifest", async () => {
  assert.doesNotMatch(script, /"chat",\s*"salience"/);
  const p = await boot({ control: true });
  assert.ok(p.calls.some((c) => c.path === "/services/manifest"));
  p.deliver({ type: "services", services: [svcRow("chat")] });
  assert.equal((p.get("#svcRows").innerHTML.match(/data-act="/g) ?? []).length, 3);
});

// @spec DASH-UI-021
test("when the manifest cannot be fetched no row gets buttons", async () => {
  const p = await boot({ control: true, manifestFails: true });
  p.deliver({ type: "services", services: [svcRow("chat")] });
  assert.doesNotMatch(p.get("#svcRows").innerHTML, /data-act=/);
});

// @spec DASH-STACK-008
test("Rebuild asks for confirmation, then posts /stack/rebuild; cancelling sends nothing", async () => {
  const p = await boot({ control: true, token: "tok", confirm: () => false });
  p.get("#stRebuild").onclick!();
  await p.tick();
  assert.equal(p.calls.filter((c) => c.path === "/stack/rebuild").length, 0);
  assert.match(p.confirms.at(-1)!, /Rebuild/);
  const q = await boot({ control: true, token: "tok" });
  q.get("#stRebuild").onclick!();
  await q.tick(); await q.tick();
  assert.deepEqual(q.calls.filter((c) => c.path === "/stack/rebuild").map((c) => c.method), ["POST"]);
});

// ---------- settings tab (module-contract MOD-UI-001 to 006)

const SETTINGS_SCHEMA = {
  sections: [
    { path: "voice", services: ["voice"], secrets: [], schema: { type: "object", properties: {
      engine: { type: "string", enum: ["kokoro", "stub"], default: "kokoro" },
      speed: { type: "number", default: 1 },
      fallback: { type: "object", properties: { lines: { type: "array", items: { type: "string" }, default: [] } } },
    } } },
    { path: "llm", services: ["salience", "cortex"], secrets: ["openai.api_key"], schema: { type: "object", properties: {
      model: { type: "string" },
      openai: { type: "object", properties: { api_key: { type: "string", "x-secret": true } } },
    } } },
  ],
};
const VOICE_SECTION = { section: "voice", etag: "e1", unknown: [], keys: {
  engine: { source: "env-default", editable: true, value: "kokoro", raw: "kokoro", env: { name: "VOICE_ENGINE", set: false } },
  speed: { source: "literal", editable: true, value: 1, raw: "1" },
  "fallback.lines": { source: "literal", editable: true, value: ["a", "b"], raw: "[a, b]" },
} };
const LLM_SECTION = { section: "llm", etag: "e1", unknown: [], keys: {
  model: { source: "env", editable: false, value: "qwen", env: { name: "LLM_MODEL", set: true } },
  "openai.api_key": { source: "env", editable: false, secret: true, set: true, env: { name: "LLM_API_KEY", set: true } },
} };

interface SettingsOpts { control?: boolean; put?: (path: string, body: any) => FakeRes; apply?: (path: string) => FakeRes }
async function bootSettings(o: SettingsOpts = {}) {
  const p = await boot({
    control: o.control ?? true, token: "tok",
    handler: (path, init) => {
      if (path === "/config/schema") return res(200, SETTINGS_SCHEMA);
      if (path === "/config/voice" && !init.method) return res(200, VOICE_SECTION);
      if (path === "/config/llm" && !init.method) return res(200, LLM_SECTION);
      if (init.method === "PUT" && path.startsWith("/config/")) return (o.put ?? (() => res(200, { ok: true, etag: "e2", restart: [], warnings: [] })))(path, JSON.parse(init.body ?? "{}"));
      if (/^\/services\/[^/]+\/restart$/.test(path)) return (o.apply ?? (() => res(200, { ok: true })))(path);
      return res(404, "");
    },
  });
  await p.get("#tabSettings").onclick!();
  await p.tick();
  return p;
}
type SettingsPage = Awaited<ReturnType<typeof bootSettings>>;
const pick = async (p: SettingsPage, path: string) => { p.get("#sSection").value = path; await p.get("#sSection").onchange!(); await p.tick(); };
const change = (p: SettingsPage, key: string, kind: string, v: string | boolean) =>
  p.get("#sForm").onchange!({ target: { dataset: { key, kind }, value: String(v), checked: v === true } });

// @spec MOD-UI-001
test("the Settings tab lists the sections, renders the chosen one from its schema with each key's source, and names its readers", async () => {
  const p = await bootSettings();
  assert.ok(p.calls.some((c) => c.path === "/config/schema"));
  const opts = p.get("#sSection").innerHTML;
  assert.match(opts, /value="voice"/);
  assert.match(opts, /value="llm"/);
  await pick(p, "voice");
  assert.ok(p.calls.some((c) => c.path === "/config/voice"));
  assert.match(p.get("#sReaders").textContent, /read by: voice/);
  const form = p.get("#sForm").innerHTML;
  assert.match(form, /data-key="engine"/);
  assert.match(form, /<option[^>]*value="stub"/); // an enum renders as a select
  assert.match(form, /data-key="speed"[^>]*data-kind="number"/);
  assert.match(form, /data-key="fallback\.lines"/); // nested keys are named relative to the section
  assert.match(form, /env-default/);
  assert.match(form, /literal/);
  await pick(p, "llm");
  assert.match(p.get("#sReaders").textContent, /read by: salience, cortex/);
});

// @spec MOD-UI-002
test("non-editable keys are read-only, showing the variable for env keys and only set or not set for secrets", async () => {
  const p = await bootSettings();
  await pick(p, "llm");
  const form = p.get("#sForm").innerHTML;
  assert.match(form, /LLM_MODEL/);
  assert.match(form, /data-key="model"[^>]*disabled/);
  assert.match(form, /LLM_API_KEY/);
  assert.match(form, /\bset\b/);
  assert.doesNotMatch(form, /data-key="openai\.api_key"[^>]*value=/); // no value is ever put in a secret's control
});

// @spec MOD-UI-003
test("Validate sends only the changed keys with ?dryRun=1 and shows issues or warnings; Save sends them without it", async () => {
  const seen: { path: string; body: any }[] = [];
  const p = await bootSettings({ put: (path, body) => {
    seen.push({ path, body });
    return path.includes("dryRun") ? res(400, { ok: false, issues: [{ path: "voice.speed", message: "too fast" }] }) : res(200, { ok: true, etag: "e2", restart: [], warnings: [] });
  } });
  await pick(p, "voice");
  change(p, "speed", "number", "1.3");
  change(p, "fallback.lines", "list", "x\ny");
  change(p, "engine", "enum", "kokoro"); // back to the loaded value: not a change
  await p.get("#sValidate").onclick!();
  await p.tick();
  assert.equal(seen[0]!.path, "/config/voice?dryRun=1");
  assert.deepEqual(seen[0]!.body, { etag: "e1", values: { speed: 1.3, "fallback.lines": ["x", "y"] } });
  assert.match(p.get("#sMsg").textContent, /voice\.speed/);
  assert.match(p.get("#sMsg").textContent, /too fast/);
  await p.get("#sSave").onclick!();
  await p.tick();
  assert.equal(seen[1]!.path, "/config/voice");
  assert.deepEqual(seen[1]!.body, { etag: "e1", values: { speed: 1.3, "fallback.lines": ["x", "y"] } });
});

// @spec MOD-UI-003
test("Validate with a passing dry run reports it valid and shows the warnings", async () => {
  const p = await bootSettings({ put: () => res(200, { ok: true, dryRun: true, warnings: ["voice.engine: VOICE_ENGINE is set"] }) });
  await pick(p, "voice");
  change(p, "engine", "enum", "stub");
  await p.get("#sValidate").onclick!();
  await p.tick();
  assert.match(p.get("#sMsg").textContent, /valid/i);
  assert.match(p.get("#sMsg").textContent, /VOICE_ENGINE is set/);
});

// @spec MOD-UI-004
test("a 409 says the file changed and keeps the unsaved edits until the operator reloads the section", async () => {
  const p = await bootSettings({ put: () => res(409, { ok: false, etag: "e9" }) });
  await pick(p, "voice");
  change(p, "speed", "number", "2");
  await p.get("#sSave").onclick!();
  await p.tick();
  assert.match(p.get("#sMsg").textContent, /changed since/i);
  assert.equal(p.run("JSON.stringify(sEdits)"), '{"speed":2}'); // still held
  assert.notEqual(p.get("#sReload").style.display, "none");
  const before = p.calls.filter((c) => c.path === "/config/voice" && c.method === "GET").length;
  await p.get("#sReload").onclick!();
  await p.tick();
  assert.equal(p.calls.filter((c) => c.path === "/config/voice" && c.method === "GET").length, before + 1);
  assert.equal(p.run("JSON.stringify(sEdits)"), "{}");
});

// @spec MOD-UI-005
test("after a save with units to restart, Apply restarts each one after another with an empty body and shows every result", async () => {
  const p = await bootSettings({
    put: () => res(200, { ok: true, etag: "e2", restart: ["salience", "cortex", "memory"], warnings: [] }),
    apply: (path) => (path === "/services/cortex/restart" ? res(500, { ok: false, detail: "compose failed" }) : res(200, { ok: true })),
  });
  await pick(p, "voice");
  assert.equal(p.get("#sApply").style.display, "none");
  change(p, "speed", "number", "1.1");
  await p.get("#sSave").onclick!();
  await p.tick();
  assert.equal(p.get("#sApply").textContent, "Apply: restart salience, cortex, memory");
  assert.notEqual(p.get("#sApply").style.display, "none");
  await p.get("#sApply").onclick!();
  await p.tick(); await p.tick();
  const restarts = p.calls.filter((c) => /\/restart$/.test(c.path));
  assert.deepEqual(restarts.map((c) => [c.path, c.method, c.body]), [
    ["/services/salience/restart", "POST", undefined],
    ["/services/cortex/restart", "POST", undefined],
    ["/services/memory/restart", "POST", undefined],
  ]); // the failed middle one did not stop the last
  const log = p.get("#sApplyLog").innerHTML;
  assert.match(log, /salience[^<]*ok/i);
  assert.match(log, /cortex[^<]*(failed|compose failed)/i);
  assert.match(log, /memory[^<]*ok/i);
});

// @spec MOD-UI-006
test("with control disabled there is no Apply; the page names the units and the cohostctl command instead", async () => {
  const p = await bootSettings({ control: false, put: () => res(200, { ok: true, etag: "e2", restart: ["voice", "mouth"], warnings: [] }) });
  await pick(p, "voice");
  change(p, "speed", "number", "1.2");
  await p.get("#sSave").onclick!();
  await p.tick();
  assert.equal(p.get("#sApply").style.display, "none");
  const msg = p.get("#sMsg").textContent + p.get("#sApplyLog").innerHTML;
  assert.match(msg, /cohostctl restart voice/);
  assert.match(msg, /cohostctl restart mouth/);
  assert.equal(p.calls.filter((c) => /\/restart$/.test(c.path)).length, 0);
});

// ---- module contract: needs, pause, test drawer (MOD-LIFE-002, MOD-PAUSE-*, MOD-TEST-001), audio autoplay (DASH-UI-012)
const rowOf = (p: Awaited<ReturnType<typeof boot>>, name: string) => p.get("#svcRows").innerHTML.split("</tr>").find((r) => r.includes(`<td>${name}</td>`)) ?? "";
const unitRow = (service: string, over: Record<string, unknown> = {}) => ({ service, state: "up", restarts: 0, ...over });
const beat = (detail?: string) => ({ state: "ready", mode: "live", deps: {}, instance: "i", ...(detail ? { detail } : {}) });

// @spec MOD-LIFE-002
test("a row with needs shows 'needs <service> (<state>)' for each beside its own, unchanged, state; a row with none shows nothing", async () => {
  const p = await boot();
  p.deliver({ type: "services", services: [
    unitRow("salience", { needs: [{ service: "affect", state: "down" }, { service: "cortex", state: "unknown" }] }),
    unitRow("cortex", { needs: [] }), unitRow("chat"),
  ] });
  const r = rowOf(p, "salience");
  assert.match(r, /<span class="badge up">up<\/span>/);
  assert.match(r, /needs affect \(down\)/);
  assert.match(r, /needs cortex \(unknown\)/);
  assert.doesNotMatch(rowOf(p, "cortex"), /needs /);
  assert.doesNotMatch(rowOf(p, "chat"), /needs /);
});

// @spec MOD-PAUSE-001
test("Pause and Resume appear on the rows of units whose manifest pause is true, with control enabled, and on no other row", async () => {
  const on = await boot({ control: true });
  on.deliver({ type: "services", services: SERVICE_MANIFEST.map((d) => unitRow(d.id)) });
  for (const d of unitDescriptors()) {
    const r = rowOf(on, d.id);
    assert.equal(/data-ctl="pause"/.test(r) && /data-ctl="resume"/.test(r), d.pause, d.id);
    if (!d.pause) assert.doesNotMatch(r, /data-ctl=/, d.id);
  }
  assert.deepEqual(unitDescriptors().filter((d) => d.pause).map((d) => d.id).sort(), ["affect", "cortex", "salience"]);
  const off = await boot();
  off.deliver({ type: "services", services: [unitRow("salience")] });
  assert.doesNotMatch(rowOf(off, "salience"), /data-ctl=/);
});

// @spec MOD-PAUSE-002
test("pressing Pause or Resume posts /control with the command and the unit as target, through the authenticated fetch", async () => {
  const p = await boot({ control: true, token: "tok" });
  p.deliver({ type: "services", services: [unitRow("salience")] });
  await p.click("#svcRows", { ctl: "pause", svc: "salience" });
  await p.click("#svcRows", { ctl: "resume", svc: "cortex" });
  const sent = p.calls.filter((c) => c.path === "/control");
  assert.deepEqual(sent.map((c) => [c.method, JSON.parse(c.body!)]), [
    ["POST", { cmd: "pause", target: "salience" }],
    ["POST", { cmd: "resume", target: "cortex" }],
  ]);
});

// @spec MOD-PAUSE-003
test("a unit is shown paused exactly while its heartbeat detail is 'paused'; another detail is shown in its place; the page keeps no paused flag", async () => {
  const p = await boot({ control: true });
  p.deliver({ type: "services", services: [unitRow("salience", { heartbeat: beat("paused") })] });
  assert.match(rowOf(p, "salience"), /badge paused">paused</);
  p.deliver({ type: "services", services: [unitRow("salience", { heartbeat: beat("degraded: scorer down") })] });
  assert.doesNotMatch(rowOf(p, "salience"), /badge paused/);
  assert.match(rowOf(p, "salience"), /degraded: scorer down/);
  p.deliver({ type: "services", services: [unitRow("salience", { heartbeat: beat() })] });
  assert.doesNotMatch(rowOf(p, "salience"), /paused/);
  assert.doesNotMatch(script, /\bpaused\s*=\s*(true|false)|pausedUnits|isPaused/);
});

const openDrawer = async (p: Awaited<ReturnType<typeof boot>>, unit: string) => {
  p.deliver({ type: "services", services: [unitRow(unit)] });
  await p.click("#svcRows", { open: "test", svc: unit });
};

// @spec MOD-TEST-001
test("every unit row has a test button, with control enabled or not; non-unit rows have none", async () => {
  for (const control of [true, false]) {
    const p = await boot({ control });
    p.deliver({ type: "services", services: [unitRow("chat"), unitRow("redis"), unitRow("mystery")] });
    assert.match(rowOf(p, "chat"), /data-open="test"/);
    assert.doesNotMatch(rowOf(p, "redis"), /data-open=/);
    assert.doesNotMatch(rowOf(p, "mystery"), /data-open=/);
  }
});

// @spec MOD-TEST-001
test("the drawer offers one input form per entry of the unit's test.inputs, and the isolated start only with control enabled", async () => {
  const on = await boot({ control: true });
  await openDrawer(on, "salience");
  assert.notEqual(on.get("#testDrawer").style.display, "none");
  const html = on.get("#testDrawer").innerHTML;
  assert.match(html, /salience/);
  assert.equal((html.match(/data-td="send"/g) ?? []).length, 3);
  for (const t of ["chat.message", "speech.heard", "vision.summary"]) assert.match(html, new RegExp(t.replace(".", "\\.")));
  assert.match(html, /data-td="isolated"/);
  const off = await boot();
  await openDrawer(off, "salience");
  assert.doesNotMatch(off.get("#testDrawer").innerHTML, /data-td="isolated"/);
  const chat = await boot();
  await openDrawer(chat, "chat");
  assert.equal((chat.get("#testDrawer").innerHTML.match(/data-td="send"/g) ?? []).length, 1);
  assert.match(chat.get("#testDrawer").innerHTML, /<textarea/);
  const eyes = await boot();
  await openDrawer(eyes, "eyes");
  assert.match(eyes.get("#testDrawer").innerHTML, /type="file"/);
});

// @spec MOD-TEST-001
test("a bus-event form posts /inject/event {unit, type, data} and reports the published bus id, or the server's refusal", async () => {
  let answer = res(202, { id: "17-0" });
  const p = await boot({ handler: (path) => (path === "/inject/event" ? answer : res(204)) });
  await openDrawer(p, "salience");
  p.get("#tdIn0").value = JSON.stringify({ platform: "twitch", user: "bob", text: "hi" });
  await p.click("#testDrawer", { td: "send", i: "0" });
  const call = p.calls.find((c) => c.path === "/inject/event")!;
  assert.deepEqual(JSON.parse(call.body!), { unit: "salience", type: "chat.message", data: { platform: "twitch", user: "bob", text: "hi" } });
  assert.match(p.get("#tdStatus").textContent, /published chat\.message.*17-0/);
  answer = res(409, { ok: false, detail: "service not running: salience" });
  await p.click("#testDrawer", { td: "send", i: "0" });
  assert.match(p.get("#tdStatus").textContent, /409.*service not running: salience/);
  p.get("#tdIn0").value = "{not json";
  const before = p.calls.length;
  await p.click("#testDrawer", { td: "send", i: "0" });
  assert.equal(p.calls.length, before, "invalid JSON is not sent");
  assert.match(p.get("#tdStatus").textContent, /JSON/);
});

// @spec MOD-TEST-001
test("every bus input the manifest declares has a sample payload that its bus schema accepts", async () => {
  const p = await boot();
  const types = [...new Set(unitDescriptors().flatMap((d) => d.test.inputs).filter((t) => !["text", "image", "audio"].includes(t)))];
  assert.ok(types.length >= 6);
  for (const t of types) {
    const sample = JSON.parse(p.run(`JSON.stringify(sampleFor(${JSON.stringify(t)}))`) as string);
    const parsed = (EventPayloads as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>)[t]!.safeParse(sample);
    assert.ok(parsed.success, `${t}: ${JSON.stringify(sample)}`);
  }
});

// @spec MOD-TEST-001
test("the chat unit's text form posts a service-level /inject/text and its inject.result shows in the drawer feed", async () => {
  const p = await boot({ handler: (path) => (path === "/inject/text" ? res(202, { id: "req-1" }) : res(204)) });
  await openDrawer(p, "chat");
  p.get("#tdIn0").value = "hello there";
  await p.click("#testDrawer", { td: "send", i: "0" });
  const call = p.calls.find((c) => c.path === "/inject/text")!;
  assert.deepEqual(JSON.parse(call.body!), { level: "service", text: "hello there" });
  p.deliver({ id: "e1", type: "inject.result", ts: 1, source: "chat", data: { id: "other", ok: true } });
  assert.doesNotMatch(p.get("#tdFeed").innerHTML, /inject\.result/);
  p.deliver({ id: "e2", type: "inject.result", ts: 1, source: "chat", data: { id: "req-1", ok: true, detail: "queued" } });
  assert.match(p.get("#tdFeed").innerHTML, /inject\.result/);
  assert.match(p.get("#tdFeed").innerHTML, /queued/);
});

// @spec MOD-TEST-001
test("the drawer feed shows the unit's test.observe types, including ones the main feed drops, and nothing else", async () => {
  const p = await boot();
  await openDrawer(p, "salience");
  p.deliver({ id: "a", type: "attention.focus", ts: 1, source: "salience", data: { reason: "mentioned", score: 0.9 } });
  p.deliver({ id: "b", type: "brain.say", ts: 1, source: "cortex", data: { id: "s", text: "hello", emotion: "happy" } });
  p.deliver({ id: "c", type: "affect.state", ts: 1, source: "affect", data: { valence: 0, arousal: 0, mood: "neutral" } });
  const html = p.get("#tdFeed").innerHTML;
  assert.match(html, /attention\.focus/);
  assert.match(html, /brain\.say/);
  assert.doesNotMatch(html, /affect\.state/);
  assert.equal(p.get("#feed").children.length, 1, "the main feed still drops attention.focus");
});

// @spec MOD-TEST-001
test("the isolated start asks for confirmation, then posts the unit's start with isolated: true", async () => {
  const p = await boot({ control: true, confirm: () => true });
  await openDrawer(p, "voice");
  await p.click("#testDrawer", { td: "isolated" });
  const call = p.calls.find((c) => c.path === "/services/voice/start")!;
  assert.deepEqual([call.method, JSON.parse(call.body!)], ["POST", { isolated: true }]);
  const declined = await boot({ control: true, confirm: () => false });
  await openDrawer(declined, "voice");
  await declined.click("#testDrawer", { td: "isolated" });
  assert.equal(declined.calls.filter((c) => c.path === "/services/voice/start").length, 0);
});

// @spec DASH-UI-022
test("when the browser refuses to start playback the dropped line is reported done, audio goes back to off, and the rest of the queue is kept for when audio is re-enabled", async () => {
  const p = await boot({ rejectPlay: true });
  p.get("#audio").onclick!(); // audio on
  for (const id of ["a", "b", "c"]) p.deliver(utterance(id));
  await p.tick();
  assert.deepEqual(p.calls.filter((c) => c.path === "/sink").map((c) => JSON.parse(c.body!)), [{ event: "done", id: "a" }]);
  assert.equal(p.run("audioOn"), false);
  assert.match(p.get("#audio").textContent, /enable audio/);
  assert.equal(p.run("queue.length"), 2);
  p.get("#audio").onclick!(); // re-enable: the kept queue resumes
  await p.tick();
  assert.deepEqual(p.audios.map((a) => a.src), ["/audio/a.wav", "/audio/b.wav"]);
});

// ---------- Voice speakers on the Viewers page
const VOICE_LIST = {
  viewers: [
    { key: "discord:77", display: "Vox", regular: false, regularManual: false, msgCount: 0, noteCount: 1, voice: true, discordId: "77" },
    { key: "1", display: "Alice", regular: false, regularManual: false, msgCount: 3, noteCount: 0 },
  ],
};
const voiceApi = (detail: Record<string, unknown>): Handler => (path, init) => {
  const m = init.method ?? "GET";
  if (m === "GET" && (path.startsWith("/viewers?") || path === "/viewers")) return res(200, VOICE_LIST);
  if (m === "GET" && path === "/viewers/1") return res(200, { viewer: VOICE_LIST.viewers[1], core: [], recent: [], deletions: [], links: detail.links });
  if (m === "GET" && path.startsWith("/viewers/")) return res(200, detail);
  return res(200, {});
};
const VOICE_DETAIL = { viewer: VOICE_LIST.viewers[0], core: [], recent: [], deletions: [] };
const LINKED_DETAIL = { viewer: VOICE_LIST.viewers[1], core: [], recent: [], deletions: [], links: [{ discordId: "88", discordDisplay: "Ali <b>" }] };

// @spec DASH-VIEWERS-020
test("a voice viewer is listed with a VOICE tag and its panel offers Link to a chat viewer", async () => {
  const p = await boot({ handler: voiceApi(VOICE_DETAIL), viewersToken: "tok" });
  await p.get("#tabViewers").onclick!();
  await p.tick();
  const rows = p.get("#vRows").innerHTML;
  assert.equal((rows.match(/VOICE/g) ?? []).length, 1, "only the voice viewer is tagged");
  await p.run('selectViewer("discord:77")');
  assert.match(p.get("#vDetail").innerHTML, /Link to a chat viewer/);
  await p.run('selectViewer("1")');
  assert.doesNotMatch(p.get("#vDetail").innerHTML, /Link to a chat viewer/);
});

// @spec DASH-VIEWERS-020
test("Link to a chat viewer asks for a name, posts the discord id and the name, and reloads; cancel or empty posts nothing", async () => {
  let answer: string | null = null;
  const p = await boot({ handler: voiceApi(VOICE_DETAIL), viewersToken: "tok", prompt: () => answer });
  await p.run('selectViewer("discord:77")');
  p.calls.length = 0;
  await p.run('linkVoice("discord:77", "77")');
  answer = "   ";
  await p.run('linkVoice("discord:77", "77")');
  assert.deepEqual(vcalls(p), [], "cancelled or empty: nothing sent");
  answer = " Alice ";
  await p.run('linkVoice("discord:77", "77")');
  const [post, ...rest] = vcalls(p);
  assert.deepEqual([post!.method, post!.path, JSON.parse(post!.body!)], ["POST", "/viewers/links", { discordId: "77", name: "Alice" }]);
  assert.ok(rest.some((c) => c.method === "GET" && c.path.startsWith("/viewers?")), "the list is reloaded");
});

// @spec DASH-VIEWERS-021
test("a chat viewer's panel lists its linked Discord ids (escaped) with an unlink that posts and reloads", async () => {
  const p = await boot({ handler: voiceApi(LINKED_DETAIL), viewersToken: "tok" });
  await p.run('selectViewer("1")');
  const html = p.get("#vDetail").innerHTML;
  assert.match(html, /88/);
  assert.match(html, /Ali &lt;b&gt;/);
  assert.match(html, /data-act="unlink"/);
  p.calls.length = 0;
  await p.run('unlinkVoice("1", "88")');
  const [post, ...rest] = vcalls(p);
  assert.deepEqual([post!.method, post!.path], ["POST", "/viewers/links/88/delete"]);
  assert.ok(rest.some((c) => c.method === "GET" && c.path === "/viewers/1"));
});
