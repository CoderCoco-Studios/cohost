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

const hasRedis = await redisUp();
const needsRedis = { skip: !hasRedis && `no Redis at ${url}` };
const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);

test("publish validates the payload before it reaches the stream (needs Redis)", needsRedis, async () => {
  const bus = new Bus("validate", undefined, url);
  await assert.rejects(bus.publish("affect.state", { valence: 5, arousal: 0, mood: "happy" }));
  await assert.rejects(bus.publish("affect.state", { valence: 0, arousal: 0, mood: "ecstatic" } as never));
  bus.stop();
});

test("a throwing handler is logged, the event acked, and the loop keeps going (needs Redis)", needsRedis, async () => {
  const group = `throw-${Date.now()}`;
  const errors: unknown[] = [];
  const log = { error: (o: unknown) => errors.push(o), debug() {}, info() {}, warn() {} } as never;
  const pub = new Bus("pub", undefined, url);
  const sub = new Bus("sub", log, url);
  const seen: string[] = [];
  const second = new Promise<void>((resolve) => {
    void sub.subscribe({ group, types: ["control"], fromNow: true, blockMs: 100 }, (ev) => {
      seen.push(ev.data.cmd);
      if (ev.data.cmd === "mute") throw new Error("handler blew up");
      resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  await pub.publish("control", { cmd: "mute" });
  await pub.publish("control", { cmd: "unmute" });
  await within(second);
  assert.deepEqual(seen, ["mute", "unmute"]);
  assert.equal(errors.length, 1);
  const r = new Redis(url);
  const pending = (await r.xpending("cohost:events", group)) as [number, ...unknown[]];
  assert.equal(pending[0], 0, "both events acked");
  r.disconnect();
  sub.stop(); pub.stop();
});

test("recent() returns the newest events oldest-first and skips entries it can't decode (needs Redis)", needsRedis, async () => {
  const bus = new Bus("recent", undefined, url);
  const tag = `r-${Date.now()}`;
  const r = new Redis(url);
  await bus.publish("brain.status", { state: "idle", detail: `${tag}-1` });
  await r.xadd("cohost:events", "*", "type", "not.a.type", "ts", "1", "source", "x", "data", "{}");
  await r.xadd("cohost:events", "*", "type", "brain.status", "ts", "1", "source", "x", "data", "{not json");
  await r.xadd("cohost:events", "*", "type", "brain.status", "ts", "1", "source", "x", "data", JSON.stringify({ state: "dancing" }));
  await bus.publish("brain.status", { state: "thinking", detail: `${tag}-2` });
  const got = await bus.recent(5);
  assert.deepEqual(got.map((e) => (e.data as { detail?: string }).detail), [`${tag}-1`, `${tag}-2`]);
  assert.equal(got[1]!.source, "recent");
  assert.ok(got[1]!.ts > 0);
  r.disconnect();
  bus.stop();
});

test("tail() delivers live events without a consumer group (needs Redis)", needsRedis, async () => {
  const pub = new Bus("tailpub", undefined, url);
  const watcher = new Bus("tail", undefined, url);
  const tag = `t-${Date.now()}`;
  const got = new Promise<string>((resolve) => {
    void watcher.tail((ev) => {
      const d = ev.data as { detail?: string };
      if (ev.type === "brain.status" && d.detail === tag) resolve(ev.source);
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  await pub.publish("brain.status", { state: "idle", detail: tag });
  assert.equal(await within(got), "tailpub");
  watcher.stop(); pub.stop();
});

test("subscribe() and tail() resolve when stop() interrupts a blocking read (needs Redis)", needsRedis, async () => {
  const bus = new Bus("stopper", undefined, url);
  const sub = bus.subscribe({ group: `stop-${Date.now()}`, fromNow: true, blockMs: 5000 }, () => {});
  const tail = bus.tail(() => {});
  await new Promise((r) => setTimeout(r, 200)); // both are now parked in BLOCK
  bus.stop();
  await within(Promise.all([sub, tail]), 2000);
});
