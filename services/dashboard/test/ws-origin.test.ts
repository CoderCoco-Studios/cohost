import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { startListeners, wsOriginAllowed, type Listeners } from "../src/host.js";

const log = { info: () => {}, warn: () => {}, fatal: () => {} } as never;

async function boot(bind = "127.0.0.1") {
  const wss = new WebSocketServer({ noServer: true });
  const handler: http.RequestListener = (_req, res) => { res.writeHead(200); res.end("ok"); };
  const l = await startListeners({ handler, wss, bind, port: 0, lanPort: 0, lanHost: "127.0.0.1", controlEnabled: true, log, exit: () => {} });
  assert.ok(l);
  after(() => { void l!.close(); });
  return { l: l as Listeners, wss };
}

/** Opens `/ws` with the given headers; resolves "open" or the refusing HTTP status. */
function upgrade(port: number, headers: Record<string, string>): Promise<{ result: "open" | number; ws?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => resolve({ result: "open", ws }));
    ws.on("unexpected-response", (_req, res) => { res.resume(); resolve({ result: res.statusCode ?? 0 }); });
    ws.on("error", (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

// @spec DASH-HOST-008
test("wsOriginAllowed: absent is accepted; a same host and port (defaults explicit) is accepted; null, unparsable or different is refused", () => {
  assert.equal(wsOriginAllowed(undefined, "localhost:3000"), true);
  assert.equal(wsOriginAllowed("http://localhost:3000", "localhost:3000"), true);
  assert.equal(wsOriginAllowed("http://example.test", "example.test:80"), true);
  assert.equal(wsOriginAllowed("https://example.test:443", "example.test"), false);
  for (const [o, h] of [["null", "localhost:3000"], ["", "localhost:3000"], ["not a url", "localhost:3000"], ["http://evil.example", "localhost:3000"], ["http://localhost:3001", "localhost:3000"], ["http://localhost:3000", undefined], ["http://localhost:3000, http://evil.example", "localhost:3000"]] as const) {
    assert.equal(wsOriginAllowed(o, h), false, `${o} vs ${h}`);
  }
});

// @spec DASH-HOST-008
test("a /ws upgrade with a cross-site, null or unparsable Origin is 403 on both listeners and joins nothing", async () => {
  const t = await boot();
  for (const port of [t.l.fullPort, t.l.lanPort]) {
    for (const origin of ["http://evil.example", "null", "not a url", `http://127.0.0.1:${port + 1}`, "file://", "http://evil.example:80"]) {
      const r = await upgrade(port, { origin });
      assert.equal(r.result, 403, `${port} ${origin}`);
    }
  }
  assert.equal(t.wss.clients.size, 0);
});

// @spec DASH-HOST-008
test("a /ws upgrade whose Origin equals its Host, or that has no Origin, is accepted on both listeners", async () => {
  const t = await boot();
  const opened: WebSocket[] = [];
  for (const port of [t.l.fullPort, t.l.lanPort]) {
    const same = await upgrade(port, { origin: `http://127.0.0.1:${port}` });
    assert.equal(same.result, "open", `same origin on ${port}`);
    opened.push(same.ws!);
    const none = await upgrade(port, {});
    assert.equal(none.result, "open", `no origin on ${port}`);
    opened.push(none.ws!);
  }
  assert.equal(t.wss.clients.size, 4);
  for (const ws of opened) ws.close();
});

// @spec DASH-HOST-008
test("a browser upgrade (one that carries an Origin) on a listener the LAN can reach is accepted only when its Host is an IP literal or a loopback name, so a DNS-rebinding page whose Origin equals its Host is refused", async () => {
  const t = await boot();
  const opened: WebSocket[] = [];
  const hosts = [`192.168.1.5:${t.l.lanPort}`, `10.0.0.2`, `[fe80::1]:${t.l.lanPort}`, `[::1]:${t.l.lanPort}`, `localhost:${t.l.lanPort}`, `127.0.0.1:${t.l.lanPort}`];
  for (const host of hosts) {
    const r = await upgrade(t.l.lanPort, { host, origin: `http://${host}` });
    assert.equal(r.result, "open", `IP literal or loopback name ${host}`);
    if (r.ws) opened.push(r.ws);
  }
  for (const host of [`my-pc.lan:${t.l.lanPort}`, `rebind.evil.example:${t.l.lanPort}`, "streampc", `localhost.evil.example:${t.l.lanPort}`, `127.0.0.1.evil.example:${t.l.lanPort}`]) {
    const r = await upgrade(t.l.lanPort, { host, origin: `http://${host}` });
    assert.equal(r.result, 403, `a DNS name ${host} with a matching Origin is refused`);
  }
  for (const ws of opened) ws.close();
  assert.equal((await upgrade(t.l.lanPort, { host: "192.168.1.5", origin: "http://evil.example" })).result, 403, "an IP-literal Host still needs a matching Origin");
});

// @spec DASH-HOST-008, DASH-HOST-009
test("an upgrade with no Origin is held to the Host rule too: a name that is not allowed is refused, an address is accepted", async () => {
  const t = await boot();
  assert.equal((await upgrade(t.l.lanPort, { host: "my-pc.lan:3001" })).result, 403);
  const r = await upgrade(t.l.lanPort, { host: "192.168.1.5:3001" });
  assert.equal(r.result, "open");
  r.ws?.close();
});

// @spec DASH-HOST-008, DASH-HOST-004
test("the loopback-bound full surface refuses an upgrade whose Host is not a loopback name even when its Origin equals it, as it does any other request", async () => {
  const t = await boot();
  const port = t.l.fullPort;
  assert.equal((await upgrade(port, { host: `rebind.evil.example:${port}`, origin: `http://rebind.evil.example:${port}` })).result, 403);
  assert.equal((await upgrade(port, { host: `rebind.evil.example:${port}` })).result, 403, "no Origin does not help");
  const ok = await upgrade(port, { host: `localhost:${port}`, origin: `http://localhost:${port}` });
  assert.equal(ok.result, "open");
  ok.ws?.close();
});

// @spec DASH-HOST-008
test("a non-loopback full surface checks the Origin too", async () => {
  const t = await boot("0.0.0.0");
  assert.equal((await upgrade(t.l.fullPort, { origin: "http://evil.example" })).result, 403);
  const ok = await upgrade(t.l.fullPort, {});
  assert.equal(ok.result, "open");
  ok.ws?.close();
});

// @spec DASH-HOST-008
test("an upgrade to a path other than /ws is still refused, and a refused Origin never reaches the WebSocket server", async () => {
  const t = await boot();
  let connections = 0;
  t.wss.on("connection", () => { connections++; });
  await upgrade(t.l.fullPort, { origin: "http://evil.example" });
  assert.equal(connections, 0);
});
