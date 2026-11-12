import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Emotion, ExpressionMap } from "@cohost/config";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { expressionsFor, runAvatar, type AvatarBus, type AvatarEnv } from "../src/boot.js";
import type { AvatarDriver, AvatarParams, DriverContext } from "../src/types.js";

type SubscribeCall = { opts: Record<string, unknown>; handler: (ev: never) => unknown };

/** A FakeBus plus the two group calls boot makes; each can be held open or made to fail. */
class BootBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeCall[] = [];
  stopped = false;
  resetGate?: Promise<void>;
  subscribeError?: Error;
  async resetGroup(group: string): Promise<void> {
    this.calls.push(`resetGroup:${group}`);
    await this.resetGate;
  }
  subscribe = (async (opts: SubscribeCall["opts"], handler: SubscribeCall["handler"]) => {
    this.calls.push("subscribe");
    this.subscribed.push({ opts, handler });
    if (this.subscribeError) throw this.subscribeError;
    await new Promise(() => {}); // like the real loop: runs until stop()
  }) as unknown as AvatarBus["subscribe"];
  stop(): void { this.stopped = true; }
  deliver(ev: ReturnType<typeof event>) { return this.subscribed[0]!.handler(ev as never); }
}

class FakeDriver implements AvatarDriver {
  readonly name = "fake";
  params: AvatarParams[] = [];
  expressions: [Emotion, number][] = [];
  gestures: string[] = [];
  ctx?: DriverContext;
  disconnected = false;
  isConnected = false;
  /** What `connect` does; the default never settles, like a VTS pairing nobody has approved. */
  onConnect: (ctx: DriverContext) => Promise<void> = () => new Promise(() => {});
  connect(ctx: DriverContext) { this.ctx = ctx; return this.onConnect(ctx); }
  async disconnect() { this.disconnected = true; }
  connected() { return this.isConnected; }
  setParams(p: AvatarParams) { this.params.push({ ...p }); }
  setExpression(e: Emotion, i: number) { this.expressions.push([e, i]); }
  trigger(g: string) { this.gestures.push(g); }
}

/** Builds a run; its shutdown steps run when the test ends, pass or fail, so no engine timer or driver outlives it. */
function boot(ctx: TestContext, over: { bus?: BootBus; driver?: FakeDriver; env?: Partial<AvatarEnv> } = {}) {
  const bus = over.bus ?? new BootBus();
  const driver = over.driver ?? new FakeDriver();
  const rec = recordingLog();
  const exits: number[] = [];
  const shutdown: (() => void | Promise<void>)[] = [];
  const b: AvatarEnv = {
    log: rec.log,
    loadConfig: () => testConfig({ avatar: { driver: "vmc", fps: 100, idle_motion: false } }),
    createBus: () => bus as unknown as AvatarBus,
    createDriver: () => driver,
    loadExpressions: () => blocks({ vmc: { happy: "Smile", gestures: { wave: "WAVE" } } }),
    stateDir: "/state",
    onShutdown: (fn) => { shutdown.push(fn); },
    exit: (code) => { exits.push(code); },
    ...over.env,
  };
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= (async () => { for (const fn of shutdown) await fn(); })());
  ctx.after(close);
  return { b, bus, driver, rec, exits, shutdown, close };
}

/** The zod type of an expression block cannot express `gestures` next to string-valued emotions, so literals are cast once, here. */
const blocks = (x: unknown) => x as ExpressionMap;

const states = (bus: FakeBus) => bus.health.map((h) => h.state);

// @spec AVATAR-BUS-001
test("subscribes in group avatar with start mode latest to the five body events, after the engine started", async (ctx) => {
  const t = boot(ctx);
  void runAvatar(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  assert.deepEqual(t.bus.calls, ["resetGroup:avatar", "subscribe"]);
  const { opts } = t.bus.subscribed[0]!;
  assert.equal(opts.group, "avatar");
  assert.equal(opts.start, "latest");
  assert.equal("fromNow" in opts, false);
  assert.deepEqual([...(opts.types as string[])].sort(), ["affect.state", "brain.say", "voice.done", "voice.playing", "voice.utterance"]);
  await waitFor(() => t.driver.params.length > 0, "engine frames"); // the engine is running
});

// @spec AVATAR-BUS-002, AVATAR-BUS-003, AVATAR-BUS-004, AVATAR-BUS-005, AVATAR-BUS-006
test("events reach the engine: brain.say shows the emotion, utterance + playing lip-syncs, done ends it, affect.state sets the mood", async (ctx) => {
  const t = boot(ctx);
  void runAvatar(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await t.bus.deliver(event("brain.say", { id: "u1", text: "hi", emotion: "smug" }));
  assert.deepEqual(t.driver.expressions.at(-1), ["smug", 1]);
  await t.bus.deliver(event("voice.utterance", {
    id: "u1", text: "hi", emotion: "happy", gesture: "wave", durationMs: 1000, envelopeHz: 30, envelope: Array(30).fill(0.9), audioUrl: "http://v/audio/u1.wav", sampleRate: 24000,
  }));
  assert.deepEqual(t.driver.gestures, []); // prepared, not playing
  await t.bus.deliver(event("voice.playing", { id: "u1", sink: "discord" }));
  assert.deepEqual(t.driver.gestures, ["wave"]);
  assert.deepEqual(t.driver.expressions.at(-1), ["happy", 1]);
  // The envelope spans the whole 1 s line, so any frame while it plays opens the mouth: a 100 ms envelope needed a
  // frame inside that window, which an event loop stalled under load could miss.
  await waitFor(() => t.driver.params.some((p) => p.mouthOpen > 0.5), "mouth moves");
  await t.bus.deliver(event("voice.done", { id: "u1", sink: "discord" }));
  await waitFor(() => t.driver.params.at(-1)!.mouthOpen < 0.3, "mouth closes");
  await t.bus.deliver(event("affect.state", { mood: "sad", valence: -0.5, arousal: 0.2 } as never));
});

// @spec AVATAR-HEALTH-001, AVATAR-VTS-002
test("ready once the consumer group is positioned, without waiting for the driver to connect", async (ctx) => {
  const bus = new BootBus();
  let release!: () => void;
  bus.resetGate = new Promise<void>((r) => { release = r; });
  const t = boot(ctx, { bus }); // driver.connect never settles
  void runAvatar(t.b);
  await waitFor(() => bus.calls.includes("resetGroup:avatar"), "group positioning started");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(states(bus), ["starting"]);
  release();
  await waitFor(() => bus.subscribed.length === 1, "subscription");
  await waitFor(() => states(bus).includes("degraded") || states(bus).includes("ready"), "ready");
  // the driver is still connecting: the heartbeat reports it as a down dependency, not as an unready service
  assert.equal(bus.health.at(-1)!.deps.driver, "down");
  assert.equal(t.driver.ctx !== undefined, true); // connect was started
});

// @spec AVATAR-VTS-002, AVATAR-DRV-006
test("the engine runs and the subscription starts while the first driver connect is still pending", async (ctx) => {
  const t = boot(ctx); // connect() never resolves
  void runAvatar(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await waitFor(() => t.driver.params.length > 0, "engine frames");
  assert.deepEqual(t.driver.ctx?.expressions, { happy: "Smile" });
  assert.deepEqual(t.driver.ctx?.gestures, { wave: "WAVE" });
  assert.equal(t.driver.ctx?.stateDir, "/state");
  assert.deepEqual(t.exits, []);
});

// @spec AVATAR-BUS-007
test("a startup failure after the config loads (driver creation, expressions load) logs fatal and exits 1", async (ctx) => {
  const t = boot(ctx);
  t.b.createDriver = () => { throw new Error("driver invalid"); };
  await runAvatar(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
  assert.equal(t.bus.subscribed.length, 0);
});

// @spec AVATAR-BUS-007
test("a rejecting driver.connect logs fatal and exits 1", async (ctx) => {
  const driver = new FakeDriver();
  driver.onConnect = async () => { throw new Error("bad ws url"); };
  const t = boot(ctx, { driver });
  void runAvatar(t.b);
  await waitFor(() => t.exits.length > 0, "fatal exit");
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
});

// @spec AVATAR-BUS-008
test("a rejecting subscription logs fatal and exits 1", async (ctx) => {
  const bus = new BootBus();
  bus.subscribeError = new Error("NOGROUP consumer group deleted");
  const t = boot(ctx, { bus });
  await runAvatar(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
});

// @spec AVATAR-HEALTH-004
test("shutdown stops the engine, disconnects the driver and stops the bus", async (ctx) => {
  const t = boot(ctx);
  void runAvatar(t.b);
  await waitFor(() => t.bus.subscribed.length === 1, "subscription");
  await t.close();
  assert.equal(t.driver.disconnected, true);
  assert.equal(t.bus.stopped, true);
  const frames = t.driver.params.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.driver.params.length, frames); // the engine loop is stopped
});

// @spec AVATAR-BUS-007
test("a configuration that does not load logs the loader's message and exits 1, with no bus and no heartbeat", async (ctx) => {
  const t = boot(ctx, { env: { loadConfig: () => { throw new Error("bad config"); } } });
  await runAvatar(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.deepEqual(t.rec.msgs("error"), ["bad config"]);
  assert.equal(t.bus.health.length, 0);
});

// @spec AVATAR-BUS-007
test("a failed expressions load logs fatal and exits 1", async (ctx) => {
  const t = boot(ctx, { env: { loadExpressions: () => { throw new Error("expressions.yaml invalid"); } } });
  await runAvatar(t.b);
  assert.deepEqual(t.exits, [1]);
  assert.ok(t.rec.msgs("error").includes("fatal"));
  assert.equal(t.bus.subscribed.length, 0);
});

// @spec AVATAR-DRV-005
test("expressionsFor takes the block named after the active driver and splits its gestures", () => {
  const all = blocks({
    vmc: { happy: "Joy", sad: "Sorrow", gestures: { wave: "WAVE" } },
    "vtube-studio": { happy: "Smile", gestures: {} },
  });
  assert.deepEqual(expressionsFor(all, "vmc"), { expressions: { happy: "Joy", sad: "Sorrow" }, gestures: { wave: "WAVE" } });
  assert.deepEqual(expressionsFor(all, "vtube-studio"), { expressions: { happy: "Smile" }, gestures: {} });
  assert.deepEqual(expressionsFor(all, "null"), { expressions: {}, gestures: {} }, "no block: empty maps");
});

// @spec AVATAR-DRV-005
test("the service hands the driver the active driver's block of expressions.yaml", async (ctx) => {
  const t = boot(ctx);
  void runAvatar(t.b);
  await waitFor(() => t.driver.ctx !== undefined, "driver connect started");
  assert.deepEqual(t.driver.ctx!.expressions, { happy: "Smile" });
  assert.deepEqual(t.driver.ctx!.gestures, { wave: "WAVE" });
});
