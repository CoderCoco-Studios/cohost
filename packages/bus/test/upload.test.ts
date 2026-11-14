// Upload store behaviour on a fake transport: no Redis server required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, EventPayloads } from "../src/index.js";
import { FakeTransport, busError } from "../../testing/src/fake-transport.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const needsRedis = { skip: !(await redisUp()) && `no Redis at ${url}` };

/** A `FakeTransport` with a byte store behind `putUpload` / `takeUpload`. */
class UploadTransport extends FakeTransport {
  kv = new Map<string, Buffer>();
  putUpload(id: string, bytes: Buffer, ttlMs: number) { return this.run("putUpload", [id, bytes, ttlMs], () => { this.kv.set(id, bytes); }); }
  takeUpload(id: string) { return this.run("takeUpload", [id], () => { const v = this.kv.get(id) ?? null; this.kv.delete(id); return v; }); }
}

const busWith = (fake: UploadTransport, opts: Record<string, unknown> = {}) =>
  new Bus("t", undefined, "redis://fake", { transport: fake.factory, ...opts });

// @spec BUS-UPL-001
test("putUpload hands the transport the id, bytes and millisecond expiry, and rejects when the write fails", async () => {
  const fake = new UploadTransport();
  const bus = busWith(fake);
  await bus.putUpload("abc", Buffer.from("hi"), 5000);
  assert.deepEqual(fake.of("putUpload")[0]!.args, ["abc", Buffer.from("hi"), 5000]);
  fake.on("putUpload", () => { throw busError("BUS_CONNECTION", "redis down"); });
  await assert.rejects(bus.putUpload("abd", Buffer.from("x"), 1), /redis down/);
  await bus.stop();
});

// @spec BUS-UPL-001, BUS-UPL-002
test("the transport is built for the stream prefix option, which names the upload key", async () => {
  const fake = new UploadTransport();
  const bus = busWith(fake, { streamPrefix: "t1" });
  assert.equal(fake.factoryCalls[0]!.opts.prefix, "t1");
  await bus.putUpload("abc", Buffer.from("x"), 1000);
  assert.deepEqual((await bus.takeUpload("abc"))!, Buffer.from("x"));
  assert.deepEqual(fake.of("takeUpload")[0]!.args, ["abc"]);
  await bus.stop();
});

// @spec BUS-UPL-002
test("takeUpload returns the bytes once and deletes the key; a missing or taken key is null", async () => {
  const fake = new UploadTransport();
  const bus = busWith(fake);
  await bus.putUpload("k", Buffer.from("payload"), 1000);
  assert.deepEqual(await bus.takeUpload("k"), Buffer.from("payload"));
  assert.equal(await bus.takeUpload("k"), null);
  assert.equal(await bus.takeUpload("never"), null);
  assert.equal(fake.kv.size, 0);
  await bus.stop();
});

// @spec BUS-UPL-003
test("an upload is not a stream entry: the upload key never goes through append", async () => {
  const fake = new UploadTransport();
  const bus = busWith(fake);
  await bus.putUpload("k", Buffer.from("x"), 1000);
  assert.equal(fake.of("append").length, 0);
  await bus.stop();
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
  } finally { await bus.stop(); }
});
