import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "dash-build-"));
const pkg = new URL("../../", import.meta.url).pathname;
const r = spawnSync("node", ["node_modules/vite/bin/vite.js", "build", "--config", "ui/vite.config.ts", "--outDir", out, "--emptyOutDir"], { cwd: pkg, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_OPTIONS: "--max-old-space-size=1024" } });
test.after(() => rmSync(out, { recursive: true, force: true }));

/** The script and stylesheet a built entry page names (root-relative `/assets/...`), as paths under `out`. */
function entryFiles(page: "index.html" | "avatar.html"): { html: string; scripts: string[]; styles: string[] } {
  const html = readFileSync(join(out, page), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]!)
    .concat([...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"/g)].map((m) => m[1]!));
  return { html, scripts, styles };
}
const read = (p: string): string => readFileSync(join(out, p.replace(/^\//, "")), "utf8");
const indexJs = (): string => read(entryFiles("index.html").scripts[0]!);
const avatarJs = (): string => read(entryFiles("avatar.html").scripts[0]!);
const notices = (): string[] => readdirSync(join(out, "assets")).filter((f) => /^third-party-notices-[0-9a-f]{8}\.txt$/.test(f));

// @spec DASH-BUILD-001
test("the build writes index.html, avatar.html, favicon.svg and assets/ with one script and one stylesheet per entry and no other chunk", () => {
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(readdirSync(out).sort(), ["assets", "avatar.html", "favicon.svg", "index.html"]);
  const assets = readdirSync(join(out, "assets"));
  assert.equal(assets.filter((f) => f.endsWith(".js")).length, 2, assets.join());
  assert.equal(assets.filter((f) => f.endsWith(".css")).length, 2, assets.join());
  assert.equal(notices().length, 1, "and the notices file");
  assert.equal(assets.length, 5, `no source maps or other files: ${assets.join()}`);
  const a = entryFiles("index.html"), b = entryFiles("avatar.html");
  for (const e of [a, b]) { assert.equal(e.scripts.length, 1); assert.equal(e.styles.length, 1); }
  assert.notEqual(a.scripts[0], b.scripts[0], "no script shared between the entries");
  assert.notEqual(a.styles[0], b.styles[0], "no stylesheet shared between the entries");
  for (const p of [...a.scripts, ...a.styles, ...b.scripts, ...b.styles]) assert.ok(existsSync(join(out, p)), p);
});

// @spec DASH-BUILD-002
test("the built index.html references only root-relative files, carries the name placeholder and loads nothing external", () => {
  const { html, styles } = entryFiles("index.html");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(m[1]!, /^\/(assets\/|favicon\.svg)/, m[1]!);
  assert.match(html, /<meta name="cohost-name" content="__COHOST_NAME__"/);
  assert.match(html, /<title>__COHOST_NAME__ dashboard<\/title>/);
  assert.ok(!/https?:\/\//.test(html));
  const css = read(styles[0]!);
  assert.ok(!/@font-face|@import|url\(\s*["']?https?:/.test(css));
});

// @spec DASH-BUILD-001, DASH-THEME-001
test("the dashboard bundle makes no request to another origin: no http(s) URL in the script except in comments or namespaces", () => {
  const js = indexJs();
  const hosts = new Set([...js.matchAll(/https?:\/\/[^"'`\s)]+/g)].map((m) => new URL(m[0]).host));
  // React and the DOM name XML namespaces and docs links in strings; none is fetched.
  for (const h of hosts) assert.match(h, /^(www\.w3\.org|react\.dev|reactjs\.org|localhost|x)$/, h);
});

// @spec DASH-AVP-003, DASH-BUILD-010
test("the 3D libraries are in the avatar entry only: the dashboard entry holds none of them", () => {
  const dash = indexJs(), avatar = avatarJs();
  for (const marker of ["WebGLRenderer", "PerspectiveCamera", "VRMLoaderPlugin", "GLTFLoader"]) {
    assert.ok(avatar.includes(marker), `avatar entry holds ${marker}`);
    assert.ok(!dash.includes(marker), `dashboard entry holds no ${marker}`);
  }
  assert.ok(!avatar.includes("createRoot") && !avatar.includes("react-dom"), "the avatar page is plain TypeScript, with no React");
});

// @spec DASH-AVP-003
test("neither entry script uses a dynamic import()", () => {
  for (const [name, js] of [["index", indexJs()], ["avatar", avatarJs()]] as const) {
    assert.ok(!/(?<![.\w$])import\s*\(/.test(js), `${name} entry has a dynamic import()`);
  }
});

// @spec DASH-AVP-005
test("the avatar entry creates no audio element and no audio context and plays no sound", () => {
  const js = avatarJs();
  assert.ok(!/\bAudioContext\b|\bwebkitAudioContext\b|\bnew Audio\s*\(|createElement\(\s*["']audio["']\)/.test(js));
});

// @spec DASH-BUILD-010
test("the avatar entry fetches no script, stylesheet or font from another origin", () => {
  const { html, styles } = entryFiles("avatar.html");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(m[1]!, /^\/(assets\/|favicon\.svg)/, m[1]!);
  assert.ok(!/https?:\/\//.test(html));
  const css = read(styles[0]!);
  assert.ok(!/@font-face|@import|url\(\s*["']?(?:https?:|\/\/)/.test(css));
  const js = avatarJs();
  assert.ok(!/importScripts\s*\(|new Worker\s*\(|new SharedWorker\s*\(|serviceWorker/.test(js), "no worker: the CSP has worker-src 'none'");
});

// @spec DASH-AVP-002, DASH-AVP-004
test("avatar.html fits its Content-Security-Policy: no inline script or style, no style attribute, no eval", () => {
  const { html } = entryFiles("avatar.html");
  assert.ok(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
  assert.ok(!/<style\b/i.test(html), "no inline style element");
  assert.ok(!/\sstyle\s*=/i.test(html), "no style attribute");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "no inline event handler");
  assert.ok(!/<base\b|<form\b|<object\b|<embed\b|<iframe\b/i.test(html));
  assert.ok(!/\beval\s*\(|new Function\s*\(/.test(avatarJs()), "the CSP has no unsafe-eval");
});

// @spec DASH-AVP-006
test("avatar.html is a transparent document: the stylesheet sets background transparent and the page holds no text but the status line", () => {
  const { html, styles } = entryFiles("avatar.html");
  const css = read(styles[0]!).replace(/\s+/g, "");
  assert.match(css, /background(?:-color)?:transparent/);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<head[\s\S]*?<\/head>/i, "");
  assert.equal(body.replace(/<[^>]*>/g, "").trim(), "", "no visible text, border or loading indicator in the served page");
});

// @spec DASH-BUILD-009, DEPLOY-LIC-005
test("the first line of each entry script names the notices file, and that file exists with the hashed name", () => {
  const files = notices();
  assert.equal(files.length, 1);
  const name = files[0]!;
  for (const js of [indexJs(), avatarJs()]) {
    const first = js.split("\n", 1)[0]!;
    assert.match(first, /^(?:\/\/|\/\*!?)/, first);
    assert.ok(first.includes(`assets/${name}`), first);
  }
  const text = readFileSync(join(out, "assets", name));
  assert.equal(name, `third-party-notices-${createHash("sha256").update(text).digest("hex").slice(0, 8)}.txt`);
});

// @spec DEPLOY-LIC-005
test("the notices file holds each bundled third-party package with name, version, licence and licence text, and none that is not bundled or is in the workspace", () => {
  const text = readFileSync(join(out, "assets", notices()[0]!), "utf8");
  for (const name of ["react", "react-dom", "three", "@pixiv/three-vrm"]) {
    const m = new RegExp(`^${name.replace(/[/@]/g, "\\$&")}@\\d+\\.\\d+\\.\\d+`, "m").exec(text);
    assert.ok(m, `an entry for ${name}`);
  }
  assert.match(text, /Permission is hereby granted, free of charge/, "the MIT text travels with the packages");
  for (const absent of ["@cohost/", "vite", "happy-dom", "@testing-library", "typescript"]) assert.ok(!text.includes(`\n${absent}`) && !text.startsWith(absent), `no entry for ${absent}`);
  assert.ok(!/^@cohost\//m.test(text), "workspace packages (head-rotation) have no entry");
});

// @spec DASH-BUILD-010
test("three and @pixiv/three-vrm are development dependencies of the dashboard package, not runtime ones", () => {
  const p = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const name of ["three", "@pixiv/three-vrm"]) {
    assert.ok(p.devDependencies?.[name], `${name} in devDependencies`);
    assert.equal(p.dependencies?.[name], undefined, `${name} not in dependencies`);
  }
});
