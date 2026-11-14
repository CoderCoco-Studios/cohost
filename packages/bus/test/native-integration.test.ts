// The native transport against a real Redis, on streams of its own (BUS-NAT-CI-002 for the TS side). Needs the built addon
// (`pnpm build:native`); tests that need Redis skip when none answers. Fails now: native.ts is a stub.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, MAX_FRAME_BYTES, type BusTransport } from "../src/index.js";
import { createNativeTransport } from "../src/native.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const hasRedis = await redisUp();
const needsRedis = { skip: !hasRedis && `no Redis at ${url}` };
let n = 0;

/** A transport and a raw connection on a scratch prefix, cleaned up whatever the body does. */
async function scratch(body: (s: { t: BusTransport; raw: Redis; prefix: string }) => Promise<void>): Promise<void> {
  const prefix = `cohost-test:${process.pid}:${Date.now()}:${n++}`;
  const raw = new Redis(url);
  let t: BusTransport | undefined;
  try {
    t = createNativeTransport(url, { prefix, failFast: false });
    await body({ t, raw, prefix });
  } finally {
    await t?.close();
    const keys = await raw.keys(`${prefix}:*`);
    if (keys.length) await raw.del(...keys);
    raw.disconnect();
  }
}
const frame = (pcm: Buffer) => ({ epoch: 1, seq: 0, rate: 16000, ch: 1, pcm });

// @spec BUS-NAT-TRN-002, BUS-NAT-ERR-002
test("createGroup resolves true when created, false on BUSYGROUP, and rejects BUS_REDIS with Redis's text for another error", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    assert.equal(await t.createGroup("g"), true);
    assert.equal(await t.createGroup("g"), false);
    await raw.set(`${prefix}:wrongtype:events`, "x"); // the events key of the transport built below
    const bad = createNativeTransport(url, { prefix: `${prefix}:wrongtype`, failFast: false });
    try {
      await assert.rejects(bad.createGroup("g"), (e: { code?: string; message: string }) => e.code === "BUS_REDIS" && /WRONGTYPE/.test(e.message));
    } finally { await bad.close(); }
  });
});

// @spec BUS-NAT-TRN-009
test("a Buffer changed or reused after putUpload / appendFrame returns does not change what was written", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const bytes = Buffer.from("original-bytes");
    const up = t.putUpload("u1", bytes, 5000);
    bytes.fill(0);
    await up;
    assert.deepEqual(await t.takeUpload("u1"), Buffer.from("original-bytes"));
    const pcm = Buffer.alloc(8, 5);
    const ap = t.appendFrame("in", "t", frame(pcm));
    pcm.fill(9);
    await ap;
    const rows = (await raw.xrangeBuffer(`${prefix}:audio.in.t`, "-", "+")) as [Buffer, Buffer[]][];
    const f = rows[0]![1];
    assert.deepEqual(f[f.findIndex((x: Buffer) => x.toString() === "pcm") + 1], Buffer.alloc(8, 5));
  });
});

// @spec BUS-NAT-TRN-010
test("a Buffer from readFrames or takeUpload keeps its content through later reads and calls and after the transport closed", needsRedis, async () => {
  await scratch(async ({ t }) => {
    await t.putUpload("u1", Buffer.from("kept-upload"), 5000);
    const upload = (await t.takeUpload("u1"))!;
    await t.appendFrame("in", "t", frame(Buffer.alloc(16, 7)));
    const reader = t.openReader();
    const frames = (await reader.readFrames("in", "t", "0", 10, 200))!;
    const pcm = frames[0]!.decoded.ok ? frames[0]!.decoded.frame.pcm : undefined;
    assert.deepEqual(pcm, Buffer.alloc(16, 7));
    for (let i = 0; i < 50; i++) { await t.putUpload(`x${i}`, Buffer.alloc(1024, i), 1000); await t.takeUpload(`x${i}`); await reader.readFrames("in", "t", "0", 10, 50); }
    reader.close();
    await t.close();
    assert.deepEqual(upload, Buffer.from("kept-upload"));
    assert.deepEqual(pcm, Buffer.alloc(16, 7));
  });
});

// @spec BUS-NAT-FRM-001
test("appendFrame with pcm over MAX_FRAME_BYTES rejects BUS_INVALID and writes nothing", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await assert.rejects(t.appendFrame("in", "t", frame(Buffer.alloc(MAX_FRAME_BYTES + 2))), (e: { code?: string }) => e.code === "BUS_INVALID");
    assert.equal(await raw.exists(`${prefix}:audio.in.t`), 0);
    const b = new Bus("t", undefined, url, { streamPrefix: prefix });
    try {
      await assert.rejects(b.publishFrame("in", "t", frame(Buffer.alloc(MAX_FRAME_BYTES + 2))), (e: { code?: string }) => e.code === "BUS_INVALID");
    } finally { await b.stop(); }
    assert.equal(await raw.exists(`${prefix}:audio.in.t`), 0);
  });
});

// @spec BUS-NAT-FRM-002
test("appendFrame with an odd pcm byte count rejects BUS_INVALID and writes nothing", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await assert.rejects(t.appendFrame("in", "t", frame(Buffer.alloc(3))), (e: { code?: string }) => e.code === "BUS_INVALID");
    assert.equal(await raw.exists(`${prefix}:audio.in.t`), 0);
    const b = new Bus("t", undefined, url, { streamPrefix: prefix });
    try {
      await assert.rejects(b.publishFrame("in", "t", frame(Buffer.alloc(3))), (e: { code?: string }) => e.code === "BUS_INVALID");
    } finally { await b.stop(); }
    assert.equal(await raw.exists(`${prefix}:audio.in.t`), 0);
  });
});

// @spec BUS-NAT-FRM-003
test("appendFrame adds one entry to <prefix>:audio.<dir>.<tag> and sets its 60 s expiry", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    const id = await t.appendFrame("out", "mouth-out", frame(Buffer.alloc(4)));
    assert.match(id, /^\d+-\d+$/);
    const key = `${prefix}:audio.out.mouth-out`;
    assert.equal(await raw.xlen(key), 1);
    const ttl = await raw.pttl(key);
    assert.ok(ttl > 55_000 && ttl <= 60_000, `pttl ${ttl}`);
  });
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
  });
});

// @spec BUS-NAT-TRN-014
test("a read returns only the id and the four envelope fields; a missing field stays undefined", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await raw.xadd(`${prefix}:events`, "*", "type", "control", "data", "{}", "extra", "ignored");
    const reader = t.openReader();
    const got = (await reader.read("events", "0", 10, 200))!;
    reader.close();
    assert.equal(got.length, 1);
    assert.deepEqual(Object.keys(got[0]!).sort(), ["data", "id", "type"]);
    assert.equal(got[0]!.ts, undefined);
  });
});

// @spec BUS-NAT-ERR-007
test("an entry with an envelope field that is not valid UTF-8 comes back as an id with no fields", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await raw.xadd(`${prefix}:events`, "*", "type", "control", "ts", "1", "source", "s", "data", Buffer.from([0xff, 0xfe, 0x7b]));
    const reader = t.openReader();
    const got = (await reader.read("events", "0", 10, 200))!;
    reader.close();
    assert.equal(got.length, 1);
    assert.deepEqual(Object.keys(got[0]!), ["id"]);
  });
});

// Unreachable Redis: needs no server. Runs in a subprocess so that its stdout and stderr can be checked.
// @spec BUS-STREAM-009, BUS-NAT-CONN-005, BUS-NAT-CONN-006, BUS-NAT-ERR-009
test("failFast against a closed port: the first command rejects BUS_CONNECTION naming the cause, the next at once, and nothing is printed", () => {
  const out = join(mkdtempSync(join(tmpdir(), "failfast-")), "result.json");
  const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./native-failfast.fixture.ts", import.meta.url)), out], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.stdout, "", "nothing on stdout");
  assert.equal(r.stderr, "", "nothing on stderr");
  assert.equal(r.status, 0);
  const res = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(res.first?.code, "BUS_CONNECTION");
  assert.match(res.first?.message ?? "", /ECONNREFUSED|refused/i);
  assert.ok(res.firstMs < 3000, "the refused attempt settles at once");
  assert.equal(res.second?.code, "BUS_CONNECTION");
  assert.ok(res.secondMs < 100, `rejected at once (${res.secondMs} ms)`);
});
