import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { event, FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { Handler, SubscribeOptions, EventType } from "@cohost/bus";
import { runMemory, type MemoryBus } from "../src/main.js";
import { InMemoryStore } from "../src/fake-store.js";

/** A FakeBus whose subscriptions report their group ready and stay open until stop(). */
class GroupBus extends FakeBus {
  subscribed: SubscribeOptions<EventType>[] = [];
  /** The handler each consumer group was subscribed with, by group name. */
  handlers = new Map<string, Handler<EventType>>();
  stopped = false;
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    this.subscribed.push(opts as SubscribeOptions<EventType>);
    this.handlers.set(opts.group, handler as Handler<EventType>);
    queueMicrotask(() => opts.onReady?.());
    return new Promise<void>(() => {});
  }
  stop(): void { this.stopped = true; }
}

const MOCK = { brain: { memory: { store: "memory", embedder: "hash" } } };

function env(bus: GroupBus, over: Record<string, unknown> = MOCK) {
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  return {
    shutdown, exits,
    env: {
      loadConfig: () => testConfig(over),
      createBus: () => bus as unknown as MemoryBus,
      onShutdown: (fn: () => void | Promise<void>) => { shutdown.push(fn); },
      exit: (code: number) => { exits.push(code); },
      sleep: async () => {},
    },
  };
}

// @spec MOD-MAN-009, MEM-START-005
test("runMemory starts the heartbeat, subscribes its three groups and reports ready on the shared bootstrap", async () => {
  const bus = new GroupBus();
  const { env: e, shutdown, exits } = env(bus);
  const { log } = recordingLog();
  await runMemory({ ...e, log });
  assert.deepEqual(bus.subscribed.map((s) => s.group), ["memory", "memory-recall", "memory-notes"]);
  await waitFor(() => bus.health.some((h) => h.state === "ready"), "ready heartbeat");
  assert.equal(bus.health[0]!.state, "starting");
  assert.deepEqual(exits, []);
  for (const fn of shutdown) await fn();
});

// @spec MEM-START-006, MEM-CONSOL-013
test("shutdown stops the bus and then closes the store", async () => {
  const bus = new GroupBus();
  const order: string[] = [];
  bus.stop = () => { bus.stopped = true; order.push("bus.stop"); };
  const closeStore = mock.method(InMemoryStore.prototype, "close", async () => { order.push("store.close"); });
  try {
    const { env: e, shutdown } = env(bus);
    await runMemory({ ...e, log: recordingLog().log });
    assert.equal(bus.stopped, false);
    assert.equal(closeStore.mock.callCount(), 0);
    for (const fn of shutdown) await fn();
    assert.equal(bus.stopped, true);
    assert.equal(order.filter((x) => x === "store.close").length, 1);
    assert.ok(order.indexOf("bus.stop") < order.indexOf("store.close"), `the bus stops before the store closes: ${order.join(", ")}`);
  } finally { closeStore.mock.restore(); }
});

// @spec MEM-WRITE-016, MEM-START-006
test("shutdown stops the bus, writes the open streamed line, then closes the store", async () => {
  const bus = new GroupBus();
  const order: string[] = [];
  bus.stop = () => { bus.stopped = true; order.push("bus.stop"); };
  const remember = mock.method(InMemoryStore.prototype, "remember", async (...args: unknown[]) => { order.push(`store.remember ${JSON.stringify(args.slice(0, 3))}`); });
  const closeStore = mock.method(InMemoryStore.prototype, "close", async () => { order.push("store.close"); });
  try {
    const { env: e, shutdown } = env(bus);
    await runMemory({ ...e, log: recordingLog().log });
    const onMemory = bus.handlers.get("memory")!;
    await onMemory(event("brain.say", { id: "open", text: "Still talking.", emotion: "happy", more: true }));
    await onMemory(event("brain.clause", { id: "open", seq: 1, text: "Mid-line." }));
    assert.equal(remember.mock.callCount(), 0, "an open line is not written before shutdown");
    for (const fn of shutdown) await fn();
    const written = order.filter((x) => x.startsWith("store.remember"));
    assert.deepEqual(written, [`store.remember ${JSON.stringify(["self", "Coco", "Still talking. Mid-line."])}`]);
    assert.ok(order.indexOf("bus.stop") < order.indexOf(written[0]!), `the bus stops before the open line is written: ${order.join(", ")}`);
    assert.ok(order.indexOf(written[0]!) < order.indexOf("store.close"), `the open line is written before the store closes: ${order.join(", ")}`);
  } finally { remember.mock.restore(); closeStore.mock.restore(); }
});

// @spec MEM-START-006
test("a startup failure logs fatal and exits 1", async () => {
  const bus = new GroupBus();
  bus.subscribe = (async () => { throw new Error("redis down"); }) as never;
  const { env: e, exits } = env(bus);
  const { log, msgs } = recordingLog();
  await runMemory({ ...e, log });
  assert.deepEqual(exits, [1]);
  assert.ok(msgs("error").includes("fatal"));
});

// @spec MEM-HEALTH-008
test("the heartbeat carries a hook dependency per llm hook, and none for a rules hook", async () => {
  const bus = new GroupBus();
  const { env: e, shutdown } = env(bus, { brain: { memory: { store: "memory", embedder: "hash", notes: { capture: { kind: "llm" }, consolidator: { kind: "rules" } } } } });
  await runMemory({ ...e, log: recordingLog().log });
  await waitFor(() => bus.health.some((h) => h.state === "ready"), "ready heartbeat");
  const ready = bus.health.find((h) => h.state === "ready")!;
  assert.ok("hook.memory.capture" in (ready.deps ?? {}));
  assert.ok(!("hook.memory.consolidator" in (ready.deps ?? {})));
  assert.equal(ready.mode, "mock");
  for (const fn of shutdown) await fn();
});

// @spec MEM-HEALTH-009
test("both llm hooks are pinged once at startup, and each one that does not answer is warned about", async () => {
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = "http://127.0.0.1:1"; // nothing listens: the notes hooks run on local ollama
  try {
    const bus = new GroupBus();
    const { env: e, shutdown } = env(bus, { llm: { provider: "ollama" }, brain: { memory: { store: "memory", embedder: "hash", notes: { capture: { kind: "llm" }, consolidator: { kind: "llm" } } } } });
    const { log, lines } = recordingLog();
    await runMemory({ ...e, log });
    await waitFor(() => lines.filter((l) => l.level === "warn" && /hook provider unreachable/.test(l.msg ?? "")).length === 2, "one warning per hook");
    const named = lines.filter((l) => /hook provider unreachable/.test(l.msg ?? "")).map((l) => (l.obj as { module: string }).module).sort();
    assert.deepEqual(named, ["memory.capture", "memory.consolidator"]);
    for (const fn of shutdown) await fn();
  } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
});
