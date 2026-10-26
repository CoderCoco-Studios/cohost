import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { createMemoryEmbedder, createStore } from "../src/backend.js";
import { createMemoryHandler } from "../src/region.js";
import { MemoryHealth } from "../src/health.js";

const log = { warn() {}, info() {}, error() {}, debug() {} } as never;

test("createStore picks the fake for store=memory without touching the embedder", () => {
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash" } } } as never);
  assert.ok(createStore(cfg, createMemoryEmbedder(cfg), log) instanceof InMemoryStore);
});

test("region handler works end to end over the in-memory store", async () => {
  let t = 1_000_000;
  const cfg = testConfig();
  const store = new InMemoryStore({ ...cfg.brain.memory, recall_k: 3, min_similarity: 0.3 }, () => t);
  const published: { type: string; data: any }[] = [];
  const bus = { publish: async (type: string, data: unknown) => { published.push({ type, data }); return "1"; } } as never;
  const on = createMemoryHandler({ cfg, bus, store });
  const ev = (type: string, data: unknown) => ({ id: "1", type, ts: 0, source: "t", data }) as never;
  await on(ev("chat.message", { user: "bob", text: "coco I love speedrunning", mentionsCohost: true, userId: "1" }));
  t += 150_000;
  await on(ev("memory.recall.request", { id: "r1", query: "bob speedrunning", k: 3 }));
  const reply = published.find((p) => p.type === "memory.recall.reply")!;
  assert.equal(reply.data.id, "r1");
  assert.equal(reply.data.memories.length, 1);
  assert.ok(published.some((p) => p.type === "memory.viewer"));
});

test("hash embedder makes no network request; memory+hash reports mock with n/a deps", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network"); }) as typeof fetch;
  try {
    const cfg = testConfig({ brain: { memory: { embedder: "hash" } } } as never);
    await createMemoryEmbedder(cfg).embed("x");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  const h = new MemoryHealth({ store: "memory", embedder: "hash" });
  assert.equal(h.spec.mode, "mock");
});
