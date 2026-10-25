import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceController, resetConsumerGroups, type LifecycleRecord, type Runtime, type RuntimeResult } from "../src/index.js";

function setup(over: { advanced?: boolean; runtimeFail?: boolean; resetFail?: boolean } = {}) {
  const log: string[] = [];
  const audits: LifecycleRecord[] = [];
  const res = (): RuntimeResult => (over.runtimeFail ? { ok: false, detail: "boom" } : { ok: true });
  const runtime: Runtime = {
    name: "compose",
    async start(id, o) { log.push(`start ${id}${o?.env ? " " + JSON.stringify(o.env) : ""}`); return res(); },
    async stop(id) { log.push(`stop ${id}`); return res(); },
    async restart(id) { log.push(`restart ${id}`); return res(); },
  };
  const groups = { async resetGroup(g: string) { if (over.resetFail) throw new Error("redis down"); log.push(`reset ${g}`); } };
  const c = new ServiceController({ runtime, groups, by: "test", advanced: over.advanced, audit: (r) => { audits.push(r); } });
  return { c, log, audits };
}

test("fresh restart of cortex: stop, reset group, start (in that order)", async () => {
  const { c, log } = setup();
  assert.equal((await c.restart("cortex")).ok, true);
  assert.deepEqual(log, ["stop cortex", "reset cortex", "start cortex"]);
});

test("memory resumes by default: native restart, groups untouched", async () => {
  const { c, log } = setup();
  await c.restart("memory");
  assert.deepEqual(log, ["restart memory"]);
});

test("explicit mode:fresh resets both memory groups; mode:resume on cortex keeps the group", async () => {
  const a = setup();
  await a.c.restart("memory", { mode: "fresh" });
  assert.deepEqual(a.log, ["stop memory", "reset memory", "reset memory-recall", "start memory"]);
  const b = setup();
  await b.c.restart("cortex", { mode: "resume" });
  assert.deepEqual(b.log, ["restart cortex"]);
});

test("fresh start resets then starts; stop never resets", async () => {
  const { c, log } = setup();
  await c.start("voice");
  await c.stop("voice");
  assert.deepEqual(log, ["reset voice", "start voice", "stop voice"]);
});

test("a failed reset aborts the start and is reported", async () => {
  const { c, log, audits } = setup({ resetFail: true });
  const r = await c.restart("cortex");
  assert.equal(r.ok, false);
  assert.match(r.detail!, /redis down/);
  assert.deepEqual(log, ["stop cortex"]);
  assert.equal(audits[0]!.ok, false);
});

test("isolated start passes the manifest's preset env; restart recreates instead of a native restart", async () => {
  const { c, log } = setup();
  await c.start("memory", { isolated: true });
  await c.restart("cortex", { mode: "resume", isolated: true });
  assert.deepEqual(log, [
    `start memory {"MEMORY_STORE":"inmemory","MEMORY_EMBEDDER":"hash"}`,
    "stop cortex",
    `start cortex {"LLM_PROVIDER":"mock"}`,
  ]);
});

test("unknown id: refused 'unknown', nothing executed or audited", async () => {
  const { c, log, audits } = setup();
  for (const id of ["nope", "cortex; rm -rf /"]) {
    const r = await c.start(id);
    assert.equal(r.refused, "unknown");
  }
  assert.deepEqual(log, []);
  assert.deepEqual(audits, []);
});

test("dashboard cannot stop or restart itself (conflict)", async () => {
  const { c, log } = setup();
  assert.equal((await c.stop("dashboard")).refused, "conflict");
  assert.equal((await c.restart("dashboard")).refused, "conflict");
  assert.deepEqual(log, []);
});

test("infra is forbidden unless advanced, then executed (never reset)", async () => {
  const off = setup();
  assert.equal((await off.c.stop("redis")).refused, "forbidden");
  assert.equal((await off.c.start("postgres")).refused, "forbidden");
  assert.deepEqual(off.log, []);
  const on = setup({ advanced: true });
  assert.equal((await on.c.stop("postgres")).ok, true);
  assert.equal((await on.c.restart("redis", { mode: "fresh" })).ok, true);
  assert.deepEqual(on.log, ["stop postgres", "restart redis"]);
});

test("every attempt is audited, failures with ok:false and detail", async () => {
  const ok = setup();
  await ok.c.stop("voice");
  assert.deepEqual(ok.audits, [{ service: "voice", action: "stop", by: "test", ok: true }]);
  const bad = setup({ runtimeFail: true });
  await bad.c.start("eyes");
  assert.deepEqual(bad.audits, [{ service: "eyes", action: "start", by: "test", ok: false, detail: "boom" }]);
});

test("an audit that throws does not fail the action", async () => {
  const c2 = new ServiceController({
    runtime: { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) },
    groups: { resetGroup: async () => {} }, by: "x", audit: () => { throw new Error("bus down"); },
  });
  assert.equal((await c2.stop("voice")).ok, true);
});

test("resetConsumerGroups resets each group in order and stops at the first failure", async () => {
  const seen: string[] = [];
  assert.equal((await resetConsumerGroups({ resetGroup: async (g) => { seen.push(g); } }, ["a", "b"])).ok, true);
  assert.deepEqual(seen, ["a", "b"]);
  const r = await resetConsumerGroups({ resetGroup: async (g) => { if (g === "a") throw new Error("x"); seen.push(g); } }, ["a", "b"]);
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ["a", "b"]);
});
