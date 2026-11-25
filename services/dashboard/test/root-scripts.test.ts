import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const scripts = (JSON.parse(root("package.json")) as { scripts: Record<string, string> }).scripts;
const globs = '"packages/*/test/*.test.ts" "services/*/test/*.test.ts" "services/*/test/ui/*.test.tsx"';
const UI_BUILD = "pnpm --filter @cohost/dashboard build:ui";

// @spec DEPLOY-REPO-002, DASH-BUILD-006
test("test and test:only run the UI tests; test builds the UI first, test:only builds nothing", () => {
  assert.equal(scripts.test, `pnpm build:native && tsc -b && ${UI_BUILD} && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test ${globs}`);
  assert.equal(scripts["test:only"], `TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test ${globs}`);
});

// @spec DEPLOY-REPO-002, DASH-BUILD-001
test("build runs the UI build after tsc -b", () => {
  assert.equal(scripts.build, `pnpm build:native && tsc -b && ${UI_BUILD}`);
});

// @spec DEPLOY-REPO-002, DASH-BUILD-008
test("typecheck and lint also type-check the UI and its tests without emitting", () => {
  assert.equal(scripts.typecheck, "tsc -b && tsc -p services/dashboard/ui --noEmit");
  assert.equal(scripts.lint, scripts.typecheck);
});

// @spec DEPLOY-REPO-002
test("clean removes the UI bundle too", () => {
  assert.equal(scripts.clean, "rm -rf packages/*/dist services/*/dist services/dashboard/dist-ui");
});

// @spec DASH-BUILD-007
test("dashboard:ui runs the Vite dev server of the dashboard package", () => {
  assert.equal(scripts["dashboard:ui"], "pnpm --filter @cohost/dashboard dev:ui");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["build:ui"]!, /^vite build /);
  assert.match(pkg.scripts["dev:ui"]!, /^vite /);
});

// @spec DEPLOY-REPO-003
test("the built UI is git-ignored", () => {
  assert.ok(root(".gitignore").split("\n").includes("services/dashboard/dist-ui/"));
});

// @spec DEPLOY-REPO-003
test("the .gitignore excludes the secrets directory and the user-owned config files, and no longer names config/secrets.yaml", () => {
  const lines = root(".gitignore").split("\n").map((l) => l.trim());
  for (const f of ["node_modules/", "dist/", "*.tsbuildinfo", ".env", "data/", "secrets/", "services/dashboard/dist-ui/", "*.log", ".DS_Store", "config/config.yaml", "config/personality.md", "config/expressions.yaml"]) {
    assert.ok(lines.includes(f), `${f} is ignored`);
  }
  assert.ok(!lines.includes("config/secrets.yaml"), "the credentials file lives in secrets/, not config/");
});

// @spec DASH-BUILD-008
test("the UI tsconfig covers the UI source and test/ui and emits nothing", () => {
  const cfg = readFileSync(new URL("../ui/tsconfig.json", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const j = JSON.parse(cfg) as { compilerOptions: { noEmit: boolean; jsx: string }; include: string[] };
  assert.equal(j.compilerOptions.noEmit, true);
  assert.equal(j.compilerOptions.jsx, "react-jsx");
  assert.ok(j.include.includes("src") && j.include.includes("../test/ui"));
});
