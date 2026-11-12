import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as { packageManager: string };

// @spec DEPLOY-IMG-006
test("package.json names the pnpm version, and neither the Dockerfile, the installer nor a workflow names another", () => {
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  for (const f of ["Dockerfile", "scripts/install.sh"]) {
    assert.doesNotMatch(readFileSync(root(f), "utf8"), /pnpm@\d/, `${f} hard-codes a pnpm version`);
  }
  for (const f of readdirSync(root(".github/workflows"))) {
    const text = readFileSync(root(`.github/workflows/${f}`), "utf8");
    assert.doesNotMatch(text, /pnpm@\d|^\s*version:\s*\d+\s*$/m, `${f} hard-codes a pnpm version`);
  }
});

// @spec DEPLOY-IMG-006
test("the Dockerfile copies package.json before it prepares pnpm and prepares what packageManager names", () => {
  const d = readFileSync(root("Dockerfile"), "utf8");
  const copy = d.search(/COPY package\.json/);
  const prepare = d.search(/corepack prepare/);
  assert.ok(copy >= 0 && prepare > copy, "package.json is copied into the base stage first");
  assert.match(d, /packageManager/);
});

// @spec DEPLOY-IMG-006
test("the installer's pnpm_spec prints the packageManager value of the package.json beside it", () => {
  const src = readFileSync(root("scripts/install.sh"), "utf8");
  const m = src.match(/# begin pnpm-version\n([\s\S]*?)# end pnpm-version\n/);
  assert.ok(m, "install.sh has a pnpm-version block");
  const dir = mkdtempSync(join(tmpdir(), "cohost-pm-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", packageManager: "pnpm@9.9.9" }));
    const out = execFileSync("bash", ["-c", `set -euo pipefail\ncd "${dir}"\n${m![1]}\npnpm_spec`], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    assert.equal(out.trim(), "pnpm@9.9.9");
    assert.match(src, /corepack prepare "\$\(pnpm_spec\)"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
