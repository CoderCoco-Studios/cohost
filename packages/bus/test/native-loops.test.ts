// Read loops on a scripted BusTransport: acks, drain, backoff, stop (BUS-NAT-ACK-*, CONN-*, ERR-*, amended BUS-SUB-008/009,
// BUS-STOP-001). Until the facade runs on `BusOptions.transport` (Phase 6) every test here fails at the first assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bus, BusEvent, EventType } from "../src/index.js";
import { FakeTransport, rawEntry, groupRead, busError, withBus, busWith, until, within, tick, run } from "./native-helpers.js";

const empty = () => groupRead(null);
const batch = (...ids: string[]) => () => groupRead(ids.map((id) => rawEntry(id)));
const down = (code: "BUS_CONNECTION" | "BUS_REDIS" | "BUS_INTERNAL" = "BUS_CONNECTION") => () => { throw busError(code, `${code} failure`); };
const cursors = (f: FakeTransport) => f.of("readGroup").map((c) => c.args[2]);
const sub = (bus: Bus, handler: (e: BusEvent) => unknown = () => {}, extra: object = {}) =>
  run(bus.subscribe({ group: "g", start: "latest", blockMs: 10, ...extra } as never, handler as never));
const idsOf = (calls: { args: unknown[] }[]) => calls.map((c) => c.args[1]);

// @spec BUS-NAT-ACK-001
test("the facade acks through the reader's synchronous ack, which only queues; the queued ids travel with the next readGroup", async () => {
  const fake = new FakeTransport().on("readGroup", empty, batch("1-0", "2-0"), empty);
  await withBus(fake, {}, async ({ bus }) => {
    const handled: string[] = [];
    void sub(bus, (e) => { handled.push(e.id); });
    await until(() => fake.of("readGroup").length >= 3, "third read");
    assert.deepEqual(fake.of("ack").map((c) => c.args), [["g", "1-0"], ["g", "2-0"]]);
    assert.deepEqual(fake.of("readGroup").map((c) => c.acks), [[], [], ["1-0", "2-0"]], "queued acks ride in the next read's pipeline");
    const names = fake.names();
    assert.ok(names.lastIndexOf("ack") < names.lastIndexOf("readGroup"), "acks are queued ahead of the read that sends them");
    assert.ok(fake.of("ack").every((c) => c.reader === 1), "queued on the reader of the subscription");
  });
});

// @spec BUS-NAT-ACK-002
test("an entry is acked only after its handler returned or threw, or after it was filtered out or found undecodable", async () => {
  const fake = new FakeTransport().on("readGroup", empty, () => groupRead([
    rawEntry("1-0"), rawEntry("2-0"), rawEntry("3-0", "chat.message", { platform: "twitch", user: "a", text: "x" }),
    { id: "4-0" }, rawEntry("5-0", "control", "{not json"),
  ]));
  await withBus(fake, {}, async ({ bus, l }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const acksAtStart: [string, number][] = [];
    void sub(bus, async (e) => {
      acksAtStart.push([e.id, fake.of("ack").length]);
      if (e.id === "1-0") await gate;
      if (e.id === "2-0") throw new Error("boom");
    }, { types: ["control"] as EventType[] });
    await until(() => acksAtStart.length === 1, "first handler running");
    await tick(30);
    assert.equal(fake.of("ack").length, 0, "no ack while the handler runs");
    release();
    await until(() => fake.of("ack").length === 5, "five acks");
    assert.deepEqual(acksAtStart, [["1-0", 0], ["2-0", 1]], "each ack follows its handler");
    assert.deepEqual(fake.of("ack").map((c) => c.args[1]), ["1-0", "2-0", "3-0", "4-0", "5-0"]);
    assert.equal(l.at("error").filter((x) => x.msg === "handler failed").length, 1);
  });
});

// @spec BUS-NAT-ACK-003, BUS-SUB-009
test("a refused ack is logged `ack failed` at warn, not retried, and the entry is redelivered once by a later drain without being read twice in one drain", async () => {
  const fake = new FakeTransport().on("readGroup",
    empty, batch("1-0"), empty, () => { fake.refusedAcks.delete("1-0"); throw busError("BUS_CONNECTION"); }, batch("1-0"), empty);
  fake.refusedAcks.add("1-0");
  await withBus(fake, {}, async ({ bus, l }) => {
    const handled: string[] = [];
    const s = sub(bus, (e) => { handled.push(e.id); });
    await until(() => fake.of("readGroup").length >= 3, "the read that reports the refusal");
    await until(() => l.at("warn").some((x) => x.msg === "ack failed"), "ack failed warn");
    const w = l.at("warn").find((x) => x.msg === "ack failed")!;
    assert.deepEqual(w.obj.ids, ["1-0"]);
    assert.equal(fake.of("ack").length, 1, "the refused ack is not retried");
    await until(() => fake.of("readGroup").length >= 7, "the drain after the failure");
    assert.deepEqual(cursors(fake).slice(0, 7), ["0", ">", ">", ">", "0", "1-0", ">"]);
    assert.deepEqual(handled, ["1-0", "1-0"], "delivered once more by the drain");
    assert.equal(fake.of("ack").length, 2);
    assert.equal(s.settled, false);
    assert.equal(l.at("warn").filter((x) => x.msg === "ack failed, entry dropped").length, 0);
  });
});

// @spec BUS-NAT-ACK-004
test("acks queued before a failed read are not queued again by the facade; the transport sends them with the next pipeline", async () => {
  const fake = new FakeTransport().on("readGroup", empty, batch("1-0"), down(), empty, empty);
  await withBus(fake, {}, async ({ bus }) => {
    void sub(bus);
    await until(() => fake.of("readGroup").length >= 5, "reads after the failure");
    assert.equal(fake.of("ack").length, 1, "one ack call for the one entry");
    assert.deepEqual(fake.of("readGroup")[2]!.acks, ["1-0"], "queued when the failing read was issued");
    assert.deepEqual(fake.of("readGroup")[3]!.acks, ["1-0"], "still queued: the failed pipeline never reached Redis");
    assert.deepEqual(fake.of("readGroup")[4]!.acks, [], "gone once a pipeline went through");
  });
});

// @spec BUS-NAT-ACK-005, BUS-SUB-013
test("acks queued before stop() are flushed by close(); the entry whose handler was running at stop() and later entries get none", async () => {
  const fake = new FakeTransport().on("readGroup", empty, batch("1-0", "2-0", "3-0"));
  await withBus(fake, {}, async ({ bus }) => {
    const handled: string[] = [];
    let stopping!: Promise<void>;
    const s = sub(bus, async (e) => {
      handled.push(e.id);
      if (e.id === "2-0") { stopping = bus.stop(); await tick(20); }
    });
    await until(() => handled.includes("2-0"), "second handler");
    await within(s.done, 1000, "subscribe");
    await within(stopping, 1000, "stop");
    assert.deepEqual(handled, ["1-0", "2-0"], "the rest of the batch is not handled");
    assert.deepEqual(fake.of("ack").map((c) => c.args[1]), ["1-0"], "no ack for the entry running at stop() or after it");
    assert.deepEqual(fake.flushedAtClose, [{ group: "g", id: "1-0" }]);
    assert.equal(s.error, undefined);
  });
});

// @spec BUS-NAT-ACK-006
test("Bus.stop() resolves when the transport's ack flush failed", async () => {
  const fake = new FakeTransport().on("readGroup", empty, batch("1-0", "2-0"));
  fake.flushFails = true;
  const { bus } = busWith(fake);
  let stopping!: Promise<void>;
  const s = sub(bus, async (e) => { if (e.id === "2-0") { stopping = bus.stop(); await tick(10); } });
  await until(() => fake.of("ack").length >= 1, "an ack queued");
  await within(s.done, 1000, "subscribe");
  assert.equal(await within(stopping, 1000, "stop"), undefined);
  assert.equal(fake.closed, true);
  assert.deepEqual(fake.flushedAtClose, []);
});

// @spec BUS-NAT-ACK-008
test("an ack refused on both deliveries logs `ack failed, entry dropped`, and no later drain handles or acks the entry again", async () => {
  const fake = new FakeTransport().on("readGroup",
    empty, batch("1-0"), empty, down(), batch("1-0"), empty, down(), batch("1-0"), empty);
  fake.refusedAcks.add("1-0");
  await withBus(fake, {}, async ({ bus, l }) => {
    const handled: string[] = [];
    void sub(bus, (e) => { handled.push(e.id); });
    await until(() => fake.of("readGroup").length >= 10, "three drains");
    assert.deepEqual(cursors(fake).slice(0, 10), ["0", ">", ">", ">", "0", "1-0", ">", "0", "1-0", ">"]);
    assert.deepEqual(handled, ["1-0", "1-0"], "never delivered a third time");
    assert.equal(fake.of("ack").length, 2, "the dropped entry's ack is not queued again");
    assert.equal(l.at("warn").filter((x) => x.msg === "ack failed").length, 1);
    const dropped = l.at("warn").filter((x) => x.msg === "ack failed, entry dropped");
    assert.equal(dropped.length, 1);
    assert.deepEqual(dropped[0]!.obj.ids, ["1-0"]);
  });
});

// @spec BUS-SUB-008
test("delivery is at most once: handler failures are acked, a refused ack is redelivered at most once, a successor does not claim", async () => {
  const fake = new FakeTransport().on("readGroup",
    empty, batch("1-0", "2-0"), empty, down(), batch("2-0"), empty, down(), batch("2-0"), empty);
  fake.refusedAcks.add("2-0");
  await withBus(fake, {}, async ({ bus, l }) => {
    const handled: string[] = [];
    void sub(bus, (e) => { handled.push(e.id); if (e.id === "1-0") throw new Error("handler failed"); });
    await until(() => fake.of("readGroup").length >= 10, "three drains");
    assert.deepEqual(handled, ["1-0", "2-0", "2-0"], "1-0 once (failure acked), 2-0 at most twice");
    assert.ok(fake.of("ack").some((c) => c.args[1] === "1-0"), "the failed handler's entry is acked");
    assert.equal(l.at("warn").filter((x) => x.msg === "ack failed, entry dropped").length, 1);
  });
  // a successor has its own consumer name and a first read of its own pending list; nothing claims the predecessor's
  const next = new FakeTransport().on("readGroup", empty);
  await withBus(next, {}, async ({ bus }) => {
    void sub(bus);
    await until(() => next.of("readGroup").length >= 2, "successor reads");
    assert.notEqual(next.of("readGroup")[0]!.args[1], fake.of("readGroup")[0]!.args[1], "own consumer name");
    assert.deepEqual(cursors(next).slice(0, 2), ["0", ">"], "an empty pending list moves it straight to >");
  });
});

// @spec BUS-SUB-009
test("a failing read is logged at warn and retried after a capped, growing delay that resets after a success; subscribe never rejects", async () => {
  const fake = new FakeTransport().on("readGroup", down(), down("BUS_REDIS"), down(), down(), empty, down(), empty);
  await withBus(fake, { retryBaseMs: 5, retryMaxMs: 30 }, async ({ bus, l }) => {
    const s = sub(bus);
    await until(() => fake.of("readGroup").length >= 8, "all scripted reads");
    const warns = l.at("warn").filter((x) => x.obj?.delayMs !== undefined);
    assert.deepEqual(warns.map((w) => w.obj.delayMs), [5, 10, 20, 30, 5]);
    assert.deepEqual(warns.map((w) => w.obj.failures), [1, 2, 3, 4, 1]);
    assert.ok(warns.every((w) => w.obj.err instanceof Error));
    assert.equal(s.settled, false, "the promise neither rejects nor resolves");
  });
});

// @spec BUS-NAT-CONN-002
test("a failing read of subscribe, tail, tailHealth or tailAudio logs exactly one warn, reports once to onRead, and waits min(cap, base*2^(n-1))", async () => {
  const loops: [string, "readGroup" | "read" | "readFrames", (bus: Bus, onRead: (e?: unknown) => void) => Promise<void>][] = [
    ["subscribe", "readGroup", (bus) => bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {})],
    ["tail", "read", (bus, o) => bus.tail(() => {}, "$", o)],
    ["tailHealth", "read", (bus, o) => bus.tailHealth(() => {}, "$", o)],
    ["tailAudio", "readFrames", (bus, o) => bus.tailAudio("in", "discord", () => {}, o)],
  ];
  for (const [name, method, start] of loops) {
    const fake = new FakeTransport();
    const ok = method === "readGroup" ? empty : () => null;
    fake.on(method, down(), down(), down(), ok, down());
    await withBus(fake, { retryBaseMs: 20, retryMaxMs: 60 }, async ({ bus, l }) => {
      const reports: unknown[] = [];
      void start(bus, (e) => { reports.push(e); });
      await until(() => fake.of(method).length >= 6, `${name}: all scripted reads`);
      const warns = l.at("warn");
      assert.equal(warns.length, 4, `${name}: one warn per failure`);
      assert.deepEqual(warns.map((w) => w.obj.delayMs), [20, 40, 60, 20], name);
      if (name !== "subscribe") {
        assert.equal(reports.filter((r) => r instanceof Error).length, 4, `${name}: one onRead error per failure`);
        assert.equal(reports.filter((r) => r === undefined).length, 1, `${name}: one onRead success`);
      }
      const reads = fake.of(method);
      for (const [i, delay] of [[1, 20], [2, 40], [3, 60]] as const) {
        assert.ok(reads[i]!.at - reads[i - 1]!.at >= delay - 3, `${name}: waited ~${delay} ms before read ${i + 1}`);
      }
    });
  }
});

// @spec BUS-NAT-CONN-003
test("after a failed read and its backoff, subscribe restarts at cursor 0 and drains the pending entries before reading with >", async () => {
  const fake = new FakeTransport().on("readGroup",
    empty, batch("5-0"), down(), batch("3-0", "4-0"), empty, empty);
  await withBus(fake, {}, async ({ bus }) => {
    const handled: string[] = [];
    void sub(bus, (e) => { handled.push(e.id); });
    await until(() => fake.of("readGroup").length >= 7, "the drain and the next read");
    assert.deepEqual(cursors(fake).slice(0, 7), ["0", ">", ">", "0", "4-0", ">", ">"]);
    assert.deepEqual(handled, ["5-0", "3-0", "4-0"]);
    assert.deepEqual(fake.of("readGroup")[3]!.acks, ["5-0"], "acks from before the failure go ahead of the first drain read");
  });
});

// @spec BUS-NAT-ERR-003
test("BUS_CONNECTION, BUS_REDIS and BUS_INTERNAL rejections of a read are read failures: warn, back off, carry on", async () => {
  const fake = new FakeTransport().on("readGroup", down("BUS_CONNECTION"), down("BUS_REDIS"), down("BUS_INTERNAL"), empty);
  const tailFake = new FakeTransport().on("read", down("BUS_CONNECTION"), down("BUS_REDIS"), down("BUS_INTERNAL"), () => null);
  for (const [f, method, start] of [
    [fake, "readGroup", (b: Bus) => sub(b)], [tailFake, "read", (b: Bus) => run(b.tail(() => {}))],
  ] as const) {
    await withBus(f, {}, async ({ bus, l }) => {
      const s = start(bus);
      await until(() => f.of(method).length >= 5, `${method}: reads after three failures`);
      assert.equal(l.at("warn").length, 3, method);
      assert.deepEqual(l.at("warn").map((w) => (w.obj.err as { code: string }).code), ["BUS_CONNECTION", "BUS_REDIS", "BUS_INTERNAL"]);
      assert.equal(s.settled, false);
    });
  }
});

// @spec BUS-NAT-ERR-004, BUS-STOP-001
test("after stop(), a read or the group creation that rejects resolves subscribe, tail, tailHealth and tailAudio without a log line or a rethrow", async () => {
  const fake = new FakeTransport();
  await withBus(fake, {}, async ({ bus, l }) => {
    const loops = [
      sub(bus), run(bus.tail(() => {})), run(bus.tailHealth(() => {})), run(bus.tailAudio("in", "discord", () => {})),
    ];
    await until(() => fake.of("readGroup").length + fake.of("read").length + fake.of("readFrames").length >= 4, "four blocked reads");
    await within(bus.stop(), 1000, "stop");
    await within(Promise.all(loops.map((x) => x.done)), 1000, "loops");
    assert.ok(loops.every((x) => x.settled && x.error === undefined), "all four resolve");
    assert.deepEqual([...l.at("warn"), ...l.at("error")], [], "no log line");
  });
  for (const code of ["BUS_CLOSED", "BUS_CONNECTION"] as const) {
    const f = new FakeTransport();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    f.on("createGroup", async () => { await gate; throw busError(code, "late"); });
    await withBus(f, {}, async ({ bus, l }) => {
      const s = sub(bus);
      await until(() => f.of("createGroup").length === 1, "createGroup in flight");
      const stopping = bus.stop();
      release();
      await within(s.done, 1000, "subscribe");
      await within(stopping, 1000, "stop");
      assert.equal(s.error, undefined, `${code}: not rethrown`);
      assert.deepEqual([...l.at("warn"), ...l.at("error")], [], `${code}: not logged`);
    });
  }
});

// @spec BUS-NAT-ERR-005
test("after the transport closed, publish and publishHealth reject BUS_CLOSED, log it at warn and rethrow it", async () => {
  const { bus, l, fake } = busWith(new FakeTransport());
  await bus.stop();
  const hb = { service: "s", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 1 } as const;
  for (const call of [() => bus.publish("control", { cmd: "mute" }), () => bus.publishHealth(hb)]) {
    await assert.rejects(call(), (e: { code?: string }) => e.code === "BUS_CLOSED");
  }
  const warns = l.at("warn").filter((w) => w.msg === "publish failed");
  assert.equal(warns.length, 2);
  assert.ok(warns.every((w) => (w.obj.err as { code: string }).code === "BUS_CLOSED"));
  assert.equal(fake.closed, true);
});

// @spec BUS-NAT-ERR-007
test("an entry the transport returns with no fields (trimmed, or an invalid-UTF-8 field) is dropped silently: acked in subscribe, skipped in tails and recent", async () => {
  const fake = new FakeTransport();
  fake.on("readGroup", empty, () => groupRead([{ id: "1-0" }, rawEntry("2-0")]));
  fake.on("read", () => [{ id: "1-0" }, rawEntry("2-0")]);
  fake.on("recent", () => [{ id: "1-0" }, rawEntry("2-0")]);
  await withBus(fake, {}, async ({ bus, l }) => {
    const got: string[] = [], tailed: string[] = [];
    void sub(bus, (e) => { got.push(e.id); });
    void bus.tail((e) => { tailed.push(e.id); });
    await until(() => got.length > 0 && tailed.length > 0 && fake.of("ack").length === 2, "both entries handled");
    assert.deepEqual(got, ["2-0"]);
    assert.deepEqual(tailed, ["2-0"]);
    assert.deepEqual((await bus.recent(5)).map((e) => e.id), ["2-0"]);
    assert.deepEqual(fake.of("ack").map((c) => c.args[1]), ["1-0", "2-0"], "the poison entry is acked");
    assert.deepEqual([...l.at("warn"), ...l.at("error")], [], "no log line");
  });
});

// @spec BUS-NAT-ERR-008
test("a repeated Bus.stop() resolves, and not before the first close has completed", async () => {
  const fake = new FakeTransport();
  fake.closeDelayMs = 40;
  const { bus } = busWith(fake);
  const t0 = performance.now();
  const [a, b] = [bus.stop(), bus.stop()];
  const done: number[] = [];
  await Promise.all([a.then(() => done.push(performance.now() - t0)), b.then(() => done.push(performance.now() - t0))]);
  assert.ok(done.every((d) => d >= 35), `both resolved after the close finished: ${done}`);
  await within(bus.stop(), 500, "third stop");
});

// @spec BUS-STOP-001
test("stop() marks the instance stopped, wakes backoff sleeps, closes the transport and returns a Promise<void> that resolves after the close", async () => {
  const fake = new FakeTransport().on("readGroup", down());
  fake.closeDelayMs = 40;
  const { bus, l } = busWith(fake, { retryBaseMs: 10_000, retryMaxMs: 10_000 });
  const s = sub(bus);
  await until(() => l.at("warn").length === 1, "the loop in its backoff sleep");
  const t0 = performance.now();
  const stopping = bus.stop();
  assert.ok(stopping instanceof Promise);
  let resolved = false;
  void stopping.then(() => { resolved = true; });
  await tick(5);
  assert.equal(resolved, false, "not before the transport closed");
  assert.equal(await within(stopping, 1000, "stop"), undefined);
  assert.ok(performance.now() - t0 >= 35);
  await within(s.done, 500, "subscribe woken from its backoff sleep");
  assert.equal(s.error, undefined);
  assert.equal(fake.closed, true);
  assert.ok(fake.of("close").length >= 1);
  assert.equal(l.at("warn").length, 1, "no further log from the woken loop");
});
