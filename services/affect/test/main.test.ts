import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { event, FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { Handler, SubscribeOptions } from "@cohost/bus";
import type { EventType } from "@cohost/bus";
import { main, type AffectBus } from "../src/main.js";

/** A FakeBus that also records the consumer-group calls main() makes, with a gate on group creation. */
class GroupBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeOptions<EventType>[] = [];
  handler?: Handler<EventType>;
  stopped = false;
  gate?: Promise<void>;
  resetError?: Error;
  async resetGroup(group: string): Promise<void> {
    this.calls.push(`resetGroup:${group}`);
    await this.gate;
    if (this.resetError) throw this.resetError;
  }
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    this.calls.push(`subscribe:${opts.group}`);
    this.subscribed.push(opts as SubscribeOptions<EventType>);
    this.handler = handler as unknown as Handler<EventType>;
  }
  stop(): void { this.stopped = true; }
}

function env(bus: GroupBus, over: Record<string, unknown> = {}) {
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  return {
    shutdown, exits,
    env: {
      loadConfig: () => testConfig(over),
      createBus: () => bus as unknown as AffectBus,
      onShutdown: (fn: () => void | Promise<void>) => { shutdown.push(fn); },
      exit: (code: number) => { exits.push(code); },
    },
  };
}
const states = (bus: GroupBus) => bus.health.map((h) => h.state);

test("main: subscribes in start mode latest and signals ready only after the consumer group exists", async () => { // @spec AFF-IN-001, AFF-HEALTH-001
  const bus = new GroupBus();
  let open!: () => void;
  bus.gate = new Promise<void>((r) => (open = r));
  const { env: e, shutdown } = env(bus);
  const { log } = recordingLog();
  const started = main(log, e);
  await waitFor(() => bus.calls.includes("resetGroup:affect"), "group creation");
  await waitFor(() => states(bus).includes("starting"), "starting heartbeat");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(states(bus), ["starting"], "not ready while the group is still being created");
  open();
  await started;
  await waitFor(() => states(bus).includes("ready"), "ready heartbeat");
  assert.deepEqual(bus.calls, ["resetGroup:affect", "subscribe:affect"]);
  assert.deepEqual(bus.subscribed[0], {
    group: "affect",
    types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "control"],
    start: "latest",
  });
  for (const fn of shutdown) await fn();
});

test("main: the publish timer runs at publish_ms and shutdown stops it and the bus", async () => { // @spec AFF-PUB-001
  mock.timers.enable({ apis: ["setInterval"] });
  const bus = new GroupBus();
  const { env: e, shutdown } = env(bus, { brain: { affect: { publish_ms: 2000 } } });
  try {
    await main(recordingLog().log, e);
    mock.timers.tick(1999);
    await new Promise((r) => setImmediate(r));
    assert.equal(bus.of("affect.state").length, 0, "not before publish_ms");
    mock.timers.tick(1);
    await waitFor(() => bus.of("affect.state").length === 1, "affect.state from the timer");
    await bus.handler!(event("chat.message", { platform: "twitch", user: "bob", text: "lol nice", isMod: false, isSub: false, mentionsCohost: false }));
    for (const fn of shutdown) await fn();
    assert.ok(bus.stopped, "the bus is stopped on shutdown");
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(bus.of("affect.state").length, 1, "no publish after shutdown");
  } finally { mock.timers.reset(); }
});

test("main: any startup failure logs fatal and exits 1", async () => { // @spec AFF-HEALTH-002
  const cases: [string, (bus: GroupBus) => ReturnType<typeof env>][] = [
    ["config", (bus) => { const x = env(bus); x.env.loadConfig = () => { throw new Error("bad config"); }; return x; }],
    ["bus", (bus) => { const x = env(bus); x.env.createBus = () => { throw new Error("no redis url"); }; return x; }],
    ["scorer", (bus) => env(bus, { brain: { affect: { module: { kind: "http", url: "" } } } })],
    ["subscription", (bus) => { bus.resetError = new Error("NOAUTH"); return env(bus); }],
  ];
  for (const [name, build] of cases) {
    const bus = new GroupBus();
    const x = build(bus);
    const { log, lines } = recordingLog();
    await main(log, x.env);
    assert.deepEqual(x.exits, [1], `${name}: exit code`);
    const fatal = lines.filter((l) => l.level === "error" && l.msg === "fatal");
    assert.equal(fatal.length, 1, `${name}: one fatal log`);
    assert.ok((fatal[0]!.obj as { err?: unknown }).err instanceof Error, `${name}: the error is logged`);
    assert.ok(!states(bus).includes("ready"), `${name}: never reported ready`);
  }
});

test("main: the heartbeat reports mode mock and a hook dependency when the appraiser hook inherits the mock provider", async () => { // @spec HOOK-HEALTH-004, HOOK-HEALTH-005
  const bus = new GroupBus();
  const { env: e, shutdown } = env(bus, { llm: { provider: "mock" }, brain: { affect: { module: { kind: "llm" } } } });
  await main(recordingLog().log, e);
  await waitFor(() => states(bus).includes("ready"), "ready heartbeat");
  const ready = bus.health.find((h) => h.state === "ready")!;
  assert.equal(ready.mode, "mock");
  assert.ok("hook.affect.appraiser" in (ready.deps ?? {}));
  for (const fn of shutdown) await fn();
});
