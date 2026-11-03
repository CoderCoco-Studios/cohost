import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (name: string) =>
  spawnSync(process.execPath, ["--import", "tsx", new URL(`./${name}`, import.meta.url).pathname], { encoding: "utf8" });

// @spec BUS-STOP-005, BUS-STOP-003, BUS-STOP-004
test("several onShutdown callbacks share one sequence: all run in order, failures are logged, one exit(0)", () => {
  const r = run("shutdown-multi.fixture.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["cb1", "cb2", "cb3", "cb4", "exit:0"]);
  assert.match(r.stderr, /cb1 rejected/);
  assert.match(r.stderr, /cb2 threw/);
});

// @spec BUS-STOP-006, BUS-STOP-002
test("a beforeShutdown hook that throws synchronously is ignored; other hooks and callbacks still run", () => {
  const r = run("shutdown-hooks.fixture.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["hook2", "cb"]);
});
