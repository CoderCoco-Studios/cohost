import { test } from "node:test";
import assert from "node:assert/strict";
import type { HeartbeatEvent } from "@cohost/bus";
import { executeCli, type CliWiring, type LockResult, type Runtime, type StackResult, type StackStatus } from "../src/index.js";

const hbEvent = (service: string, ageMs = 1000): HeartbeatEvent => ({
  id: "1", type: "service.heartbeat", ts: Date.now() - ageMs, source: service,
  data: { service, instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 5000 },
});

/** Everything `executeCli` can build, each recording that it was built or used. */
function wiring(o: { recent?: HeartbeatEvent[]; status?: StackStatus; busThrows?: boolean; refuse?: string } = {}) {
  const lockLog: string[] = [];
  const built = { bus: 0, runtime: 0, stack: 0 };
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  const stacks: string[] = [];
  let stopped = 0;
  const bus = {
    publish: async (type: string, data: Record<string, unknown>) => { published.push({ type, data }); return "1"; },
    resetGroup: async () => {},
    recentHealth: async () => { if (o.busThrows) throw new Error("redis down"); return o.recent ?? []; },
    stop: () => { stopped++; },
  };
  const runtime: Runtime & { consolidate(): Promise<{ ok: boolean }>; reembed(): Promise<{ ok: boolean }> } = {
    name: "compose",
    start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }),
    consolidate: async () => ({ ok: true }), reembed: async () => ({ ok: true }),
  };
  const res: StackResult = { ok: true, services: [{ service: "redis", status: "running", health: "healthy" }] };
  const stackFor = (onPhase: (p: string) => void) => ({
    launch: async () => { stacks.push("launch"); onPhase("compose-up"); return res; },
    rebuild: async () => { stacks.push("rebuild"); onPhase("compose-build"); return res; },
    stopAll: async () => { stacks.push("stop-all"); return { ok: true }; },
    restartAll: async () => { stacks.push("restart-all"); return { ok: true, restarts: [] }; },
    statusWithRestarts: async (): Promise<StackStatus> => o.status ?? { docker: { ok: false, detail: "no docker" }, services: [] },
  });
  const out: string[] = [], err: string[] = [];
  const w: CliWiring = {
    openBus: () => { built.bus++; return bus as never; },
    buildRuntime: () => { built.runtime++; return runtime as never; },
    buildStack: (onPhase) => { built.stack++; return stackFor(onPhase) as never; },
    lock: {
      tryAcquire: (action): LockResult => {
        if (o.refuse) { lockLog.push(`refused ${action}`); return { ok: false, holder: { pid: 7, by: "dashboard", action: "launch", startedAt: 1 }, detail: o.refuse }; }
        lockLog.push(`acquired ${action}`);
        return { ok: true, release: () => { lockLog.push(`released ${action}`); } };
      },
    },
    out: (l) => out.push(l), err: (l) => err.push(l), env: {},
  };
  return { w, built, published, stacks, out, err, lockLog, stopped: () => stopped };
}

// @spec CTRL-CLI-013
test("arguments that do not parse exit 2 with the usage before any runtime, bus or stack is built", async () => {
  for (const argv of [[], ["bogus"], ["start"], ["status", "--mode", "x"], ["launch", "extra"], ["--nope"]]) {
    const h = wiring();
    assert.equal(await executeCli(argv, h.w), 2, JSON.stringify(argv));
    assert.deepEqual(h.built, { bus: 0, runtime: 0, stack: 0 }, JSON.stringify(argv));
    assert.match(h.err.join("\n"), /usage:/);
  }
});

// @spec CTRL-CLI-009, CTRL-CLI-014
test("consolidate, launch, rebuild and stop-all never open the bus", async () => {
  for (const argv of [["consolidate"], ["launch"], ["rebuild"], ["stop-all"]]) {
    const h = wiring();
    assert.equal(await executeCli(argv, h.w), 0, argv[0]);
    assert.equal(h.built.bus, 0, argv[0]);
    assert.deepEqual(h.published, []);
  }
});

// @spec CTRL-CLI-004
test("start publishes service.lifecycle by cohostctl through the bus it opened, and the bus is stopped afterwards", async () => {
  const h = wiring();
  assert.equal(await executeCli(["start", "voice"], h.w), 0);
  assert.equal(h.built.bus, 1);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0]!.type, "service.lifecycle");
  assert.equal(h.published[0]!.data.by, "cohostctl");
  assert.equal(h.published[0]!.data.service, "voice");
  assert.equal(h.stopped(), 1);
});

// @spec CTRL-CLI-005
test("the bus is stopped even when the command throws, and the error is reported with exit 1", async () => {
  const h = wiring({ busThrows: true });
  assert.equal(await executeCli(["status"], h.w), 1);
  assert.equal(h.stopped(), 1);
  assert.match(h.err.join("\n"), /redis down/);
});

// @spec CTRL-CLI-014
test("rebuild prints its phases and container lines and ends with 'rebuild: ok'", async () => {
  const h = wiring();
  assert.equal(await executeCli(["rebuild"], h.w), 0);
  assert.deepEqual(h.stacks, ["rebuild"]);
  assert.equal(h.out[0], "rebuild: compose-build");
  assert.match(h.out[1]!, /^redis\s+running healthy$/);
  assert.equal(h.out.at(-1), "rebuild: ok");
});

// @spec CTRL-CLI-014
test("rebuild failure prints 'rebuild failed: <detail>' and exits 1; rebuild takes no arguments or options", async () => {
  const h = wiring();
  h.w.buildStack = () => ({
    rebuild: async () => ({ ok: false, detail: "build error" }),
  }) as never;
  assert.equal(await executeCli(["rebuild"], h.w), 1);
  assert.deepEqual(h.err, ["rebuild failed: build error"]);
  assert.equal(await executeCli(["rebuild", "x"], wiring().w), 2);
  assert.equal(await executeCli(["rebuild", "--isolated"], wiring().w), 2);
});

// @spec CTRL-CLI-015
test("status merges container restart counts: a service that never beat but whose container restarts shows crash-looping", async () => {
  const h = wiring({
    recent: [hbEvent("chat")],
    status: { docker: { ok: true }, services: [{ service: "cortex", status: "restarting", restartCount: 5 }, { service: "chat", status: "running", restartCount: 0 }] },
  });
  assert.equal(await executeCli(["status"], h.w), 0);
  const row = (name: string) => h.out.find((l) => l.startsWith(name))!;
  assert.match(row("cortex"), /^cortex\s+crash-looping\s/);
  assert.match(row("chat"), /^chat\s+up\s/);
});

// @spec CTRL-CLI-015
test("status with Docker unavailable prints the heartbeat-derived rows unchanged", async () => {
  const h = wiring({ recent: [hbEvent("chat")] });
  assert.equal(await executeCli(["status"], h.w), 0);
  assert.match(h.out.find((l) => l.startsWith("cortex"))!, /^cortex\s+unknown\s/);
  assert.match(h.out.find((l) => l.startsWith("chat"))!, /^chat\s+up\s/);
});

// @spec CTRL-LOCK-004
test("every lifecycle command holds the lifecycle lock for the whole command and releases it afterwards; status takes none", async () => {
  for (const argv of [["start", "voice"], ["stop", "voice"], ["restart", "voice"], ["consolidate"], ["reembed"], ["launch"], ["rebuild"], ["stop-all"], ["restart-all"]]) {
    const h = wiring();
    assert.equal(await executeCli(argv, h.w), 0, argv[0]);
    assert.deepEqual(h.lockLog, [`acquired ${argv[0]}`, `released ${argv[0]}`], argv[0]);
  }
  const s = wiring();
  assert.equal(await executeCli(["status"], s.w), 0);
  assert.deepEqual(s.lockLog, []);
});

// @spec CTRL-LOCK-004
test("a refused lock runs nothing, prints 'refused: <detail>' and exits 1", async () => {
  for (const argv of [["launch"], ["stop-all"], ["start", "voice"], ["consolidate"]]) {
    const h = wiring({ refuse: "busy: launch held by dashboard (pid 7)" });
    assert.equal(await executeCli(argv, h.w), 1, argv[0]);
    assert.deepEqual(h.err, ["refused: busy: launch held by dashboard (pid 7)"], argv[0]);
    assert.deepEqual(h.stacks, []);
    assert.deepEqual(h.published, []);
    assert.equal(h.built.bus, 0);
  }
});

// @spec CTRL-LOCK-004
test("the lock is released when the command throws", async () => {
  const h = wiring();
  h.w.buildStack = () => ({ launch: async () => { throw new Error("boom"); } }) as never;
  assert.equal(await executeCli(["launch"], h.w), 1);
  assert.deepEqual(h.lockLog, ["acquired launch", "released launch"]);
});
