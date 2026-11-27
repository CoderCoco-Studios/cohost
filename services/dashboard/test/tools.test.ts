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
// acting tool run, so both are always bearer-gated, in either control mode (DASH-TOOL-002, DASH-INJ-011).

const TOKEN = "s3cret";
const ids = ["chat", "tools"];
const health = (state: HealthState): ServiceHealth[] => ids.map((service) => ({ service, state, restarts: 0 }));

interface Opts {
  /** CONTROL_ENABLED=1 with the token. */
  control?: boolean;
  /** CONTROL_TOKEN configured without control mode; `null` is none at all. */
  token?: string | null;
  states?: Record<string, HealthState>;
}

async function boot(o: Opts = {}) {
  const bus = new (class extends FakeBus { async resetGroup() {} })();
  const rec = recordingLog();
  const setup = setupControl(o.control ? { CONTROL_ENABLED: "1", CONTROL_TOKEN: TOKEN } : {}, bus, rec.log);
  const token = o.control ? TOKEN : o.token === undefined ? undefined : o.token ?? undefined;
  const services = () => health("up").map((s) => (o.states?.[s.service] ? { ...s, state: o.states[s.service]! } : s));
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services,
    control: setup.control, ...(token ? { controlToken: token } : {}),
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
  });
  const mk = (h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });
  const full = await mk(guardFullSurface(handler, { loopback: true, controlEnabled: !!o.control }));
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
  const t = await boot({ control: true });
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
  const t = await boot({ control: true });
  const bad: unknown[] = [
    "not json", "[]", "null", "7", "{}", { id: "a" }, { allow: true }, { id: 7, allow: true }, { id: null, allow: true },
    { id: "a", allow: "true" }, { id: "a", allow: 1 }, { id: "a", allow: null }, { id: ["a"], allow: true }, { id: { x: 1 }, allow: false },
  ];
  for (const b of bad) assert.equal((await t.answer(b)).status, 400, JSON.stringify(b));
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-001
test("a body over 64 KiB is 413 and publishes nothing", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.answer({ id: "a".repeat(70 * 1024), allow: true })).status, 413);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-001
test("the dashboard keeps no record of confirmations: an answer for an unknown, finished or repeated id is published each time and answered 202 (the tools service ignores all but the first for a pending call, TOOL-CONF-007)", async () => {
  const t = await boot({ control: true });
  for (let i = 0; i < 3; i++) assert.equal((await t.answer({ id: "gone", allow: true })).status, 202);
  assert.equal((await t.answer({ id: "gone", allow: false })).status, 202);
  assert.equal(t.bus.of("tool.answer").length, 4);
});

// @spec DASH-TOOL-002, DASH-CTRL-001
test("control mode on: no or a wrong token is 401 with www-authenticate and publishes nothing", async () => {
  const t = await boot({ control: true });
  for (const headers of [{}, t.bearer("wrong"), { authorization: TOKEN }, { authorization: "Basic abc" }, { authorization: "Bearer " }]) {
    const r = await t.answer({ id: "a", allow: true }, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.headers["www-authenticate"], "Bearer");
  }
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-002, DASH-CTRL-001
test("control mode OFF with CONTROL_TOKEN configured: the route is still gated (an Allow lets an action run), unlike /control and /personality", async () => {
  const t = await boot({ token: TOKEN });
  assert.equal((await t.answer({ id: "a", allow: true }, {})).status, 401);
  assert.equal((await t.answer({ id: "a", allow: true }, t.bearer("wrong"))).status, 401);
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.answer({ id: "a", allow: true })).status, 202, "the right token works in this mode too");
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "a", allow: true }]);
});

// @spec DASH-TOOL-002, DASH-CTRL-001
test("no control token configured: 403 naming CONTROL_TOKEN and CONTROL_ENABLED, whatever the request carries, and nothing is published", async () => {
  const t = await boot({ token: null });
  for (const headers of [{}, t.bearer("anything"), t.bearer("")]) {
    const r = await t.answer({ id: "a", allow: true }, headers);
    assert.equal(r.status, 403);
    assert.match(r.text, /CONTROL_TOKEN/);
    assert.match(r.text, /CONTROL_ENABLED/);
  }
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-002
test("the token is judged before the body: an invalid body without the token is 401, with it 400", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.answer("not json", {})).status, 401);
  assert.equal((await t.answer("not json")).status, 400);
});

// @spec DASH-TOOL-002, DASH-HOST-005
test("a request that carries a foreign Origin is refused 403 with the right token, in both control modes, and publishes nothing; the page's own Origin is served", async () => {
  for (const o of [{ control: true }, { token: TOKEN }]) {
    const t = await boot(o);
    for (const origin of ["http://evil.example", "https://127.0.0.1", "null", "http://127.0.0.1:1", "http://localhost.evil.example"]) {
      const r = await t.answer({ id: "a", allow: true }, { ...t.bearer(), origin });
      assert.equal(r.status, 403, `${JSON.stringify(o)} ${origin}`);
    }
    assert.equal(t.bus.published.length, 0);
    // an Origin naming the Host the request used is the dashboard's own page
    const own = await t.answer({ id: "own", allow: true }, { ...t.bearer(), host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234" });
    assert.equal(own.status, 202);
    assert.deepEqual(t.bus.of("tool.answer"), [{ id: "own", allow: true }]);
  }
});

// @spec DASH-TOOL-002
test("a foreign Host is refused 403 as on every full-surface route (DNS rebinding), and the route is not served on the LAN listener", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.answer({ id: "a", allow: true }, { ...t.bearer(), host: "rebind.example" })).status, 403);
  const lan = await t.onLan("/tools/answer", { id: "a", allow: true });
  assert.equal(lan.status, 404);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-TOOL-002, DASH-CTRL-001
test("the control token never appears in the response or in a log line", async () => {
  const t = await boot({ control: true });
  const r = await t.answer({ id: "a", allow: true }, t.bearer("wrong-" + TOKEN));
  assert.equal(r.text.includes(TOKEN), false);
  assert.equal(JSON.stringify(t.rec.lines).includes(TOKEN), false);
});

const tool = { level: "service", as: "tool", text: '{"tool":"stream_info","arguments":{}}' };

// @spec DASH-INJ-001
test("as: tool is accepted only at service level: level bus with as: tool is 400, and service level takes only chat and tool", async () => {
  const t = await boot({ control: true });
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
  const t = await boot({ control: true });
  const text = '  {"tool":"timer",\n "arguments":{"minutes":1,  "note":"a   b"}}  ';
  const r = await t.text({ ...tool, text });
  assert.equal(r.status, 202);
  assert.equal(t.bus.of("inject.request").length, 1);
  assert.deepEqual(t.bus.of("inject.request")[0], { id: json(r).id, target: "tools", kind: "text", text, remember: false });
  assert.deepEqual(t.bus.published.map((p) => p.type), ["inject.request"], "nothing else is published, chat.message least of all");
});

// @spec DASH-INJ-011
test("as: tool never remembers and never carries chat metadata: remember true, user, platform, isMod and isSub are not carried", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.text({ ...tool, remember: true, user: "bob", platform: "twitch", isMod: true, isSub: true })).status, 202);
  const ev = t.bus.of("inject.request")[0]!;
  assert.equal(ev.remember, false);
  assert.equal("meta" in ev, false);
});

// @spec DASH-INJ-011, DASH-CTRL-001
test("as: tool is gated in both control modes: 401 with www-authenticate without the token, 403 when no token is configured, and the chat injection beside it stays open only with no token configured", async () => {
  const on = await boot({ control: true });
  const r = await on.text(tool, {});
  assert.equal(r.status, 401);
  assert.equal(r.headers["www-authenticate"], "Bearer");
  assert.equal((await on.text(tool, on.bearer("wrong"))).status, 401);
  assert.equal(on.bus.published.length, 0);

  const off = await boot({ token: TOKEN });
  assert.equal((await off.text(tool, {})).status, 401, "control off, token configured");
  assert.equal((await off.text(tool, off.bearer("wrong"))).status, 401);
  assert.equal(off.bus.published.length, 0);
  assert.equal((await off.text({ level: "service", text: "hi" }, {})).status, 401, "a configured token gates every injection, control off too");
  assert.equal((await off.text({ level: "service", text: "hi" })).status, 202);
  assert.equal((await off.text(tool)).status, 202, "the right token works with control off");
  assert.deepEqual(off.bus.of("inject.request").map((e) => e.target), ["chat", "tools"]);

  const none = await boot({ token: null });
  for (const headers of [{}, none.bearer("x")]) {
    const x = await none.text(tool, headers);
    assert.equal(x.status, 403);
    assert.match(x.text, /CONTROL_TOKEN/);
  }
  assert.equal((await none.text({ level: "service", text: "hi" }, {})).status, 202);
  assert.deepEqual(none.bus.of("inject.request").map((e) => e.target), ["chat"], "only the chat one went out");
});

// @spec DASH-INJ-011, DASH-HOST-005
test("as: tool with a foreign Origin is refused 403 even with the token, and is not served on the LAN listener", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.text(tool, { ...t.bearer(), origin: "http://evil.example" })).status, 403);
  assert.equal((await t.onLan("/inject/text", tool)).status, 404);
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-INJ-011, MOD-TEST-005
test("as: tool is for the tools unit alone: refused 409 while tools is down, and chat being down does not matter", async () => {
  const down = await boot({ control: true, states: { tools: "down" } });
  const r = await down.text(tool);
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), { ok: false, detail: "service not running: tools" });
  assert.equal(down.bus.published.length, 0);
  const chatDown = await boot({ control: true, states: { chat: "down" } });
  assert.equal((await chatDown.text(tool)).status, 202);
});

// @spec DASH-CTRL-001, DASH-CTRL-004, DASH-CTRL-011
test("with control off and a token configured every mutation needs it: the answer, as: tool, the chat and bus injections; with no token configured only the always-gated ones refuse", async () => {
  const t = await boot({ token: TOKEN });
  assert.equal((await t.answer({ id: "a", allow: true }, {})).status, 401);
  assert.equal((await t.text(tool, {})).status, 401);
  assert.equal((await t.text({ level: "bus", text: "hi" }, {})).status, 401);
  assert.equal((await t.text({ level: "service", text: "hi" }, {})).status, 401);
  assert.equal((await t.text({ level: "service", text: "hi" })).status, 202, "with the token");
  const none = await boot({ token: null });
  assert.equal((await none.answer({ id: "a", allow: true }, {})).status, 403);
  assert.equal((await none.text({ level: "bus", text: "hi" }, {})).status, 202, "nothing to check against");
});

// @spec DASH-TOOL-001
test("the answer id is 1 to 256 characters: empty is 400, 256 is 202, 257 is 400", async () => {
  const t = await boot({ control: true });
  assert.equal((await t.answer({ id: "", allow: true })).status, 400);
  assert.equal((await t.answer({ id: "a".repeat(256), allow: true })).status, 202);
  assert.equal((await t.answer({ id: "a".repeat(257), allow: true })).status, 400);
  assert.deepEqual(t.bus.of("tool.answer"), [{ id: "a".repeat(256), allow: true }]);
});

// @spec DASH-INJ-012
test("as: tool ignores each chat field on its own: remember, user, platform, isMod and isSub change nothing about the published event", async () => {
  const t = await boot({ control: true });
  for (const extra of [{ remember: true }, { user: "bob" }, { platform: "youtube" }, { isMod: true }, { isSub: true }]) {
    assert.equal((await t.text({ ...tool, ...extra })).status, 202, JSON.stringify(extra));
  }
  for (const ev of t.bus.of("inject.request")) {
    assert.deepEqual({ ...ev, id: "x" }, { id: "x", target: "tools", kind: "text", text: tool.text, remember: false });
  }
  assert.equal(t.bus.of("inject.request").length, 5);
});
