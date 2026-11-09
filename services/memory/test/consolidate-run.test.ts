import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingLog, testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { runConsolidate } from "../src/consolidate-run.js";
import { META_LAST_CONSOLIDATION, META_SHUTDOWN_RUN_OWED } from "../src/consolidation.js";

function setup(store: "memory" | "postgres" = "postgres") {
  const cfg = testConfig({ brain: { memory: { store, embedder: "hash", notes: { dirty_threshold: 100 } } } });
  const mem = new InMemoryStore(cfg.brain.memory);
  const { log, lines } = recordingLog();
  const events: string[] = [];
  const hook = { run: async (input: { viewer: string }) => { events.push(`hook:${input.viewer}`); return { ops: [] }; } };
  const store_ = Object.assign(Object.create(mem) as InMemoryStore, {
    init: async () => { events.push("init"); },
    close: async () => { events.push("close"); },
  });
  return { cfg, mem, store: store_, log, lines, hook, events };
}

// @spec MEM-CONSOL-012
test("consolidate runs one pass over every viewer with a dirty note regardless of the threshold, clears the flag and closes the store", async () => {
  const t = setup();
  for (const k of ["amy", "bob"]) { await t.mem.touchViewer(k, k); await t.mem.insertNote({ userKey: k, category: "general", text: `note of ${k}` }); }
  await t.mem.setMeta(META_SHUTDOWN_RUN_OWED, "true");
  const res = await runConsolidate({ cfg: t.cfg, store: t.store, hook: t.hook, log: t.log });
  assert.deepEqual(res, { status: "completed", viewers: 2, notes: 2 });
  assert.deepEqual(t.events, ["init", "hook:amy", "hook:bob", "close"], "no waiting for the cortex");
  assert.equal(await t.mem.getMeta(META_SHUTDOWN_RUN_OWED), "false");
  assert.ok(await t.mem.getMeta(META_LAST_CONSOLIDATION));
});

// @spec MEM-CONSOL-012
test("consolidate with the in-memory store warns and runs no pass", async () => {
  const t = setup("memory");
  await t.mem.touchViewer("amy", "amy");
  await t.mem.insertNote({ userKey: "amy", category: "general", text: "a note" });
  const res = await runConsolidate({ cfg: t.cfg, store: t.store, hook: t.hook, log: t.log });
  assert.equal(res, undefined);
  assert.deepEqual(t.events, [], "the store is not even opened");
  assert.ok(t.lines.some((l) => l.level === "warn"));
});

// @spec MEM-CONSOL-012
test("consolidate leaves the flag alone when another pass holds the lock, and still closes the store", async () => {
  const t = setup();
  await t.mem.setMeta(META_SHUTDOWN_RUN_OWED, "true");
  const res = await t.mem.withConsolidationLock(() => runConsolidate({ cfg: t.cfg, store: t.store, hook: t.hook, log: t.log }));
  assert.deepEqual(res, { ran: true, value: { status: "skipped", viewers: 0, notes: 0 } });
  assert.equal(await t.mem.getMeta(META_SHUTDOWN_RUN_OWED), "true");
  assert.equal(t.events.at(-1), "close");
});

// @spec MEM-CONSOL-012
test("consolidate propagates a failure (the entry point exits 1) after closing the store, leaving the flag set", async () => {
  const t = setup();
  await t.mem.setMeta(META_SHUTDOWN_RUN_OWED, "true");
  t.store.dirtyViewerKeys = async () => { throw new Error("db down"); };
  await assert.rejects(runConsolidate({ cfg: t.cfg, store: t.store, hook: t.hook, log: t.log }), /db down/);
  assert.equal(t.events.at(-1), "close");
  assert.equal(await t.mem.getMeta(META_SHUTDOWN_RUN_OWED), "true");
});

// @spec MEM-CONSOL-012
test("consolidate fails when the store cannot initialise, closing it", async () => {
  const t = setup();
  t.store.init = async () => { throw new Error("no postgres"); };
  await assert.rejects(runConsolidate({ cfg: t.cfg, store: t.store, hook: t.hook, log: t.log }), /no postgres/);
  assert.equal(t.events.at(-1), "close");
});
