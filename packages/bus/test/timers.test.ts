// The tools service's pending-timer hash on the Bus: BUS-TIMER-001, BUS-TIMER-002, and the three transport calls of
// BUS-NAT-TRN-001. The facade test runs on a scripted transport; the hash tests need Redis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus } from "../src/index.js";
import { FakeTransport } from "../../testing/src/fake-transport.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const needsRedis = { skip: !(await redisUp()) && `no Redis at ${url}` };

// @spec BUS-NAT-TRN-001
test("the facade passes putTimer, deleteTimer and listTimers through to the transport", async () => {
  const fake = new FakeTransport();
  const bus = new Bus("t", undefined, "redis://fake", { transport: fake.factory });
  await bus.putTimer("a", "{\"n\":1}");
  await bus.putTimer("b", "{\"n\":2}");
  assert.deepEqual(await bus.listTimers(), [{ id: "a", json: "{\"n\":1}" }, { id: "b", json: "{\"n\":2}" }]);
  await bus.deleteTimer("a");
  assert.deepEqual(await bus.listTimers(), [{ id: "b", json: "{\"n\":2}" }]);
  assert.deepEqual(fake.calls.filter((c) => /Timer/.test(c.method)).map((c) => [c.method, ...c.args]), [
    ["putTimer", "a", "{\"n\":1}"], ["putTimer", "b", "{\"n\":2}"], ["listTimers"], ["deleteTimer", "a"], ["listTimers"],
  ]);
  await bus.stop();
});

// @spec BUS-TIMER-001
test("putTimer writes the field id with the value json in <prefix>:tools:timers and deleteTimer deletes that field", needsRedis, async () => {
  const prefix = `cohost-test:timers:${process.pid}:${Date.now()}:a`;
  const key = `${prefix}:tools:timers`;
  const raw = new Redis(url);
  const bus = new Bus("t", undefined, url, { streamPrefix: prefix });
  try {
    await bus.putTimer("t1", "{\"note\":\"x\"}");
    await bus.putTimer("t2", "{\"note\":\"y\"}");
    assert.deepEqual(await raw.hgetall(key), { t1: "{\"note\":\"x\"}", t2: "{\"note\":\"y\"}" });
    await bus.putTimer("t1", "{\"note\":\"z\"}");
    assert.equal(await raw.hget(key, "t1"), "{\"note\":\"z\"}");
    await bus.deleteTimer("t1");
    assert.deepEqual(await raw.hgetall(key), { t2: "{\"note\":\"y\"}" });
    await bus.deleteTimer("never");
  } finally {
    await bus.stop();
    await raw.del(key).catch(() => {});
    raw.disconnect();
  }
});

// @spec BUS-TIMER-002
test("listTimers returns every field as id and value, and an empty list when the key does not exist", needsRedis, async () => {
  const prefix = `cohost-test:timers:${process.pid}:${Date.now()}:b`;
  const key = `${prefix}:tools:timers`;
  const raw = new Redis(url);
  const bus = new Bus("t", undefined, url, { streamPrefix: prefix });
  try {
    assert.deepEqual(await bus.listTimers(), []);
    await raw.hset(key, { t1: "{\"a\":1}", t2: "{\"b\":2}" });
    const got = (await bus.listTimers()).toSorted((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(got, [{ id: "t1", json: "{\"a\":1}" }, { id: "t2", json: "{\"b\":2}" }]);
    await bus.deleteTimer("t1");
    await bus.deleteTimer("t2");
    assert.deepEqual(await bus.listTimers(), []);
  } finally {
    await bus.stop();
    await raw.del(key).catch(() => {});
    raw.disconnect();
  }
});
