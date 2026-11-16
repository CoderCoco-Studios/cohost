import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "dash-build-"));
const pkg = new URL("../../", import.meta.url).pathname;
const r = spawnSync("node", ["node_modules/vite/bin/vite.js", "build", "--config", "ui/vite.config.ts", "--outDir", out, "--emptyOutDir"], { cwd: pkg, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_OPTIONS: "--max-old-space-size=1024" } });
test.after(() => rmSync(out, { recursive: true, force: true }));

// @spec DASH-BUILD-001
test("the build writes index.html, favicon.svg and assets/ with one script and one stylesheet and no other chunk", () => {
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(readdirSync(out).sort(), ["assets", "favicon.svg", "index.html"]);
  const assets = readdirSync(join(out, "assets"));
  assert.equal(assets.filter((f) => f.endsWith(".js")).length, 1, assets.join());
  assert.equal(assets.filter((f) => f.endsWith(".css")).length, 1, assets.join());
  assert.equal(assets.length, 2, "no source maps or other files");
  const js = readFileSync(join(out, "assets", assets.find((f) => f.endsWith(".js"))!), "utf8");
});

// @spec DASH-BUILD-002
test("the built index.html references only root-relative files, carries the name placeholder and loads nothing external", () => {
  const html = readFileSync(join(out, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(m[1]!, /^\/(assets\/|favicon\.svg)/, m[1]);
  assert.match(html, /<meta name="cohost-name" content="__COHOST_NAME__"/);
  assert.match(html, /<title>__COHOST_NAME__ dashboard<\/title>/);
  assert.ok(!/https?:\/\//.test(html));
  const css = readFileSync(join(out, "assets", readdirSync(join(out, "assets")).find((f) => f.endsWith(".css"))!), "utf8");
  assert.ok(!/@font-face|@import|url\(\s*["']?https?:/.test(css));
});

// @spec DASH-BUILD-001, DASH-THEME-001
test("the bundle makes no request to another origin: no http(s) URL in the script except in comments or namespaces", () => {
  const js = readFileSync(join(out, "assets", readdirSync(join(out, "assets")).find((f) => f.endsWith(".js"))!), "utf8");
  const hosts = new Set([...js.matchAll(/https?:\/\/[^"'`\s)]+/g)].map((m) => new URL(m[0]).host));
  // React and the DOM name XML namespaces and docs links in strings; none is fetched.
  for (const h of hosts) assert.match(h, /^(www\.w3\.org|react\.dev|reactjs\.org|localhost|x)$/, h);
});
