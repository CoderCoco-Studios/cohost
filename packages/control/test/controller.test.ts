import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceController, resetConsumerGroups, SERVICE_MANIFEST, findService, type ServiceDef, type LifecycleRecord, type Runtime, type RuntimeResult } from "../src/index.js";

function setup(over: { advanced?: boolean; runtimeFail?: boolean; resetFail?: boolean; failStart?: string; stopNotRunning?: boolean; manifest?: readonly ServiceDef[] } = {}) {
  const log: string[] = [];
  const audits: LifecycleRecord[] = [];
  const res = (): RuntimeResult => (over.runtimeFail ? { ok: false, detail: "boom" } : { ok: true });
  const runtime: Runtime = {
    name: "compose",
    async start(id, o) {
      log.push(`start ${id}${o?.env ? " " + JSON.stringify(o.env) : ""}`);
      return id === over.failStart ? { ok: false, detail: "no image" } : res();
    },
    async stop(id) {
      log.push(`stop ${id}`);
      return over.stopNotRunning ? { ok: false, notRunning: true, detail: "not running under this process runtime (no tracked pid)" } : res();
    },
    async restart(id) { log.push(`restart ${id}`); return res(); },
  };
  const groups = { async resetGroup(g: string) { if (over.resetFail) throw new Error("redis down"); log.push(`reset ${g}`); } };
  const c = new ServiceController({ runtime, groups, by: "test", advanced: over.advanced, audit: (r) => { audits.push(r); }, manifest: over.manifest });
  return { c, log, audits };
}

// @spec CTRL-GUARD-005
test("fresh restart of cortex: stop, reset group, start (in that order)", async () => {
  const { c, log } = setup();
  assert.equal((await c.restart("cortex")).ok, true);
  assert.deepEqual(log, ["stop cortex", "reset cortex", "start cortex"]);
});

// @spec CTRL-GUARD-005
test("memory resumes by default: native restart, groups untouched", async () => {
  const { c, log } = setup();
  await c.restart("memory");
  assert.deepEqual(log, ["restart memory"]);
});

// @spec CTRL-GUARD-005
test("explicit mode:fresh resets both memory groups; mode:resume on cortex keeps the group", async () => {
  const a = setup();
  await a.c.restart("memory", { mode: "fresh" });
  assert.deepEqual(a.log, ["stop memory", "reset memory", "reset memory-recall", "start memory"]);
  const b = setup();
  await b.c.restart("cortex", { mode: "resume" });
  assert.deepEqual(b.log, ["restart cortex"]);
});

// @spec CTRL-GUARD-004, CTRL-GUARD-005
test("fresh start resets then starts; stop never resets", async () => {
  const { c, log } = setup();
  await c.start("voice");
  await c.stop("voice");
  assert.deepEqual(log, ["reset voice", "start voice", "stop voice"]);
});

// @spec CTRL-GUARD-005
test("a failed reset aborts the start and is reported", async () => {
  const { c, log, audits } = setup({ resetFail: true });
  const r = await c.restart("cortex");
  assert.equal(r.ok, false);
  assert.match(r.detail!, /redis down/);
  assert.deepEqual(log, ["stop cortex"]);
  assert.equal(audits[0]!.ok, false);
});

// @spec CTRL-GUARD-006
test("isolated start passes the manifest's preset env; restart recreates instead of a native restart", async () => {
  const { c, log } = setup();
  await c.start("memory", { isolated: true });
  await c.restart("cortex", { mode: "resume", isolated: true });
  assert.deepEqual(log, [
    `start memory {"MEMORY_STORE":"memory","MEMORY_EMBEDDER":"hash"}`,
    "stop cortex",
    `start cortex {"LLM_PROVIDER":"mock"}`,
  ]);
});

// @spec CTRL-GUARD-001
test("unknown id: refused 'unknown', nothing executed or audited", async () => {
  const { c, log, audits } = setup();
  for (const id of ["nope", "cortex; rm -rf /"]) {
    const r = await c.start(id);
    assert.equal(r.refused, "unknown");
  }
  assert.deepEqual(log, []);
  assert.deepEqual(audits, []);
});

// @spec CTRL-GUARD-002
test("dashboard cannot stop or restart itself (conflict)", async () => {
  const { c, log } = setup();
  assert.equal((await c.stop("dashboard")).refused, "conflict");
  assert.equal((await c.restart("dashboard")).refused, "conflict");
  assert.deepEqual(log, []);
});

// @spec CTRL-GUARD-003
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

// @spec CTRL-GUARD-007
test("every attempt is audited, failures with ok:false and detail", async () => {
  const ok = setup();
  await ok.c.stop("voice");
  assert.deepEqual(ok.audits, [{ service: "voice", action: "stop", by: "test", ok: true }]);
  const bad = setup({ runtimeFail: true });
  await bad.c.start("eyes");
  assert.deepEqual(bad.audits, [{ service: "eyes", action: "start", by: "test", ok: false, detail: "boom" }]);
});

// @spec CTRL-GUARD-007
test("an audit that throws does not fail the action", async () => {
  const c2 = new ServiceController({
    runtime: { name: "compose", start: async () => ({ ok: true }), stop: async () => ({ ok: true }), restart: async () => ({ ok: true }) },
    groups: { resetGroup: async () => {} }, by: "x", audit: () => { throw new Error("bus down"); },
  });
  assert.equal((await c2.stop("voice")).ok, true);
});

// @spec CTRL-GUARD-004
test("resetConsumerGroups resets each group in order and stops at the first failure", async () => {
  const seen: string[] = [];
  assert.equal((await resetConsumerGroups({ resetGroup: async (g) => { seen.push(g); } }, ["a", "b"])).ok, true);
  assert.deepEqual(seen, ["a", "b"]);
  const r = await resetConsumerGroups({ resetGroup: async (g) => { if (g === "a") throw new Error("x"); seen.push(g); } }, ["a", "b"]);
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ["a", "b"]);
});

// @spec CTRL-GUARD-008
test("the manifest declares cortex requires salience and affect, and nothing else requires anything", () => {
  assert.deepEqual(findService("cortex")!.requires, ["salience", "affect"]);
  for (const s of SERVICE_MANIFEST) if (s.id !== "cortex") assert.equal(s.requires, undefined, s.id);
});

// @spec CTRL-GUARD-008
test("isolated start of cortex starts salience and affect first, each fresh and isolated, each audited", async () => {
  const { c, log, audits } = setup();
  const r = await c.start("cortex", { isolated: true });
  assert.equal(r.ok, true);
  assert.deepEqual(log, [
    "reset salience", "start salience {}",
    "reset affect", "start affect {}",
    "reset cortex", `start cortex {"LLM_PROVIDER":"mock"}`,
  ]);
  assert.deepEqual(audits.map((a) => `${a.action} ${a.service}`), ["start salience", "start affect", "start cortex"]);
});

// @spec CTRL-GUARD-008
test("a non-isolated start, and isolated restart or stop, never apply the closure", async () => {
  const a = setup();
  await a.c.start("cortex");
  assert.deepEqual(a.log, ["reset cortex", "start cortex"]);
  const b = setup();
  await b.c.restart("cortex", { isolated: true });
  await b.c.stop("cortex");
  assert.deepEqual(b.log, ["stop cortex", "reset cortex", `start cortex {"LLM_PROVIDER":"mock"}`, "stop cortex"]);
});

// @spec CTRL-GUARD-008
test("the closure is transitive and deduplicated, and tolerates cycles", async () => {
  const mk = (id: string, requires?: string[]): ServiceDef => ({ id, composeName: id, groups: [], defaultMode: "resume", infra: false, self: false, isolatedEnv: {}, ...(requires ? { requires } : {}) });
  const manifest = [mk("a", ["b", "c"]), mk("b", ["c"]), mk("c", ["a"])];
  const { c, log } = setup({ manifest });
  assert.equal((await c.start("a", { isolated: true })).ok, true);
  assert.deepEqual(log, ["start c {}", "start b {}", "start a {}"]);
});

// @spec CTRL-GUARD-008
test("a required unit that fails to start stops the closure; the named unit is not started", async () => {
  const { c, log, audits } = setup({ failStart: "affect" });
  const r = await c.start("cortex", { isolated: true });
  assert.equal(r.ok, false);
  assert.match(r.detail!, /affect/);
  assert.deepEqual(log, ["reset salience", "start salience {}", "reset affect", "start affect {}"]);
  assert.deepEqual(audits.map((a) => `${a.service} ${a.ok}`), ["salience true", "affect false"]);
});

// @spec CTRL-GUARD-009
test("fresh restart of a service the runtime reports as not running resets its groups and starts it", async () => {
  const { c, log, audits } = setup({ stopNotRunning: true });
  const r = await c.restart("cortex");
  assert.equal(r.ok, true);
  assert.deepEqual(log, ["stop cortex", "reset cortex", "start cortex"]);
  assert.deepEqual(audits.map((a) => `${a.action} ${a.service} ${a.ok}`), ["restart cortex true"]);
});

// @spec CTRL-GUARD-009
test("isolated restart of a service the runtime reports as not running starts it with the preset", async () => {
  const { c, log } = setup({ stopNotRunning: true });
  assert.equal((await c.restart("memory", { isolated: true })).ok, true);
  assert.deepEqual(log, ["stop memory", `start memory {"MEMORY_STORE":"memory","MEMORY_EMBEDDER":"hash"}`]);
});

// @spec CTRL-GUARD-009
test("a genuine stop failure during a fresh restart is returned without resetting or starting", async () => {
  const { c, log } = setup({ runtimeFail: true });
  const r = await c.restart("cortex");
  assert.equal(r.ok, false);
  assert.equal(r.detail, "boom");
  assert.deepEqual(log, ["stop cortex"]);
});
