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

async function boot(opts: { search?: string; handler?: Handler; control?: boolean; token?: string | null } = {}) {
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
    prompt: () => (opts.token === undefined ? null : opts.token),
    confirm: () => true,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: () => 0,
    navigator: {}, window: {}, console,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx);
  const tick = () => new Promise<void>((r) => setImmediate(r));
  await tick();
  const run = (code: string) => vm.runInContext(code, ctx) as unknown;
  const deliver = (ev: Record<string, unknown>) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(ev) });
  return { els, get, calls, sockets, audios, timers, run, deliver, tick };
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
