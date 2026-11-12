import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { Handler, SubscribeOptions, EventType } from "@cohost/bus";
import { runMemory, type MemoryBus } from "../src/main.js";

/** A FakeBus whose subscriptions report their group ready and stay open until stop(). */
class GroupBus extends FakeBus {
  subscribed: SubscribeOptions<EventType>[] = [];
  stopped = false;
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, _handler: Handler<T>): Promise<void> {
    this.subscribed.push(opts as SubscribeOptions<EventType>);
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
test("shutdown stops the bus and closes the store", async () => {
  const bus = new GroupBus();
  const { env: e, shutdown } = env(bus);
  await runMemory({ ...e, log: recordingLog().log });
  assert.equal(bus.stopped, false);
  for (const fn of shutdown) await fn();
  assert.equal(bus.stopped, true);
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
