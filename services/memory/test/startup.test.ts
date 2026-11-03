import { test } from "node:test";
import assert from "node:assert/strict";
import { startMemory, type StartupDeps } from "../src/startup.js";
import { DimensionMismatchError } from "../src/store.js";

function setup(over: { store?: "postgres" | "memory"; embedder?: "ollama" | "hash"; pings?: boolean[]; initFailures?: unknown[] } = {}) {
  const events: string[] = [];
  const subs: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const pings = [...(over.pings ?? [true])];
  const failures = [...(over.initFailures ?? [])];
  let inits = 0;
  const deps: StartupDeps = {
    cfg: { store: over.store ?? "postgres", embedder: over.embedder ?? "ollama", recall_k: 6, min_similarity: 0.35 },
    log: { warn: (_o: unknown, m?: string) => warnings.push(m ?? String(_o)), info() {}, error() {}, debug() {} } as never,
    bus: { subscribe: (opts: Record<string, unknown>) => { subs.push(opts); events.push(`subscribe:${opts.group}`); return new Promise<void>(() => {}); } } as never,
    store: { init: async () => { inits++; events.push("init"); if (failures.length) throw failures.shift(); } } as never,
    health: { setOllama: (ok: boolean) => events.push(`ollama:${ok}`), setPostgres: (ok: boolean) => events.push(`postgres:${ok}`) },
    heartbeat: { ready: () => events.push("ready"), degraded: (d?: string) => events.push(`degraded:${d}`) },
    ping: async () => pings.shift() ?? true,
    onEvent: async () => {},
    sleep: async () => { events.push("sleep"); },
  };
  return { deps, events, subs, warnings, inits: () => inits };
}

// @spec MEM-EVT-001
test("both consumer groups subscribe with start mode resume", async () => {
  const t = setup();
  await startMemory(t.deps);
  assert.deepEqual(t.subs.map((s) => [s.group, s.types, s.start, "fromNow" in s]), [
    ["memory", ["chat.message", "speech.heard", "brain.say"], "resume", false],
    ["memory-recall", ["memory.recall.request"], "resume", false],
  ]);
  assert.equal(t.events.at(-1), "ready");
});

// @spec MEM-HEALTH-007, MEM-START-001
test("waiting for ollama reports degraded naming ollama and marks the dependency down", async () => {
  const t = setup({ pings: [false, false, true] });
  await startMemory(t.deps);
  assert.deepEqual(t.events.slice(0, 7), [
    "ollama:false", "degraded:waiting for ollama (embeddings)", "sleep",
    "ollama:false", "degraded:waiting for ollama (embeddings)", "sleep",
    "ollama:true",
  ]);
});

// @spec MEM-HEALTH-004, MEM-HEALTH-006, MEM-HEALTH-007, MEM-START-002
test("a failing postgres init is retried every 3 s, reporting degraded naming postgres", async () => {
  const t = setup({ initFailures: [new Error("refused"), new Error("refused")] });
  await startMemory(t.deps);
  const degraded = t.events.filter((e) => e.startsWith("degraded:"));
  assert.equal(degraded.length, 2);
  for (const d of degraded) assert.match(d, /postgres/i);
  assert.deepEqual(t.events.filter((e) => e.startsWith("postgres:")), ["postgres:false", "postgres:false", "postgres:true"]);
  assert.equal(t.inits(), 3);
  assert.equal(t.events.at(-1), "ready");
});

// @spec MEM-START-002
test("the 21st failed postgres init is fatal", async () => {
  const t = setup({ initFailures: Array.from({ length: 21 }, () => new Error("refused")) });
  await assert.rejects(startMemory(t.deps), /refused/);
  assert.equal(t.inits(), 21);
  assert.equal(t.subs.length, 0);
  assert.ok(!t.events.includes("ready"));
});

// @spec MEM-STORE-002, MEM-START-002
test("a vector-dimension mismatch is not retried", async () => {
  const t = setup({ initFailures: [new DimensionMismatchError(768, 64)] });
  await assert.rejects(startMemory(t.deps), DimensionMismatchError);
  assert.equal(t.inits(), 1);
  assert.ok(!t.events.includes("sleep"));
  assert.equal(t.subs.length, 0);
  assert.ok(!t.events.includes("ready"));
});

// @spec MEM-START-003, MEM-START-004
test("store=memory initialises once with no ollama wait, and warns that data is not durable", async () => {
  const t = setup({ store: "memory", embedder: "hash", pings: [false] });
  await startMemory(t.deps);
  assert.equal(t.inits(), 1);
  assert.ok(!t.events.some((e) => e.startsWith("ollama") || e.startsWith("postgres") || e.startsWith("degraded")));
  assert.equal(t.warnings.filter((w) => /mock/.test(w)).length, 1);
});
