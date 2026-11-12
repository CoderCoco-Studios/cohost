import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { EventType, Handler, SubscribeOptions } from "@cohost/bus";
import { runCortex, type CortexBus } from "../src/main.js";

/** A bus on which no other unit exists: no salience, no affect and no memory answers anything. */
class AloneBus extends FakeBus {
  handler?: Handler<EventType>;
  stopped = false;
  async resetGroup(): Promise<void> {}
  async subscribe<T extends EventType>(_opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> { this.handler = handler as unknown as Handler<EventType>; }
  stop(): void { this.stopped = true; }
}

// @spec MOD-LIFE-003
test("cortex, which uses salience, affect and memory, starts, turns ready and keeps publishing heartbeats while none of them exists", async () => {
  const prev = process.env.HEARTBEAT_INTERVAL_MS;
  process.env.HEARTBEAT_INTERVAL_MS = "20";
  const bus = new AloneBus();
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  try {
    await runCortex({
      loadConfig: () => testConfig({ llm: { provider: "mock" }, brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 50 } } }),
      createBus: () => bus as unknown as CortexBus, loadPersonality: () => "You are Coco.", log: recordingLog().log,
      onShutdown: (fn) => { shutdown.push(fn); }, exit: (c) => { exits.push(c); },
    });
    await waitFor(() => bus.health.filter((h) => h.state === "ready").length >= 3, "three ready heartbeats with no peer running");
    assert.deepEqual(exits, []);
    assert.ok(bus.health.every((h) => h.state !== "stopping"), "no peer's absence stops it");
    assert.equal(bus.stopped, false);
  } finally {
    for (const fn of shutdown) await fn();
    if (prev === undefined) delete process.env.HEARTBEAT_INTERVAL_MS; else process.env.HEARTBEAT_INTERVAL_MS = prev;
  }
});
