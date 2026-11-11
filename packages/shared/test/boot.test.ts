import { test } from "node:test";
import assert from "node:assert/strict";
import { runService } from "../src/index.js";

function rig(over: Record<string, unknown> = {}) {
  const order: string[] = [];
  const lines: { level: string; obj: unknown; msg?: string }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: typeof obj === "string" ? obj : msg }); };
  const log = { warn: at("warn"), info: at("info"), error: at("error"), debug: at("debug"), fatal: at("fatal") };
  const published: string[] = [];
  let stopped = 0;
  const bus = {
    consumer: "b-1",
    publishHealth: async (d: { state: string }) => { published.push(d.state); return "1"; },
    stop: () => { stopped++; order.push("bus.stop"); },
  };
  const cfg = { marker: "cfg" };
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const created: string[] = [];
  const env = {
    log: log as never,
    loadConfig: () => { order.push("loadConfig"); return cfg as never; },
    createBus: (service: string) => { order.push("createBus"); created.push(service); return bus as never; },
    onShutdown: (fn: () => void | Promise<void>) => { order.push("onShutdown"); shutdown = fn; },
    exit: (c: number) => { exits.push(c); },
    ...over,
  };
  return { env, order, lines, published, exits, created, cfg, bus, get stopped() { return stopped; }, get shutdown() { return shutdown; } };
}
const health = () => ({ service: "svc", mode: "live", deps: {} });

// @spec SHARED-BOOT-001, SHARED-BOOT-008
test("the bootstrap loads config, creates the bus under the service name, starts the heartbeat, then calls main with the context", async () => {
  const r = rig();
  let ctx: Record<string, unknown> | undefined;
  await runService({
    service: "svc", health: (cfg) => { r.order.push("health"); assert.equal(cfg, r.cfg); return health() as never; },
    main: async (c) => { r.order.push("main"); ctx = c as never; },
    ...r.env,
  } as never);
  await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(r.order.filter((o) => o !== "onShutdown"), ["loadConfig", "createBus", "health", "main"]);
  assert.deepEqual(r.created, ["svc"]);
  assert.deepEqual(r.published, ["starting"], "the heartbeat started in `starting`");
  assert.deepEqual(Object.keys(ctx!).sort(), ["bus", "cfg", "heartbeat", "log", "onStop"]);
  assert.equal(ctx!.cfg, r.cfg);
  assert.equal(ctx!.bus, r.bus);
  assert.deepEqual(r.exits, []);
  await (ctx!.heartbeat as { stop(): Promise<void> }).stop();
});

// @spec SHARED-BOOT-002
test("a failing config load logs the loader's message, creates no bus or heartbeat and exits 1", async () => {
  const r = rig({ loadConfig: () => { throw new Error("config/config.yaml: llm.model required"); } });
  let ran = false;
  await runService({ service: "svc", health: health as never, main: async () => { ran = true; }, ...r.env } as never);
  assert.deepEqual(r.exits, [1]);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.published, []);
  assert.equal(ran, false);
  assert.ok(r.lines.some((l) => l.level === "error" && String(l.msg).includes("llm.model required")));
});

// @spec SHARED-BOOT-003
test("a main that throws or rejects is logged as `fatal` and exits 1", async () => {
  for (const main of [async () => { throw new Error("rejected"); }, (() => { throw new Error("threw"); }) as never]) {
    const r = rig();
    await runService({ service: "svc", health: health as never, main, ...r.env } as never);
    assert.deepEqual(r.exits, [1]);
    assert.ok(r.lines.some((l) => l.level === "error" && l.msg === "fatal"));
  }
});

// @spec SHARED-BOOT-004
test("the bootstrap never declares readiness itself", async () => {
  const r = rig();
  await runService({ service: "svc", health: health as never, main: async () => {}, ...r.env } as never);
  await new Promise((x) => setTimeout(x, 20));
  assert.ok(!r.published.includes("ready") && !r.published.includes("degraded"), r.published.join());
});

// @spec SHARED-BOOT-005
test("shutdown runs onStop steps in reverse order, awaited, skipping ones that throw, then stops the bus", async () => {
  const r = rig();
  const ran: string[] = [];
  await runService({
    service: "svc", health: health as never,
    main: async ({ onStop }) => {
      onStop(() => { ran.push("first"); });
      onStop(async () => { throw new Error("second broke"); });
      onStop(async () => { await new Promise((x) => setTimeout(x, 20)); ran.push("third"); });
    },
    ...r.env,
  } as never);
  await r.shutdown!();
  assert.deepEqual(ran, ["third", "first"]);
  assert.equal(r.stopped, 1);
  assert.equal(r.order.at(-1), "bus.stop");
  assert.ok(r.lines.some((l) => l.level === "error" && String(l.msg).includes("onStop")));
});

// @spec SHARED-BOOT-006
test("steps that do not settle within the limit are abandoned: the bus is stopped and the sequence ends", async () => {
  const r = rig();
  await runService({
    service: "svc", health: health as never, stopTimeoutMs: 50,
    main: async ({ onStop }) => { onStop(() => new Promise<void>(() => {})); },
    ...r.env,
  } as never);
  const t0 = performance.now();
  await r.shutdown!();
  const took = performance.now() - t0;
  assert.ok(took >= 40 && took < 1000, `took ${took}`);
  assert.equal(r.stopped, 1);
  assert.deepEqual(r.exits, [], "exit(0) is the lifecycle's job, not the bootstrap's");
});

// @spec SHARED-BOOT-007
test("a signal before main resolves runs only the steps registered so far; later registrations never run", async () => {
  const r = rig();
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((x) => { release = x; });
  let late!: (fn: () => void) => void;
  const done = runService({
    service: "svc", health: health as never,
    main: async ({ onStop }) => { onStop(() => { ran.push("early"); }); late = onStop; await gate; late(() => { ran.push("late"); }); },
    ...r.env,
  } as never);
  await new Promise((x) => setTimeout(x, 5));
  const sd = r.shutdown!();
  release();
  await done;
  await sd;
  late(() => { ran.push("after"); });
  assert.deepEqual(ran, ["early"]);
});
