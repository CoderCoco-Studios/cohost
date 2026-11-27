import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import type { HealthState, ServiceHealth } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { guardFullSurface, lanHandler } from "../src/host.js";
import { StackService } from "../src/stack.js";

// The tool routes of the dashboard: POST /tools/answer and the service-level `as: "tool"` text injection. Both let an
// acting tool run; both pass the one gate as every mutation does (DASH-TOOL-002, DASH-INJ-011).

const TOKEN = "s3cret-control-token-for-tools-000001";
const ids = ["chat", "tools"];
const health = (state: HealthState): ServiceHealth[] => ids.map((service) => ({ service, state, restarts: 0 }));

interface Opts {
  states?: Record<string, HealthState>;
}

async function boot(o: Opts = {}) {
  const bus = new (class extends FakeBus { async resetGroup() {} })();
  const rec = recordingLog();
  const setup = setupControl({ CONTROL_TOKEN: TOKEN }, bus, rec.log);
  const services = () => health("up").map((s) => (o.states?.[s.service] ? { ...s, state: o.states[s.service]! } : s));
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services,
    control: setup.control,
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
  });
  const mk = (h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });
  const full = await mk(guardFullSurface(handler, { loopback: true }));
  const lan = await mk(lanHandler(handler));
  after(() => { full.close(); lan.close(); });
  const port = (full.address() as { port: number }).port;
  const lanPort = (lan.address() as { port: number }).port;
  const call = (p: number, path: string, body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });
  return {
    bus, rec,
    answer: (body: unknown, headers: Record<string, string> = bearer()) => call(port, "/tools/answer", body, headers),
    text: (body: unknown, headers: Record<string, string> = bearer()) => call(port, "/inject/text", body, headers),
    onLan: (path: string, body: unknown) => call(lanPort, path, body, bearer()),
    bearer,
  };
}

const json = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;

// @spec DASH-TOOL-001
test("POST /tools/answer with a string id and a boolean allow publishes tool.answer with exactly those two members and answers 202", async () => {
  const t = await boot();
  for (const allow of [true, false]) {
    const r = await t.answer({ id: `call-${allow}`, allow });
    assert.equal(r.status, 202, String(allow));
  }
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "call-true", allow: true }, { id: "call-false", allow: false }]);
  // an extra member is not carried onto the bus
  assert.equal((await t.answer({ id: "x", allow: true, injected: true, origin: "dashboard" })).status, 202);
  assert.deepEqual(t.bus.of("tool.answer").at(-1), { id: "x", allow: true });
});

// @spec DASH-TOOL-001
test("a body that is not {id: string, allow: boolean} is 400 and publishes nothing", async () => {
  const t = await boot();
  const bad: unknown[] = [
    "not json", "[]", "null", "7", "{}", { id: "a" }, { allow: true }, { id: 7, allow: true }, { id: null, allow: true },
    { id: "a", allow: "true" }, { id: "a", allow: 1 }, { id: "a", allow: null }, { id: ["a"], allow: true }, { id: { x: 1 }, allow: false },
  ];
  for (const b of bad) assert.equal((await t.answer(b)).status, 400, JSON.stringify(b));
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-001
test("a body over 64 KiB is 413 and publishes nothing", async () => {
  const t = await boot();
  assert.equal((await t.answer({ id: "a".repeat(70 * 1024), allow: true })).status, 413);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-001
test("the dashboard keeps no record of confirmations: an answer for an unknown, finished or repeated id is published each time and answered 202 (the tools service ignores all but the first for a pending call, TOOL-CONF-007)", async () => {
  const t = await boot();
  for (let i = 0; i < 3; i++) assert.equal((await t.answer({ id: "gone", allow: true })).status, 202);
  assert.equal((await t.answer({ id: "gone", allow: false })).status, 202);
  assert.equal(t.bus.of("tool.answer").length, 4);
});

// @spec DASH-TOOL-002, DASH-CTRL-011
test("the answer passes the one gate: no or a wrong token is 401 with www-authenticate and publishes nothing; the right one is served", async () => {
  const t = await boot();
  for (const headers of [{}, t.bearer("wrong"), { authorization: TOKEN }, { authorization: "Basic abc" }, { authorization: "Bearer " }]) {
    const r = await t.answer({ id: "a", allow: true }, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.headers["www-authenticate"], "Bearer");
  }
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.answer({ id: "a", allow: true })).status, 202);
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "a", allow: true }]);
});

// @spec DASH-TOOL-002
test("the token is judged before the body: an invalid body without the token is 401, with it 400", async () => {
  const t = await boot();
  assert.equal((await t.answer("not json", {})).status, 401);
  assert.equal((await t.answer("not json")).status, 400);
});

// @spec DASH-TOOL-002, DASH-HOST-005
test("a request that carries a foreign Origin is refused 403 with the right token and publishes nothing; the page's own Origin is served", async () => {
  const t = await boot();
  for (const origin of ["http://evil.example", "https://127.0.0.1", "null", "http://127.0.0.1:1", "http://localhost.evil.example"]) {
    const r = await t.answer({ id: "a", allow: true }, { ...t.bearer(), origin });
    assert.equal(r.status, 403, origin);
  }
  assert.equal(t.bus.published.length, 0);
  // an Origin naming the Host the request used is the dashboard's own page
  const own = await t.answer({ id: "own", allow: true }, { ...t.bearer(), host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234" });
  assert.equal(own.status, 202);
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "own", allow: true }]);
});

// @spec DASH-TOOL-002
test("a foreign Host is refused 403 as on every full-surface route (DNS rebinding), and the route is not served on the LAN listener", async () => {
  const t = await boot();
  assert.equal((await t.answer({ id: "a", allow: true }, { ...t.bearer(), host: "rebind.example" })).status, 403);
  const lan = await t.onLan("/tools/answer", { id: "a", allow: true });
  assert.equal(lan.status, 404);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-002, DASH-CTRL-001
test("the control token never appears in the response or in a log line", async () => {
  const t = await boot();
  const r = await t.answer({ id: "a", allow: true }, t.bearer("wrong-" + TOKEN));
  assert.equal(r.text.includes(TOKEN), false);
  assert.equal(JSON.stringify(t.rec.lines).includes(TOKEN), false);
});

const tool = { level: "service", as: "tool", text: '{"tool":"stream_info","arguments":{}}' };

// @spec DASH-INJ-001
test("as: tool is accepted only at service level: level bus with as: tool is 400, and service level takes only chat and tool", async () => {
  const t = await boot();
  assert.equal((await t.text({ level: "bus", as: "tool", text: "x" })).status, 400);
  assert.equal((await t.text({ level: "service", as: "tool", text: "   " })).status, 400);
  assert.equal((await t.text({ level: "service", as: "tool", text: 7 })).status, 400);
  assert.equal((await t.text({ level: "service", as: "tools", text: "x" })).status, 400);
  assert.equal((await t.text({ level: "service", as: "speech", text: "x" })).status, 400);
  assert.equal((await t.text({ level: "service", as: "vision", text: "x" })).status, 400);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-INJ-011
test("service-level as: tool publishes inject.request {id, target: tools, kind: text, text, remember: false} with the text unmodified and answers 202 with that same id", async () => {
  const t = await boot();
  const text = '  {"tool":"timer",\n "arguments":{"minutes":1,  "note":"a   b"}}  ';
  const r = await t.text({ ...tool, text });
  assert.equal(r.status, 202);
  assert.equal(t.bus.of("inject.request").length, 1);
  assert.deepEqual(t.bus.of("inject.request")[0], { id: json(r).id, target: "tools", kind: "text", text, remember: false });
  assert.deepEqual(t.bus.published.map((p) => p.type), ["inject.request"], "nothing else is published, chat.message least of all");
});

// @spec DASH-INJ-011
test("as: tool never remembers and never carries chat metadata: remember true, user, platform, isMod and isSub are not carried", async () => {
  const t = await boot();
  assert.equal((await t.text({ ...tool, remember: true, user: "bob", platform: "twitch", isMod: true, isSub: true })).status, 202);
  const ev = t.bus.of("inject.request")[0]!;
  assert.equal(ev.remember, false);
  assert.equal("meta" in ev, false);
});

// @spec DASH-INJ-011, DASH-CTRL-001
test("as: tool passes the gate as every injection does: 401 with www-authenticate without the token, the chat injection beside it too", async () => {
  const t = await boot();
  const r = await t.text(tool, {});
  assert.equal(r.status, 401);
  assert.equal(r.headers["www-authenticate"], "Bearer");
  assert.equal((await t.text(tool, t.bearer("wrong"))).status, 401);
  assert.equal((await t.text({ level: "service", text: "hi" }, {})).status, 401, "every injection is gated");
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.text({ level: "service", text: "hi" })).status, 202);
  assert.equal((await t.text(tool)).status, 202);
  assert.deepEqual(t.bus.of("inject.request").map((e) => e.target), ["chat", "tools"]);
});

// @spec DASH-INJ-011, DASH-HOST-005
test("as: tool with a foreign Origin is refused 403 even with the token, and is not served on the LAN listener", async () => {
  const t = await boot();
  assert.equal((await t.text(tool, { ...t.bearer(), origin: "http://evil.example" })).status, 403);
  assert.equal((await t.onLan("/inject/text", tool)).status, 404);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-INJ-011, MOD-TEST-005
test("as: tool is for the tools unit alone: refused 409 while tools is down, and chat being down does not matter", async () => {
  const down = await boot({ states: { tools: "down" } });
  const r = await down.text(tool);
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), { ok: false, detail: "service not running: tools" });
  assert.equal(down.bus.published.length, 0);
  const chatDown = await boot({ states: { chat: "down" } });
  assert.equal((await chatDown.text(tool)).status, 202);
});

// @spec DASH-CTRL-001, DASH-CTRL-004, DASH-CTRL-011
test("every mutation needs the token: the answer, as: tool, the chat and bus injections", async () => {
  const t = await boot();
  assert.equal((await t.answer({ id: "a", allow: true }, {})).status, 401);
  assert.equal((await t.text(tool, {})).status, 401);
  assert.equal((await t.text({ level: "bus", text: "hi" }, {})).status, 401);
  assert.equal((await t.text({ level: "service", text: "hi" }, {})).status, 401);
  assert.equal((await t.text({ level: "service", text: "hi" })).status, 202, "with the token");
});

// @spec DASH-TOOL-001
test("the answer id is 1 to 256 characters: empty is 400, 256 is 202, 257 is 400", async () => {
  const t = await boot();
  assert.equal((await t.answer({ id: "", allow: true })).status, 400);
  assert.equal((await t.answer({ id: "a".repeat(256), allow: true })).status, 202);
  assert.equal((await t.answer({ id: "a".repeat(257), allow: true })).status, 400);
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "a".repeat(256), allow: true }]);
});

// @spec DASH-INJ-012
test("as: tool ignores each chat field on its own: remember, user, platform, isMod and isSub change nothing about the published event", async () => {
  const t = await boot();
  for (const extra of [{ remember: true }, { user: "bob" }, { platform: "youtube" }, { isMod: true }, { isSub: true }]) {
    assert.equal((await t.text({ ...tool, ...extra })).status, 202, JSON.stringify(extra));
  }
  for (const ev of t.bus.of("inject.request")) {
    assert.deepEqual({ ...ev, id: "x" }, { id: "x", target: "tools", kind: "text", text: tool.text, remember: false });
  }
  assert.equal(t.bus.of("inject.request").length, 5);
});
