import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { unitDescriptors } from "@cohost/control";

// The test drawer for the Discord connector unit (MOD-TEST-001, DASH-INJ-010), run under a minimal stub DOM like page.test.ts.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;

class El {
  textContent = ""; value = ""; checked = false; disabled = false; innerHTML = ""; className = "";
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; files: unknown[] = [];
  children: El[] = []; parent?: El; scrollTop = 0; scrollHeight = 0;
  listeners: Record<string, ((e: unknown) => unknown)[]> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  get firstChild() { return this.children[0]; }
  appendChild(c: El) { c.parent = this; this.children.push(c); }
  remove() {}
  setAttribute() {}
  addEventListener(type: string, fn: (e: unknown) => unknown) { (this.listeners[type] ??= []).push(fn); }
  closest() { return null; }
}
const res = (status: number, body: unknown = "") => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

async function boot() {
  const els = new Map<string, El>();
  const get = (sel: string) => { let e = els.get(sel); if (!e) els.set(sel, (e = new El())); return e; };
  const calls: { path: string; method: string }[] = [];
  const sockets: { onmessage?: (m: { data: string }) => void }[] = [];
  const fetchStub = async (path: string, init: { method?: string } = {}) => {
    calls.push({ path, method: init.method ?? "GET" });
    if (path === "/personality" && !init.method) return res(200, "# Coco\n");
    if (path === "/services/manifest") return res(200, { units: unitDescriptors() });
    if (path === "/services/control") return res(200, { enabled: false });
    if (path.startsWith("/inject/audio")) return res(202, { id: "req-9" });
    return res(204);
  };
  class WebSocket { onmessage?: (m: { data: string }) => void; constructor() { sockets.push(this); } }
  const sandbox = {
    document: { querySelector: get, createElement: () => new El(), body: get("body") },
    location: { search: "", protocol: "http:", host: "dash.test" },
    fetch: fetchStub, WebSocket, Audio: class {}, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    prompt: () => null, confirm: () => true,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    navigator: {}, window: {}, console,
  };
  vm.runInContext(script, vm.createContext(sandbox));
  const tick = () => new Promise<void>((r) => setImmediate(r));
  await tick();
  const click = async (sel: string, button: Record<string, string>) => {
    for (const fn of get(sel).listeners.click ?? []) await fn({ target: { closest: () => ({ dataset: button }) } });
    await tick();
  };
  const deliver = (ev: Record<string, unknown>) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(ev) });
  return { get, calls, click, deliver };
}

// @spec MOD-TEST-001, DASH-INJ-010
test("the connector's row opens a drawer offering an audio form that posts to /inject/audio with its own target, and its inject.result shows in the feed", async () => {
  const p = await boot();
  p.deliver({ type: "services", services: [{ service: "connector-discord", state: "up", restarts: 0 }] });
  assert.match(p.get("#svcRows").innerHTML, /data-open="test"/);
  await p.click("#svcRows", { open: "test", svc: "connector-discord" });
  const drawer = p.get("#testDrawer").innerHTML;
  assert.equal((drawer.match(/data-td="send"/g) ?? []).length, 1);
  assert.match(drawer, /type="file"/);
  p.get("#tdIn0").files = [{ type: "audio/wav" }];
  await p.click("#testDrawer", { td: "send", i: "0" });
  assert.deepEqual(p.calls.filter((c) => c.path.startsWith("/inject/")).map((c) => c.path), ["/inject/audio?level=service&target=connector-discord"]);
  p.deliver({ id: "e1", type: "inject.result", ts: 1, source: "connector-discord", data: { id: "req-9", ok: true, detail: "played 3 frames" } });
  assert.match(p.get("#tdFeed").innerHTML, /played 3 frames/);
});
