import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { repo } from "./helpers.js";

/** Every source file under `dir`, build output, dependencies and tests excepted. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "dist-ui", "test", "models"].includes(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(repo, p).split(sep).join("/");
const units = (top: string): string[] => readdirSync(join(repo, top)).filter((n) => statSync(join(repo, top, n)).isDirectory()).map((n) => `${top}/${n}`);
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
const importsOf = (text: string): string[] => [...text.matchAll(IMPORT)].map((m) => m[1]!);

// @spec STORE-PKG-001
test("only the dashboard, @cohost/control and the store itself import @cohost/store or declare it; no other service names the store or the key file", () => {
  const allowed = new Set(["services/dashboard", "packages/control", "packages/store"]);
  const offenders: string[] = [];
  for (const unit of [...units("packages"), ...units("services")]) {
    if (allowed.has(unit)) continue;
    const manifest = join(repo, unit, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes("\"@cohost/store\"")) offenders.push(`${unit}/package.json`);
    for (const f of sources(join(repo, unit))) {
      const text = readFileSync(f, "utf8");
      if (importsOf(text).some((i) => i === "@cohost/store" || i.startsWith("@cohost/store/"))) offenders.push(rel(f));
      if (unit.startsWith("services/") && /["'`/]store\/cohost\.db|cohost\.db["'`]|master\.key|COHOST_KEY_FILE/.test(text)) offenders.push(`${rel(f)} (names the store or the key file)`);
    }
  }
  assert.deepEqual(offenders, []);
});

// @spec STORE-PKG-002
test("@cohost/store depends on @cohost/config and imports nothing else outside Node's standard library", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "packages/store/package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  assert.deepEqual(pkg.dependencies, { "@cohost/config": "workspace:*" });
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  const outside = sources(join(repo, "packages/store/src")).flatMap((f) => importsOf(readFileSync(f, "utf8"))
    .filter((i) => !i.startsWith("node:") && !i.startsWith(".") && i !== "@cohost/config")
    .map((i) => `${rel(f)}: ${i}`));
  assert.deepEqual(outside, []);
});

// @spec STORE-DB-001
test("only packages/store/src/db.ts imports node:sqlite", () => {
  const files = sources(join(repo, "packages/store/src")).filter((f) => importsOf(readFileSync(f, "utf8")).includes("node:sqlite")).map(rel);
  assert.deepEqual(files, ["packages/store/src/db.ts"]);
});
