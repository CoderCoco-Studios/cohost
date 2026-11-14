// A Rust panic inside a binding call (BUS-NAT-ERR-006). The addon is rebuilt with the test-only cargo feature `test-panic`
// into a target directory of its own and loaded from a temp copy; `packages/bus/native/*.node` is never touched.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// @spec BUS-NAT-ERR-006, BUS-NAT-TRN-011
test("a panic in a binding call rejects with BUS_INTERNAL and the process stays alive", { timeout: 300_000 }, () => {
  const targetDir = join(root, "target", "test-panic");
  const build = spawnSync("cargo", ["build", "--release", "-p", "cohost-bus-node", "--features", "test-panic", "--target-dir", targetDir], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const addon = join(mkdtempSync(join(tmpdir(), "test-panic-")), "cohost-bus.test-panic.node");
  copyFileSync(join(targetDir, "release", "libcohost_bus_node.so"), addon);
  const script = `
    const b = require(${JSON.stringify(addon)});
    (async () => {
      let rejection;
      try { await b.testPanic(); } catch (e) { rejection = { code: e.code, message: e.message }; }
      await new Promise((r) => setTimeout(r, 50));
      // still alive: the binding answers another call, and a second panic is caught as well
      const alive = b.connectorKey("p", "x");
      let second;
      try { await b.testPanic(); } catch (e) { second = e.code; }
      console.log(JSON.stringify({ rejection, alive, second }));
    })();`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.stderr, "", "a caught panic prints nothing (BUS-NAT-TRN-011)");
  assert.equal(r.status, 0, `process exited ${r.status} ${r.signal}: ${r.stderr}`);
  const res = JSON.parse(r.stdout) as { rejection?: { code: string; message: string }; alive: string; second: string };
  assert.equal(res.rejection?.code, "BUS_INTERNAL");
  assert.match(res.rejection?.message ?? "", /test-panic/);
  assert.equal(res.alive, "p:connector:x");
  assert.equal(res.second, "BUS_INTERNAL");
});
