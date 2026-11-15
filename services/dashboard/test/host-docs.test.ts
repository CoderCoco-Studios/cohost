import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { lanAllows, lanHandler } from "../src/host.js";

const call = (port: number, path: string, method: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });

// @spec DASH-DOCS-012
test("a docs path on the LAN listener is a 404 `not found` for every method, and nothing runs", async () => {
  const seen: string[] = [];
  const server = http.createServer(lanHandler((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200); res.end("ok"); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); server.closeAllConnections(); });
  const port = (server.address() as { port: number }).port;
  for (const m of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
    for (const p of ["/cohost", "/cohost/", "/cohost/guide/operate/health", "/cohost/assets/a.js", "/cohost/%00"]) {
      const r = await call(port, p, m);
      assert.equal(r.status, 404, `${m} ${p}`);
      if (m !== "HEAD") assert.equal(r.body, "not found", `${m} ${p}`);
    }
  }
  assert.deepEqual(seen, []);
  for (const m of ["GET", "HEAD", "POST"]) assert.equal(lanAllows(m, "/cohost/"), false, m);
});
