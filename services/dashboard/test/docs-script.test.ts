import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts.dashboard!;

// @spec DEPLOY-HOST-001, DEPLOY-HOST-006
test("the dashboard script has exactly the specified shape", () => {
  assert.equal(script, "pnpm docs:build || echo 'pnpm dashboard: the docs build failed (see above); starting the dashboard anyway' >&2; tsc -b services/dashboard && node services/dashboard/dist/index.js");
});

/** Runs the script's shell text with fake pnpm, tsc and node on PATH; each records its call and exits as told. */
function run(fail: { pnpm?: boolean; tsc?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "dash-script-"));
  const log = join(dir, "calls");
  const fake = (name: string, code: number) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  fake("pnpm", fail.pnpm ? 1 : 0); fake("tsc", fail.tsc ? 1 : 0); fake("node", 0);
  const r = spawnSync("sh", ["-c", script], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
  let calls: string[] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n"); } catch { /* nothing ran */ }
  return { ...r, calls };
}

// @spec DEPLOY-HOST-001
test("docs build, then the dashboard build, then the dashboard", () => {
  const r = run({});
  assert.deepEqual(r.calls, ["pnpm docs:build", "tsc -b services/dashboard", "node services/dashboard/dist/index.js"]);
  assert.equal(r.stderr, "");
});

// @spec DEPLOY-HOST-006
test("a failed docs build prints the notice to stderr and still builds and starts the dashboard", () => {
  const r = run({ pnpm: true });
  assert.deepEqual(r.calls, ["pnpm docs:build", "tsc -b services/dashboard", "node services/dashboard/dist/index.js"]);
  assert.equal(r.stderr, "pnpm dashboard: the docs build failed (see above); starting the dashboard anyway\n");
  assert.equal(r.status, 0);
});

// @spec DEPLOY-HOST-006
test("only a failed dashboard build stops the script before the dashboard runs", () => {
  const r = run({ tsc: true });
  assert.deepEqual(r.calls, ["pnpm docs:build", "tsc -b services/dashboard"]);
  assert.notEqual(r.status, 0);
});
