import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { HashEmbedder } from "@cohost/llm";
import { InMemoryStore } from "../src/fake-store.js";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
function make(over: { recall_k?: number; min_similarity?: number } = {}) {
  let now = T0;
  const s = new InMemoryStore({ ...testConfig().brain.memory, recall_k: 3, min_similarity: 0.3, ...over }, () => now);
  return { s, advance: (ms: number) => { now += ms; } };
}

// @spec MEM-BACKEND-004
test("the in-memory store embeds with @cohost/llm's HashEmbedder: recall ranks by its cosine similarity", async () => {
  const { s, advance } = make({ min_similarity: 0 });
  await s.remember("chat", "bob", "the cursed sword in level three");
  await s.remember("chat", "amy", "pizza for dinner");
  advance(3 * 60_000);
  const got = await s.recall("cursed sword");
  const e = new HashEmbedder();
  const dot = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * y[i]!, 0);
  const q = await e.embed("cursed sword");
  const expected = await e.embed("bob: the cursed sword in level three");
  assert.ok(Math.abs(got.find((m) => m.who === "bob")!.similarity! - dot(q, expected)) < 1e-12);
  assert.equal(got[0]!.who, "bob");
  assert.deepEqual(await s.embedText("cursed sword"), q);
});

// @spec MEM-BACKEND-004, MEM-RECALL-004, MEM-RECALL-005
test("recall returns the most similar memories, skips the last 2 minutes, and honours min_similarity", async () => {
  const { s, advance } = make();
  await s.init();
  await s.remember("chat", "bob", "the cursed sword is in level three");
  await s.remember("chat", "amy", "I had pizza for dinner");
  advance(60_000);
  assert.deepEqual(await s.recall("cursed sword"), [], "too fresh");
  advance(120_000);
  const got = await s.recall("where is the cursed sword");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.who, "bob");
  assert.equal(got[0]!.kind, "chat");
  assert.ok(got[0]!.similarity! >= 0.3);
  assert.deepEqual(await s.recall("xylophone zebra"), []);
  assert.deepEqual(await s.recall("cursed sword", 0), []);
});

// @spec MEM-BACKEND-004
test("recall respects k", async () => {
  const { s, advance } = make();
  for (const t of ["sword one", "sword two", "sword three"]) await s.remember("chat", "x", t);
  advance(3 * 60_000);
  assert.equal((await s.recall("sword", 2)).length, 2);
});

// @spec MEM-BACKEND-005
test("touchViewer counts per case-insensitive key; first sight is new", async () => {
  const { s } = make();
  assert.deepEqual(await s.touchViewer("ABC", "Bob"), { msgCount: 1, notes: "", isNew: true, regular: false });
  assert.deepEqual(await s.touchViewer("abc", "Bobby"), { msgCount: 2, notes: "", isNew: false, regular: false });
});

// @spec MEM-BACKEND-006
test("recentSince is ordered and filtered; meta round-trips", async () => {
  const { s, advance } = make();
  await s.remember("chat", "a", "one");
  advance(1000);
  await s.remember("speech", "b", "two");
  assert.deepEqual((await s.recentSince({ ts: new Date(T0).toISOString(), id: 1 })).map((m) => m.text), ["two"]);
  assert.equal((await s.recentSince({ ts: new Date(T0 - 1).toISOString(), id: 0 })).length, 2);
  assert.equal(await s.getMeta("k"), undefined);
  await s.setMeta("k", "v");
  assert.equal(await s.getMeta("k"), "v");
  await s.close();
});

// @spec MEM-REFLECT-008
test("recentSince reads strictly after a (ts, id) cursor, including rows that share the cursor's timestamp", async () => {
  const { s, advance } = make();
  for (const t of ["a", "b", "c"]) await s.remember("chat", "x", t); // all at T0, ids 1..3
  advance(1000);
  await s.remember("chat", "x", "d"); // id 4
  assert.deepEqual((await s.recentSince({ ts: new Date(T0).toISOString(), id: 1 })).map((m) => m.text), ["b", "c", "d"]);
  assert.deepEqual((await s.recentSince({ ts: new Date(T0).toISOString(), id: 3 }, 1)).map((m) => m.text), ["d"]);
  assert.deepEqual((await s.recentSince({ ts: new Date(T0).toISOString(), id: 0 }, 2)).map((m) => m.text), ["a", "b"]);
});
