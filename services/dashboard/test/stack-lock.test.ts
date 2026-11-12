import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingLog } from "@cohost/testing";
import type { LockResult, StackResult, StackStatus } from "@cohost/control";
import { StackService, type StackOps } from "../src/stack.js";

const up: StackStatus = { docker: { ok: true }, services: [{ service: "redis", status: "running", health: "healthy" }] };
const down: StackStatus = { docker: { ok: true }, services: [] };
const restarter = { restart: async () => ({ ok: true }) };
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A service whose lock records acquire/release and can be made to refuse; a long action is finished by the test. */
function harness(o: { holder?: string; status?: StackStatus } = {}) {
  const log: string[] = [];
  let refuse = o.holder;
  let finish: (r: StackResult) => void = () => {};
  const ops: StackOps = {
    status: async () => o.status ?? up,
    launch: async () => new Promise<StackResult>((r) => { finish = r; }),
    rebuild: async () => ({ ok: true }),
    stopAll: async () => { throw new Error("boom"); },
    restartAll: async () => ({ ok: true }),
    consolidate: async () => ({ ok: true }),
  };
  const lock = {
    tryAcquire: (action: string): LockResult => {
      if (refuse) { log.push(`refused ${action}`); return { ok: false, holder: { pid: 4321, by: "cohostctl", action: refuse, startedAt: 1 }, detail: `busy: ${refuse} held by cohostctl (pid 4321)` }; }
      log.push(`acquired ${action}`);
      return { ok: true, release: () => { log.push(`released ${action}`); } };
    },
  };
  const svc = new StackService({ log: recordingLog().log, bus: () => "connected", lock });
  svc.attach(ops);
  return { svc, log, finish: (r: StackResult) => finish(r), clear: () => { refuse = undefined; } };
}

// @spec DASH-STACK-009
test("a stack action holds the lifecycle lock until it finishes, then releases it", async () => {
  const h = harness();
  await h.svc.probe();
  assert.deepEqual(h.svc.request("launch", restarter), { ok: true, action: "launch" });
  assert.deepEqual(h.log, ["acquired launch"]);
  h.finish({ ok: true });
  await tick(); await tick();
  assert.deepEqual(h.log, ["acquired launch", "released launch"]);
});

// @spec DASH-STACK-009
test("the lock is released when the action throws", async () => {
  const h = harness();
  await h.svc.probe();
  assert.equal(h.svc.request("stop", restarter).ok, true);
  await tick(); await tick();
  assert.deepEqual(h.log, ["acquired stop", "released stop"]);
  assert.equal(h.svc.snapshot().last?.ok, false);
});

// @spec DASH-STACK-009
test("a lock held by cohostctl refuses a stack request 409 naming the holder, and runs nothing", async () => {
  const h = harness({ holder: "launch" });
  await h.svc.probe();
  assert.deepEqual(h.svc.request("stop", restarter), { ok: false, status: 409, detail: "busy: launch held by cohostctl (pid 4321)" });
  assert.equal(h.svc.snapshot().action, null);
  h.clear();
  assert.equal(h.svc.request("launch", restarter).ok, true); // nothing was left claimed in this process
});

// @spec DASH-STACK-009
test("a lifecycle request takes the lock too: refused while cohostctl holds it, released with its slot", async () => {
  const h = harness({ holder: "stop-all" });
  assert.equal(h.svc.tryAcquire("service-restart"), undefined);
  assert.equal(h.svc.busyDetail(), "busy: stop-all held by cohostctl (pid 4321)");
  h.clear();
  const release = h.svc.tryAcquire("service-restart");
  assert.ok(release);
  assert.equal(h.svc.busyKind(), "service-restart");
  release!();
  assert.deepEqual(h.log, ["refused service-restart", "acquired service-restart", "released service-restart"]);
  assert.ok(h.svc.tryAcquire("service-stop"));
});

// @spec DASH-STACK-009
test("a request refused by the Docker or precondition checks takes no lock", async () => {
  const h = harness({ status: down });
  await h.svc.probe();
  assert.equal(h.svc.request("restart", restarter).ok, false); // 409: stack is down
  assert.deepEqual(h.log, []);
});
