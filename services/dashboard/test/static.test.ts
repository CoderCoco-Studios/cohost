import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUi, locateUiDir } from "../src/static.js";

/** A fake `dist-ui` with an index, one hashed asset and a favicon, plus a file outside it that a traversal must never reach. */
const root = mkdtempSync(join(tmpdir(), "dash-ui-"));
const ui = join(root, "dist-ui");
mkdirSync(join(ui, "assets"), { recursive: true });
writeFileSync(join(ui, "index.html"), `<!doctype html><title>__COHOST_NAME__ dashboard</title><meta name="cohost-name" content="__COHOST_NAME__"><script type="module" src="/assets/index-abc.js"></script>`);
writeFileSync(join(ui, "assets", "index-abc.js"), "console.log(1)");
writeFileSync(join(ui, "assets", "index-abc.css"), "body{}");
writeFileSync(join(ui, "favicon.svg"), "<svg/>");
writeFileSync(join(root, "secret.txt"), "TOP SECRET");
symlinkSync(join(root, "secret.txt"), join(ui, "assets", "leak.txt"));
after(() => rmSync(root, { recursive: true, force: true }));

function serve(dir: string, name: string) {
  const server = http.createServer((req, res) => {
    if (!handleUi(dir, name, req, res, new URL(req.url ?? "/", "http://x"))) { res.writeHead(404); res.end("fell through"); }
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    resolve({ base, close: () => { server.close(); server.closeAllConnections(); } });
  }));
}

const main = await serve(ui, "Coco");
const empty = await serve(join(root, "nowhere"), "Coco");
after(() => { main.close(); empty.close(); });

// @spec DASH-HTTP-001
test("GET / serves the built index with every co-host name occurrence HTML-escaped, uncached, read per request", async () => {
  const r = await fetch(`${main.base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const body = await r.text();
  assert.match(body, /<title>Coco dashboard<\/title>/);
  assert.match(body, /<meta name="cohost-name" content="Coco">/);
  assert.ok(!body.includes("__COHOST_NAME__"));
  // Read per request: a rebuilt index is visible without a restart.
  writeFileSync(join(ui, "index.html"), "<p>__COHOST_NAME__ v2</p>");
  assert.equal(await (await fetch(`${main.base}/`)).text(), "<p>Coco v2</p>");
  writeFileSync(join(ui, "index.html"), `<title>__COHOST_NAME__ dashboard</title><meta name="cohost-name" content="__COHOST_NAME__"><script type="module" src="/assets/index-abc.js"></script>`);
});

// @spec DASH-HTTP-001
test("the co-host name is escaped as HTML and `$` stays literal", async () => {
  const evil = await serve(ui, `A&B <i>"x"</i> 'y' $& $1`);
  after(() => evil.close());
  const body = await (await fetch(`${evil.base}/`)).text();
  assert.match(body, /content="A&amp;B &lt;i&gt;&quot;x&quot;&lt;\/i&gt; &#39;y&#39; \$&amp; \$1"/);
  assert.ok(!body.includes("<i>"));
});

// @spec DASH-BUILD-003
test("GET and HEAD for an asset answer the file with type, length, nosniff, etag and the immutable cache; favicon is no-cache", async () => {
  for (const method of ["GET", "HEAD"]) {
    const r = await fetch(`${main.base}/assets/index-abc.js`, { method });
    assert.equal(r.status, 200, method);
    assert.equal(r.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(r.headers.get("content-length"), "14");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(r.headers.get("etag")!, /^W\/"e-[0-9a-f]+"$/);
    assert.equal(await r.text(), method === "GET" ? "console.log(1)" : "");
  }
  assert.equal((await fetch(`${main.base}/assets/index-abc.css`)).headers.get("content-type"), "text/css; charset=utf-8");
  const fav = await fetch(`${main.base}/favicon.svg`);
  assert.equal(fav.headers.get("content-type"), "image/svg+xml");
  assert.equal(fav.headers.get("cache-control"), "no-cache");
});

// @spec DASH-BUILD-003
test("a matching If-None-Match answers 304 with only etag and cache-control", async () => {
  const first = await fetch(`${main.base}/assets/index-abc.js`);
  const etag = first.headers.get("etag")!;
  const r = await fetch(`${main.base}/assets/index-abc.js`, { headers: { "if-none-match": etag } });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("etag"), etag);
  assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await r.text(), "");
  assert.equal((await fetch(`${main.base}/assets/index-abc.js`, { headers: { "if-none-match": "*" } })).status, 304);
});

// @spec DASH-BUILD-004
test("a missing file, a directory and a symlink out of dist-ui are a plain-text 404 that reads nothing outside", async () => {
  for (const p of ["/assets/nope.js", "/assets/", "/assets", "/assets/leak.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/favicon.svg/x"]) {
    const r = await fetch(`${main.base}${p}`);
    assert.ok(r.status === 404, `${p} -> ${r.status}`);
    const text = await r.text();
    assert.ok(!text.includes("TOP SECRET"), p);
  }
  const r = await fetch(`${main.base}/assets/nope.js`);
  assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await r.text(), "not found");
});

// @spec DASH-BUILD-004
test("a malformed escape or a NUL in an asset path is a 400", async () => {
  assert.equal((await fetch(`${main.base}/assets/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${main.base}/assets/a%00b.js`)).status, 400);
});

// @spec DASH-BUILD-003
test("only GET and HEAD are served here; any other method falls through to the router", async () => {
  assert.equal((await fetch(`${main.base}/assets/index-abc.js`, { method: "POST" })).status, 404);
  assert.equal(await (await fetch(`${main.base}/assets/index-abc.js`, { method: "DELETE" })).text(), "fell through");
  assert.equal(await (await fetch(`${main.base}/stack`)).text(), "fell through");
  assert.equal(await (await fetch(`${main.base}/`, { method: "POST" })).text(), "fell through");
});

// @spec DASH-BUILD-005
test("with no built index.html, GET / is a 503 'Dashboard not built' page that names pnpm build and loads nothing; the assets answer 404", async () => {
  const r = await fetch(`${empty.base}/`);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.text();
  assert.match(body, /<title>Dashboard not built<\/title>/);
  assert.match(body, /pnpm build/);
  assert.ok(!/<script|<link|src=|href=|@import|url\(/i.test(body), "loads nothing");
  assert.equal((await fetch(`${empty.base}/assets/index-abc.js`)).status, 404);
  assert.equal(await (await fetch(`${empty.base}/stack`)).text(), "fell through"); // every other route is unaffected
});

// @spec DASH-BUILD-001
test("the UI directory is services/dashboard/dist-ui, beside the server's dist", () => {
  assert.match(locateUiDir().replaceAll("\\", "/"), /services\/dashboard\/dist-ui$/);
});
