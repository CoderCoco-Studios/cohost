import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
  addEventListener() {}
  closest() { return null; }
}

interface FakeRes { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }
const res = (status: number, body: unknown = ""): FakeRes => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

type Handler = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => FakeRes | Promise<FakeRes>;

async function boot(opts: { search?: string; handler?: Handler; control?: boolean; token?: string | null; prompt?: (msg: string) => string | null; confirm?: (msg: string) => boolean; viewersToken?: string } = {}) {
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
    if (path === "/services/control") return res(200, opts.control ? { enabled: true } : { enabled: false });
    return opts.handler ? opts.handler(path, init) : res(204);
  };
  class Audio {
    src: string; played = false;
    onplay?: () => void; onended?: () => void; onerror?: () => void;
    constructor(src: string) { this.src = src; audios.push(this); }
    async play() { this.played = true; }
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
  return { els, get, calls, sockets, audios, timers, run, deliver, tick, prompts, confirms, store };
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
test("a service id with quotes is escaped inside data-svc in the services table", async () => {
  const p = await boot({ control: true });
  p.deliver({ type: "services", services: [{ service: `x" onmouseover="alert(1)`, state: "up", restarts: 0 }] });
  const rows = p.get("#svcRows").innerHTML;
  assert.match(rows, /data-svc="x&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(rows, /data-svc="x"/);
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
