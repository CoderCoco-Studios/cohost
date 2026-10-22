import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, EventPayloads, type BusEvent } from "../src/index.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}

test("every region event validates its documented shape", () => {
  assert.ok(EventPayloads["attention.focus"].safeParse({ reason: "mentioned", score: 1, focus: { kind: "chat", who: "u", text: "hi" } }).success);
  assert.ok(EventPayloads["affect.state"].safeParse({ valence: 0.2, arousal: 0.4, mood: "happy" }).success);
  assert.equal(EventPayloads["affect.state"].safeParse({ valence: 2, arousal: 0.4, mood: "happy" }).success, false);
  assert.ok(EventPayloads["memory.recall.request"].safeParse({ id: "x", query: "q" }).success);
  assert.ok(EventPayloads["memory.recall.reply"].safeParse({ id: "x", memories: [{ ts: 1, kind: "chat", who: "u", text: "t" }] }).success);
  assert.ok(EventPayloads["memory.viewer"].safeParse({ user: "u", isNew: true, msgCount: 1 }).success);
});

test("publish → consumer group subscribe round-trip (needs Redis)", { skip: !(await redisUp()) && `no Redis at ${url}` }, async () => {
  const group = `test-${Date.now()}`;
  const pub = new Bus(`pub-${group}`, undefined, url);
  const sub = new Bus(`sub-${group}`, undefined, url);
  const got: BusEvent[] = [];
  const done = new Promise<void>((resolve) => {
    void sub.subscribe({ group, types: ["attention.focus"], fromNow: true, blockMs: 200 }, (ev) => { got.push(ev); resolve(); });
  });
  await new Promise((r) => setTimeout(r, 300)); // let the group get created at "$"
  await pub.publish("affect.state", { valence: 0, arousal: 0, mood: "neutral" }); // filtered out by types
  await pub.publish("attention.focus", { reason: "test", score: 0.7 });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for event")), 3000))]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.type, "attention.focus");
  assert.equal(got[0]!.source, `pub-${group}`);
  assert.deepEqual(got[0]!.data, { reason: "test", score: 0.7 });
  sub.stop(); pub.stop();
});
