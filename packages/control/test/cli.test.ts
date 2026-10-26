import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCli, runCli, UsageError, ServiceController, type Runtime, type ServiceHealth } from "../src/index.js";

test("parseCli: commands, flags, defaults", () => {
  assert.deepEqual(parseCli(["status"]), { cmd: "status" });
  assert.deepEqual(parseCli(["status", "cortex"]), { cmd: "status", id: "cortex" });
  assert.deepEqual(parseCli(["stop", "memory"]), { cmd: "stop", id: "memory", opts: {} });
  assert.deepEqual(parseCli(["restart", "cortex", "--mode", "fresh", "--isolated"]), { cmd: "restart", id: "cortex", opts: { mode: "fresh", isolated: true } });
  assert.deepEqual(parseCli(["start", "voice", "--mode=resume"]), { cmd: "start", id: "voice", opts: { mode: "resume" } });
});

test("parseCli: bad input throws UsageError", () => {
  for (const argv of [[], ["bogus"], ["start"], ["start", "a", "b"], ["start", "a", "--mode", "x"], ["start", "a", "--nope"], ["stop", "a", "--isolated"], ["status", "--isolated"]]) {
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
  return { log, audits, out, err, run: (argv: string[]) => runCli(argv, { controller, health, out: (l) => out.push(l), err: (l) => err.push(l) }) };
}

test("stop memory runs the runtime and audits as cohostctl", async () => {
  const h = harness();
  assert.equal(await h.run(["stop", "memory"]), 0);
  assert.deepEqual(h.log, ["stop memory"]);
  assert.deepEqual(h.audits, [{ service: "memory", action: "stop", by: "cohostctl", ok: true }]);
});

test("restart cortex --mode fresh resets the group in between", async () => {
  const h = harness();
  assert.equal(await h.run(["restart", "cortex", "--mode", "fresh"]), 0);
  assert.deepEqual(h.log, ["stop cortex", "reset cortex", "start cortex"]);
});

test("protections apply: dashboard stop and redis stop exit 1 without acting; unknown too", async () => {
  const h = harness();
  assert.equal(await h.run(["stop", "dashboard"]), 1);
  assert.equal(await h.run(["stop", "redis"]), 1);
  assert.equal(await h.run(["start", "nope"]), 1);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  assert.match(h.err[0]!, /conflict/);
});

test("usage errors exit 2; status prints rows", async () => {
  const h = harness();
  assert.equal(await h.run(["wat"]), 2);
  assert.equal(await h.run(["status"]), 0);
  assert.match(h.out[0]!, /cortex\s+up\s+mock\s+2s ago/);
  assert.equal(await h.run(["status", "nope"]), 1);
});
