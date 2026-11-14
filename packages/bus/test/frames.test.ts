// The frames path: the facade's publishFrame / tailAudio on a scripted FrameTransport (BUS-NAT-FRM-001, -002, -007) and the
// ioredis frame transport of src/frames.ts (BUS-NAT-FRM-003 to -006, BUS-NAT-ERR-005). Tests that need Redis skip when none
// answers; the connection tests use a plain TCP server or a closed port and need none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { Redis } from "ioredis";
import { MAX_FRAME_BYTES, type Frame, type FrameTransport } from "../src/index.js";
import { createFrameTransport } from "../src/frames.js";
import { FakeTransport, busWith, until, within } from "./native-helpers.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  r.on("error", () => {});
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const hasRedis = await redisUp();
const needsRedis = { skip: !hasRedis && `no Redis at ${url}` };
let n = 0;

const frame = (pcm: Buffer, over: Partial<Frame> = {}): Frame => ({ epoch: 1, seq: 0, rate: 16000, ch: 1, pcm, ...over });
const rejectsWith = (code: string) => (e: { code?: string }) => e.code === code;

/** A frame transport and a raw connection on a scratch prefix, cleaned up whatever the body does. */
async function scratch(body: (s: { t: FrameTransport; raw: Redis; prefix: string }) => Promise<void>): Promise<void> {
  const prefix = `cohost-test:${process.pid}:${Date.now()}:f${n++}`;
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

// @spec BUS-NAT-FRM-001
test("publishFrame rejects BUS_INVALID for pcm over MAX_FRAME_BYTES without calling the frame transport", async () => {
  const { bus, frames } = busWith(new FakeTransport());
  await assert.rejects(bus.publishFrame("in", "discord", frame(Buffer.alloc(MAX_FRAME_BYTES + 2))), rejectsWith("BUS_INVALID"));
  assert.equal(frames.of("appendFrame").length, 0, "nothing written");
  await bus.publishFrame("in", "discord", frame(Buffer.alloc(MAX_FRAME_BYTES)));
  assert.equal(frames.of("appendFrame").length, 1, "exactly MAX_FRAME_BYTES is accepted");
  await bus.stop();
});

// @spec BUS-NAT-FRM-002
test("publishFrame rejects BUS_INVALID for an odd pcm byte count without calling the frame transport", async () => {
  const { bus, frames } = busWith(new FakeTransport());
  await assert.rejects(bus.publishFrame("out", "discord", frame(Buffer.alloc(3))), rejectsWith("BUS_INVALID"));
  assert.equal(frames.of("appendFrame").length, 0, "nothing written");
  await bus.publishFrame("out", "discord", { epoch: 1, seq: 0, rate: 48000, ch: 2, utt: "u", flush: true, pcm: Buffer.alloc(0) });
  assert.equal(frames.of("appendFrame").length, 1, "a flush frame has empty pcm and is valid");
  await bus.stop();
});

// @spec BUS-NAT-FRM-007, BUS-NAT-ERR-005
test("publishFrame and tailAudio run on BusOptions.frames and never touch the events transport; after stop() they reject or end with BUS_CLOSED", async () => {
  const events = new FakeTransport();
  const { bus, frames } = busWith(events);
  await bus.publishFrame("in", "discord", frame(Buffer.alloc(4)));
  const tail = bus.tailAudio("in", "discord", () => {});
  await until(() => frames.of("readFrames").length === 1, "the tail reading");
  assert.equal(events.of("append").length + events.of("openReader").length, 0, "the events transport is untouched");
  assert.equal(frames.of("openReader").length, 1);
  await bus.stop();
  await within(tail, 1000, "tailAudio ends");
  assert.equal(frames.closed, true);
  await assert.rejects(bus.publishFrame("in", "discord", frame(Buffer.alloc(4))), rejectsWith("BUS_CLOSED"));
});

// ---------------------------------------------------------------- ioredis frame transport: connections

// @spec BUS-NAT-FRM-005
test("the frame transport opens no connection until the first appendFrame or openReader, then one publish connection and one per reader", async () => {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => { sockets.push(s); s.on("error", () => {}); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const t = createFrameTransport(`redis://127.0.0.1:${port}`, { prefix: "p", failFast: true });
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sockets.length, 0, "constructing the transport opens nothing");
    void t.appendFrame("in", "t", frame(Buffer.alloc(4))).catch(() => {});
    await until(() => sockets.length === 1, "publish connection");
    void t.appendFrame("in", "t", frame(Buffer.alloc(4), { seq: 1 })).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sockets.length, 1, "every frame goes out on the one publish connection");
    const reader = t.openReader();
    void reader.readFrames("in", "t", "$", 1, 100).catch(() => {});
    await until(() => sockets.length === 2, "reader connection");
    const reader2 = t.openReader();
    void reader2.readFrames("in", "t", "$", 1, 100).catch(() => {});
    await until(() => sockets.length === 3, "second reader connection");
  } finally {
    await t.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// @spec BUS-NAT-FRM-006
test("with Redis down: the first appendFrame rejects BUS_CONNECTION once the first attempt failed, and every later one rejects at once, nothing queued", async () => {
  const t = createFrameTransport("redis://127.0.0.1:1", { prefix: "p", failFast: false });
  try {
    const t0 = performance.now();
    await assert.rejects(t.appendFrame("in", "t", frame(Buffer.alloc(4))), rejectsWith("BUS_CONNECTION"));
    assert.ok(performance.now() - t0 < 3000, "a refused attempt settles at once");
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) await assert.rejects(t.appendFrame("in", "t", frame(Buffer.alloc(4), { seq: i })), rejectsWith("BUS_CONNECTION"));
    assert.ok(performance.now() - t1 < 100, `five rejections took ${performance.now() - t1} ms`);
  } finally { await t.close(); }
});

// @spec BUS-NAT-FRM-006
test("appendFrames issued while the first connect attempt is in flight all wait for it, then reject BUS_CONNECTION together", async () => {
  const t = createFrameTransport("redis://127.0.0.1:1", { prefix: "p", failFast: true });
  try {
    const all = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => t.appendFrame("in", "t", frame(Buffer.alloc(4), { seq: i }))));
    assert.ok(all.every((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "BUS_CONNECTION"));
  } finally { await t.close(); }
});

// @spec BUS-NAT-FRM-006, BUS-NAT-ERR-005
test("close() while the first connect attempt is in flight rejects the waiting appendFrame with BUS_CLOSED; calls after close reject BUS_CLOSED", async () => {
  // a server that accepts and never answers keeps the first attempt in flight
  const sockets: Socket[] = [];
  const server = createServer((s) => { sockets.push(s); s.on("error", () => {}); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const t = createFrameTransport(`redis://127.0.0.1:${port}`, { prefix: "p", failFast: false });
  try {
    const waiting = t.appendFrame("in", "t", frame(Buffer.alloc(4)));
    const outcome = waiting.then(() => "resolved", (e: { code?: string }) => e.code);
    await until(() => sockets.length === 1, "connecting");
    await t.close();
    assert.equal(await within(outcome, 2000, "the waiting append"), "BUS_CLOSED");
    await assert.rejects(t.appendFrame("in", "t", frame(Buffer.alloc(4))), rejectsWith("BUS_CLOSED"));
    assert.throws(() => t.openReader(), rejectsWith("BUS_CLOSED"));
    await within(t.close(), 500, "second close");
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------- ioredis frame transport: Redis commands

// @spec BUS-NAT-FRM-003
test("appendFrame adds one entry with the encodeFrame fields to <prefix>:audio.<dir>.<tag> and sets its 60 s expiry", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const id = await t.appendFrame("out", "mouth-out", frame(Buffer.alloc(4, 3), { utt: "u1", last: true, seq: 7 }));
    assert.match(id, /^\d+-\d+$/);
    const key = `${prefix}:audio.out.mouth-out`;
    assert.equal(await raw.xlen(key), 1);
    const ttl = await raw.pttl(key);
    assert.ok(ttl > 55_000 && ttl <= 60_000, `pttl ${ttl}`);
    const rows = (await raw.xrangeBuffer(key, "-", "+")) as [Buffer, Buffer[]][];
    assert.equal(rows[0]![0].toString(), id);
    const f = rows[0]![1].map((x) => x.toString("latin1"));
    for (const [k, v] of [["v", "1"], ["seq", "7"], ["rate", "16000"], ["ch", "1"], ["utt", "u1"], ["last", "1"]]) assert.equal(f[f.indexOf(k!) + 1], v, k);
  });
});

// @spec BUS-NAT-FRM-003
test("appendFrame caps the stream with MAXLEN ~ AUDIO_MAXLEN[dir]", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const key = `${prefix}:audio.out.cap`;
    await Promise.all(Array.from({ length: 1700 }, (_, i) => t.appendFrame("out", "cap", frame(Buffer.alloc(2), { seq: i }))));
    const len = await raw.xlen(key);
    assert.ok(len >= 1500 && len < 1700, `approximate trim to about 1500 (${len})`);
  });
});

// @spec BUS-NAT-FRM-005
test("frames appended without awaiting reach the stream in call order", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => t.appendFrame("in", "ord", frame(Buffer.alloc(2), { seq: i }))));
    const rows = (await raw.xrangeBuffer(`${prefix}:audio.in.ord`, "-", "+")) as [Buffer, Buffer[]][];
    const seqs = rows.map(([, f]) => Number(f[f.findIndex((x) => x.toString() === "seq") + 1]!.toString()));
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i));
  });
});

// @spec BUS-NAT-FRM-001, BUS-NAT-FRM-002
test("a real Bus rejects an oversized or odd frame BUS_INVALID and writes nothing", needsRedis, async () => {
  const { Bus } = await import("../src/index.js");
  const prefix = `cohost-test:${process.pid}:${Date.now()}:f${n++}`;
  const raw = new Redis(url);
  const b = new Bus("t", undefined, url, { streamPrefix: prefix });
  try {
    await assert.rejects(b.publishFrame("in", "t", frame(Buffer.alloc(MAX_FRAME_BYTES + 2))), rejectsWith("BUS_INVALID"));
    await assert.rejects(b.publishFrame("in", "t", frame(Buffer.alloc(3))), rejectsWith("BUS_INVALID"));
    assert.equal(await raw.exists(`${prefix}:audio.in.t`), 0);
    await b.publishFrame("in", "t", frame(Buffer.alloc(4)));
    assert.equal(await raw.xlen(`${prefix}:audio.in.t`), 1);
  } finally { await b.stop(); await raw.del(`${prefix}:audio.in.t`); raw.disconnect(); }
});

// @spec BUS-NAT-FRM-004
test("readFrames returns { ok: false, reason } for entries the codec rejects instead of rejecting the read", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const key = `${prefix}:audio.in.t`;
    const hdr = ["epoch", "1", "seq", "0", "rate", "16000", "ch", "1"];
    await raw.xadd(key, "*", "v", "2", ...hdr, "pcm", Buffer.alloc(4));
    await raw.xadd(key, "*", "v", "1", ...hdr, "pcm", Buffer.alloc(3));
    await raw.xadd(key, "*", "v", "1", ...hdr, "pcm", Buffer.alloc(MAX_FRAME_BYTES + 2));
    await raw.xadd(key, "*", "v", "1", ...hdr);
    await raw.xadd(key, "*", "v", "1", ...hdr, "pcm", Buffer.alloc(4));
    const reader = t.openReader();
    const got = (await reader.readFrames("in", "t", "0", 100, 200))!;
    reader.close();
    assert.deepEqual(got.map((g) => (g.decoded.ok ? "ok" : g.decoded.reason)), ["version", "odd byte count", "too large", "no pcm", "ok"]);
    assert.ok(got.every((g) => /^\d+-\d+$/.test(g.id)));
  });
});

// @spec BUS-NAT-FRM-004
test("readFrames returns null on timeout, and a blocked read rejects BUS_CLOSED when its reader is closed", needsRedis, async () => {
  await scratch(async ({ t }) => {
    const reader = t.openReader();
    assert.equal(await reader.readFrames("in", "quiet", "$", 10, 100), null);
    const blocked = reader.readFrames("in", "quiet", "$", 10, 5000);
    await new Promise((r) => setTimeout(r, 50));
    reader.close();
    await assert.rejects(within(blocked, 1000, "blocked read"), rejectsWith("BUS_CLOSED"));
  });
});

// @spec BUS-NAT-FRM-003, BUS-NAT-FRM-004
test("a frame published through a Bus is tailed by another Bus's tailAudio from $, decoded, and the Buffer keeps its content", needsRedis, async () => {
  const { Bus } = await import("../src/index.js");
  const prefix = `cohost-test:${process.pid}:${Date.now()}:f${n++}`;
  const raw = new Redis(url);
  const producer = new Bus("p", undefined, url, { streamPrefix: prefix });
  const consumer = new Bus("c", undefined, url, { streamPrefix: prefix });
  try {
    await producer.publishFrame("in", "t", frame(Buffer.alloc(4, 1), { seq: 0 })); // before the tail connects: not replayed
    const got: Frame[] = [];
    const tail = consumer.tailAudio("in", "t", (d) => { if (d.ok) got.push(d.frame); });
    await new Promise((r) => setTimeout(r, 200));
    const pcm = Buffer.alloc(8, 5);
    const sent = producer.publishFrame("in", "t", frame(pcm, { seq: 1 }));
    await sent;
    await until(() => got.length === 1, "the frame tailed", 2000);
    assert.equal(got[0]!.seq, 1);
    assert.deepEqual(got[0]!.pcm, Buffer.alloc(8, 5));
    await consumer.stop();
    await within(tail, 1000, "tailAudio ends on stop");
    assert.deepEqual(got[0]!.pcm, Buffer.alloc(8, 5), "kept after the transport closed");
  } finally { await producer.stop(); await consumer.stop(); await raw.del(`${prefix}:audio.in.t`); raw.disconnect(); }
});

