import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore, hashEmbed } from "../src/fake-store.js";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
function make(over: { recall_k?: number; min_similarity?: number } = {}) {
  let now = T0;
  const s = new InMemoryStore({ recall_k: 3, min_similarity: 0.3, ...over }, () => now);
  return { s, advance: (ms: number) => { now += ms; } };
}

test("hashEmbed is deterministic, unit-length, and closer for overlapping text", () => {
  const a = hashEmbed("the cursed sword in level three");
  assert.deepEqual(a, hashEmbed("the cursed sword in level three"));
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
  const dot = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * y[i]!, 0);
  assert.ok(dot(a, hashEmbed("cursed sword")) > dot(a, hashEmbed("pizza for dinner")));
});

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

test("recall respects k", async () => {
  const { s, advance } = make();
  for (const t of ["sword one", "sword two", "sword three"]) await s.remember("note", "x", t);
  advance(3 * 60_000);
  assert.equal((await s.recall("sword", 2)).length, 2);
});

test("touchViewer counts per case-insensitive key; first sight is new", async () => {
  const { s } = make();
  assert.deepEqual(await s.touchViewer("ABC", "Bob"), { msgCount: 1, notes: "", isNew: true });
  assert.deepEqual(await s.touchViewer("abc", "Bobby"), { msgCount: 2, notes: "", isNew: false });
});

test("recentSince is ordered and filtered; meta round-trips", async () => {
  const { s, advance } = make();
  await s.remember("chat", "a", "one");
  advance(1000);
  await s.remember("speech", "b", "two");
  assert.deepEqual((await s.recentSince(new Date(T0))).map((m) => m.text), ["two"]);
  assert.equal((await s.recentSince(new Date(T0 - 1))).length, 2);
  assert.equal(await s.getMeta("k"), undefined);
  await s.setMeta("k", "v");
  assert.equal(await s.getMeta("k"), "v");
  await s.close();
});
