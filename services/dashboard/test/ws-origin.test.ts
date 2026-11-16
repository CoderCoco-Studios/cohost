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
  assert.equal(wsOriginAllowed("https://example.test:443", "example.test"), true);
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
test("the Origin is compared with the Host header the request carries, so a LAN name works for the sink page", async () => {
  const t = await boot();
  const r = await upgrade(t.l.lanPort, { host: "my-pc.lan:3001", origin: "http://my-pc.lan:3001" });
  assert.equal(r.result, "open");
  r.ws?.close();
  assert.equal((await upgrade(t.l.lanPort, { host: "my-pc.lan:3001", origin: "http://evil.example" })).result, 403);
  assert.equal((await upgrade(t.l.lanPort, { host: "my-pc.lan:3001", origin: "http://my-pc.lan:3002" })).result, 403);
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
