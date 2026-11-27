import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { testControl } from "./control-fixture.js";
import { guardFullSurface } from "../src/host.js";
import { StackService } from "../src/stack.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "docs-test-")));
// The UI the handler serves at `/`: a one-line index, so these tests do not depend on a built bundle.
const uiDir = join(tmp, "ui");
mkdirSync(uiDir);
writeFileSync(join(uiDir, "index.html"), "page");
const dist = join(tmp, "dist");
const put = (rel: string, body: string, root = dist) => {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
  return f;
};
// A built site, plus things outside it that a request must never reach.
put("index.html", "<h1>home</h1>");
put("404.html", "<h1>custom 404</h1>");
put("guide/operate/health.html", "<h1>health</h1>");
put("guide/operate/index.html", "<h1>operate index</h1>");
put("advanced/testing/index.html", "<h1>testing index</h1>");
put("advanced/only-dir/readme.txt", "no index here");
put("assets/app.abc123.js", "export const a = 1;");
put("assets/deep/er/style.css", "body{}");
put("favicon.svg", "<svg/>");
put("LOGO.PNG", "png");
put("noext", "raw");
put("data.json", "{}");
put("page.html", "<h1>explicit html</h1>");
put("both.html", "<h1>both.html</h1>");
put("both", "plain file named both");
put("weird name.html", "<h1>spaces</h1>");
put("secret.txt", "outside secret", tmp);
put("outdir/index.html", "<h1>outside dir</h1>", tmp);
put("outdir/x.txt", "outside x", tmp);
put("package.json", "{\"name\":\"outer\"}", tmp);
symlinkSync(join(tmp, "secret.txt"), join(dist, "link-out.txt"));
symlinkSync(join(tmp, "secret.txt"), join(dist, "link-out2.html"));
symlinkSync(join(tmp, "outdir"), join(dist, "linkdir"));
symlinkSync(join(dist, "page.html"), join(dist, "link-in.html"));
mkdirSync(join(dist, "idxlink"));
symlinkSync(join(tmp, "outdir", "index.html"), join(dist, "idxlink", "index.html"));

const bare = join(tmp, "bare"); // built, but no 404.html
put("index.html", "<h1>bare</h1>", bare);

const unbuilt = join(tmp, "unbuilt");
mkdirSync(unbuilt);

const rec = recordingLog();
async function serve(docsDir: string, opts: { control?: boolean; guard?: boolean } = {}) {
  const handler = createDashboardHandler({
    bus: new FakeBus(), log: rec.log, uiDir, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
    docsDir,
    control: testControl(),
  });
  const server = http.createServer(opts.guard ? guardFullSurface(handler, { loopback: true }) : handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.close(); server.closeAllConnections(); });
  return { port: (server.address() as { port: number }).port };
}
interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }
/** The path goes out exactly as given (fetch would normalise it). */
const raw = (port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Raw> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

const { port } = await serve(dist);
const get = (p: string, h?: Record<string, string>, m = "GET") => raw(port, p, h, m);

// @spec DASH-DOCS-001
test("the docs directory is found under the workspace root, or the working directory when there is none, once at startup", async () => {
  const cwd = process.cwd();
  const proj = join(tmp, "proj"); // no pnpm-workspace.yaml above it
  put("docs/.vitepress/dist/index.html", "<h1>from cwd</h1>", proj);
  process.chdir(proj);
  try {
    const handler = createDashboardHandler({
      bus: new FakeBus(), log: rec.log, uiDir, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
      loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
      stack: new StackService({ log: rec.log, bus: () => "connected" }), control: testControl(),
    });
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    after(() => { server.close(); server.closeAllConnections(); });
    const p = (server.address() as { port: number }).port;
    process.chdir(cwd); // located once: a later cwd change does not move it
    const r = await raw(p, "/cohost/");
    assert.equal(r.status, 200);
    assert.equal(r.body, "<h1>from cwd</h1>");
  } finally { process.chdir(cwd); }
});

// @spec DASH-DOCS-001
test("serving never writes to the docs directory", async () => {
  const snap = () => JSON.stringify(readdirSync(dist, { recursive: true }).map(String).toSorted().map((f) => [f, statSync(join(dist, f)).mtimeMs]));
  const before = snap();
  for (const p of ["/cohost/", "/cohost/guide/operate/health", "/cohost/nope", "/cohost/assets/app.abc123.js"]) await get(p);
  assert.equal(snap(), before);
});

// @spec DASH-DOCS-002
test("a path with an empty remainder or a trailing slash serves only <remainder>index.html", async () => {
  const a = await get("/cohost/");
  assert.equal(a.status, 200);
  assert.equal(a.body, "<h1>home</h1>");
  assert.equal((await get("/cohost/guide/operate/")).body, "<h1>operate index</h1>");
  assert.equal((await get("/cohost/advanced/only-dir/")).status, 404);
  assert.equal((await get("/cohost/assets/")).status, 404);
  assert.equal((await get("/cohost/page.html/")).status, 404); // never page.html itself
});

// @spec DASH-DOCS-002
test("a remainder is served as the file it names, else with .html appended (clean URLs); a regular file wins over the .html", async () => {
  assert.equal((await get("/cohost/favicon.svg")).body, "<svg/>");
  assert.equal((await get("/cohost/page.html")).body, "<h1>explicit html</h1>");
  assert.equal((await get("/cohost/guide/operate/health")).body, "<h1>health</h1>");
  assert.equal((await get("/cohost/both")).body, "plain file named both");
  assert.equal((await get("/cohost/weird%20name")).body, "<h1>spaces</h1>");
  assert.equal((await get("/cohost/link-in.html")).body, "<h1>explicit html</h1>"); // a symlink that stays inside is a regular file
  assert.equal((await get("/cohost/guide/operate/health?x=1#y")).status, 200);
});

// @spec DASH-DOCS-003
test("a directory with an index.html asked for without the slash is a 301 to the slash form, query kept; /cohost goes to /cohost/", async () => {
  const a = await get("/cohost");
  assert.equal(a.status, 301);
  assert.equal(a.headers.location, "/cohost/");
  const b = await get("/cohost/advanced/testing?tab=2&x=%20y");
  assert.equal(b.status, 301);
  assert.equal(b.headers.location, "/cohost/advanced/testing/?tab=2&x=%20y");
  assert.equal(b.body, "");
  assert.equal((await get("/cohost?a=1")).headers.location, "/cohost/?a=1");
  assert.equal((await get("/cohost/guide/operate")).headers.location, "/cohost/guide/operate/");
});

// @spec DASH-DOCS-003
test("a file named by the remainder or the .html wins over a same-named directory; a directory without index.html is not redirected", async () => {
  put("clash.html", "<h1>clash file</h1>");
  put("clash/index.html", "<h1>clash dir</h1>");
  assert.equal((await get("/cohost/clash")).status, 200);
  assert.equal((await get("/cohost/advanced/only-dir")).status, 404);
});

// @spec DASH-DOCS-004
test("an unknown path is a 404 with the built 404.html and its headers", async () => {
  const r = await get("/cohost/no/such/page");
  assert.equal(r.status, 404);
  assert.equal(r.body, "<h1>custom 404</h1>");
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.headers["content-length"], String(Buffer.byteLength("<h1>custom 404</h1>")));
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["cache-control"], "no-cache");
});

// @spec DASH-DOCS-004
test("without a 404.html the 404 is the plain text `not found`", async () => {
  const b = await serve(bare);
  const r = await raw(b.port, "/cohost/nope");
  assert.equal(r.status, 404);
  assert.equal(r.body, "not found");
  assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
});

// @spec DASH-DOCS-005
test("content-type comes from the extension, case-insensitively; content-length and nosniff are set", async () => {
  for (const f of ["a.mjs", "b.woff2", "c.jpg", "d.JPEG", "e.webp", "f.ico", "g.txt", "h.CSS", "i.JS"]) put(f, "x");
  const want: Record<string, string> = {
    "page.html": "text/html; charset=utf-8", "assets/app.abc123.js": "text/javascript; charset=utf-8", "a.mjs": "text/javascript; charset=utf-8",
    "i.JS": "text/javascript; charset=utf-8", "assets/deep/er/style.css": "text/css; charset=utf-8", "h.CSS": "text/css; charset=utf-8",
    "data.json": "application/json", "favicon.svg": "image/svg+xml", "b.woff2": "font/woff2", "LOGO.PNG": "image/png", "c.jpg": "image/jpeg",
    "d.JPEG": "image/jpeg", "e.webp": "image/webp", "f.ico": "image/x-icon", "g.txt": "text/plain; charset=utf-8", "noext": "application/octet-stream",
  };
  for (const [f, type] of Object.entries(want)) {
    const r = await get(`/cohost/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers["content-type"], type, f);
    assert.equal(r.headers["x-content-type-options"], "nosniff", f);
    assert.equal(r.headers["content-length"], String(Buffer.byteLength(r.body)), f);
  }
});

// @spec DASH-DOCS-006
test("etag is W/\"<size hex>-<mtime ms hex>\"; assets get an immutable year, everything else no-cache", async () => {
  const f = put("etag.txt", "x".repeat(300));
  utimesSync(f, 1_700_000_000.5, 1_700_000_000.5);
  const st = statSync(f);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const r = await get("/cohost/etag.txt");
  assert.equal(r.headers.etag, etag);
  assert.equal(r.headers["cache-control"], "no-cache");
  const a = await get("/cohost/assets/deep/er/style.css");
  assert.equal(a.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await get("/cohost/")).headers["cache-control"], "no-cache");
  assert.equal((await get("/cohost/guide/operate/health")).headers["cache-control"], "no-cache");
});

// @spec DASH-DOCS-006
test("If-None-Match listing the etag (with or without W/) or * is a 304 with only etag and cache-control", async () => {
  const first = await get("/cohost/assets/app.abc123.js");
  const etag = first.headers.etag!;
  const unweak = etag.replace(/^W\//, "");
  for (const inm of [etag, unweak, `"zzz", ${etag}`, `W/"other",${unweak}`, "*"]) {
    const r = await get("/cohost/assets/app.abc123.js", { "if-none-match": inm });
    assert.equal(r.status, 304, inm);
    assert.deepEqual(Object.keys(r.headers).filter((k) => !["date", "connection", "keep-alive"].includes(k)).toSorted(), ["cache-control", "etag"], inm);
    assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(r.body, "");
  }
  assert.equal((await get("/cohost/assets/app.abc123.js", { "if-none-match": 'W/"nope"' })).status, 200);
  const page = await get("/cohost/page.html", { "if-none-match": (await get("/cohost/page.html")).headers.etag! });
  assert.equal(page.status, 304);
  assert.equal(page.headers["cache-control"], "no-cache");
});

// @spec DASH-DOCS-007
test("a malformed escape, invalid UTF-8 or a NUL in the remainder is a 400 and reads nothing", async () => {
  for (const p of ["/cohost/%00", "/cohost/a%00b", "/cohost/%E0%A4%A", "/cohost/%ff", "/cohost/%", "/cohost/page.html%00.png"]) {
    const r = await get(p);
    assert.equal(r.status, 400, p);
  }
});

// @spec DASH-DOCS-008
test("a remainder that decodes to a path outside the docs directory is the 404 answer", async () => {
  for (const p of ["/cohost/..%2f..%2fpackage.json", "/cohost/..%2fsecret.txt", "/cohost/%2e%2e%2fsecret.txt", "/cohost/guide%2f..%2f..%2fsecret.txt", "/cohost/%2fetc%2fpasswd", "/cohost/..%2foutdir%2f"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body, "<h1>custom 404</h1>", p);
  }
});

// @spec DASH-DOCS-008
test("a symlink whose target is outside the docs directory is never followed: file, .html candidate, directory and index.html", async () => {
  for (const p of ["/cohost/link-out.txt", "/cohost/link-out2", "/cohost/link-out2.html", "/cohost/linkdir/x.txt", "/cohost/linkdir/", "/cohost/linkdir", "/cohost/idxlink/", "/cohost/idxlink"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body, "<h1>custom 404</h1>", p);
  }
});

// @spec DASH-DOCS-009
test("while index.html is not a regular file every docs request is a 503 page naming mise run docs:build, loading nothing", async () => {
  const u = await serve(unbuilt);
  for (const [p, m] of [["/cohost/", "GET"], ["/cohost", "GET"], ["/cohost/anything", "GET"], ["/cohost/%00", "GET"], ["/cohost/..%2fx", "GET"], ["/cohost/", "HEAD"]] as const) {
    const r = await raw(u.port, p, {}, m);
    assert.equal(r.status, 503, p);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.headers["cache-control"], "no-store");
    if (m === "GET") {
      assert.match(r.body, /<title>Docs not built<\/title>/);
      assert.match(r.body, /not been built/);
      assert.match(r.body, /mise run docs:build/);
      assert.match(r.body, /mise run dashboard/);
      assert.match(r.body, /mise run dashboard<\/code> builds them when it starts/);
      assert.doesNotMatch(r.body, /<script|<link|<img|src=|href=|@import|url\(/i);
    }
  }
  mkdirSync(join(unbuilt, "index.html")); // a directory named index.html is not a built site
  assert.equal((await raw(u.port, "/cohost/")).status, 503);
});

// @spec DASH-DOCS-009
test("a build that finishes while the dashboard runs is served without a restart", async () => {
  const dir = join(tmp, "late");
  mkdirSync(dir);
  const l = await serve(dir);
  assert.equal((await raw(l.port, "/cohost/")).status, 503);
  put("index.html", "<h1>late</h1>", dir);
  const r = await raw(l.port, "/cohost/");
  assert.equal(r.status, 200);
  assert.equal(r.body, "<h1>late</h1>");
});

// @spec DASH-DOCS-010
test("HEAD answers the status and headers GET would, with no body", async () => {
  for (const [p, h] of [["/cohost/", {}], ["/cohost/guide/operate/health", {}], ["/cohost/nope", {}], ["/cohost/advanced/testing", {}], ["/cohost/%00", {}], ["/cohost/assets/app.abc123.js", {}], ["/cohost/page.html", { "if-none-match": "*" }]] as const) {
    const g = await get(p, { ...h });
    const hd = await get(p, { ...h }, "HEAD");
    assert.equal(hd.status, g.status, p);
    const strip = (x: http.IncomingHttpHeaders) => { const { date, ...rest } = x; void date; return rest; };
    assert.deepEqual(strip(hd.headers), strip(g.headers), p);
    assert.equal(hd.body, "", p);
  }
});

// @spec DASH-DOCS-011
test("a method other than GET or HEAD on a docs path is the unknown-route 404, with or without control or a token, and a foreign Origin is a 403 first", async () => {
  for (const control of [false, true]) {
    const s = await serve(dist, { control, guard: true });
    for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const p of ["/cohost/", "/cohost", "/cohost/page.html", "/cohost/%00", "/cohost/..%2fsecret.txt"]) {
        for (const h of [{}, { authorization: "Bearer tok" }] as Record<string, string>[]) {
          const r = await raw(s.port, p, h, m);
          assert.deepEqual([r.status, r.body], [404, "not found"], `${m} ${p} control=${control}`);
        }
      }
    }
    const r = await raw(s.port, "/cohost/", { origin: "http://evil.example" }, "POST");
    assert.equal(r.status, 403);
  }
});

// @spec DASH-DOCS-001
test("only /cohost and /cohost/... are docs paths", async () => {
  assert.deepEqual([(await get("/cohostx")).status, (await get("/cohostx")).body], [404, "not found"]);
  assert.equal((await get("/cohost.html")).body, "not found");
  assert.equal((await get("/")).body, "page");
});
