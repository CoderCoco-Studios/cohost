import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, EVENT_TYPES, EventPayloads, type BusEvent } from "../src/index.js";

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

// ---- service.heartbeat / health stream ----

const hb = (over: Record<string, unknown> = {}) => ({
  service: "t", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready" as const,
  deps: { x: "ok" as const }, mode: "live", intervalMs: 5000, ...over,
});

test("service.heartbeat is catalogued and validated", () => {
  assert.ok(EVENT_TYPES.includes("service.heartbeat"));
  assert.ok(EventPayloads["service.heartbeat"].safeParse(hb()).success);
  assert.ok(EventPayloads["service.heartbeat"].safeParse(hb({ detail: "d" })).success);
  assert.equal(EventPayloads["service.heartbeat"].safeParse(hb({ state: "dead" })).success, false);
  assert.equal(EventPayloads["service.heartbeat"].safeParse(hb({ deps: { x: "maybe" } })).success, false);
});

test("publish('service.heartbeat') throws and writes nothing (needs Redis)", needsRedis, async () => {
  const bus = new Bus("hb-reject", undefined, url);
  const r = new Redis(url);
  const before = await r.xlen("cohost:events");
  await assert.rejects(bus.publish("service.heartbeat", hb()), /publishHealth/);
  assert.equal(await r.xlen("cohost:events"), before);
  r.disconnect(); bus.stop();
});

test("publishHealth writes to cohost:health only, and rejects an invalid state (needs Redis)", needsRedis, async () => {
  const bus = new Bus("hb-route", undefined, url);
  const r = new Redis(url);
  const ev = await r.xlen("cohost:events");
  const h = await r.xlen("cohost:health");
  await bus.publishHealth(hb({ service: "route" }));
  assert.equal(await r.xlen("cohost:events"), ev);
  assert.equal(await r.xlen("cohost:health"), h + 1);
  await assert.rejects(bus.publishHealth(hb({ state: "dead" }) as never));
  assert.equal(await r.xlen("cohost:health"), h + 1, "nothing written for the invalid heartbeat");
  r.disconnect(); bus.stop();
});

test("recentHealth returns the newest heartbeats oldest-first; tailHealth delivers live ones (needs Redis)", needsRedis, async () => {
  const bus = new Bus("hb-recent", undefined, url);
  const watcher = new Bus("hb-tail", undefined, url);
  const tag = `rh-${Date.now()}`;
  const live = new Promise<string>((resolve) => {
    void watcher.tailHealth((h) => { if (h.data.service === `${tag}-live`) resolve(h.source); });
  });
  await new Promise((r) => setTimeout(r, 200));
  for (let n = 1; n <= 4; n++) await bus.publishHealth(hb({ service: tag, pid: n }));
  const got = await bus.recentHealth(3);
  assert.deepEqual(got.map((h) => h.data.pid), [2, 3, 4]);
  await bus.publishHealth(hb({ service: `${tag}-live` }));
  assert.equal(await within(live), "hb-recent");
  watcher.stop(); bus.stop();
});

// startHeartbeat against a recording publisher (no Redis).
import { startHeartbeat } from "../src/index.js";
class RecBus {
  readonly consumer = "rec-1";
  sent: { state: string; deps: Record<string, string>; ts: number }[] = [];
  fail = false;
  async publishHealth(d: ReturnType<typeof hb>): Promise<string> {
    if (this.fail) throw new Error("redis down");
    this.sent.push({ state: d.state, deps: d.deps, ts: Date.now() });
    return "1";
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("startHeartbeat publishes starting, then ready, then repeats every interval", async () => {
  const bus = new RecBus();
  const h = startHeartbeat(bus as never, { service: "t", mode: "live", deps: {}, intervalMs: 100 });
  await sleep(20);
  assert.deepEqual(bus.sent.map((s) => s.state), ["starting"]);
  h.ready();
  await sleep(20);
  assert.deepEqual(bus.sent.map((s) => s.state), ["starting", "ready"]);
  await sleep(250);
  assert.ok(bus.sent.filter((s) => s.state === "ready").length >= 3, "ready repeats");
  await h.stop();
});

test("startHeartbeat publishes immediately when a dep changes, and reports degraded", async () => {
  const bus = new RecBus();
  let dep: "ok" | "down" = "ok";
  const h = startHeartbeat(bus as never, { service: "t", mode: "live", deps: () => ({ x: dep }), intervalMs: 60_000 });
  h.ready();
  await sleep(20);
  const n = bus.sent.length;
  dep = "down";
  await sleep(1300); // change check runs at least once a second, interval is 60 s
  const last = bus.sent.at(-1)!;
  assert.ok(bus.sent.length > n);
  assert.equal(last.state, "degraded");
  assert.deepEqual(last.deps, { x: "down" });
  await h.stop();
});

test("stop() publishes a single stopping heartbeat and cancels the timer", async () => {
  const bus = new RecBus();
  const h = startHeartbeat(bus as never, { service: "t", mode: "live", deps: {}, intervalMs: 50 });
  h.ready();
  await h.stop(); await h.stop();
  const n = bus.sent.length;
  assert.equal(bus.sent.filter((s) => s.state === "stopping").length, 1);
  assert.equal(bus.sent.at(-1)!.state, "stopping");
  await sleep(150);
  assert.equal(bus.sent.length, n);
});

test("a failing publish is logged and does not throw into the service", async () => {
  const bus = new RecBus();
  bus.fail = true;
  const warns: unknown[] = [];
  const log = { warn: (o: unknown) => warns.push(o) } as never;
  const h = startHeartbeat(bus as never, { service: "t", mode: "live", deps: {}, intervalMs: 50, log });
  h.degraded("x"); h.ready();
  await sleep(80);
  await h.stop();
  assert.ok(warns.length >= 2);
});

test("SIGTERM publishes `stopping` before the service's own shutdown callback, then exits 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--import", "tsx", new URL("./shutdown.fixture.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["hb:starting", "hb:ready", "hb:stopping", "bus.stop"]);
});
