import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { hostPermitted, startListeners, type Listeners } from "../src/host.js";

// The Host rule of every listener other machines can reach (the LAN listener, and the full surface when it is not bound to
// loopback), and the Origin rule of its state-changing route (`POST /sink`), as one table per surface.

const log = { info: () => {}, warn: () => {}, fatal: () => {} } as never;
const ALLOWED = ["streampc"];

interface Boot { l: Listeners; hits: string[]; wss: WebSocketServer }
async function boot(bind: string, allowedHosts: string[] = ALLOWED): Promise<Boot> {
  const hits: string[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const handler: http.RequestListener = (req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200); res.end("ok"); };
  const l = await startListeners({ handler, wss, bind, port: 0, lanPort: 0, lanHost: "127.0.0.1", controlEnabled: true, allowedHosts, log, exit: () => {} });
  assert.ok(l);
  after(() => { void l!.close(); });
  return { l: l!, hits, wss };
}

/** One request with the given headers (`host: undefined` sends HTTP/1.0 with none); resolves the status code. */
function send(port: number, method: string, path: string, headers: Record<string, string | undefined>): Promise<number> {
  if (!("host" in headers) || headers.host !== undefined) {
    return new Promise((resolve, reject) => {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: clean, setHost: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  }
  return rawStatus(port, `${method} ${path} HTTP/1.0\r\n${Object.entries(headers).filter(([k, v]) => k !== "host" && v !== undefined).map(([k, v]) => `${k}: ${v}\r\n`).join("")}content-length: 0\r\n\r\n`);
}

function rawStatus(port: number, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf); if (m) { s.destroy(); resolve(Number(m[1])); } });
    s.on("error", reject);
    s.on("close", () => { if (!/^HTTP/.test(buf)) resolve(0); });
  });
}

/** `/ws` with the given headers: "open", or the refusing status. An absent Host goes over a raw HTTP/1.0 socket. */
function upgrade(port: number, headers: Record<string, string | undefined>): Promise<"open" | number> {
  if ("host" in headers && headers.host === undefined) {
    return rawStatus(port, `GET /ws HTTP/1.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers.origin ? `Origin: ${headers.origin}\r\n` : ""}\r\n`).then((c) => (c === 101 ? "open" : c));
  }
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: clean });
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
    ws.on("error", (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

// host header, whether it is accepted
const HOSTS: [string | undefined, boolean][] = [
  ["192.168.1.5:3001", true], ["10.0.0.2", true], ["[fe80::1]:3001", true], ["[::1]:3001", true], ["127.0.0.1:3001", true],
  ["localhost:3001", true], ["LOCALHOST:3001", true], ["localhost.:3001", true],
  ["streampc:3001", true], ["streampc", true], ["STREAMPC:3001", true], ["streampc.:3001", true], ["StreamPC.:9999", true],
  ["otherpc:3001", false], ["evil.example:3001", false],
  ["1.2.3.4.evil.example:3001", false], ["192.168.1.5.evil.example", false], ["streampc.evil.example:3001", false], ["evilstreampc:3001", false],
  ["999.1.1.1", false], ["256.0.0.1:3001", false], ["010.1.1.1", false], ["0x7f.1", false], ["2130706433", false], ["1.2.3", false], ["1.2.3.4.", false],
  ["[not-an-ip]", false], ["evil.example@192.168.1.5", false], ["192.168.1.5:3001:1", false], ["a b", false], ["", false], [undefined, false],
];

// @spec DASH-HOST-009
test("hostPermitted: an IP literal, localhost or a listed name, any case and with a trailing dot, any port; nothing else", () => {
  for (const [h, ok] of HOSTS) assert.equal(hostPermitted(h, ALLOWED), ok, String(h));
  assert.equal(hostPermitted("streampc", []), false, "an empty list allows no name");
  assert.equal(hostPermitted("192.168.1.5", []), true);
});

for (const surface of ["LAN listener", "full surface bound beyond loopback"] as const) {
  const port = (b: Boot) => (surface === "LAN listener" ? b.l.lanPort : b.l.fullPort);
  const mk = () => boot(surface === "LAN listener" ? "127.0.0.1" : "0.0.0.0");

  // @spec DASH-HOST-009
  test(`${surface}: every GET is answered 403 for a Host that is not an IP literal, localhost or a listed name, and reaches no route`, async () => {
    const b = await mk();
    for (const [host, ok] of HOSTS) {
      for (const path of surface === "LAN listener" ? ["/health", "/audio/x.wav"] : ["/health", "/config/dashboard", "/personality", "/services", "/stack", "/audio/x.wav"]) {
        const before = b.hits.length;
        const status = await send(port(b), "GET", path, { host });
        assert.equal(status, ok ? 200 : 403, `GET ${path} Host ${JSON.stringify(host)}`);
        assert.equal(b.hits.length - before, ok ? 1 : 0, `${path} Host ${JSON.stringify(host)}: ${ok ? "served" : "nothing ran"}`);
      }
    }
  });

  // @spec DASH-HOST-009
  test(`${surface}: with no allowed names, a name Host is refused and an address Host is served`, async () => {
    const b = await boot(surface === "LAN listener" ? "127.0.0.1" : "0.0.0.0", []);
    assert.equal(await send(port(b), "GET", "/health", { host: "streampc:3001" }), 403);
    assert.equal(await send(port(b), "GET", "/health", { host: "192.168.1.5:3001" }), 200);
  });

  // @spec DASH-HOST-008, DASH-HOST-009
  test(`${surface}: a /ws upgrade is held to the same Host rule with or without an Origin, and to the Origin rule`, async () => {
    const b = await mk();
    for (const [host, ok] of HOSTS) {
      if (host !== "") { // an empty Host cannot be sent by this client; hostPermitted refuses it (above)
        const bare = await upgrade(port(b), { host });
        assert.equal(bare, ok ? "open" : 403, `no Origin, Host ${JSON.stringify(host)}`);
      }
      if (host !== undefined && host !== "") {
        const same = await upgrade(port(b), { host, origin: `http://${host}` });
        assert.equal(same, ok ? "open" : 403, `own Origin, Host ${JSON.stringify(host)}`);
      }
    }
    for (const origin of ["null", "http://evil.example", "not a url"]) {
      assert.equal(await upgrade(port(b), { host: "192.168.1.5:3001", origin }), 403, `Origin ${origin}`);
    }
    assert.equal(b.wss.clients.size, 0);
  });
}

// @spec DASH-HOST-010
test("POST /sink on the LAN listener: no Origin passes; an Origin must name the Host's host and port; any other, null or unparsable is 403 and nothing is published", async () => {
  const b = await boot("127.0.0.1");
  const h = "192.168.1.5:3001";
  const table: [string, string | undefined, string | undefined, number][] = [
    ["no Origin", h, undefined, 200],
    ["same origin by IP", h, `http://${h}`, 200],
    ["same origin, upper-case name with a trailing dot", "STREAMPC.:3001", "http://streampc.:3001", 200],
    ["same origin by allowed name", "streampc:3001", "http://streampc:3001", 200],
    ["cross-site Origin", h, "http://evil.example", 403],
    ["cross-site Origin that names the host with another port", h, "http://192.168.1.5:3002", 403],
    ["Origin: null", h, "null", 403],
    ["unparsable Origin", h, "not a url", 403],
    ["https Origin naming the same host and port", h, `https://${h}`, 403],
    ["same origin but a Host that is refused", "evil.example:3001", "http://evil.example:3001", 403],
    ["no Origin but a Host that is refused", "evil.example:3001", undefined, 403],
    ["no Host", undefined, undefined, 403],
  ];
  for (const [name, host, origin, expected] of table) {
    const before = b.hits.length;
    assert.equal(await send(b.l.lanPort, "POST", "/sink", { host, origin, "content-type": "text/plain" }), expected, name);
    assert.equal(b.hits.length - before, expected === 200 ? 1 : 0, `${name}: ${expected === 200 ? "reached the handler" : "nothing ran"}`);
  }
});

// @spec DASH-HOST-010
test("POST /sink on a full surface bound beyond loopback follows the same Origin rule", async () => {
  const b = await boot("0.0.0.0");
  const h = "192.168.1.5:3000";
  assert.equal(await send(b.l.fullPort, "POST", "/sink", { host: h, origin: "http://evil.example" }), 403);
  assert.equal(await send(b.l.fullPort, "POST", "/sink", { host: h, origin: "null" }), 403);
  assert.equal(await send(b.l.fullPort, "POST", "/sink", { host: h, origin: `https://${h}` }), 403);
  assert.equal(await send(b.l.fullPort, "POST", "/sink", { host: h, origin: `http://${h}` }), 200);
  assert.equal(await send(b.l.fullPort, "POST", "/sink", { host: h }), 200);
});

// @spec DASH-HOST-004
test("a full surface bound to loopback keeps its own Host rule: loopback names only, whatever dashboard.allowed_hosts holds", async () => {
  const b = await boot("127.0.0.1");
  for (const [host, ok] of [["localhost:3000", true], ["127.0.0.1:3000", true], ["[::1]:3000", true], ["192.168.1.5:3000", false], ["streampc:3000", false], ["evil.example", false]] as const) {
    assert.equal(await send(b.l.fullPort, "GET", "/health", { host }), ok ? 200 : 403, host);
  }
});
