// Bus behaviour against fake Redis connections: no Redis server required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, STREAM, HEALTH_STREAM, type BusEvent } from "../src/index.js";

type Call = [method: string, ...args: unknown[]];
type Fn = (...args: any[]) => Promise<unknown>;

/** Scripted stand-in for an ioredis connection. Unscripted blocking reads hang until disconnect(). */
class FakeRedis {
  calls: Call[] = [];
  script: Partial<Record<"xadd" | "xgroup" | "xreadgroup" | "xack" | "xread", Fn[]>> = {};
  private waiters: ((e: Error) => void)[] = [];
  private next(method: keyof FakeRedis["script"], args: unknown[]): Promise<unknown> {
    this.calls.push([method, ...args]);
    const fn = this.script[method]?.shift();
    if (fn) return fn(...args);
    if (method === "xreadgroup" || method === "xread") {
      return new Promise((_, reject) => this.waiters.push(reject));
    }
    return Promise.resolve(method === "xadd" ? "1-0" : "OK");
  }
  xadd(...a: unknown[]) { return this.next("xadd", a); }
  xgroup(...a: unknown[]) { return this.next("xgroup", a); }
  xreadgroup(...a: unknown[]) { return this.next("xreadgroup", a); }
  xack(...a: unknown[]) { return this.next("xack", a); }
  xread(...a: unknown[]) { return this.next("xread", a); }
  disconnect() { for (const w of this.waiters.splice(0)) w(new Error("Connection is closed.")); }
  of(method: string) { return this.calls.filter((c) => c[0] === method); }
}

function logger() {
  const lines: { level: string; obj: any; msg?: string }[] = [];
  const mk = (level: string) => (obj: any, msg?: string) => { lines.push({ level, obj, msg }); };
  const log = { warn: mk("warn"), error: mk("error"), info: mk("info"), debug: mk("debug"), fatal: mk("fatal"), trace: mk("trace") };
  return { log: log as never, lines, at: (level: string) => lines.filter((l) => l.level === level) };
}

function busWith(fake: FakeRedis, opts: Record<string, unknown> = {}) {
  const l = logger();
  const bus = new Bus("t", l.log, "redis://fake", { connect: () => fake as never, retryBaseMs: 5, retryMaxMs: 30, ...opts });
  return { bus, l };
}
const busyGroup = async () => { throw new Error("BUSYGROUP Consumer Group name already exists"); };

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await tick(2); }
}
const entry = (id: string, type = "control", data: object = { cmd: "mute" }): [string, [string, string[]][]][] =>
  [[STREAM, [[id, ["type", type, "ts", "1", "source", "t", "data", JSON.stringify(data)]]]]];

// @spec BUS-SUB-001, BUS-SUB-010
test("latest: a missing group is created at $ with MKSTREAM before the first read", async () => {
  const fake = new FakeRedis();
  const { bus } = busWith(fake);
  const done = bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
  await until(() => fake.of("xreadgroup").length > 0);
  assert.deepEqual(fake.calls[0], ["xgroup", "CREATE", STREAM, "g", "$", "MKSTREAM"]);
  assert.equal(fake.of("xgroup").length, 1);
  bus.stop(); await done;
});

// @spec BUS-SUB-010
test("latest: an existing group (BUSYGROUP) is moved to $ before the first read", async () => {
  const fake = new FakeRedis();
  fake.script.xgroup = [busyGroup];
  const { bus } = busWith(fake);
  const done = bus.subscribe({ group: "g", start: "latest", blockMs: 10 }, () => {});
  await until(() => fake.of("xreadgroup").length > 0);
  assert.deepEqual(fake.calls.slice(0, 2), [
    ["xgroup", "CREATE", STREAM, "g", "$", "MKSTREAM"],
    ["xgroup", "SETID", STREAM, "g", "$"],
  ]);
  bus.stop(); await done;
});

// @spec BUS-SUB-002
test("resume: an existing group keeps its stored position (no SETID)", async () => {
  const fake = new FakeRedis();
  fake.script.xgroup = [busyGroup];
  const { bus } = busWith(fake);
  const done = bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {});
  await until(() => fake.of("xreadgroup").length > 0);
  assert.deepEqual(fake.of("xgroup"), [["xgroup", "CREATE", STREAM, "g", "$", "MKSTREAM"]]);
  bus.stop(); await done;
});

// @spec BUS-SUB-001
test("any group-creation error other than BUSYGROUP rejects subscribe", async () => {
  const fake = new FakeRedis();
  fake.script.xgroup = [async () => { throw new Error("READONLY You can't write against a read only replica."); }];
  const { bus } = busWith(fake);
  await assert.rejects(bus.subscribe({ group: "g", start: "resume" }, () => {}), /READONLY/);
  assert.equal(fake.of("xreadgroup").length, 0);
});

// @spec BUS-SUB-011
test("subscribe requires an explicit start mode and ignores the removed fromNow", async () => {
  for (const extra of [{}, { fromNow: true }, { start: "bogus" }]) {
    const fake = new FakeRedis();
    const { bus } = busWith(fake);
    await assert.rejects(bus.subscribe({ group: "g", blockMs: 10, ...extra } as never, () => {}), /start/);
    assert.equal(fake.of("xgroup").length, 0);
    assert.equal(fake.of("xreadgroup").length, 0);
  }
});

// @spec BUS-SUB-008
test("subscribe only reads its own consumer's pending list and never claims", async () => {
  const fake = new FakeRedis();
  const { bus } = busWith(fake);
  const done = bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {});
  await until(() => fake.of("xreadgroup").length > 0);
  const [, ...args] = fake.of("xreadgroup")[0]!;
  assert.equal(args[0], "GROUP"); assert.equal(args[2], bus.consumer);
  assert.equal(args.at(-1), "0");
  assert.ok(fake.calls.every((c) => ["xgroup", "xreadgroup", "xack"].includes(c[0])));
  bus.stop(); await done;
});

// @spec BUS-SUB-009
test("a failed blocking read is logged and retried with a growing, capped delay that resets after a success", async () => {
  const fake = new FakeRedis();
  const boom = async () => { throw new Error("ECONNRESET"); };
  fake.script.xreadgroup = [boom, boom, boom, boom, async () => null, boom, async () => entry("5-0")];
  const { bus, l } = busWith(fake, { retryBaseMs: 2, retryMaxMs: 7 });
  const got: BusEvent[] = [];
  const done = bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, (ev) => { got.push(ev); });
  await until(() => got.length === 1);
  assert.deepEqual(l.at("warn").map((w) => w.obj.delayMs), [2, 4, 7, 7, 2]);
  assert.match(String(l.at("warn")[0]!.obj.err), /ECONNRESET/);
  bus.stop(); await done; // resolves, never rejected
});

// @spec BUS-SUB-009
test("a failed XACK is logged, the next entry is handled, and the handled entry is not redelivered", async () => {
  const fake = new FakeRedis();
  fake.script.xreadgroup = [
    async () => null, // pending drain: nothing
    async () => [[STREAM, [
      ["1-0", ["type", "control", "ts", "1", "source", "t", "data", JSON.stringify({ cmd: "mute" })]],
      ["2-0", ["type", "control", "ts", "1", "source", "t", "data", JSON.stringify({ cmd: "pause" })]],
    ]]],
  ];
  fake.script.xack = [async () => { throw new Error("ACK down"); }];
  const { bus, l } = busWith(fake);
  const got: string[] = [];
  const done = bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, (ev) => { got.push(ev.id); });
  await until(() => got.length === 2);
  await until(() => fake.of("xack").length === 2);
  assert.deepEqual(got, ["1-0", "2-0"]);
  assert.equal(l.at("warn").length, 1);
  assert.match(String(l.at("warn")[0]!.obj.err), /ACK down/);
  await tick(30);
  assert.deepEqual(got, ["1-0", "2-0"]);
  bus.stop(); await done;
});

// @spec BUS-SUB-009, BUS-STOP-001
test("stop() ends a retry backoff promptly", async () => {
  const fake = new FakeRedis();
  fake.script.xreadgroup = [async () => { throw new Error("down"); }];
  const { bus, l } = busWith(fake, { retryBaseMs: 60_000, retryMaxMs: 60_000 });
  const done = bus.subscribe({ group: "g", start: "resume", blockMs: 10 }, () => {});
  await until(() => l.at("warn").length === 1);
  const t0 = Date.now();
  bus.stop();
  await done;
  assert.ok(Date.now() - t0 < 500);
});

// @spec BUS-TAIL-003
test("tail retries a failed read from the last delivered id and never rejects", async () => {
  const fake = new FakeRedis();
  fake.script.xread = [async () => entry("7-0"), async () => { throw new Error("ECONNRESET"); }];
  const { bus, l } = busWith(fake);
  const got: string[] = [];
  const done = bus.tail((ev) => { got.push(ev.id); });
  await until(() => fake.of("xread").length >= 3);
  assert.deepEqual(got, ["7-0"]);
  assert.equal(fake.of("xread")[2]!.at(-1), "7-0");
  assert.equal(l.at("warn").length, 1);
  bus.stop(); await done;
});

// @spec BUS-TAIL-003
test("tailHealth retries a failed read from the last delivered id and never rejects", async () => {
  const fake = new FakeRedis();
  const hb = { service: "s", instance: "i", version: "1", pid: 1, startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 1000 };
  fake.script.xread = [
    async () => [[HEALTH_STREAM, [["9-0", ["type", "service.heartbeat", "ts", "1", "source", "s", "data", JSON.stringify(hb)]]]]],
    async () => { throw new Error("ECONNRESET"); },
  ];
  const { bus, l } = busWith(fake);
  const got: string[] = [];
  const done = bus.tailHealth((ev) => { got.push(ev.id); });
  await until(() => fake.of("xread").length >= 3);
  assert.deepEqual(got, ["9-0"]);
  assert.equal(fake.of("xread")[2]!.at(-1), "9-0");
  assert.equal(l.at("warn").length, 1);
  bus.stop(); await done;
});

// @spec BUS-TAIL-004
test("a throwing tail handler is logged at error level and the loop continues", async () => {
  const fake = new FakeRedis();
  fake.script.xread = [async () => [[STREAM, [
    ["1-0", ["type", "control", "ts", "1", "source", "t", "data", JSON.stringify({ cmd: "mute" })]],
    ["2-0", ["type", "control", "ts", "1", "source", "t", "data", JSON.stringify({ cmd: "pause" })]],
  ]]]];
  const { bus, l } = busWith(fake);
  const got: string[] = [];
  const done = bus.tail((ev) => { got.push(ev.id); if (ev.id === "1-0") throw new Error("handler boom"); });
  await until(() => got.length === 2);
  assert.equal(l.at("error").length, 1);
  assert.match(String(l.at("error")[0]!.obj.err), /handler boom/);
  assert.ok(fake.of("xread").length >= 2);
  bus.stop(); await done;
});

// @spec BUS-TAIL-004
test("a throwing tailHealth handler is logged and the loop continues", async () => {
  const fake = new FakeRedis();
  const hb = { service: "s", instance: "i", version: "1", pid: 1, startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 1000 };
  const row = (id: string): [string, string[]] => [id, ["type", "service.heartbeat", "ts", "1", "source", "s", "data", JSON.stringify(hb)]];
  fake.script.xread = [async () => [[HEALTH_STREAM, [row("1-0"), row("2-0")]]]];
  const { bus, l } = busWith(fake);
  const got: string[] = [];
  const done = bus.tailHealth((ev) => { got.push(ev.id); throw new Error("hb boom"); });
  await until(() => got.length === 2);
  assert.equal(l.at("error").length, 2);
  bus.stop(); await done;
});

// @spec BUS-STREAM-007
test("a rejected XADD is logged at warn with the type and the original error is propagated", async () => {
  const fake = new FakeRedis();
  const err = new Error("Stream isn't writeable");
  fake.script.xadd = [async () => { throw err; }, async () => { throw err; }];
  const { bus, l } = busWith(fake);
  await assert.rejects(bus.publish("control", { cmd: "mute" }), (e) => e === err);
  await assert.rejects(bus.publishHealth({ service: "s", instance: "i", version: "1", pid: 1, startedAt: 1, state: "ready", deps: {}, mode: "live", intervalMs: 1000 }), (e) => e === err);
  const w = l.at("warn");
  assert.equal(w.length, 2);
  assert.equal(w[0]!.obj.err, err); assert.equal(w[0]!.obj.type, "control");
  assert.equal(w[0]!.msg, "publish failed");
  assert.equal(w[1]!.obj.type, "service.heartbeat");
  bus.stop();
});

// @spec BUS-STREAM-003
test("a schema failure throws before XADD and is not logged as a publish failure", async () => {
  const fake = new FakeRedis();
  const { bus, l } = busWith(fake);
  await assert.rejects(bus.publish("control", { cmd: "nope" } as never));
  assert.equal(fake.of("xadd").length, 0);
  assert.equal(l.at("warn").length, 0);
  bus.stop();
});

// ---- resetGroup on a fresh Redis ----

/** Real text Redis 7+ returns for XGROUP SETID/DESTROY/... on a key that does not exist. */
const NO_KEY =
  "ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.";

/** Minimal stateful XGROUP matching Redis 7: only CREATE ... MKSTREAM may touch a missing stream. */
function redis7Xgroup(fake: FakeRedis, state: { stream: boolean; groups: Set<string> }) {
  fake.xgroup = (...a: unknown[]) => {
    fake.calls.push(["xgroup", ...a]);
    const [sub, , group, , mk] = a as string[];
    if (sub === "CREATE") {
      if (!state.stream && mk !== "MKSTREAM") return Promise.reject(new Error(NO_KEY));
      state.stream = true;
      if (state.groups.has(group!)) return Promise.reject(new Error("BUSYGROUP Consumer Group name already exists"));
      state.groups.add(group!);
      return Promise.resolve("OK");
    }
    if (!state.stream) return Promise.reject(new Error(NO_KEY));
    if (!state.groups.has(group!)) return Promise.reject(new Error("NOGROUP No such consumer group for key name"));
    return Promise.resolve("OK");
  };
}

// @spec BUS-GROUP-001
test("resetGroup on a fresh Redis (no stream key) creates the stream and group instead of failing", async () => {
  const fake = new FakeRedis();
  const state = { stream: false, groups: new Set<string>() };
  redis7Xgroup(fake, state);
  const { bus } = busWith(fake);
  await bus.resetGroup("g");
  assert.equal(state.stream, true);
  assert.ok(state.groups.has("g"));
  assert.ok(fake.of("xgroup").some((c) => c[1] === "CREATE" && c.includes("MKSTREAM")));
  bus.stop();
});

// @spec BUS-GROUP-001
test("resetGroup on an existing group moves it to $ with SETID", async () => {
  const fake = new FakeRedis();
  redis7Xgroup(fake, { stream: true, groups: new Set(["g"]) });
  const { bus } = busWith(fake);
  await bus.resetGroup("g");
  assert.deepEqual(fake.of("xgroup").at(-1), ["xgroup", "SETID", STREAM, "g", "$"]);
  bus.stop();
});

// @spec BUS-GROUP-001
test("resetGroup tolerates a concurrent create (BUSYGROUP) and still ends at $", async () => {
  const fake = new FakeRedis();
  const state = { stream: false, groups: new Set<string>() };
  redis7Xgroup(fake, state);
  const inner = fake.xgroup.bind(fake);
  let raced = false;
  // A competing process creates the group between our calls.
  fake.xgroup = (...a: unknown[]) => {
    if (!raced) { raced = true; state.stream = true; state.groups.add("g"); }
    return inner(...a);
  };
  const { bus } = busWith(fake);
  await bus.resetGroup("g");
  assert.deepEqual(fake.of("xgroup").at(-1), ["xgroup", "SETID", STREAM, "g", "$"]);
  bus.stop();
});

// @spec BUS-GROUP-001
test("resetGroup rethrows an error that is not a missing stream or group", async () => {
  const fake = new FakeRedis();
  fake.xgroup = (...a: unknown[]) => {
    fake.calls.push(["xgroup", ...a]);
    return Promise.reject(new Error("READONLY You can't write against a read only replica."));
  };
  const { bus } = busWith(fake);
  await assert.rejects(bus.resetGroup("g"), /READONLY/);
  bus.stop();
});

// @spec BUS-SUB-012, MEM-START-005
test("onReady fires after the group is created and positioned, before the first read", async () => {
  const fake = new FakeRedis();
  fake.script.xgroup = [busyGroup];
  const { bus } = busWith(fake);
  let callsAtReady: string[] = [];
  const done = bus.subscribe({ group: "g", start: "latest", blockMs: 10, onReady: () => { callsAtReady = fake.calls.map((c) => c[0] as string); } }, () => {});
  await until(() => fake.of("xreadgroup").length > 0);
  assert.deepEqual(callsAtReady, ["xgroup", "xgroup"]);
  bus.stop(); await done;
});
