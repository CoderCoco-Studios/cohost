import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (name: string) =>
  spawnSync(process.execPath, ["--import", "tsx", new URL(`./${name}`, import.meta.url).pathname], { encoding: "utf8" });

// @spec SHARED-LIFE-004, SHARED-LIFE-002, SHARED-LIFE-003
test("several onShutdown callbacks share one sequence: all run in order, failures are logged, one exit(0)", () => {
  const r = run("shutdown-multi.fixture.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["cb1", "cb2", "cb3", "cb4", "exit:0"]);
  assert.match(r.stderr, /cb1 rejected/);
  assert.match(r.stderr, /cb2 threw/);
});

// @spec SHARED-LIFE-005, SHARED-LIFE-001
test("a beforeShutdown hook that throws synchronously is ignored; other hooks and callbacks still run", () => {
  const r = run("shutdown-hooks.fixture.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["hook2", "cb"]);
});

// @spec SHARED-LIFE-001
test("a beforeShutdown hook that never settles delays the callbacks by at most 2000 ms, then the process exits 0", () => {
  const r = run("shutdown-hang.fixture.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["cb:2000", "exit:0"]);
});
