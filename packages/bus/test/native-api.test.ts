// Facade API on a scripted BusTransport (BUS-NAT-API-*, BUS-NAT-TRN-*, amended BUS-STREAM-005/009, BUS-UPL-001).
// Until the facade runs on `BusOptions.transport` (Phase 6) every test here fails at the first assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as mod from "../src/index.js";
import {
  Bus, STREAM, HEALTH_STREAM, HEALTH_MAXLEN, EventPayloads, tagProblem, ConnectorRegistrar, parseRegistration,
  type BusEvent, type BusOptions, type BusReader, type BusTransport, type HeartbeatEvent, type Handler, type Publisher,
  type ReadOutcome, type SubscribeOptions, type SubscribeStart, type TransportFactory,
} from "../src/index.js";
import { FakeTransport, rawEntry, groupRead, busError, busWith, withBus, until, within, tick } from "./native-helpers.js";

const repo = new URL("../../../", import.meta.url).pathname;
const chat = { platform: "twitch", user: "ann", text: "hi" } as const;
const hb = { service: "chat", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 5000 } as const;

// Compile-time: the names BUS-NAT-API-002 lists exist as types (tsx erases this; `tsc` over the tests checks it).
export type _ApiTypes = [SubscribeStart, SubscribeOptions<"control">, Handler<"control">, Publisher, ReadOutcome, HeartbeatEvent, BusOptions, BusTransport, BusReader, TransportFactory];
const _fakeIsATransport: BusTransport = new FakeTransport();
void _fakeIsATransport;

/** Every `.ts` file under `dir`, skipping build output and dependencies. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name === "native" || name === "target") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const srcFiles = (): string[] => ["packages", "services"].flatMap((top) => readdirSync(join(repo, top)).flatMap((pkg) => {
  try { return sources(join(repo, top, pkg, "src")); } catch { return []; }
}));

// @spec BUS-NAT-API-001
test("Bus has the constructor and every member the API lists, and stop() returns a Promise<void>", async () => {
  const { bus } = busWith(new FakeTransport());
  const members = ["publish", "publishHealth", "subscribe", "tail", "tailHealth", "recent", "recentHealth", "resetGroup", "serverTime", "putUpload", "takeUpload", "connectorKey", "audioStream", "writeRegistration", "readRegistration", "deleteRegistration", "listConnectors", "publishFrame", "tailAudio", "stop"];
  for (const m of members) assert.equal(typeof (bus as never as Record<string, unknown>)[m], "function", m);
  assert.equal(typeof bus.consumer, "string");
  assert.equal(Bus.length >= 1, true);
  const p = bus.stop();
  assert.ok(p instanceof Promise);
  assert.equal(await p, undefined);
});

// @spec BUS-NAT-API-002
test("@cohost/bus exports the constants and everything events.ts, connector.ts and registrar.ts export", () => {
  assert.equal(STREAM, "cohost:events");
  assert.equal(HEALTH_STREAM, "cohost:health");
  assert.equal(HEALTH_MAXLEN, 1000);
  assert.equal(typeof EventPayloads, "object");
  assert.equal(typeof tagProblem, "function");
  assert.equal(typeof ConnectorRegistrar, "function");
  assert.equal(typeof parseRegistration, "function");
  for (const name of ["Bus", "EVENT_TYPES", "decodeFrame", "encodeFrame", "FrameTracker", "FrameSequencer", "watchConnectors", "ConnectorRegistry", "findOffer", "findReady", "capabilityDirection"]) {
    assert.ok(name in mod, `export ${name}`);
  }
});

// @spec BUS-NAT-API-003
test("no src file of any package or service imports a Redis client, and none lists one as a runtime dependency", () => {
  const offenders: string[] = [];
  const client = /(?:from\s+|require\(\s*|import\(\s*)["'](?:ioredis|redis|@redis\/[^"']+|ioredis-mock|redis-mock)["']/;
  for (const f of srcFiles()) if (client.test(readFileSync(f, "utf8"))) offenders.push(relative(repo, f));
  assert.deepEqual(offenders, [], "Redis client imported outside the native transport");
  const manifests: string[] = [];
  for (const top of ["packages", "services"]) for (const pkg of readdirSync(join(repo, top))) {
    try {
      const j = JSON.parse(readFileSync(join(repo, top, pkg, "package.json"), "utf8"));
      for (const dep of ["ioredis", "redis", "@redis/client"]) if (j.dependencies?.[dep]) manifests.push(`${top}/${pkg}:${dep}`);
    } catch { /* not a package */ }
  }
  assert.deepEqual(manifests, [], "a Redis client is only a devDependency");
  assert.match(readFileSync(join(repo, "packages/bus/src/index.ts"), "utf8"), /["']\.\/native\.js["']/, "the default transport is the native one");
});

// @spec BUS-NAT-API-004
test("BusOptions.transport is called once with the URL and { prefix, failFast }, and every operation runs on what it returns", async () => {
  const f1 = new FakeTransport();
  const l = busWith(f1, {}, "redis://h:1");
  assert.deepEqual(f1.factoryCalls, [{ url: "redis://h:1", opts: { prefix: "cohost", failFast: false } }]);
  const f2 = new FakeTransport();
  busWith(f2, { streamPrefix: "p1", failFast: true }, "redis://h:2");
  assert.deepEqual(f2.factoryCalls, [{ url: "redis://h:2", opts: { prefix: "p1", failFast: true } }]);

  // a connection-level option is gone: a stray `connect` is never called
  let connects = 0;
  const f3 = new FakeTransport();
  const b3 = busWith(f3, { connect: () => { connects++; return {} as never; } } as BusOptions);
  await b3.bus.publish("chat.message", chat);
  assert.equal(connects, 0);

  const bus = l.bus;
  const reg = { v: 1, id: "disc", kind: "k", version: "1", instance: "i", pid: 1, startedAt: 1, intervalMs: 1000, state: "ready", detail: "", capabilities: [] } as const;
  f1.on("readRegistration", () => JSON.stringify(reg)).on("listRegistrations", () => [JSON.stringify(reg)]);
  await bus.publish("chat.message", chat);
  await bus.publishHealth(hb);
  await bus.recent(2); await bus.recentHealth(2);
  await bus.putUpload("u", Buffer.from("x"), 5); await bus.takeUpload("u");
  await bus.writeRegistration(reg as never); assert.equal((await bus.readRegistration("disc"))?.id, "disc"); await bus.deleteRegistration("disc");
  assert.equal((await bus.listConnectors()).length, 1);
  await bus.publishFrame("in", "discord", { epoch: 1, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(4) });
  await bus.serverTime(); await bus.resetGroup("g");
  const seen = new Set(f1.names());
  for (const m of ["append", "recent", "putUpload", "takeUpload", "writeRegistration", "readRegistration", "deleteRegistration", "listRegistrations", "appendFrame", "serverTime", "createGroup"]) assert.ok(seen.has(m as never), m);
  assert.deepEqual(f1.of("append").map((c) => c.args[0]), ["events", "health"]);
  assert.deepEqual(f1.of("recent").map((c) => c.args), [["events", 2], ["health", 2]]);
  await bus.stop(); await b3.bus.stop();
});

// @spec BUS-NAT-API-005
test("publish and publishHealth validate with zod, stamp ts with Date.now() and pass append only the four string fields", async () => {
  await withBus(new FakeTransport(), {}, async ({ bus, fake }) => {
    const realNow = Date.now;
    Date.now = () => 1_234_567;
    try {
      await bus.publish("chat.message", { ...chat, extra: "dropped" } as never);
      await bus.publishHealth(hb);
    } finally { Date.now = realNow; }
    const [events, health] = fake.of("append");
    assert.equal(events!.args[0], "events");
    assert.equal(health!.args[0], "health");
    for (const c of [events!, health!]) {
      const f = c.args[1] as Record<string, unknown>;
      assert.deepEqual(Object.keys(f).sort(), ["data", "source", "ts", "type"]);
      assert.ok(Object.values(f).every((v) => typeof v === "string"));
      assert.equal(f.ts, "1234567");
      assert.equal(f.source, "t");
    }
    assert.deepEqual(JSON.parse((events!.args[1] as { data: string }).data), { ...chat, isMod: false, isSub: false, mentionsCohost: false });
    assert.equal((health!.args[1] as { type: string }).type, "service.heartbeat");
    const before = fake.of("append").length;
    await assert.rejects(bus.publish("chat.message", { platform: "irc" } as never));
    await assert.rejects(bus.publishHealth({ ...hb, state: "dead" } as never));
    assert.equal(fake.of("append").length, before, "an invalid payload is never appended");
  });
});

// @spec BUS-NAT-API-006
test("events read from subscribe, tail and recent are built by decode from the transport's RawEntry", async () => {
  const fake = new FakeTransport();
  const wire = { ...rawEntry("5-0", "chat.message", chat, { ts: "1700", source: "src" }) };
  fake.on("readGroup", () => groupRead(null), () => groupRead([wire, rawEntry("6-0", "chat.message", "{not json")]));
  fake.on("read", () => [wire, rawEntry("7-0", "chat.message", "{not json")]);
  fake.on("recent", () => [rawEntry("1-0", "chat.message", "{not json"), wire]);
  await withBus(fake, {}, async ({ bus }) => {
    const want: BusEvent = { id: "5-0", type: "chat.message", ts: 1700, source: "src", data: { ...chat, isMod: false, isSub: false, mentionsCohost: false } };
    const subbed: BusEvent[] = [], tailed: BusEvent[] = [];
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, (e) => { subbed.push(e); });
    void bus.tail((e) => { tailed.push(e); });
    await until(() => subbed.length > 0 && tailed.length > 0, "an event from each loop");
    assert.deepEqual(subbed, [want]);
    assert.deepEqual(tailed, [want]);
    assert.deepEqual(await bus.recent(10), [want]);
  });
});

// @spec BUS-NAT-API-007
test("subscribe with start latest and createGroup resolving false calls moveGroupToLatest before onReady and the first read", async () => {
  for (const [start, created, moves] of [["latest", false, true], ["latest", true, false], ["resume", false, false]] as const) {
    const fake = new FakeTransport().resolveOnce("createGroup", created);
    await withBus(fake, {}, async ({ bus }) => {
      let atReady = -1;
      void bus.subscribe({ group: "g", start, blockMs: 10, onReady: () => { atReady = fake.calls.length; } }, () => {});
      await until(() => fake.of("readGroup").length > 0, "first read");
      const names = fake.names().filter((n) => n !== "openReader");
      assert.deepEqual(names.slice(0, moves ? 3 : 2), moves ? ["createGroup", "moveGroupToLatest", "readGroup"] : ["createGroup", "readGroup"], `${start}/${created}`);
      assert.ok(atReady > 0, "onReady ran");
      const readIdx = fake.calls.findIndex((c) => c.method === "readGroup");
      assert.ok(atReady <= readIdx, "onReady before the first read");
      if (moves) assert.ok(fake.calls.findIndex((c) => c.method === "moveGroupToLatest") < atReady, "move before onReady");
      assert.deepEqual(fake.of("createGroup")[0]!.args, ["g"]);
    });
  }
});

// @spec BUS-NAT-API-008
test("resetGroup calls createGroup, then moveGroupToLatest when it resolves false, and rethrows any rejection", async () => {
  const fake = new FakeTransport();
  const { bus } = busWith(fake);
  fake.resolveOnce("createGroup", true);
  await bus.resetGroup("g");
  assert.deepEqual(fake.names(), ["createGroup"]);
  fake.resolveOnce("createGroup", false);
  await bus.resetGroup("g");
  assert.deepEqual(fake.names().slice(1), ["createGroup", "moveGroupToLatest"]);
  const boom = busError("BUS_REDIS", "WRONGTYPE");
  fake.on("createGroup", () => { throw boom; });
  await assert.rejects(bus.resetGroup("g"), (e) => e === boom);
  fake.resolveOnce("createGroup", false).on("moveGroupToLatest", () => { throw boom; });
  await assert.rejects(bus.resetGroup("g"), (e) => e === boom);
  await bus.stop();
});

// @spec BUS-NAT-API-009
test("serverTime returns the transport's TIME in epoch ms and is never used as an envelope ts", async () => {
  const fake = new FakeTransport();
  fake.serverNow = 1_700_000_000_250;
  const { bus } = busWith(fake);
  assert.equal(await bus.serverTime(), 1_700_000_000_250);
  const realNow = Date.now;
  Date.now = () => 42;
  try { await bus.publish("chat.message", chat); } finally { Date.now = realNow; }
  assert.equal((fake.of("append")[0]!.args[1] as { ts: string }).ts, "42");
  assert.equal(fake.of("serverTime").length, 1, "publish does not read the server clock");
  await bus.stop();
});

// @spec BUS-NAT-API-010
test("native.ts is the only src file that loads the native addon", () => {
  const loaders = srcFiles().filter((f) => /cohost-bus\.[^"'`]*\.node|createRequire\s*\(\s*import\.meta\.url\s*\)/.test(readFileSync(f, "utf8"))).map((f) => relative(repo, f));
  assert.deepEqual(loaders, ["packages/bus/src/native.ts"]);
});

// @spec BUS-NAT-API-011
test("tests that need a Bus without a Redis server give it a fake transport, not a connection factory", () => {
  const tests = ["packages", "services"].flatMap((top) => readdirSync(join(repo, top)).flatMap((pkg) => {
    try { return sources(join(repo, top, pkg, "test")); } catch { return []; }
  }));
  const withConnect = tests.filter((f) => /new Bus\([^)]*\{[^}]*\bconnect\s*:/.test(readFileSync(f, "utf8")) || /\bconnect:\s*\(\s*(?:_?u\w*)?[^)]*\)\s*=>\s*\w+\s+as never/.test(readFileSync(f, "utf8"))).map((f) => relative(repo, f));
  assert.deepEqual(withConnect, [], "tests still pass BusOptions.connect");
  assert.match(readFileSync(join(repo, "packages/bus/test/resilience.test.ts"), "utf8"), /transport:/);
});

// @spec BUS-STREAM-005
test("the transport is opened when the Bus is constructed (URL from REDIS_URL when none is given) and the consumer name is HOSTNAME-<8 hex>, fixed for the instance", async () => {
  const saved = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  const buses: Bus[] = [];
  try {
    const fake = new FakeTransport();
    const l = new Bus("t", undefined, undefined, { transport: fake.factory });
    buses.push(l);
    assert.equal(fake.factoryCalls.length, 1, "factory called inside the constructor");
    assert.equal(fake.factoryCalls[0]!.url, "redis://127.0.0.1:1");
    const host = (process.env.HOSTNAME ?? "local").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(l.consumer, new RegExp(`^${host}-[0-9a-f]{8}$`));
    const before = l.consumer;
    fake.on("readGroup", () => groupRead(null));
    void l.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    assert.equal(fake.of("readGroup")[0]!.args[1], before, "reads run under the instance's consumer name");
    assert.equal(l.consumer, before);
    const other = new Bus("t", undefined, undefined, { transport: new FakeTransport().factory });
    buses.push(other);
    assert.notEqual(other.consumer, before);
  } finally {
    for (const b of buses) await Promise.race([b.stop(), tick(500)]);
    if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
  }
});

// @spec BUS-STREAM-009
test("failFast reaches the transport factory, a BUS_CONNECTION rejection reaches the caller unchanged, and the facade prints nothing", async () => {
  const printed: string[] = [];
  const o = { log: console.log, warn: console.warn, err: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => { printed.push(a.join(" ")); };
  let failure: unknown, factory: unknown;
  try {
    const fake = new FakeTransport();
    const err = busError("BUS_CONNECTION", "connect ECONNREFUSED 127.0.0.1:1");
    fake.on("recent", () => { throw err; });
    const { bus } = busWith(fake, { failFast: true });
    factory = fake.factoryCalls[0]!.opts;
    failure = await bus.recentHealth(1).then(() => undefined, (e) => e);
    assert.equal(failure, err);
    await bus.stop();
  } finally {
    console.log = o.log; console.warn = o.warn; console.error = o.err;
  }
  assert.deepEqual(factory, { prefix: "cohost", failFast: true });
  assert.equal((failure as { code: string }).code, "BUS_CONNECTION");
  assert.deepEqual(printed, []);
  const off = new FakeTransport();
  busWith(off);
  assert.equal(off.factoryCalls[0]!.opts.failFast, false);
});

// @spec BUS-UPL-001
test("putUpload hands the transport the id, bytes and ttl, and rejects when the write fails", async () => {
  const fake = new FakeTransport();
  const { bus } = busWith(fake);
  await bus.putUpload("abc", Buffer.from("hi"), 5000);
  assert.deepEqual(fake.of("putUpload")[0]!.args, ["abc", Buffer.from("hi"), 5000]);
  const boom = busError("BUS_CONNECTION", "redis down");
  fake.on("putUpload", () => { throw boom; });
  await assert.rejects(bus.putUpload("abd", Buffer.from("x"), 1), (e) => e === boom);
  await bus.stop();
});

// @spec BUS-NAT-TRN-005
test("each loop reads on a reader of its own and every non-blocking command uses the shared transport", async () => {
  const fake = new FakeTransport();
  await withBus(fake, {}, async ({ bus }) => {
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
    void bus.tail(() => {});
    void bus.tailHealth(() => {});
    void bus.tailAudio("in", "discord", () => {});
    await until(() => fake.of("readGroup").length + fake.of("read").length + fake.of("readFrames").length >= 4, "four loops reading");
    assert.equal(fake.readers.length, 4);
    assert.equal(fake.of("openReader").length, 4);
    const kinds = fake.readers.map((r) => new Set(fake.calls.filter((c) => c.reader === r.n && ["readGroup", "read", "readFrames"].includes(c.method)).map((c) => c.method)));
    assert.ok(kinds.every((k) => k.size === 1), "one kind of blocking read per reader");
    await bus.publish("chat.message", chat); await bus.recent(1); await bus.serverTime(); await bus.putUpload("u", Buffer.alloc(1), 1);
    assert.equal(fake.of("openReader").length, 4, "non-blocking commands open no reader");
    assert.ok(fake.calls.filter((c) => ["append", "recent", "serverTime", "putUpload"].includes(c.method)).every((c) => c.reader === undefined));
  });
});

// @spec BUS-NAT-TRN-007
test("subscribe does not issue the next readGroup until the handler of every entry of the batch has settled", async () => {
  const fake = new FakeTransport();
  fake.on("readGroup", () => groupRead(null), () => groupRead([rawEntry("1-0"), rawEntry("2-0"), rawEntry("3-0")]));
  await withBus(fake, {}, async ({ bus }) => {
    const readsAtStart: number[] = [];
    let lastFinish = 0;
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, async (e) => {
      readsAtStart.push(fake.of("readGroup").length);
      await tick(20);
      lastFinish = performance.now();
      void e;
    });
    await until(() => fake.of("readGroup").length >= 3, "the read after the batch");
    assert.deepEqual(readsAtStart, [2, 2, 2]);
    assert.ok(fake.of("readGroup")[2]!.at >= lastFinish, "the next read came after the last handler finished");
  });
});

// @spec BUS-NAT-TRN-008
test("commands issued without awaiting reach the transport in call order", async () => {
  await withBus(new FakeTransport(), {}, async ({ bus, fake }) => {
    const pubs = Array.from({ length: 20 }, (_, i) => bus.publish("chat.message", { ...chat, text: String(i) }));
    const frames = Array.from({ length: 10 }, (_, i) => bus.publishFrame("in", "discord", { epoch: 1, seq: i, rate: 16000, ch: 1, pcm: Buffer.alloc(2) }));
    await Promise.all([...pubs, ...frames]);
    assert.deepEqual(fake.of("append").map((c) => JSON.parse((c.args[1] as { data: string }).data).text), Array.from({ length: 20 }, (_, i) => String(i)));
    assert.deepEqual(fake.of("appendFrame").map((c) => (c.args[2] as { seq: number }).seq), Array.from({ length: 10 }, (_, i) => i));
  });
});

// @spec BUS-NAT-CONN-005
test("a command rejected BUS_CONNECTION by the down shared connection reaches its caller unchanged, with nothing queued by the facade", async () => {
  const fake = new FakeTransport();
  const { bus, l } = busWith(fake);
  const err = busError("BUS_CONNECTION", "connection closed");
  const fail = () => { throw err; };
  const calls: [string, () => Promise<unknown>][] = [
    ["append", () => bus.publish("chat.message", chat)], ["append", () => bus.publishHealth(hb)],
    ["appendFrame", () => bus.publishFrame("in", "discord", { epoch: 1, seq: 0, rate: 1, ch: 1, pcm: Buffer.alloc(2) })],
    ["putUpload", () => bus.putUpload("u", Buffer.alloc(1), 1)], ["takeUpload", () => bus.takeUpload("u")],
    ["writeRegistration", () => bus.writeRegistration({ v: 1, id: "d", kind: "k", version: "1", instance: "i", pid: 1, startedAt: 1, intervalMs: 1, state: "s", detail: "", capabilities: [] })],
    ["readRegistration", () => bus.readRegistration("d")], ["deleteRegistration", () => bus.deleteRegistration("d")],
    ["listRegistrations", () => bus.listConnectors()], ["recent", () => bus.recent(1)], ["recent", () => bus.recentHealth(1)],
    ["createGroup", () => bus.resetGroup("g")], ["serverTime", () => bus.serverTime()],
    ["createGroup", () => bus.subscribe({ group: "g", start: "latest" }, () => {})],
  ];
  for (const [method, call] of calls) {
    fake.on(method as never, fail);
    await assert.rejects(call(), (e) => e === err, method);
  }
  assert.equal(fake.calls.filter((c) => c.method !== "openReader" && c.method !== "readerClose").length, calls.length, "each call made exactly one transport call: no queueing or retry");
  assert.ok(l.at("warn").length >= 2, "publish failures are logged at warn");
  await within(bus.stop());
});
