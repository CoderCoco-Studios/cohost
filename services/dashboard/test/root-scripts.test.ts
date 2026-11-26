import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rel, repoRoot, task } from "../../../packages/config/test/helpers/mise.js";

const root = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const TEST_RUN = 'scripts/test-env.sh node --import tsx --test "packages/*/test/*.test.ts" "services/*/test/*.test.ts" "services/*/test/ui/*.test.tsx"';
const dashboardDir = `${repoRoot}services/dashboard`;

// @spec DEPLOY-REPO-002, DASH-BUILD-006
test("test and test:only run the UI tests; test builds everything (the UI included) first, test:only builds nothing", () => {
  for (const name of ["test", "test:only"]) {
    assert.deepEqual(task(name).run, [TEST_RUN], name);
    assert.match(JSON.stringify(task(name).env), /TSX_TSCONFIG_PATH.*tsconfig\.test\.json/, `${name} sets TSX_TSCONFIG_PATH`);
  }
  assert.ok(task("test").depends.includes("build"));
  assert.deepEqual(task("test:only").depends, []);
});

// @spec DEPLOY-REPO-002, DASH-BUILD-001
test("build runs the UI build, which runs vite in the dashboard package", () => {
  assert.ok(task("build").depends.includes("build:ui"));
  const ui = task("build:ui");
  assert.deepEqual(ui.run, ["node_modules/.bin/vite build --config ui/vite.config.ts"]);
  assert.equal(ui.dir, dashboardDir);
  assert.deepEqual(ui.outputs, [`${dashboardDir}/dist-ui/index.html`]);
  assert.deepEqual(ui.sources.map(rel), ["services/dashboard/ui/**", "packages/shared/src/**"]);
});

// @spec DEPLOY-REPO-002, DASH-BUILD-008
test("typecheck also type-checks the UI and its tests without emitting, and lint:ts runs after it", () => {
  assert.deepEqual(task("typecheck").run, ["tsc -b", "tsc -p services/dashboard/ui --noEmit"]);
  assert.ok(task("lint:ts").depends.includes("typecheck"));
});

// @spec DEPLOY-REPO-002
test("clean removes the UI bundle too", () => {
  assert.deepEqual(task("clean").run, ["rm -rf packages/*/dist services/*/dist services/dashboard/dist-ui"]);
});

// @spec DASH-BUILD-007
test("dashboard:ui runs the Vite dev server of the dashboard package", () => {
  const ui = task("dashboard:ui");
  assert.deepEqual(ui.run, ["node_modules/.bin/vite --config ui/vite.config.ts"]);
  assert.equal(ui.dir, dashboardDir);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { devDependencies?: Record<string, string> };
  assert.ok(pkg.devDependencies?.vite, "the dashboard package declares vite");
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
