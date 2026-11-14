import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { EventType, Handler, SubscribeOptions } from "@cohost/bus";
import { createChatProvider } from "@cohost/llm";
import { runCortex, type CortexBus } from "../src/main.js";

/** A FakeBus that records the consumer-group calls the cortex makes. */
class GroupBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeOptions<EventType>[] = [];
  handler?: Handler<EventType>;
  stopped = false;
  async resetGroup(group: string): Promise<void> { this.calls.push(`resetGroup:${group}`); }
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    this.calls.push(`subscribe:${opts.group}`);
    this.subscribed.push(opts as SubscribeOptions<EventType>);
    this.handler = handler as unknown as Handler<EventType>;
  }
  stop(): void { this.stopped = true; }
}

/** The mock provider answers its ping at once, so the cortex starts without a model server. */
const mockCfg = (over: Record<string, unknown> = {}) => testConfig({ llm: { provider: "mock" }, brain: { memory: { recall_k: 0 }, cortex: { recall_timeout_ms: 50 } }, ...over });

function env(bus: GroupBus, over: Record<string, unknown> = {}) {
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  return {
    shutdown, exits,
    env: {
      loadConfig: () => mockCfg(over),
      createBus: () => bus as unknown as CortexBus,
      loadPersonality: () => "You are Coco.",
      onShutdown: (fn: () => void | Promise<void>) => { shutdown.push(fn); },
      exit: (code: number) => { exits.push(code); },
    },
  };
}
const states = (bus: GroupBus) => bus.health.map((h) => h.state);

test("main: reports idle, subscribes in start mode latest, then ready; shutdown stops the bus", async () => { // @spec CTX-START-003, CTX-START-004
  const bus = new GroupBus();
  const { env: e, shutdown, exits } = env(bus);
  await runCortex({ ...e, log: recordingLog().log });
  await waitFor(() => states(bus).includes("ready"), "ready heartbeat");
  assert.deepEqual(bus.calls, ["resetGroup:cortex", "subscribe:cortex"]);
  assert.equal(bus.subscribed[0]!.start, "latest");
  assert.equal(bus.of("brain.status")[0]!.state, "idle", "idle goes out before the subscription starts");
  assert.equal(bus.health.at(-1)!.mode, "mock");
  assert.deepEqual(exits, []);
  for (const fn of shutdown) await fn();
  assert.ok(bus.stopped, "the bus is stopped on shutdown");
});

test("main: a rejected critic configuration fails inside main: fatal, exit 1, no subscription, never ready", async () => { // @spec CTX-START-005
  const bus = new GroupBus();
  const { env: e, exits } = env(bus, { brain: { cortex: { critic: { kind: "http", url: "" } } } });
  const { log, lines } = recordingLog();
  await runCortex({ ...e, log });
  assert.deepEqual(exits, [1]);
  const fatal = lines.filter((l) => l.level === "error" && l.msg === "fatal");
  assert.equal(fatal.length, 1);
  assert.ok((fatal[0]!.obj as { err?: unknown }).err instanceof Error);
  assert.deepEqual(bus.calls, [], "never subscribed");
  assert.ok(!states(bus).includes("ready"));
});

test("main: a configuration that does not load, or a bus that cannot be built, ends with exit 1", async () => { // @spec CTX-START-004
  const bus = new GroupBus();
  const cfgFail = env(bus);
  cfgFail.env.loadConfig = () => { throw new Error("bad config"); };
  const a = recordingLog();
  await runCortex({ ...cfgFail.env, log: a.log });
  assert.deepEqual(cfgFail.exits, [1]);
  assert.deepEqual(a.lines.filter((l) => l.level === "error").map((l) => l.msg), ["bad config"]);

  const busFail = env(bus);
  busFail.env.createBus = () => { throw new Error("no redis url"); };
  const b = recordingLog();
  await runCortex({ ...busFail.env, log: b.log });
  assert.deepEqual(busFail.exits, [1]);
  assert.equal(b.lines.filter((l) => l.level === "error" && l.msg === "fatal").length, 1);
});

test("main: an attention.focus delivered through the subscription gets an answer", async () => { // @spec CTX-START-002, CTX-EVT-006
  const bus = new GroupBus();
  const { env: e, shutdown } = env(bus);
  await runCortex({ ...e, log: recordingLog().log });
  await waitFor(() => bus.handler !== undefined, "subscription");
  await bus.handler!(event("attention.focus", { reason: "mentioned", score: 1, focus: { kind: "chat", who: "bob", text: "hey Coco?", mention: true } }));
  await waitFor(() => bus.of("brain.say").length === 1, "brain.say");
  assert.ok(bus.of("brain.say")[0]!.text.length > 0);
  for (const fn of shutdown) await fn();
});

test("main: the heartbeat carries a hook dependency for an llm critic and none for a rules critic", async () => { // @spec CTX-HEALTH-006, CTX-HEALTH-007
  const llmBus = new GroupBus();
  const llm = env(llmBus, { brain: { cortex: { critic: { kind: "llm" } } } });
  await runCortex({ ...llm.env, log: recordingLog().log });
  await waitFor(() => states(llmBus).includes("ready"), "ready heartbeat");
  const ready = llmBus.health.find((h) => h.state === "ready")!;
  assert.equal(ready.mode, "mock");
  assert.ok("hook.cortex.critic" in (ready.deps ?? {}), "the critic hook is a dependency");
  assert.ok("llm" in (ready.deps ?? {}), "the model dependency stays");
  for (const fn of llm.shutdown) await fn();

  const rulesBus = new GroupBus();
  const rules = env(rulesBus, { brain: { cortex: { critic: { kind: "rules" } } } });
  await runCortex({ ...rules.env, log: recordingLog().log });
  await waitFor(() => states(rulesBus).includes("ready"), "ready heartbeat");
  assert.ok(!("hook.cortex.critic" in (rulesBus.health.find((h) => h.state === "ready")!.deps ?? {})));
  for (const fn of rules.shutdown) await fn();
});

test("main: the critic hook is pinged once at startup and an unreachable provider is warned about", async () => { // @spec CTX-HEALTH-007
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = "http://127.0.0.1:1"; // nothing listens: the critic hook runs on ollama
  try {
    const bus = new GroupBus();
    const { env: e, shutdown } = env(bus, { llm: { provider: "ollama" }, brain: { cortex: { critic: { kind: "llm" } } } });
    const { log, lines } = recordingLog();
    await runCortex({ ...e, createChatProvider: () => createChatProvider(mockCfg().llm), log }); // the cortex's own model answers; only the critic hook's ollama does not
    await waitFor(() => lines.some((l) => l.level === "warn" && /hook provider unreachable/.test(l.msg ?? "")), "critic ping warning");
    assert.equal(lines.filter((l) => /hook provider unreachable/.test(l.msg ?? "")).length, 1);
    for (const fn of shutdown) await fn();
  } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
});
