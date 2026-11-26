import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyClosure, repoRoot, task } from "../../../packages/config/test/helpers/mise.js";

const dashboard = task("dashboard");
const NOTICE = "mise run dashboard: the docs build failed (see above); starting the dashboard anyway";

// @spec DEPLOY-HOST-001, DEPLOY-HOST-006
test("the dashboard task depends on build:native and build:ui, then runs the docs build, tsc -b services/dashboard and the dashboard", () => {
  assert.deepEqual([...dashboard.depends].sort(), ["build:native", "build:ui"]);
  assert.deepEqual(dashboard.run, [
    `mise run docs:build || echo '${NOTICE}' >&2`,
    "tsc -b services/dashboard",
    "node services/dashboard/dist/index.js",
  ]);
  assert.equal((dashboard.dir ?? "").replace(/\/$/, ""), repoRoot.replace(/\/$/, ""), "runs from the repository root wherever it is started");
  assert.ok(dependencyClosure("dashboard").has("install"), "build:ui installs the workspace first");
});

/**
 * Runs the task's commands as mise does (each in turn, stopping at the first that fails) with fake mise, tsc and node on
 * PATH; each records its call and exits as told.
 */
function run(fail: { docs?: boolean; tsc?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "dash-task-"));
  const log = join(dir, "calls");
  const fake = (name: string, code: number) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  fake("mise", fail.docs ? 1 : 0);
  fake("tsc", fail.tsc ? 1 : 0);
  fake("node", 0);
  let status = 0;
  let stderr = "";
  for (const cmd of dashboard.run) {
    const r = spawnSync("sh", ["-c", cmd], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
    stderr += r.stderr;
    status = r.status ?? 1;
    if (status !== 0) break;
  }
  let calls: string[] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n"); } catch { /* nothing ran */ }
  return { status, stderr, calls };
}

// @spec DEPLOY-HOST-001
test("docs build, then the dashboard build, then the dashboard", () => {
  const r = run({});
  assert.deepEqual(r.calls, ["mise run docs:build", "tsc -b services/dashboard", "node services/dashboard/dist/index.js"]);
  assert.equal(r.stderr, "");
});

// @spec DEPLOY-HOST-006
test("a failed docs build prints the notice to stderr and still builds and starts the dashboard", () => {
  const r = run({ docs: true });
  assert.deepEqual(r.calls, ["mise run docs:build", "tsc -b services/dashboard", "node services/dashboard/dist/index.js"]);
  assert.equal(r.stderr, `${NOTICE}\n`);
  assert.equal(r.status, 0);
});

// @spec DEPLOY-HOST-001
test("a failed dashboard build stops the task before the dashboard runs", () => {
  const r = run({ tsc: true });
  assert.deepEqual(r.calls, ["mise run docs:build", "tsc -b services/dashboard"]);
  assert.notEqual(r.status, 0);
});

// @spec DEPLOY-HOST-006
test("the docs build the dashboard runs is skipped while the docs' sources are unchanged: docs:build declares sources and an output", () => {
  const docs = task("docs:build");
  assert.ok(docs.sources.includes("docs/**"));
  assert.deepEqual(docs.outputs, ["docs/.vitepress/dist/index.html"]);
});
