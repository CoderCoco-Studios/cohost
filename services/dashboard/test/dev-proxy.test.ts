import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createDevProxy, isProxied, PROXIED_PREFIXES } from "../ui/dev-proxy.js";

/** A stand-in dashboard that records what reached it. */
const seen: { method: string; url: string; host?: string; origin?: string }[] = [];
const target = http.createServer((req, res) => {
  seen.push({ method: req.method!, url: req.url!, host: req.headers.host, origin: req.headers.origin });
  res.writeHead(200, { "content-type": "text/plain" }); res.end("from dashboard");
});
target.on("upgrade", (req, socket) => {
  seen.push({ method: "UPGRADE", url: req.url!, host: req.headers.host, origin: req.headers.origin });
  socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\nhello");
  socket.end();
});
await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
const targetPort = (target.address() as { port: number }).port;

const proxy = createDevProxy(`http://127.0.0.1:${targetPort}`);
const dev = http.createServer((req, res) => { if (!proxy.middleware(req, res)) { res.writeHead(404); res.end("dev server page"); } });
dev.on("upgrade", (req, socket, head) => { proxy.upgrade(req, socket, head); });
await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
const devPort = (dev.address() as { port: number }).port;
after(() => { dev.close(); target.close(); dev.closeAllConnections(); target.closeAllConnections(); });

const call = (method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: devPort, path, method, headers }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject); req.end();
  });

const upgrade = (path: string, headers: Record<string, string> = {}): Promise<string> =>
  new Promise((resolve) => {
    const sock = net.connect(devPort, "127.0.0.1", () => {
      const h = { host: `127.0.0.1:${devPort}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==", "sec-websocket-version": "13", ...headers };
      sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    });
    let out = ""; sock.on("data", (c) => (out += c)); sock.on("close", () => resolve(out)); sock.on("error", () => resolve(out));
  });

// @spec DASH-BUILD-007
test("the proxied prefixes are exactly the dashboard's routes and the dev server's own paths are not proxied", () => {
  assert.deepEqual([...PROXIED_PREFIXES], ["/ws", "/audio", "/services", "/stack", "/personality", "/control", "/mouth", "/inject", "/viewers", "/config", "/secrets", "/options", "/sink", "/health"]);
  for (const p of ["/ws", "/audio/a.wav", "/services/control", "/stack", "/config/schema", "/secrets/llm.openai.api_key", "/options/models", "/health"]) assert.equal(isProxied(p), true, p);
  for (const p of ["/", "/src/main.tsx", "/@vite/client", "/assets/x.js", "/servicesx", "/wsx", "/node_modules/.vite/deps/react.js"]) assert.equal(isProxied(p), false, p);
});

// @spec DASH-BUILD-007
test("a proxied request reaches the dashboard with Host set to the target's and no Origin added", async () => {
  seen.length = 0;
  const r = await call("GET", "/services");
  assert.equal(r.body, "from dashboard");
  assert.equal(seen[0]!.host, `127.0.0.1:${targetPort}`);
  assert.equal(seen[0]!.origin, undefined);
  assert.equal((await call("POST", "/control", {})).status, 200);
  assert.equal(seen[1]!.origin, undefined);
});

// @spec DASH-BUILD-007
test("a state-changing request whose Origin is the dev server's own is forwarded with the Origin rewritten to the target's", async () => {
  seen.length = 0;
  for (const method of ["POST", "PUT", "DELETE"]) {
    const r = await call(method, "/control", { origin: `http://127.0.0.1:${devPort}` });
    assert.equal(r.status, 200, method);
  }
  assert.deepEqual(seen.map((s) => s.origin), Array(3).fill(`http://127.0.0.1:${targetPort}`));
});

// @spec DASH-BUILD-007
test("a state-changing request with any other Origin is refused 403 without contacting the dashboard", async () => {
  seen.length = 0;
  for (const origin of ["http://evil.example", "http://127.0.0.1:9", "null", "not a url", `https://127.0.0.1:${devPort}`]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await call(method, "/secrets/x", { origin });
      assert.equal(r.status, 403, `${method} ${origin}`);
    }
  }
  assert.deepEqual(seen, []);
});

// @spec DASH-BUILD-007
test("a /ws upgrade is forwarded with the Origin rewritten when it is the dev server's own, refused 403 otherwise, and gets no Origin when it sent none", async () => {
  seen.length = 0;
  assert.match(await upgrade("/ws", { origin: `http://127.0.0.1:${devPort}` }), /^HTTP\/1.1 101/);
  assert.equal(seen[0]!.origin, `http://127.0.0.1:${targetPort}`);
  assert.equal(seen[0]!.host, `127.0.0.1:${targetPort}`);
  assert.match(await upgrade("/ws"), /^HTTP\/1.1 101/);
  assert.equal(seen[1]!.origin, undefined);
  const before = seen.length;
  assert.match(await upgrade("/ws", { origin: "http://evil.example" }), /^HTTP\/1.1 403/);
  assert.match(await upgrade("/ws", { origin: "null" }), /^HTTP\/1.1 403/);
  assert.equal(seen.length, before);
});

// @spec DASH-BUILD-007
test("a non-proxied path is left to the dev server", async () => {
  assert.equal((await call("GET", "/src/main.tsx")).body, "dev server page");
});

// @spec DASH-BUILD-007
test("a request or /ws upgrade whose Host is not a loopback name with the dev server's port is refused 403 without contacting the dashboard, Origin matching or not", async () => {
  seen.length = 0;
  const bad = [`evil.example:${devPort}`, `evil.example`, `127.0.0.1.evil.example:${devPort}`, `localhost.evil.example:${devPort}`, `192.168.1.5:${devPort}`, `127.0.0.1:${devPort + 1}`, `localhost`];
  for (const host of bad) {
    assert.equal((await call("GET", "/services", { host })).status, 403, `GET with Host ${host}`);
    assert.equal((await call("POST", "/control", { host, origin: `http://${host}` })).status, 403, `POST with Host ${host}`);
    const ws = await upgrade("/ws", { host, origin: `http://${host}` });
    assert.match(ws, /^HTTP\/1\.1 403/, `upgrade with Host ${host} (a rebinding page controls Host and Origin alike)`);
    const noOrigin = await upgrade("/ws", { host });
    assert.match(noOrigin, /^HTTP\/1\.1 403/, `upgrade with Host ${host} and no Origin`);
  }
  assert.deepEqual(seen, [], "nothing reached the dashboard");
});

// @spec DASH-BUILD-007
test("Host localhost, 127.0.0.1 and [::1] with the dev server's port are served", async () => {
  seen.length = 0;
  for (const host of [`localhost:${devPort}`, `127.0.0.1:${devPort}`, `[::1]:${devPort}`]) {
    assert.equal((await call("GET", "/services", { host })).status, 200, host);
    const ws = await upgrade("/ws", { host, origin: `http://${host}` });
    assert.match(ws, /^HTTP\/1\.1 101/, host);
  }
});
