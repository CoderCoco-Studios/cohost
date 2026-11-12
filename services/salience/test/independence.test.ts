import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { EventType, Handler, SubscribeOptions } from "@cohost/bus";
import { runSalience, type SalienceBus } from "../src/main.js";

/** A bus on which no other unit exists: nothing consumes or answers anything the service publishes. */
class AloneBus extends FakeBus {
  handler?: Handler<EventType>;
  stopped = false;
  async resetGroup(): Promise<void> {}
  async subscribe<T extends EventType>(_opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> { this.handler = handler as unknown as Handler<EventType>; }
  stop(): void { this.stopped = true; }
}

// @spec MOD-LIFE-003
test("salience, which uses affect and cortex, starts, turns ready and keeps publishing heartbeats while neither of them exists", async () => {
  const prev = process.env.HEARTBEAT_INTERVAL_MS;
  process.env.HEARTBEAT_INTERVAL_MS = "20";
  const bus = new AloneBus();
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  try {
    await runSalience({
      loadConfig: () => testConfig(), createBus: () => bus as unknown as SalienceBus, log: recordingLog().log,
      onShutdown: (fn) => { shutdown.push(fn); }, exit: (c) => { exits.push(c); },
    });
    await waitFor(() => bus.health.filter((h) => h.state === "ready").length >= 3, "three ready heartbeats with no peer running");
    assert.deepEqual(exits, []);
    assert.ok(bus.health.every((h) => h.state !== "stopping" && h.state !== "degraded"), "no peer's absence degrades or stops it");
    assert.equal(bus.stopped, false);
  } finally {
    for (const fn of shutdown) await fn();
    if (prev === undefined) delete process.env.HEARTBEAT_INTERVAL_MS; else process.env.HEARTBEAT_INTERVAL_MS = prev;
  }
});
