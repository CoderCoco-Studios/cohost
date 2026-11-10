import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCli, runCli, buildRuntime, ComposeRuntime, UsageError, ServiceController, type Runtime, type ServiceHealth } from "../src/index.js";

// @spec CTRL-CLI-001
test("parseCli: commands, flags, defaults", () => {
  assert.deepEqual(parseCli(["status"]), { cmd: "status" });
  assert.deepEqual(parseCli(["status", "cortex"]), { cmd: "status", id: "cortex" });
  assert.deepEqual(parseCli(["stop", "memory"]), { cmd: "stop", id: "memory", opts: {} });
  assert.deepEqual(parseCli(["restart", "cortex", "--mode", "fresh", "--isolated"]), { cmd: "restart", id: "cortex", opts: { mode: "fresh", isolated: true } });
  assert.deepEqual(parseCli(["start", "voice", "--mode=resume"]), { cmd: "start", id: "voice", opts: { mode: "resume" } });
  assert.deepEqual(parseCli(["consolidate"]), { cmd: "consolidate" });
});

// @spec CTRL-CLI-001
test("parseCli: bad input throws UsageError", () => {
  for (const argv of [[], ["bogus"], ["start"], ["start", "a", "b"], ["start", "a", "--mode", "x"], ["start", "a", "--nope"], ["stop", "a", "--isolated"], ["status", "--isolated"], ["consolidate", "memory"], ["consolidate", "--isolated"], ["consolidate", "--mode", "fresh"]]) {
    assert.throws(() => parseCli(argv), UsageError, JSON.stringify(argv));
  }
});

function harness() {
  const log: string[] = [];
  const audits: unknown[] = [];
  const runtime: Runtime = {
    name: "compose",
    async start(id) { log.push(`start ${id}`); return { ok: true }; },
    async stop(id) { log.push(`stop ${id}`); return { ok: true }; },
    async restart(id) { log.push(`restart ${id}`); return { ok: true }; },
  };
  const controller = new ServiceController({ runtime, groups: { resetGroup: async (g) => { log.push(`reset ${g}`); } }, by: "cohostctl", audit: (r) => { audits.push(r); } });
  const out: string[] = [], err: string[] = [];
  const health = async (): Promise<ServiceHealth[]> => [{ service: "cortex", state: "up", restarts: 0, lastSeenAgeMs: 2000, heartbeat: { mode: "mock" } as never }];
  const consolidations: number[] = [];
  let consolidateResult: { ok: boolean; detail?: string } = { ok: true, detail: "consolidate completed" };
  const consolidate = async () => { consolidations.push(1); return consolidateResult; };
  return {
    log, audits, out, err, consolidations,
    setConsolidate: (r: { ok: boolean; detail?: string }) => { consolidateResult = r; },
    run: (argv: string[]) => runCli(argv, { controller, health, consolidate, out: (l) => out.push(l), err: (l) => err.push(l) }),
  };
}

// @spec CTRL-CLI-003
test("stop memory runs the runtime and audits as cohostctl", async () => {
  const h = harness();
  assert.equal(await h.run(["stop", "memory"]), 0);
  assert.deepEqual(h.log, ["stop memory"]);
  assert.deepEqual(h.audits, [{ service: "memory", action: "stop", by: "cohostctl", ok: true }]);
});

// @spec CTRL-CLI-003
test("restart cortex --mode fresh resets the group in between", async () => {
  const h = harness();
  assert.equal(await h.run(["restart", "cortex", "--mode", "fresh"]), 0);
  assert.deepEqual(h.log, ["stop cortex", "reset cortex", "start cortex"]);
});

// @spec CTRL-CLI-003
test("protections apply: dashboard stop and redis stop exit 1 without acting; unknown too", async () => {
  const h = harness();
  assert.equal(await h.run(["stop", "dashboard"]), 1);
  assert.equal(await h.run(["stop", "redis"]), 1);
  assert.equal(await h.run(["start", "nope"]), 1);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  assert.match(h.err[0]!, /conflict/);
});

// @spec CTRL-CLI-001, CTRL-CLI-002
test("usage errors exit 2; status prints rows", async () => {
  const h = harness();
  assert.equal(await h.run(["wat"]), 2);
  assert.equal(await h.run(["status"]), 0);
  assert.match(h.out[0]!, /cortex\s+up\s+mock\s+2s ago/);
  assert.equal(await h.run(["status", "nope"]), 1);
});

// @spec CTRL-CLI-008, CTRL-CLI-009
test("consolidate runs the one-shot, prints the result, and bypasses the controller and its audit", async () => {
  const h = harness();
  assert.equal(await h.run(["consolidate"]), 0);
  assert.deepEqual(h.out, ["consolidate: ok (consolidate completed)"]);
  assert.deepEqual(h.consolidations, [1]);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  h.setConsolidate({ ok: true });
  assert.equal(await h.run(["consolidate"]), 0);
  assert.equal(h.out[1], "consolidate: ok");
});

// @spec CTRL-CLI-008
test("consolidate failure prints the detail and exits 1; a usage error exits 2 without running it", async () => {
  const h = harness();
  h.setConsolidate({ ok: false, detail: "connection refused" });
  assert.equal(await h.run(["consolidate"]), 1);
  assert.deepEqual(h.err, ["consolidate failed: connection refused"]);
  h.err.length = 0;
  h.setConsolidate({ ok: false });
  assert.equal(await h.run(["consolidate"]), 1);
  assert.deepEqual(h.err, ["consolidate failed: unknown error"]);
  assert.equal(await h.run(["consolidate", "memory"]), 2);
  assert.equal(h.consolidations.length, 2);
});

// @spec CTRL-CLI-009
test("the CLI opens its bus lazily, so consolidate never connects to redis", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /const bus = new Bus/);
  assert.match(src, /bus \?\?= new Bus\("cohostctl"\)/);
});

// @spec CTRL-CLI-004
test("cohostctl always builds the compose runtime, whatever CONTROL_RUNTIME or CONTROL_PROCESS_MODE say", async () => {
  const saved = { r: process.env.CONTROL_RUNTIME, m: process.env.CONTROL_PROCESS_MODE };
  process.env.CONTROL_RUNTIME = "process";
  process.env.CONTROL_PROCESS_MODE = "bogus";
  try {
    const rt = buildRuntime();
    assert.ok(rt instanceof ComposeRuntime);
    assert.equal(rt.name, "compose");
  } finally {
    for (const [k, v] of [["CONTROL_RUNTIME", saved.r], ["CONTROL_PROCESS_MODE", saved.m]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
