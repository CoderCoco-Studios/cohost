import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCli, runCli, buildRuntime, ComposeRuntime, UsageError, ServiceController, type Runtime, type ServiceHealth, type StackResult, type CliDeps } from "../src/index.js";

// @spec CTRL-CLI-001
test("parseCli: commands, flags, defaults", () => {
  assert.deepEqual(parseCli(["status"]), { cmd: "status" });
  assert.deepEqual(parseCli(["status", "cortex"]), { cmd: "status", id: "cortex" });
  assert.deepEqual(parseCli(["stop", "memory"]), { cmd: "stop", id: "memory", opts: {} });
  assert.deepEqual(parseCli(["restart", "cortex", "--mode", "fresh", "--isolated"]), { cmd: "restart", id: "cortex", opts: { mode: "fresh", isolated: true } });
  assert.deepEqual(parseCli(["start", "voice", "--mode=resume"]), { cmd: "start", id: "voice", opts: { mode: "resume" } });
  assert.deepEqual(parseCli(["consolidate"]), { cmd: "consolidate" });
  assert.deepEqual(parseCli(["reembed"]), { cmd: "reembed" });
  assert.deepEqual(parseCli(["launch"]), { cmd: "launch" });
  assert.deepEqual(parseCli(["stop-all"]), { cmd: "stop-all" });
  assert.deepEqual(parseCli(["restart-all"]), { cmd: "restart-all" });
});

// @spec CTRL-CLI-001
test("parseCli: bad input throws UsageError", () => {
  for (const argv of [[], ["bogus"], ["start"], ["start", "a", "b"], ["start", "a", "--mode", "x"], ["start", "a", "--nope"], ["stop", "a", "--isolated"], ["status", "--isolated"], ["consolidate", "memory"], ["reembed", "memory"], ["reembed", "--isolated"], ["reembed", "--mode", "fresh"], ["consolidate", "--isolated"], ["consolidate", "--mode", "fresh"], ["launch", "x"], ["launch", "--isolated"], ["launch", "--mode", "fresh"], ["stop-all", "cortex"], ["stop-all", "--isolated"], ["restart-all", "cortex"], ["restart-all", "--mode", "resume"], ["stop", "a", "--mode", "fresh"]]) {
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
  const reembeds: number[] = [];
  let reembedResult: { ok: boolean; detail?: string } = { ok: true, detail: "reembed completed" };
  const reembed = async () => { reembeds.push(1); return reembedResult; };
  const stackCalls: string[] = [];
  let launchResult: StackResult = { ok: true, services: [{ service: "redis", status: "running", health: "healthy" }, { service: "ollama", status: "running" }, { service: "models", status: "exited", exitCode: 0 }] };
  let restartResult: StackResult = { ok: true, restarts: [{ id: "cortex", ok: true }, { id: "voice", ok: true }] };
  let stopResult: StackResult = { ok: true };
  const stack: CliDeps["stack"] = {
    async launch(onPhase) { stackCalls.push("launch"); onPhase("compose-up"); onPhase("waiting"); return launchResult; },
    async stopAll() { stackCalls.push("stop-all"); return stopResult; },
    async restartAll() { stackCalls.push("restart-all"); return restartResult; },
  };
  return {
    log, audits, out, err, consolidations, reembeds, stackCalls,
    setReembed: (r: { ok: boolean; detail?: string }) => { reembedResult = r; },
    setLaunch: (r: StackResult) => { launchResult = r; },
    setRestart: (r: StackResult) => { restartResult = r; },
    setStop: (r: StackResult) => { stopResult = r; },
    setConsolidate: (r: { ok: boolean; detail?: string }) => { consolidateResult = r; },
    run: (argv: string[]) => runCli(argv, { controller, health, consolidate, reembed, stack, out: (l) => out.push(l), err: (l) => err.push(l) }),
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
test("protections apply: dashboard is unknown, redis stop is forbidden; both exit 1 without acting", async () => {
  const h = harness();
  assert.equal(await h.run(["stop", "dashboard"]), 1);
  assert.equal(await h.run(["stop", "redis"]), 1);
  assert.equal(await h.run(["start", "nope"]), 1);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  assert.match(h.err[0]!, /refused \(unknown\)/);
  assert.match(h.err[1]!, /refused \(forbidden\)/);
});

// @spec CTRL-CLI-001, CTRL-CLI-002
test("usage errors exit 2; status prints rows", async () => {
  const h = harness();
  assert.equal(await h.run(["wat"]), 2);
  assert.equal(await h.run(["status"]), 0);
  assert.match(h.out[0]!, /cortex\s+up\s+mock\s+2s ago/);
  assert.equal(await h.run(["status", "nope"]), 1);
});

// @spec CTRL-CLI-013
test("reembed runs the one-shot, prints the result, exits 1 on failure, and never touches the controller or its audit", async () => {
  const h = harness();
  assert.equal(await h.run(["reembed"]), 0);
  assert.deepEqual(h.out, ["reembed: ok (reembed completed)"]);
  assert.deepEqual(h.reembeds, [1]);
  assert.deepEqual(h.consolidations, []);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  h.setReembed({ ok: false, detail: "ollama unreachable" });
  assert.equal(await h.run(["reembed"]), 1);
  assert.deepEqual(h.err, ["reembed failed: ollama unreachable"]);
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

// @spec CTRL-CLI-010
test("launch: prints each phase, a line per long-running container, then 'launch: ok'; the one-shot is not listed", async () => {
  const h = harness();
  assert.equal(await h.run(["launch"]), 0);
  assert.deepEqual(h.out.slice(0, 2), ["launch: compose-up", "launch: waiting"]);
  assert.match(h.out[2]!, /^redis\s+running healthy$/);
  assert.match(h.out[3]!, /^ollama\s+running$/);
  assert.equal(h.out.length, 5);
  assert.equal(h.out[4], "launch: ok");
  h.setLaunch({ ok: true, detail: "models exited 1", services: [] });
  assert.equal(await h.run(["launch"]), 0);
  assert.equal(h.out.at(-1), "launch: ok (models exited 1)");
});

// @spec CTRL-CLI-010
test("launch failure prints the container lines, then 'launch failed: <detail>' and exits 1", async () => {
  const h = harness();
  h.setLaunch({ ok: false, detail: "cortex (running, starting)", services: [{ service: "cortex", status: "running", health: "starting" }] });
  assert.equal(await h.run(["launch"]), 1);
  assert.match(h.out.at(-1)!, /^cortex\s+running starting$/);
  assert.deepEqual(h.err, ["launch failed: cortex (running, starting)"]);
});

// @spec CTRL-CLI-011
test("stop-all: ok prints stop-all: ok and the consolidate hint; failure exits 1", async () => {
  const h = harness();
  assert.equal(await h.run(["stop-all"]), 0);
  assert.equal(h.out[0], "stop-all: ok");
  assert.match(h.out[1]!, /cohostctl consolidate/);
  h.setStop({ ok: false, detail: "daemon gone" });
  assert.equal(await h.run(["stop-all"]), 1);
  assert.deepEqual(h.err, ["stop-all failed: daemon gone"]);
});

// @spec CTRL-CLI-012
test("restart-all: prints a line per restarted unit; exit 0 when all ok, else 1 (including none running)", async () => {
  const h = harness();
  assert.equal(await h.run(["restart-all"]), 0);
  assert.deepEqual(h.out, ["restart cortex: ok", "restart voice: ok"]);
  h.setRestart({ ok: false, detail: "voice: boom", restarts: [{ id: "cortex", ok: true }, { id: "voice", ok: false, detail: "boom" }] });
  assert.equal(await h.run(["restart-all"]), 1);
  assert.deepEqual(h.err, ["restart voice failed: boom"]);
  h.err.length = 0;
  h.setRestart({ ok: false, detail: "no application service is running", restarts: [] });
  assert.equal(await h.run(["restart-all"]), 1);
  assert.deepEqual(h.err, ["restart-all failed: no application service is running"]);
});

// @spec CTRL-CLI-009
test("launch and stop-all neither read health, touch the controller nor audit", async () => {
  const h = harness();
  await h.run(["launch"]);
  await h.run(["stop-all"]);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.audits, []);
  assert.deepEqual(h.stackCalls, ["launch", "stop-all"]);
});

// @spec CTRL-CLI-009, CTRL-STACK-001
test("the compose runtime is built with the workspace root as its working directory", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(src, /findWorkspaceRoot\(\) \?\? process\.cwd\(\)/);
});
