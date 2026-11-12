import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Bus, type HeartbeatEvent } from "@cohost/bus";
import { isHealthy, checkHealth } from "../src/healthcheck.js";

const rec = (service: string, ageMs: number, state: HeartbeatEvent["data"]["state"] = "ready", now = 1_000_000): HeartbeatEvent => ({
  id: "1", type: "service.heartbeat", ts: now - ageMs, source: service,
  data: { service, instance: "i", pid: 1, version: "0", startedAt: 1, state, deps: {}, mode: "live", intervalMs: 5000 },
});

// @spec CTRL-CHECK-001
test("fresh heartbeat is healthy", () => {
  assert.equal(isHealthy("chat", [rec("chat", 2000)], 1_000_000), true);
});

// @spec CTRL-CHECK-001
test("silent service (no heartbeat, or older than 3x interval) is unhealthy", () => {
  assert.equal(isHealthy("chat", [], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("chat", 20_000)], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("voice", 1000)], 1_000_000), false);
});

// @spec CTRL-CHECK-001
test("stopping is unhealthy even when fresh; only the newest heartbeat counts", () => {
  assert.equal(isHealthy("chat", [rec("chat", 1000, "stopping")], 1_000_000), false);
  assert.equal(isHealthy("chat", [rec("chat", 9000, "stopping"), rec("chat", 1000)], 1_000_000), true);
});

// The CLI test never touches the live stack's streams: it runs in Redis database 15 of the same server (a database no
// service uses), where it publishes its heartbeat and deletes the health stream in `finally`.
const liveUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const url = `${liveUrl.replace(/\/\d*$/, "")}/15`;
async function redisUp(): Promise<boolean> {
  const probe = new Bus("hc-probe", undefined, url);
  try {
    await Promise.race([probe.recentHealth(1), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800))]);
    return true;
  } catch { return false; } finally { probe.stop(); }
}
/** Delete the health stream of the test database through the bus package's own ioredis. */
async function dropHealthStream(): Promise<void> {
  const { Redis } = createRequire(import.meta.resolve("@cohost/bus"))("ioredis") as typeof import("ioredis");
  const r = new Redis(url, { maxRetriesPerRequest: 1 });
  try { await r.del("cohost:health"); } finally { r.disconnect(); }
}

// @spec CTRL-CHECK-002
test("CLI exits 0 for a fresh service and 1 for a silent one (needs Redis)", { skip: !(await redisUp()) && `no Redis at ${url}` }, async () => {
  const bus = new Bus("hc-test", undefined, url);
  const name = `hc-${Date.now()}`;
  try {
    await bus.publishHealth({ service: name, instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 5000 });
    const run = (svc: string) =>
      spawnSync(process.execPath, [new URL("../dist/healthcheck.js", import.meta.url).pathname, svc], { env: { ...process.env, REDIS_URL: url } }).status;
    assert.equal(run(name), 0);
    assert.equal(run(`${name}-silent`), 1);
  } finally {
    bus.stop();
    await dropHealthStream();
  }
});

const fakeBus = (recent: HeartbeatEvent[], serverTime: () => Promise<number>) => ({ recentHealth: async () => recent, serverTime });

// @spec CTRL-CHECK-004
test("freshness is judged against the Redis server's clock, not the container's", async () => {
  const hbs = [rec("chat", 2000, "ready", 5_000_000)]; // stamped 2 s before Redis time 5 000 000
  const realNow = Date.now(); // the container clock is nowhere near Redis time
  assert.notEqual(Math.round(realNow / 1e6), 5);
  assert.equal(await checkHealth("chat", fakeBus(hbs, async () => 5_000_000)), 0);
  assert.equal(await checkHealth("chat", fakeBus(hbs, async () => 5_020_000)), 1, "20 s of Redis time later it is stale");
});

// @spec CTRL-CHECK-004
test("an unreadable server time, or a bus that throws, is unhealthy", async () => {
  const hbs = [rec("chat", 1000, "ready", 5_000_000)];
  assert.equal(await checkHealth("chat", fakeBus(hbs, async () => { throw new Error("no redis"); })), 1);
  assert.equal(await checkHealth("chat", { recentHealth: async () => { throw new Error("no redis"); }, serverTime: async () => 5_000_000 }), 1);
});

// @spec CTRL-CHECK-004
test("Bus.serverTime reads Redis TIME and returns milliseconds", async () => {
  const conn = { time: async () => ["1700000000", "250500"], disconnect: () => {} };
  const bus = new Bus("t", undefined, "redis://fake", { connect: () => conn as never });
  try {
    assert.equal(await bus.serverTime(), 1_700_000_000_250);
  } finally {
    bus.stop();
  }
});
