import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleLock } from "../src/index.js";

function withDir(fn: (dir: string, file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cohost-lock-"));
  try { fn(join(root, "sub", "data"), join(root, "sub", "data", "control.lock")); } finally { rmSync(root, { recursive: true, force: true }); }
}

// @spec CTRL-LOCK-001
test("tryAcquire creates data/control.lock exclusively with the holder, and release removes it once", () => {
  withDir((dir, file) => {
    const lock = new LifecycleLock({ by: "dashboard", dir, pid: 4242, now: () => 1700 });
    const r = lock.tryAcquire("launch");
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: 4242, by: "dashboard", action: "launch", startedAt: 1700 });
    if (r.ok) { r.release(); r.release(); }
    assert.equal(existsSync(file), false);
  });
});

// @spec CTRL-LOCK-001
test("release leaves a file that now names another holder", () => {
  withDir((dir, file) => {
    const r = new LifecycleLock({ by: "dashboard", dir, pid: 1 }).tryAcquire("launch");
    assert.equal(r.ok, true);
    writeFileSync(file, JSON.stringify({ pid: 2, by: "cohostctl", action: "stop-all", startedAt: 5 }));
    if (r.ok) r.release();
    assert.equal(existsSync(file), true);
  });
});

// @spec CTRL-LOCK-002
test("a live holder refuses the second action, naming action, entry point and pid, and the file is untouched", () => {
  withDir((dir, file) => {
    const first = new LifecycleLock({ by: "cohostctl", dir, pid: 77, alive: () => true }).tryAcquire("stop-all");
    assert.equal(first.ok, true);
    const before = readFileSync(file, "utf8");
    const second = new LifecycleLock({ by: "dashboard", dir, pid: 88, alive: () => true }).tryAcquire("launch");
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.detail, "busy: stop-all held by cohostctl (pid 77)");
      assert.equal(second.holder.pid, 77);
    }
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

// @spec CTRL-LOCK-002
test("the default liveness check treats a running pid as live, and a signal EPERM as live", () => {
  withDir((dir) => {
    const a = new LifecycleLock({ by: "cohostctl", dir }).tryAcquire("launch"); // this process's real pid
    assert.equal(a.ok, true);
    assert.equal(new LifecycleLock({ by: "dashboard", dir }).tryAcquire("stop-all").ok, false);
    if (a.ok) a.release();
  });
  withDir((dir, file) => {
    new LifecycleLock({ by: "cohostctl", dir, pid: 5 }).tryAcquire("launch");
    const killed: number[] = [];
    const real = process.kill;
    process.kill = ((pid: number) => { killed.push(pid); throw Object.assign(new Error("nope"), { code: "EPERM" }); }) as typeof process.kill;
    try {
      assert.equal(new LifecycleLock({ by: "dashboard", dir }).tryAcquire("stop-all").ok, false);
    } finally { process.kill = real; }
    assert.deepEqual(killed, [5]);
    assert.equal(existsSync(file), true);
  });
});

// @spec CTRL-LOCK-003
test("a file whose pid is gone, or that does not parse, is removed and the lock taken", () => {
  withDir((dir, file) => {
    new LifecycleLock({ by: "cohostctl", dir, pid: 9 }).tryAcquire("launch");
    const r = new LifecycleLock({ by: "dashboard", dir, pid: 10, alive: () => false }).tryAcquire("stop-all");
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 10);
    if (r.ok) r.release();
    writeFileSync(file, "{not json");
    assert.equal(new LifecycleLock({ by: "dashboard", dir, pid: 11, alive: () => true }).tryAcquire("launch").ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 11);
  });
});
