import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  guardFullSurface, hostAllowed, lanAllows, lanHandler, originAllowed, resolvePorts, startListeners,
} from "../src/host.js";

const lines: { level: string; obj: unknown; msg?: string }[] = [];
const log = {
  info: (obj: unknown, msg?: string) => lines.push({ level: "info", obj, msg }),
  warn: (obj: unknown, msg?: string) => lines.push({ level: "warn", obj, msg }),
  error: (obj: unknown, msg?: string) => lines.push({ level: "error", obj, msg }),
  fatal: (obj: unknown, msg?: string) => lines.push({ level: "fatal", obj, msg }),
} as never;

/** Raw request, so a test can choose its own Host and Origin. */
function raw(port: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const handled: string[] = [];
const echo: http.RequestListener = (req, res) => { handled.push(`${req.method} ${req.url}`); res.writeHead(200); res.end("full"); };

async function boot(over: { bind?: string; controlEnabled?: boolean; handler?: http.RequestListener } = {}) {
  handled.length = 0;
  const wss = new WebSocketServer({ noServer: true });
  const l = await startListeners({
    handler: over.handler ?? echo, wss, bind: over.bind ?? "127.0.0.1", port: 0, lanPort: 0, lanHost: "127.0.0.1",
    controlEnabled: over.controlEnabled ?? true, log, exit: () => {},
  });
  assert.ok(l);
  after(() => { void l!.close(); });
  return { l: l!, wss };
}

// @spec DASH-HTTP-009
test("ports: PORT wins over DASHBOARD_PORT wins over the config port; empty values are skipped; the LAN port defaults to 3001", () => {
  assert.deepEqual(resolvePorts({ PORT: "4000", DASHBOARD_PORT: "5000" }, 3000), { port: 4000, lanPort: 3001 });
  assert.deepEqual(resolvePorts({ DASHBOARD_PORT: "5000" }, 3000), { port: 5000, lanPort: 3001 });
  assert.deepEqual(resolvePorts({ PORT: "", DASHBOARD_PORT: "" }, 3000), { port: 3000, lanPort: 3001 });
  assert.deepEqual(resolvePorts({ DASHBOARD_LAN_PORT: "4001" }, 3000), { port: 3000, lanPort: 4001 });
  assert.deepEqual(resolvePorts({ DASHBOARD_LAN_PORT: "" }, 3000), { port: 3000, lanPort: 3001 });
});

// @spec DASH-HOST-002
test("the LAN allow-list is exactly GET /, GET /audio/*, POST /sink, any /health", () => {
  const yes: [string, string][] = [["GET", "/"], ["GET", "/audio/abc.wav"], ["POST", "/sink"], ["GET", "/health"], ["POST", "/health"], ["DELETE", "/health"]];
  const no: [string, string][] = [
    ["POST", "/"], ["GET", "/sink"], ["POST", "/audio/x"], ["GET", "/uploads/ab12"], ["POST", "/uploads/x"], ["GET", "/stack"], ["POST", "/stack/launch"],
    ["GET", "/services"], ["GET", "/services/control"], ["POST", "/services/cortex/restart"], ["GET", "/personality"], ["PUT", "/personality"],
    ["POST", "/control"], ["POST", "/inject/text"], ["GET", "/viewers"], ["GET", "/ws"], ["GET", "/index.html"], ["GET", "/healthz"],
  ];
  for (const [m, p] of yes) assert.equal(lanAllows(m, p), true, `${m} ${p}`);
  for (const [m, p] of no) assert.equal(lanAllows(m, p), false, `${m} ${p}`);
});

// @spec DASH-HOST-002
test("the LAN handler delegates the allowed requests and answers every other request 404 without running anything", async () => {
  const seen: string[] = [];
  const h = lanHandler((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200); res.end("ok"); });
  const server = http.createServer(h);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  assert.equal((await raw(port, "/?sink=1")).status, 200);
  assert.equal((await raw(port, "/audio/a.wav")).status, 200);
  for (const [m, p] of [["POST", "/stack/launch"], ["GET", "/stack"], ["PUT", "/personality"], ["POST", "/inject/text"], ["POST", "/services/cortex/stop"]] as const) {
    const r = await raw(port, p, { method: m });
    assert.deepEqual([r.status, r.body], [404, "not found"], `${m} ${p}`);
  }
  assert.deepEqual(seen, ["GET /?sink=1", "GET /audio/a.wav"]);
});

// @spec DASH-HOST-001
test("both listeners share one handler; the LAN listener is separate from the full-surface one", async () => {
  const t = await boot();
  assert.notEqual(t.l.fullPort, t.l.lanPort);
  assert.equal((await raw(t.l.fullPort, "/stack")).body, "full");
  assert.equal((await raw(t.l.lanPort, "/")).body, "full");
  assert.equal((await raw(t.l.lanPort, "/stack")).status, 404);
  assert.deepEqual(handled, ["GET /stack", "GET /"]);
});

// @spec DASH-HOST-001
test("a /ws upgrade works on both listeners and both sockets join the one WebSocket server", async () => {
  const t = await boot();
  const open = (port: number) => new Promise<WebSocket>((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); ws.on("open", () => resolve(ws)); ws.on("error", reject); });
  const a = await open(t.l.fullPort), b = await open(t.l.lanPort);
  assert.equal(t.wss.clients.size, 2);
  a.close(); b.close();
});

// @spec DASH-HOST-001
test("an upgrade to any path other than /ws is refused", async () => {
  const t = await boot();
  await assert.rejects(new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${t.l.lanPort}/other`); ws.on("open", resolve); ws.on("error", reject); }));
});

// @spec DASH-HOST-004
test("Host check: loopback names pass; anything else is refused; IPv6 brackets and ports are stripped", () => {
  for (const h of ["localhost", "localhost:3000", "LOCALHOST:3000", "127.0.0.1", "127.0.0.1:3000", "127.9.9.9:1", "[::1]", "[::1]:3000"]) assert.equal(hostAllowed(h), true, h);
  for (const h of [undefined, "", "evil.example", "evil.example:3000", "localhost.evil.example", "128.0.0.1", "[::2]:3000", "10.0.0.5:3000", "0.0.0.0", "a b", "127.evil.example"]) assert.equal(hostAllowed(h), false, String(h));
});

// @spec DASH-HOST-004
test("loopback-bound full surface: a foreign Host is 403 on every request and /ws upgrade; the handler never runs", async () => {
  const t = await boot();
  const bad = await raw(t.l.fullPort, "/", { headers: { host: "rebind.example:3000" } });
  assert.equal(bad.status, 403);
  assert.equal((await raw(t.l.fullPort, "/personality", { headers: { host: "rebind.example" } })).status, 403);
  assert.deepEqual(handled, []);
  assert.equal((await raw(t.l.fullPort, "/", { headers: { host: `localhost:${t.l.fullPort}` } })).status, 200);
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${t.l.fullPort}/ws`, { headers: { host: "rebind.example" } });
    ws.on("open", resolve); ws.on("unexpected-response", (_r, res) => reject(new Error(`status ${res.statusCode}`)));  ws.on("error", reject);
  }), /403/);
});

// @spec DASH-HOST-004
test("a full surface bound to a non-loopback address does not check Host", async () => {
  const seen: string[] = [];
  const g = guardFullSurface((_req, res) => { seen.push("hit"); res.writeHead(200); res.end(); }, { loopback: false, controlEnabled: true });
  const server = http.createServer(g);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  assert.equal((await raw((server.address() as net.AddressInfo).port, "/", { headers: { host: "my-pc.lan:3000" } })).status, 200);
  assert.deepEqual(seen, ["hit"]);
});

// @spec DASH-HOST-005
test("Origin check: same host and port (defaults explicit) passes; null, unparsable or different is refused", () => {
  assert.equal(originAllowed("http://localhost:3000", "localhost:3000"), true);
  assert.equal(originAllowed("http://127.0.0.1:3000", "127.0.0.1:3000"), true);
  assert.equal(originAllowed("http://example.test", "example.test:80"), true);
  assert.equal(originAllowed("https://example.test", "example.test:443"), true);
  assert.equal(originAllowed("http://example.test:80", "example.test"), true);
  for (const [o, h] of [["null", "localhost:3000"], ["not a url", "localhost:3000"], ["http://evil.example", "localhost:3000"], ["http://localhost:3001", "localhost:3000"], ["http://localhost", "localhost:3000"], ["http://localhost:3000", undefined]] as const) {
    assert.equal(originAllowed(o, h), false, `${o} vs ${h}`);
  }
});

// @spec DASH-HOST-005
test("a POST, PUT or DELETE with a foreign Origin is 403 and runs nothing; GET, and a request with no Origin, are unaffected", async () => {
  const t = await boot();
  const host = `127.0.0.1:${t.l.fullPort}`;
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await raw(t.l.fullPort, "/control", { method, headers: { host, origin: "http://evil.example" } })).status, 403, method);
    assert.equal((await raw(t.l.fullPort, "/control", { method, headers: { host, origin: "null" } })).status, 403, method);
  }
  assert.deepEqual(handled, []);
  assert.equal((await raw(t.l.fullPort, "/control", { method: "POST", headers: { host } })).status, 200);
  assert.equal((await raw(t.l.fullPort, "/control", { method: "POST", headers: { host, origin: `http://${host}` } })).status, 200);
  assert.equal((await raw(t.l.fullPort, "/personality", { headers: { host, origin: "http://evil.example" } })).status, 200);
});

// @spec DASH-HOST-005
test("Origin applies on a non-loopback full surface too (but Host does not)", async () => {
  const g = guardFullSurface((_req, res) => { res.writeHead(200); res.end(); }, { loopback: false, controlEnabled: true });
  const server = http.createServer(g);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  assert.equal((await raw(port, "/control", { method: "POST", headers: { host: "my-pc.lan:3000", origin: "http://evil.example" } })).status, 403);
  assert.equal((await raw(port, "/control", { method: "POST", headers: { host: "my-pc.lan:3000", origin: "http://my-pc.lan:3000" } })).status, 200);
});

// @spec DASH-STACK-002
test("with control disabled a stack or lifecycle POST answers the handler's 404 before the Host/Origin 403", async () => {
  const g = guardFullSurface((_req, res) => { res.writeHead(404); res.end("not found"); }, { loopback: true, controlEnabled: false });
  const server = http.createServer(g);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  const evil = { host: "rebind.example", origin: "http://evil.example" };
  assert.equal((await raw(port, "/stack/launch", { method: "POST", headers: evil })).status, 404);
  assert.equal((await raw(port, "/services/cortex/stop", { method: "POST", headers: evil })).status, 404);
  assert.equal((await raw(port, "/control", { method: "POST", headers: evil })).status, 403);
});

// @spec DASH-HOST-003
test("a full-surface port that is taken logs fatal naming the address and port, with the compose hint, and exits 1", async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  after(() => blocker.close());
  const taken = (blocker.address() as net.AddressInfo).port;
  lines.length = 0;
  const codes: number[] = [];
  const l = await startListeners({ handler: echo, wss: new WebSocketServer({ noServer: true }), bind: "127.0.0.1", port: taken, lanPort: 0, lanHost: "127.0.0.1", controlEnabled: true, log, exit: (c) => { codes.push(c); } });
  assert.equal(l, undefined);
  assert.deepEqual(codes, [1]);
  const fatal = lines.filter((x) => x.level === "fatal");
  assert.equal(fatal.length, 1);
  assert.match(String(fatal[0]!.msg), new RegExp(`127\\.0\\.0\\.1:${taken}`));
  assert.match(String(fatal[0]!.msg), /docker compose down --remove-orphans/);
});

// @spec DASH-HOST-003
test("a LAN port that is taken is fatal too, and names the LAN address and port; other bind errors name no compose hint", async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  after(() => blocker.close());
  const taken = (blocker.address() as net.AddressInfo).port;
  lines.length = 0;
  const codes: number[] = [];
  const l = await startListeners({ handler: echo, wss: new WebSocketServer({ noServer: true }), bind: "127.0.0.1", port: 0, lanPort: taken, lanHost: "127.0.0.1", controlEnabled: true, log, exit: (c) => { codes.push(c); } });
  assert.equal(l, undefined);
  assert.deepEqual(codes, [1]);
  assert.match(String(lines.find((x) => x.level === "fatal")!.msg), new RegExp(`127\\.0\\.0\\.1:${taken}`));
  lines.length = 0;
  await startListeners({ handler: echo, wss: new WebSocketServer({ noServer: true }), bind: "203.0.113.9", port: 0, lanPort: 0, lanHost: "127.0.0.1", controlEnabled: true, log, exit: (c) => { codes.push(c); } });
  const other = lines.find((x) => x.level === "fatal")!;
  assert.match(String(other.msg), /203\.0\.113\.9/);
  assert.doesNotMatch(String(other.msg), /remove-orphans/);
});

// @spec DASH-HOST-006
test("startup logs the full-surface URL from the address and port actually bound, and the LAN port", async () => {
  lines.length = 0;
  const t = await boot();
  const online = lines.find((l) => l.level === "info" && /dashboard online/.test(String(l.msg)));
  assert.ok(online);
  const text = JSON.stringify(online);
  assert.ok(text.includes(`http://127.0.0.1:${t.l.fullPort}`), text);
  assert.ok(text.includes(String(t.l.lanPort)), text);
});

// @spec DASH-HTTP-009
test("startListeners resolves (so the heartbeat can go ready) only once both listeners are listening", async () => {
  const t = await boot();
  assert.ok(t.l.full.listening && t.l.lan.listening);
});

// @spec DASH-HTTP-010
test("close() stops both listeners and the WebSocket server's clients, and returns without waiting for anything else", async () => {
  const wss = new WebSocketServer({ noServer: true });
  const l = (await startListeners({ handler: echo, wss, bind: "127.0.0.1", port: 0, lanPort: 0, lanHost: "127.0.0.1", controlEnabled: true, log, exit: () => {} }))!;
  const ws = new WebSocket(`ws://127.0.0.1:${l.fullPort}/ws`);
  await new Promise((r) => ws.on("open", r));
  const closed = new Promise((r) => ws.on("close", r));
  await l.close();
  await closed;
  assert.equal(l.full.listening, false);
  assert.equal(l.lan.listening, false);
});
