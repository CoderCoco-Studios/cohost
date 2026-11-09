import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingLog, testConfig } from "@cohost/testing";
import { ConsolidationScheduler, type CortexState } from "../src/scheduler.js";
import { META_SHUTDOWN_RUN_OWED, type PassResult } from "../src/consolidation.js";

function setup(over: Record<string, unknown> = {}, dirty = 0) {
  const cfg = testConfig({ brain: { memory: { notes: { dirty_threshold: 3, ...over } } } }).brain.memory.notes;
  const meta = new Map<string, string>();
  const { log, lines } = recordingLog();
  const state = { dirty };
  const passes: { gate: () => Promise<void>; signal: AbortSignal; finish: (r?: PassResult) => void; fail: (e: Error) => void }[] = [];
  const store = {
    dirtyNoteCount: async () => state.dirty,
    getMeta: async (k: string) => meta.get(k),
    setMeta: async (k: string, v: string) => { meta.set(k, v); },
  };
  const sched = new ConsolidationScheduler({
    store, cfg, log,
    runPass: (o) => new Promise<PassResult>((resolve, reject) => {
      passes.push({ ...o, finish: (r = { status: "completed", viewers: 1, notes: 1 }) => resolve(r), fail: reject });
    }),
  });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { sched, passes, meta, state, lines, tick };
}

// @spec MEM-CONSOL-001
test("a pass is scheduled when the dirty count reaches dirty_threshold, and no second while one is scheduled or running", async () => {
  const t = setup();
  t.state.dirty = 2;
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 0, "below the threshold");
  t.state.dirty = 3;
  await t.sched.notifyDirty();
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 1, "one pass for two notifications");
  t.state.dirty = 9;
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 1, "none while it runs");
  t.passes[0]!.finish();
  await t.tick();
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 2, "a later pass can be scheduled once the first is done");
});

// @spec MEM-CONSOL-001
test("dirty_threshold comes from config", async () => {
  const t = setup({ dirty_threshold: 1 });
  t.state.dirty = 1;
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 1);
});

// @spec MEM-CONSOL-002
test("a scheduled pass starts only while the cortex is idle or muted, or no status has been seen", async () => {
  for (const [state, starts] of [["idle", true], ["muted", true], ["thinking", false], ["speaking", false]] as [CortexState, boolean][]) {
    const t = setup();
    t.sched.onBrainStatus(state);
    t.state.dirty = 5;
    await t.sched.notifyDirty();
    assert.equal(t.passes.length, starts ? 1 : 0, state);
  }
  const unseen = setup();
  unseen.state.dirty = 5;
  await unseen.sched.notifyDirty();
  assert.equal(unseen.passes.length, 1, "no cortex running means nothing to compete with");
});

// @spec MEM-CONSOL-002
test("a pass held back by a busy cortex starts when it goes idle, once", async () => {
  const t = setup();
  t.sched.onBrainStatus("thinking");
  t.state.dirty = 5;
  await t.sched.notifyDirty();
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 0);
  t.sched.onBrainStatus("speaking");
  assert.equal(t.passes.length, 0);
  t.sched.onBrainStatus("idle");
  assert.equal(t.passes.length, 1);
  t.sched.onBrainStatus("idle");
  assert.equal(t.passes.length, 1, "scheduled only once");
});

// @spec MEM-CONSOL-003
test("a running pass waits between viewers while the cortex is thinking or speaking and resumes on idle or muted", async () => {
  const t = setup();
  t.state.dirty = 5;
  await t.sched.notifyDirty();
  const gate = t.passes[0]!.gate;
  let passed = 0;
  await gate(); passed++; // idle: straight through
  t.sched.onBrainStatus("thinking");
  const waiting = gate().then(() => { passed++; });
  await t.tick();
  assert.equal(passed, 1, "held while thinking");
  t.sched.onBrainStatus("speaking");
  await t.tick();
  assert.equal(passed, 1, "still held while speaking");
  t.sched.onBrainStatus("muted");
  await waiting;
  assert.equal(passed, 2, "released by muted");
  t.sched.onBrainStatus("thinking");
  const again = gate();
  t.sched.onBrainStatus("idle");
  await again;
});

// @spec MEM-CONSOL-015
test("at startup a pass is scheduled when the dirty count is at or above the threshold", async () => {
  const below = setup({}, 2);
  await below.sched.startup();
  assert.equal(below.passes.length, 0);
  const at = setup({}, 3);
  await at.sched.startup();
  assert.equal(at.passes.length, 1);
});

// @spec MEM-CONSOL-013
test("at startup with the shutdown flag set and dirty notes, one pass is scheduled (idle-gated) and the flag is cleared when it completes", async () => {
  const t = setup({}, 1);
  t.meta.set(META_SHUTDOWN_RUN_OWED, "true");
  t.sched.onBrainStatus("thinking");
  await t.sched.startup();
  assert.equal(t.passes.length, 0, "subject to MEM-CONSOL-002");
  t.sched.onBrainStatus("idle");
  assert.equal(t.passes.length, 1);
  assert.equal(t.meta.get(META_SHUTDOWN_RUN_OWED), "true", "not cleared before the pass completes");
  t.passes[0]!.finish();
  await t.tick();
  assert.equal(t.meta.get(META_SHUTDOWN_RUN_OWED), "false");
});

// @spec MEM-CONSOL-013
test("a shutdown flag with nothing dirty is cleared without a pass, and a flag stays set when the pass was skipped or interrupted", async () => {
  const none = setup({}, 0);
  none.meta.set(META_SHUTDOWN_RUN_OWED, "true");
  await none.sched.startup();
  assert.equal(none.passes.length, 0);
  assert.equal(none.meta.get(META_SHUTDOWN_RUN_OWED), "false");
  for (const status of ["skipped", "interrupted"] as const) {
    const t = setup({}, 1);
    t.meta.set(META_SHUTDOWN_RUN_OWED, "true");
    await t.sched.startup();
    t.passes[0]!.finish({ status, viewers: 0, notes: 0 });
    await t.tick();
    assert.equal(t.meta.get(META_SHUTDOWN_RUN_OWED), "true", status);
  }
});

// @spec MEM-CONSOL-013
test("a graceful shutdown stops the pass and sets the flag before the store closes, whichever way the stack was stopped", async () => {
  const t = setup({}, 5);
  await t.sched.startup();
  const pass = t.passes[0]!;
  const done = t.sched.shutdown(50);
  assert.equal(pass.signal.aborted, true, "a running pass is told to stop");
  await done; // the pass never finished: shutdown does not wait forever
  assert.equal(t.meta.get(META_SHUTDOWN_RUN_OWED), "true");
  const idle = setup();
  await idle.sched.shutdown();
  assert.equal(idle.meta.get(META_SHUTDOWN_RUN_OWED), "true", "set even when nothing ran");
});

// @spec MEM-CONSOL-013
test("a failing flag write at shutdown is logged, not thrown", async () => {
  const t = setup();
  (t.sched as unknown as { deps: { store: { setMeta: () => Promise<void> } } }).deps.store.setMeta = async () => { throw new Error("db closed"); };
  await t.sched.shutdown();
  assert.ok(t.lines.some((l) => l.level === "warn"));
});

// @spec MEM-CONSOL-011
test("a failing pass is logged and a later trigger can schedule another", async () => {
  const t = setup();
  t.state.dirty = 5;
  await t.sched.notifyDirty();
  t.passes[0]!.fail(new Error("connection lost"));
  await t.tick();
  assert.ok(t.lines.some((l) => l.level === "warn" || l.level === "error"));
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 2);
});

// @spec MEM-CONSOL-001
test("a failing dirty count is logged and schedules nothing", async () => {
  const t = setup();
  (t.sched as unknown as { deps: { store: { dirtyNoteCount: () => Promise<number> } } }).deps.store.dirtyNoteCount = async () => { throw new Error("db down"); };
  await t.sched.notifyDirty();
  assert.equal(t.passes.length, 0);
  assert.ok(t.lines.some((l) => l.level === "warn"));
});
