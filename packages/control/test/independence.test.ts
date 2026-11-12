import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_MANIFEST } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? sources(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));

// @spec MOD-LIFE-003
test("no unit reads another unit's health: a unit in uses is an optional collaborator, never a condition of running", () => {
  const units = SERVICE_MANIFEST.filter((s) => s.pnpmFilter);
  assert.ok(units.some((u) => u.uses.length > 0));
  for (const u of units) {
    for (const file of sources(join(root, "services", u.id, "src"))) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /\bHealthTracker\b|\brecentHealth\b|\btailHealth\b|\bHEALTH_STREAM\b/, `${file} reads the health stream`);
    }
  }
});
