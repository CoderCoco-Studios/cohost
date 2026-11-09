import { test } from "node:test";
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runVoice, type VoiceBus, type VoiceBoot } from "../src/boot.js";

type SubscribeCall = { opts: Record<string, unknown>; handler: (ev: never) => unknown };

/** A FakeBus plus the two group calls boot makes; each can be held open or made to fail. */
class BootBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeCall[] = [];
  stopped = false;
  resetGate?: Promise<void>;
  resetError?: Error;
  subscribeError?: Error;
  async resetGroup(group: string): Promise<void> {
    this.calls.push(`resetGroup:${group}`);
    await this.resetGate;
    if (this.resetError) throw this.resetError;
  }
  subscribe = (async (opts: SubscribeCall["opts"], handler: SubscribeCall["handler"]) => {
    this.calls.push("subscribe");
    this.subscribed.push({ opts, handler });
    if (this.subscribeError) throw this.subscribeError;
    await new Promise(() => {}); // like the real loop: runs until stop()
  }) as unknown as VoiceBus["subscribe"];
  stop(): void { this.stopped = true; }
}

function boot(over: { bus?: BootBus; engine?: "kokoro" | "stub"; port?: number } = {}) {
  const bus = over.bus ?? new BootBus();
  const rec = recordingLog();
  const exits: number[] = [];
  const shutdown: (() => void | Promise<void>)[] = [];
  const b: VoiceBoot = {
    log: rec.log,
    setup: () => ({ cfg: testConfig({ voice: { engine: over.engine ?? "stub" } }), bus, port: over.port ?? 0, publicUrl: "http://voice:8700" }),
    onShutdown: (fn) => { shutdown.push(fn); },
    exit: (code) => { exits.push(code); },
  };
  return { b, bus, rec, exits, shutdown, close: async () => { for (const fn of shutdown) await fn(); } };
}

const states = (bus: FakeBus) => bus.health.map((h) => h.state);

// @spec VOICE-SYN-001, VOICE-SINK-010
test("subscribes in group voice with start mode latest to brain.say, voice.playing and voice.failed, and handles them one at a time", async () => {
  const t = boot();
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.deepEqual(t.bus.calls, ["resetGroup:voice", "subscribe"]); // the group is at the newest entry before the loop reads
  const { opts } = t.bus.subscribed[0]!;
  assert.equal(opts.group, "voice");
  assert.equal(opts.start, "latest");
  assert.deepEqual(opts.types, ["brain.say", "voice.playing", "voice.failed"]);
  assert.equal("fromNow" in opts, false);
  await t.close();
});

// @spec VOICE-HLTH-001, VOICE-HTTP-005
test("ready only once the HTTP server listens and the consumer group is positioned", async () => {
  const bus = new BootBus();
  let release!: () => void;
  bus.resetGate = new Promise<void>((r) => { release = r; });
  const t = boot({ bus });
  void runVoice(t.b);
  await waitFor(() => bus.calls.includes("resetGroup:voice"), "group positioning started");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(states(bus), ["starting"]); // listening, but the group does not exist yet
  assert.equal(bus.subscribed.length, 0);
  release();
  await waitFor(() => states(bus).includes("ready"), "ready");
  assert.deepEqual(states(bus), ["starting", "ready"]);
  assert.equal(bus.health[1]!.service, "voice");
  assert.equal(bus.health[1]!.mode, "mock"); // engine stub
  await t.close();
});

// @spec VOICE-HTTP-005
test("listens on the configured port and answers /health", async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const t = boot({ port });
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "ok");
  await t.close();
});

// @spec VOICE-SYN-006
test("a rejecting subscription logs fatal and exits 1", async () => {
  const bus = new BootBus();
  bus.subscribeError = new Error("NOGROUP consumer group deleted");
  const t = boot({ bus });
  await runVoice(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
  await t.close();
});

// @spec VOICE-SYN-006
test("a setup failure (config load, group positioning) logs fatal and exits 1", async () => {
  const bad = boot();
  bad.b.setup = () => { throw new Error("config invalid"); };
  await runVoice(bad.b);
  assert.deepEqual(bad.exits, [1]);
  assert.ok(bad.rec.msgs("error").includes("fatal"));

  const bus = new BootBus();
  bus.resetError = new Error("redis down");
  const t = boot({ bus });
  await runVoice(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.deepEqual(states(bus), ["starting"]); // never reported ready
  await t.close();
});

// @spec VOICE-HLTH-004
test("shutdown closes the HTTP server and stops the bus", async () => {
  const t = boot();
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await t.close();
  assert.equal(t.bus.stopped, true);
});

// @spec VOICE-STUB-003
test("the stub engine logs a startup warning that utterances are silent", async () => {
  const t = boot({ engine: "stub" });
  void runVoice(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.ok(t.rec.msgs("warn").some((m) => /stub/.test(String(m))));
  await t.close();
});
