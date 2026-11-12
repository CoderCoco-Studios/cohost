// Upload store behaviour against a fake Redis connection: no Redis server required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, EventPayloads } from "../src/index.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const needsRedis = { skip: !(await redisUp()) && `no Redis at ${url}` };

/** A string-keyed stand-in for the SET / GETDEL slice of an ioredis connection. */
class FakeRedis {
  kv = new Map<string, Buffer>();
  calls: unknown[][] = [];
  failSet = false;
  async set(key: string, value: Buffer, ...opts: unknown[]) {
    this.calls.push(["set", key, value, ...opts]);
    if (this.failSet) throw new Error("redis down");
    this.kv.set(key, value);
    return "OK";
  }
  async getdelBuffer(key: string) {
    this.calls.push(["getdelBuffer", key]);
    const v = this.kv.get(key) ?? null;
    this.kv.delete(key);
    return v;
  }
  async xadd() { return "1-0"; }
  disconnect() {}
}

const busWith = (fake: FakeRedis, opts: Record<string, unknown> = {}) =>
  new Bus("t", undefined, "redis://fake", { connect: () => fake as never, ...opts });

// @spec BUS-UPL-001
test("putUpload SETs <prefix>:upload:<id> to the bytes with a millisecond expiry, and rejects when the write fails", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  await bus.putUpload("abc", Buffer.from("hi"), 5000);
  assert.deepEqual(fake.calls[0], ["set", "cohost:upload:abc", Buffer.from("hi"), "PX", 5000]);
  fake.failSet = true;
  await assert.rejects(bus.putUpload("abd", Buffer.from("x"), 1), /redis down/);
});

// @spec BUS-UPL-001, BUS-UPL-002
test("the upload key follows the stream prefix option", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake, { streamPrefix: "t1" });
  await bus.putUpload("abc", Buffer.from("x"), 1000);
  assert.equal(fake.calls[0]![1], "t1:upload:abc");
  assert.deepEqual((await bus.takeUpload("abc"))!, Buffer.from("x"));
  assert.equal(fake.calls[1]![1], "t1:upload:abc");
});

// @spec BUS-UPL-002
test("takeUpload returns the bytes once and deletes the key; a missing or taken key is null", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  await bus.putUpload("k", Buffer.from("payload"), 1000);
  assert.deepEqual(await bus.takeUpload("k"), Buffer.from("payload"));
  assert.equal(await bus.takeUpload("k"), null);
  assert.equal(await bus.takeUpload("never"), null);
  assert.equal(fake.kv.size, 0);
});

// @spec BUS-UPL-003
test("an upload is not a stream entry: the upload key never goes through XADD", async () => {
  const fake = new FakeRedis();
  const bus = busWith(fake);
  await bus.putUpload("k", Buffer.from("x"), 1000);
  assert.equal(fake.calls.filter((c) => c[0] === "xadd").length, 0);
});

// @spec BUS-EVT-006
test("inject.request carries uploadId and contentType, and has no url field", () => {
  const ok = EventPayloads["inject.request"].safeParse({ id: "1", target: "eyes", kind: "image", uploadId: "ab", contentType: "image/png", remember: false });
  assert.ok(ok.success);
  const stripped = EventPayloads["inject.request"].parse({ id: "1", target: "eyes", kind: "image", url: "http://x/uploads/a", remember: false });
  assert.equal("url" in stripped, false);
});

// @spec BUS-UPL-001, BUS-UPL-002
test("against a real Redis: bytes round-trip binary-safe once, and an expired key is gone", needsRedis, async () => {
  const bus = new Bus("upload-test", undefined, url, { streamPrefix: `cohost-test-upload-${process.pid}` });
  try {
    const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
    await bus.putUpload("live", bytes, 10_000);
    assert.deepEqual(await bus.takeUpload("live"), bytes);
    assert.equal(await bus.takeUpload("live"), null);
    await bus.putUpload("short", Buffer.from("x"), 50);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(await bus.takeUpload("short"), null);
  } finally { bus.stop(); }
});
