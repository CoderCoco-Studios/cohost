// Bus behaviour (start modes, drain, filtering, tails, publish failures, prefix) on a scripted BusTransport: no Redis
// server and no native addon calls. The ack, backoff, error-code and stop rules are in native-loops.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "../src/index.js";
import { FakeTransport, rawEntry, groupRead, busError, busWith, withBus, until, tick, within, run } from "./native-helpers.js";

const empty = () => groupRead(null);
const batch = (...entries: ReturnType<typeof rawEntry>[]) => () => groupRead(entries);
const hbData = { service: "s", instance: "i", version: "1", pid: 1, startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 1000 } as const;
const hbEntry = (id: string) => rawEntry(id, "service.heartbeat", hbData, { source: "s" });
const cursors = (f: FakeTransport) => f.of("readGroup").map((c) => c.args[2]);

// @spec BUS-SUB-001, BUS-SUB-010
test("latest: a missing group is created before the first read and not moved", async () => {
  const fake = new FakeTransport();
  await withBus(fake, {}, async ({ bus }) => {
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    assert.deepEqual(fake.names().filter((n) => n !== "openReader").slice(0, 2), ["createGroup", "readGroup"]);
    assert.equal(fake.of("moveGroupToLatest").length, 0);
  });
});

// @spec BUS-SUB-010
test("latest: an existing group (createGroup false) is moved to $ before the first read", async () => {
  const fake = new FakeTransport().resolveOnce("createGroup", false);
  await withBus(fake, {}, async ({ bus }) => {
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    assert.deepEqual(fake.names().filter((n) => n !== "openReader").slice(0, 3), ["createGroup", "moveGroupToLatest", "readGroup"]);
    assert.deepEqual(fake.of("moveGroupToLatest")[0]!.args, ["g"]);
  });
});

// @spec BUS-SUB-002
test("resume: an existing group keeps its stored position (no move)", async () => {
  const fake = new FakeTransport().resolveOnce("createGroup", false);
  await withBus(fake, {}, async ({ bus }) => {
    void bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    assert.equal(fake.of("moveGroupToLatest").length, 0);
  });
});

// @spec BUS-SUB-001
test("any group-creation error rejects subscribe", async () => {
  const fake = new FakeTransport().failOnce("createGroup", "BUS_REDIS", "READONLY You can't write against a read only replica.");
  const { bus } = busWith(fake);
  await assert.rejects(bus.subscribe({ group: "g", start: "resume" }, () => {}), /READONLY/);
  assert.equal(fake.of("readGroup").length, 0);
  await bus.stop();
});

// @spec BUS-SUB-011
test("subscribe requires an explicit start mode and ignores the removed fromNow", async () => {
  for (const extra of [{}, { fromNow: true }, { start: "bogus" }]) {
    const fake = new FakeTransport();
    const { bus } = busWith(fake);
    await assert.rejects(bus.subscribe({ group: "g", blockMs: 10, ...extra } as never, () => {}), /start/);
    assert.equal(fake.of("createGroup").length, 0);
    assert.equal(fake.of("readGroup").length, 0);
    await bus.stop();
  }
});

// @spec BUS-SUB-008
test("subscribe reads only its own consumer's pending list first and never claims", async () => {
  const fake = new FakeTransport();
  await withBus(fake, {}, async ({ bus }) => {
    void bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    const [group, consumer, cursor] = fake.of("readGroup")[0]!.args;
    assert.deepEqual([group, consumer, cursor], ["g", bus.consumer, "0"]);
    assert.ok(fake.names().every((n) => ["createGroup", "openReader", "readGroup", "ack", "close", "readerClose", "moveGroupToLatest"].includes(n)));
  });
});

// @spec BUS-SUB-012, MEM-START-005
test("onReady fires after the group is created and positioned, before the first read", async () => {
  const fake = new FakeTransport().resolveOnce("createGroup", false);
  await withBus(fake, {}, async ({ bus }) => {
    let atReady: string[] = [];
    void bus.subscribe({ group: "g", start: "latest", blockMs: 10, onReady: () => { atReady = fake.names(); } }, () => {});
    await until(() => fake.of("readGroup").length > 0, "first read");
    assert.deepEqual(atReady.filter((n) => n !== "openReader"), ["createGroup", "moveGroupToLatest"]);
  });
});

// @spec BUS-SUB-003
test("the pending drain reads batch after batch until none remain, then switches to new entries", async () => {
  const fake = new FakeTransport().on("readGroup", batch(rawEntry("1-0")), batch(rawEntry("2-0")), empty);
  await withBus(fake, {}, async ({ bus }) => {
    const got: string[] = [];
    void bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, (ev) => { got.push(ev.id); });
    await until(() => fake.of("readGroup").length >= 4, "four reads");
    assert.deepEqual(got, ["1-0", "2-0"]);
    assert.deepEqual(cursors(fake).slice(0, 4), ["0", "1-0", "2-0", ">"]);
  });
});

// @spec BUS-SUB-004, BUS-SUB-005
test("types filters client-side: other types are acked without a handler call; a handler failure is logged and acked", async () => {
  const fake = new FakeTransport().on("readGroup", empty, batch(rawEntry("1-0"), rawEntry("2-0", "chat.message", { platform: "twitch", user: "a", text: "x" }), rawEntry("3-0")));
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [];
    void bus.subscribe({ group: "g", start: "resume", types: ["control"], blockMs: 10 }, (ev) => { got.push(ev.id); if (ev.id === "1-0") throw new Error("boom"); });
    await until(() => fake.of("ack").length === 3, "three acks");
    assert.deepEqual(got, ["1-0", "3-0"]);
    assert.equal(l.at("error").length, 1);
    assert.match(String(l.at("error")[0]!.obj.err), /boom/);
  });
});

// @spec BUS-SUB-009, BUS-STOP-001
test("stop() ends a retry backoff promptly", async () => {
  const fake = new FakeTransport().failOnce("readGroup");
  const { bus, l } = busWith(fake, { retryBaseMs: 60_000, retryMaxMs: 60_000 });
  const done = run(bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {}));
  await until(() => l.at("warn").length === 1, "the failure logged");
  const t0 = performance.now();
  await bus.stop();
  await within(done.done, 500, "subscribe");
  assert.ok(performance.now() - t0 < 500);
});

// @spec BUS-TAIL-003
test("tail retries a failed read from the last delivered id and never rejects", async () => {
  const fake = new FakeTransport().on("read", () => [rawEntry("7-0")], () => { throw busError("BUS_CONNECTION"); });
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [];
    const t = run(bus.tail((ev) => { got.push(ev.id); }));
    await until(() => fake.of("read").length >= 3, "three reads");
    assert.deepEqual(got, ["7-0"]);
    assert.deepEqual(fake.of("read")[0]!.args, ["events", "$", 100, 5000]);
    assert.equal(fake.of("read")[2]!.args[1], "7-0");
    assert.equal(l.at("warn").length, 1);
    assert.equal(t.settled, false);
  });
});

// @spec BUS-TAIL-003
test("tailHealth retries a failed read from the last delivered id and never rejects", async () => {
  const fake = new FakeTransport().on("read", () => [hbEntry("9-0")], () => { throw busError("BUS_CONNECTION"); });
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [];
    const t = run(bus.tailHealth((ev) => { got.push(ev.id); }));
    await until(() => fake.of("read").length >= 3, "three reads");
    assert.deepEqual(got, ["9-0"]);
    assert.equal(fake.of("read")[0]!.args[0], "health");
    assert.equal(fake.of("read")[2]!.args[1], "9-0");
    assert.equal(l.at("warn").length, 1);
    assert.equal(t.settled, false);
  });
});

// @spec BUS-TAIL-004
test("a throwing tail handler is logged at error level and the loop continues", async () => {
  const fake = new FakeTransport().on("read", () => [rawEntry("1-0"), rawEntry("2-0")]);
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [];
    void bus.tail((ev) => { got.push(ev.id); if (ev.id === "1-0") throw new Error("handler boom"); });
    await until(() => got.length === 2, "both entries");
    assert.equal(l.at("error").length, 1);
    assert.match(String(l.at("error")[0]!.obj.err), /handler boom/);
    await until(() => fake.of("read").length >= 2, "the loop read again");
  });
});

// @spec BUS-TAIL-004
test("a throwing tailHealth handler is logged and the loop continues", async () => {
  const fake = new FakeTransport().on("read", () => [hbEntry("1-0"), hbEntry("2-0")]);
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [];
    void bus.tailHealth((ev) => { got.push(ev.id); throw new Error("hb boom"); });
    await until(() => got.length === 2, "both entries");
    assert.equal(l.at("error").length, 2);
  });
});

// @spec BUS-TAIL-005
test("tail reports each blocking read to onRead: an empty read and a delivering read as success, a failed one with its error", async () => {
  const fake = new FakeTransport().on("read", () => null, () => { throw busError("BUS_CONNECTION", "ECONNRESET"); }, () => [rawEntry("3-0")]);
  await withBus(fake, {}, async ({ bus }) => {
    const seen: (string | undefined)[] = [];
    void bus.tail(() => {}, "$", (err) => { seen.push(err === undefined ? undefined : (err as Error).message); });
    await until(() => seen.length >= 3, "three reports");
    assert.deepEqual(seen.slice(0, 3), [undefined, "ECONNRESET", undefined]);
  });
});

// @spec BUS-TAIL-005
test("tailHealth reports each blocking read to onRead the same way", async () => {
  const fake = new FakeTransport().on("read", () => { throw busError("BUS_CONNECTION"); }, () => null);
  await withBus(fake, {}, async ({ bus }) => {
    const seen: boolean[] = [];
    void bus.tailHealth(() => {}, "$", (err) => { seen.push(err === undefined); });
    await until(() => seen.length >= 2, "two reports");
    assert.deepEqual(seen.slice(0, 2), [false, true]);
  });
});

// @spec BUS-STREAM-007
test("a rejected append is logged at warn with the type and the original error is propagated", async () => {
  const err = busError("BUS_REDIS", "Stream isn't writeable");
  const fake = new FakeTransport().on("append", () => { throw err; }, () => { throw err; });
  const { bus, l } = busWith(fake);
  await assert.rejects(bus.publish("control", { cmd: "mute" }), (e) => e === err);
  await assert.rejects(bus.publishHealth(hbData), (e) => e === err);
  const w = l.at("warn");
  assert.equal(w.length, 2);
  assert.equal(w[0]!.obj.err, err); assert.equal(w[0]!.obj.type, "control");
  assert.equal(w[0]!.msg, "publish failed");
  assert.equal(w[1]!.obj.type, "service.heartbeat");
  await bus.stop();
});

// @spec BUS-STREAM-003
test("a schema failure throws before append and is not logged as a publish failure", async () => {
  const fake = new FakeTransport();
  const { bus, l } = busWith(fake);
  await assert.rejects(bus.publish("control", { cmd: "nope" } as never));
  assert.equal(fake.of("append").length, 0);
  assert.equal(l.at("warn").length, 0);
  await bus.stop();
});

// @spec BUS-GROUP-001
test("resetGroup on a fresh Redis creates the group and does not move it; on an existing group it moves it to $; errors are rethrown", async () => {
  const fake = new FakeTransport();
  const { bus } = busWith(fake);
  await bus.resetGroup("g");
  assert.deepEqual(fake.names(), ["createGroup"]);
  fake.resolveOnce("createGroup", false);
  await bus.resetGroup("g");
  assert.deepEqual(fake.of("moveGroupToLatest")[0]!.args, ["g"]);
  fake.failOnce("createGroup", "BUS_REDIS", "READONLY You can't write against a read only replica.");
  await assert.rejects(bus.resetGroup("g"), /READONLY/);
  await bus.stop();
});

// @spec BUS-STREAM-008
test("streamPrefix is handed to the transport, which names every stream under it; the default is cohost", async () => {
  const scratch = new FakeTransport();
  const { bus } = busWith(scratch, { streamPrefix: "scratch:a" });
  assert.deepEqual(scratch.factoryCalls[0]!.opts, { prefix: "scratch:a", failFast: false });
  assert.equal(bus.connectorKey("c"), "scratch:a:connector:c");
  assert.equal(bus.audioStream("out", "x"), "scratch:a:audio.out.x");
  await bus.stop();
  const plain = new FakeTransport();
  const { bus: b2 } = busWith(plain);
  assert.equal(plain.factoryCalls[0]!.opts.prefix, "cohost");
  await b2.stop();
});

// @spec BUS-SUB-007
test("recent and recentHealth decode oldest first and skip undecodable entries", async () => {
  const fake = new FakeTransport()
    .on("recent", () => [rawEntry("1-0"), rawEntry("2-0", "nope", {}), rawEntry("3-0")], () => [hbEntry("4-0"), rawEntry("5-0", "chat.message", "{}")]);
  const { bus } = busWith(fake);
  assert.deepEqual((await bus.recent(5)).map((e: BusEvent) => e.id), ["1-0", "3-0"]);
  assert.deepEqual((await bus.recentHealth(5)).map((e) => e.id), ["4-0"]);
  await bus.stop();
  await tick(1);
});

// @spec BUS-NAT-API-004, BUS-NAT-API-011
test("a Bus built with BusOptions.transport runs on that transport and needs no Redis server", async () => {
  const fake = new FakeTransport();
  const bus = new (await import("../src/index.js")).Bus("t", undefined, "redis://127.0.0.1:1", { transport: fake.factory });
  await bus.publish("control", { cmd: "mute" });
  assert.equal(fake.of("append").length, 1);
  await bus.stop();
});
