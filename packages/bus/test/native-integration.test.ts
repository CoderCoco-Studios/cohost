// The native transport (events path) against a real Redis, on streams of its own (BUS-NAT-CI-002 for the TS side). Needs the
// built addon (`pnpm build:native`); tests that need Redis skip when none answers. The frames path is in frames.test.ts.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import type { BusTransport } from "../src/index.js";
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
test("a Buffer changed or reused after putUpload returns does not change what was written", needsRedis, async () => {
  await scratch(async ({ t }) => {
    const bytes = Buffer.from("original-bytes");
    const up = t.putUpload("u1", bytes, 5000);
    bytes.fill(0);
    await up;
    assert.deepEqual(await t.takeUpload("u1"), Buffer.from("original-bytes"));
  });
});

// @spec BUS-NAT-TRN-010
test("a Buffer from takeUpload keeps its content through later reads and calls and after the transport closed", needsRedis, async () => {
  await scratch(async ({ t, raw, prefix }) => {
    await t.putUpload("u1", Buffer.from("kept-upload"), 5000);
    const upload = (await t.takeUpload("u1"))!;
    await raw.xadd(`${prefix}:events`, "*", "type", "control", "ts", "1", "source", "s", "data", "{}");
    const reader = t.openReader();
    for (let i = 0; i < 50; i++) { await t.putUpload(`x${i}`, Buffer.alloc(1024, i), 1000); await t.takeUpload(`x${i}`); await reader.read("events", "0", 10, 50); }
    reader.close();
    await t.close();
    assert.deepEqual(upload, Buffer.from("kept-upload"));
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
// @spec BUS-STREAM-009, BUS-NAT-CONN-005, BUS-NAT-CONN-006, BUS-NAT-ERR-009, BUS-NAT-FRM-006
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
  // @spec BUS-NAT-FRM-006: the frames path under failFast: no reconnect, nothing printed, every frame after the first rejects at once
  assert.equal(res.frameFirst?.code, "BUS_CONNECTION");
  assert.ok(res.frameFirstMs < 3000, "the refused attempt settles at once");
  assert.equal(res.frameSecond?.code, "BUS_CONNECTION");
  assert.ok(res.frameSecondMs < 100, `rejected at once (${res.frameSecondMs} ms)`);
});
