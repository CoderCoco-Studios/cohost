// The avatar-frame stream on the frames path: the facade's publishAvatarFrame / tailAvatarFrames on a scripted
// FrameTransport, and the ioredis frame transport's appendAvatarFrame / readAvatarFrames (BUS-AVF-001, -003 to -010,
// BUS-NAT-FRM-005, BUS-STOP-001). Tests that need Redis skip when none answers; the connection tests use a plain TCP
// server or a closed port and need none. The avatar members are untyped here so the file compiles before they exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { Redis } from "ioredis";
import type { Frame, FrameTransport } from "../src/index.js";
import { createFrameTransport } from "../src/frames.js";
import { FakeTransport, FakeFrameTransport, busWith, until, within, tick } from "./native-helpers.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  r.on("error", () => {});
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const hasRedis = await redisUp();
const needsRedis = { skip: !hasRedis && `no Redis at ${url}` };
let n = 0;

const rejectsWith = (code: string) => (e: { code?: string }) => e.code === code;
const audio = (): Frame => ({ epoch: 1, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(4) });
const avFrame = (over: Record<string, unknown> = {}) => ({
  mouthOpen: 0.5, mouthSmile: 0.25, headX: 10, headY: -10, headZ: 0, eyeX: 0.1, eyeY: -0.1, blink: 0,
  emotion: "happy", intensity: 0.8, expression: "", ...over,
});
type AvReader = { readAvatarFrames(from: string, ms: number): Promise<{ id: string; frame: unknown }[] | null>; close(): void };
const av = (b: unknown) => b as {
  avatarFramesStream(): string;
  publishAvatarFrame(f: unknown): Promise<void>;
  tailAvatarFrames(h: (f: unknown) => void): () => void;
  stop(): Promise<void>;
};
const avT = (t: unknown) => t as { appendAvatarFrame(f: unknown): Promise<string>; openReader(): AvReader };
const calls = (f: FakeFrameTransport, m: string) => f.calls.filter((c) => (c.method as string) === m);

/** A frame transport and a raw connection on a scratch prefix, cleaned up whatever the body does. */
async function scratch(body: (s: { t: FrameTransport; raw: Redis; prefix: string }) => Promise<void>): Promise<void> {
  const prefix = `cohost-test:${process.pid}:${Date.now()}:af${n++}`;
  const raw = new Redis(url);
  const t = createFrameTransport(url, { prefix, failFast: false });
  try {
    await body({ t, raw, prefix });
  } finally {
    await t.close();
    const keys = await raw.keys(`${prefix}:*`);
    if (keys.length) await raw.del(...keys);
    raw.disconnect();
  }
}

// ---------------------------------------------------------------- facade on a scripted FrameTransport

// @spec BUS-AVF-004
test("publishAvatarFrame rejects BUS_INVALID for a frame that fails the schema, without calling the frame transport", async () => {
  const { bus, frames } = busWith(new FakeTransport());
  const bad = [avFrame({ mouthOpen: 1.5 }), avFrame({ headX: NaN }), avFrame({ emotion: "ecstatic" }), avFrame({ expression: "x".repeat(65) }), avFrame({ extra: 1 }), { ...avFrame(), blink: undefined }, null, "frame"];
  for (const f of bad) await assert.rejects(av(bus).publishAvatarFrame(f), rejectsWith("BUS_INVALID"), JSON.stringify(f));
  assert.equal(calls(frames, "appendAvatarFrame").length, 0, "nothing written");
  await bus.stop();
});

// @spec BUS-AVF-004, BUS-AVF-010
test("publishAvatarFrame hands a valid frame to the frame transport's appendAvatarFrame and nothing to the events transport", async () => {
  const events = new FakeTransport();
  const { bus, frames } = busWith(events);
  const f = avFrame();
  await av(bus).publishAvatarFrame(f);
  const sent = calls(frames, "appendAvatarFrame");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.args[0], f);
  assert.equal(frames.of("appendFrame").length, 0, "not the audio append");
  assert.equal(events.of("append").length + events.of("openReader").length, 0, "the events transport is untouched");
  await bus.stop();
});

// @spec BUS-AVF-001
test("avatarFramesStream() is <prefix>:avatar.frames on the Bus's prefix, and Bus.publish neither writes nor trims it", async () => {
  const events = new FakeTransport();
  const { bus, frames } = busWith(events, { streamPrefix: "p1" });
  assert.equal(av(bus).avatarFramesStream(), "p1:avatar.frames");
  await bus.publish("control", { cmd: "mute" } as never);
  assert.equal(calls(frames, "appendAvatarFrame").length, 0);
  assert.ok(!JSON.stringify(events.calls).includes("avatar.frames"), "no events-transport call names the avatar stream");
  await bus.stop();
});

// @spec BUS-AVF-007
test("tailAvatarFrames reads from $ with BLOCK 5000, advances from the last id, hands decoded frames in stream order, and its stop function closes the reader", async () => {
  const f1 = avFrame({ mouthOpen: 0.1 }), f2 = avFrame({ mouthOpen: 0.2 }), f3 = avFrame({ mouthOpen: 0.3 });
  const frames = new FakeFrameTransport().on("readAvatarFrames" as never, () => [{ id: "1-0", frame: f1 }, { id: "2-0", frame: f2 }], () => null, () => [{ id: "3-0", frame: f3 }]);
  const { bus } = busWith(new FakeTransport(), {}, undefined, frames);
  const got: unknown[] = [];
  const stop = av(bus).tailAvatarFrames((f) => { got.push(f); });
  assert.equal(typeof stop, "function", "returns a stop function");
  await until(() => calls(frames, "readAvatarFrames").length >= 4, "four reads");
  const reads = calls(frames, "readAvatarFrames");
  assert.deepEqual(reads.slice(0, 4).map((c) => c.args[0]), ["$", "2-0", "2-0", "3-0"], "$ first, then the last id read");
  assert.ok(reads.every((c) => c.args[1] === 5000), "BLOCK 5000");
  assert.deepEqual(got, [f1, f2, f3], "in stream order");
  assert.equal(frames.of("openReader").length, 1, "one reader for the loop");
  assert.equal(frames.of("readerClose").length, 0);
  stop();
  await until(() => frames.of("readerClose").length === 1, "the loop's reader closed");
  await tick(30);
  const after = calls(frames, "readAvatarFrames").length;
  await tick(30);
  assert.equal(calls(frames, "readAvatarFrames").length, after, "the loop ended");
  await bus.stop();
});

// @spec BUS-AVF-007, BUS-STOP-001
test("two tailAvatarFrames loops each get a reader of their own, and Bus.stop() closes both readers and the frame transport without a log line", async () => {
  const { bus, frames, l } = busWith(new FakeTransport());
  av(bus).tailAvatarFrames(() => {});
  av(bus).tailAvatarFrames(() => {});
  await until(() => calls(frames, "readAvatarFrames").length === 2, "both reading");
  assert.equal(frames.of("openReader").length, 2);
  await within(bus.stop(), 1000, "stop");
  assert.equal(frames.of("readerClose").length, 2, "both readers closed");
  assert.equal(frames.closed, true);
  assert.deepEqual([...l.at("warn"), ...l.at("error")], [], "the pending reads end without a log line");
});

// @spec BUS-AVF-009
test("after stop(), publishAvatarFrame rejects BUS_CLOSED", async () => {
  const { bus } = busWith(new FakeTransport());
  await bus.stop();
  await assert.rejects(av(bus).publishAvatarFrame(avFrame()), rejectsWith("BUS_CLOSED"));
});

// ---------------------------------------------------------------- ioredis frame transport

// @spec BUS-AVF-009, BUS-NAT-FRM-008
test("with Redis down, appendAvatarFrame rejects BUS_CONNECTION, later calls reject at once with nothing queued, and after close() it rejects BUS_CLOSED", async () => {
  const t = createFrameTransport("redis://127.0.0.1:1", { prefix: "p", failFast: false });
  try {
    await assert.rejects(avT(t).appendAvatarFrame(avFrame()), rejectsWith("BUS_CONNECTION"));
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) await assert.rejects(avT(t).appendAvatarFrame(avFrame({ mouthOpen: i / 10 })), rejectsWith("BUS_CONNECTION"));
    assert.ok(performance.now() - t1 < 100, `five rejections took ${performance.now() - t1} ms`);
  } finally { await t.close(); }
  await assert.rejects(avT(t).appendAvatarFrame(avFrame()), rejectsWith("BUS_CLOSED"));
});

// @spec BUS-NAT-FRM-005, BUS-AVF-010
test("avatar frames mixed with audio frames: no connection until the first append, then one publish connection; a reader connects at its first readAvatarFrames, not at openReader", async () => {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => { sockets.push(s); s.on("error", () => {}); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const t = createFrameTransport(`redis://127.0.0.1:${port}`, { prefix: "p", failFast: true });
  try {
    await tick(150);
    assert.equal(sockets.length, 0, "constructing the transport opens nothing");
    void avT(t).appendAvatarFrame(avFrame()).catch(() => {});
    await until(() => sockets.length === 1, "publish connection at the first appendAvatarFrame");
    void t.appendFrame("in", "t", audio()).catch(() => {});
    void avT(t).appendAvatarFrame(avFrame({ blink: 1 })).catch(() => {});
    await tick(150);
    assert.equal(sockets.length, 1, "audio and avatar frames share the one publish connection");
    const reader = avT(t).openReader();
    await tick(100);
    assert.equal(sockets.length, 1, "openReader opens nothing");
    void reader.readAvatarFrames("$", 100).catch(() => {});
    await until(() => sockets.length === 2, "reader connection at its first readAvatarFrames");
  } finally {
    await t.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// @spec BUS-AVF-003, BUS-AVF-005, BUS-AVF-006
test("appendAvatarFrame XADDs exactly ts and data, resolves to the entry id, caps the stream near 120 entries and renews a 10 s expiry", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const key = `${prefix}:avatar.frames`;
    const f = avFrame({ mouthOpen: 0.123 });
    const before = Date.now();
    const id = await avT(t).appendAvatarFrame(f);
    assert.match(id, /^\d+-\d+$/);
    const entries = await raw.xrange(key, "-", "+");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]![0], id);
    const fields = entries[0]![1];
    assert.deepEqual(fields.filter((_, i) => i % 2 === 0), ["ts", "data"], "exactly the fields ts and data");
    assert.match(fields[1]!, /^\d+$/);
    assert.ok(Number(fields[1]) >= before && Number(fields[1]) <= Date.now(), "ts is the producer's Date.now()");
    assert.deepEqual(JSON.parse(fields[3]!), f);
    const ttl = await raw.pttl(key);
    assert.ok(ttl > 9000 && ttl <= 10000, `PEXPIRE 10000 renewed on the write, pttl ${ttl}`);
    for (let i = 0; i < 600; i++) await avT(t).appendAvatarFrame(avFrame({ mouthOpen: (i % 10) / 10 }));
    const len = await raw.xlen(key);
    assert.ok(len >= 120 && len <= 250, `MAXLEN ~ 120 trims on the producer's write, length ${len}`);
  });
});

// @spec BUS-AVF-007, BUS-AVF-008, BUS-AVF-006
test("a reader reads from $ without replay, drops entries that do not decode, returns null on timeout and never writes or trims the stream", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const key = `${prefix}:avatar.frames`;
    await avT(t).appendAvatarFrame(avFrame({ mouthOpen: 0.9 })); // before the reader: not replayed from $
    const reader = avT(t).openReader();
    assert.equal(await reader.readAvatarFrames("$", 100), null, "null on timeout; the earlier entry is not replayed");
    const pending = reader.readAvatarFrames("$", 2000);
    await tick(100);
    await raw.xadd(key, "*", "ts", "1");                                                       // missing data
    await raw.xadd(key, "*", "ts", "1", "data", "{not json");                                   // invalid JSON
    await raw.xadd(key, "*", "ts", "1", "data", JSON.stringify(avFrame({ mouthOpen: 7 })));    // out of range
    await raw.xadd(key, "*", "ts", "1", "data", JSON.stringify(avFrame({ mouthOpen: 0.4 })));
    const got = (await pending) ?? [];
    const len = await raw.xlen(key);
    const rest = await reader.readAvatarFrames(got.at(-1)?.id ?? "0", 300);
    const all = [...got, ...(rest ?? [])];
    assert.deepEqual(all.map((e) => (e.frame as { mouthOpen: number }).mouthOpen), [0.4], "only the decodable entry is delivered");
    assert.ok(all.every((e) => /^\d+-\d+$/.test(e.id)));
    assert.equal(await raw.xlen(key), len, "a reader neither writes nor trims");
    reader.close();
  });
});

// @spec BUS-AVF-007, BUS-AVF-010
test("a frame published through a Bus is tailed by another Bus's tailAvatarFrames from $, in order, and nothing from before the call is replayed", needsRedis, async () => {
  const { Bus } = await import("../src/index.js");
  const prefix = `cohost-test:${process.pid}:${Date.now()}:af${n++}`;
  const raw = new Redis(url);
  const producer = av(new Bus("p", undefined, url, { streamPrefix: prefix }));
  const consumer = av(new Bus("c", undefined, url, { streamPrefix: prefix }));
  try {
    await producer.publishAvatarFrame(avFrame({ mouthOpen: 0.9 })); // before the tail: not replayed
    const got: { mouthOpen: number }[] = [];
    const stop = consumer.tailAvatarFrames((f) => { got.push(f as { mouthOpen: number }); });
    await tick(300);
    for (const m of [0.1, 0.2, 0.3]) await producer.publishAvatarFrame(avFrame({ mouthOpen: m }));
    await until(() => got.length === 3, "three frames tailed", 2000);
    assert.deepEqual(got.map((f) => f.mouthOpen), [0.1, 0.2, 0.3]);
    stop();
  } finally { await producer.stop(); await consumer.stop(); await raw.del(`${prefix}:avatar.frames`); raw.disconnect(); }
});
