import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseCli, runCli, parseProcessMode, UsageError, ServiceController, type Runtime, type ServiceHealth } from "../src/index.js";

// @spec CTRL-CLI-001
test("parseCli: commands, flags, defaults", () => {
  assert.deepEqual(parseCli(["status"]), { cmd: "status" });
  assert.deepEqual(parseCli(["status", "cortex"]), { cmd: "status", id: "cortex" });
  assert.deepEqual(parseCli(["stop", "memory"]), { cmd: "stop", id: "memory", opts: {} });
  assert.deepEqual(parseCli(["restart", "cortex", "--mode", "fresh", "--isolated"]), { cmd: "restart", id: "cortex", opts: { mode: "fresh", isolated: true } });
  assert.deepEqual(parseCli(["start", "voice", "--mode=resume"]), { cmd: "start", id: "voice", opts: { mode: "resume" } });
});

// @spec CTRL-CLI-001
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

// @spec CTRL-CLI-007
test("cohostctl rejects an invalid CONTROL_PROCESS_MODE with the dashboard's message and exits 2 without acting", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  // An unreachable Redis proves nothing was attempted: the check runs before the bus is used.
  const env = { ...process.env, CONTROL_RUNTIME: "process", CONTROL_PROCESS_MODE: "bogus", REDIS_URL: "redis://127.0.0.1:1" };
  const r = spawnSync(process.execPath, [cli, "start", "cortex"], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'CONTROL_PROCESS_MODE must be "dev" or "start", got "bogus"');
  assert.equal(r.stdout, "");
});

// @spec CTRL-CLI-007
test("parseProcessMode: empty or unset is dev, dev and start pass, anything else throws the loadControlConfig message", () => {
  assert.equal(parseProcessMode(undefined), "dev");
  assert.equal(parseProcessMode(""), "dev");
  assert.equal(parseProcessMode("dev"), "dev");
  assert.equal(parseProcessMode("start"), "start");
  assert.throws(() => parseProcessMode("prod"), /CONTROL_PROCESS_MODE must be "dev" or "start", got "prod"/);
});
