import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { formatCursor, parseCursor } from "../src/cursor.js";
import { runReflect } from "../src/reflect-run.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");

function setup(over: Record<string, unknown> = {}, provider = "ollama") {
  const cfg = testConfig(over);
  let now = T0;
  const memory = new InMemoryStore(cfg.brain.memory, () => now);
  const prompts: string[] = [];
  const saved: string[] = [];
  const warnings: string[] = [];
  const printed: string[] = [];
  let reply = "- a\n- b\n- c";
  const log = { warn: (_o: unknown, m?: string) => warnings.push(m ?? String(_o)), info() {}, error() {}, debug() {} } as never;
  const run = () => runReflect({
    cfg,
    llm: { name: provider, chat: async (msgs) => { prompts.push(msgs[1]!.content); return reply; } },
    memory,
    log,
    loadPersonality: () => "# Coco\n\n## Learned\n",
    savePersonality: (text) => { saved.push(text); },
    now: () => new Date("2026-03-04T05:06:07Z"),
    print: (s) => printed.push(s),
  });
  const seed = async (n: number, stepMs = 1000) => {
    for (let i = 0; i < n; i++) { await memory.remember("chat", "bob", `line ${i}`); now += stepMs; }
  };
  const transcriptLines = (i: number) => prompts[i]!.split("## Transcript\n")[1]!.split("\n").length;
  return { run, seed, transcriptLines, memory, prompts, saved, warnings, printed, setReply: (r: string) => { reply = r; } };
}

// @spec MEM-REFLECT-008
test("cursor helpers round-trip (ts, id) and read a legacy plain-timestamp value as that ts with the lowest id", () => {
  const c = { ts: "2026-01-01T00:00:01.123456Z", id: 5 }; // Postgres microsecond text survives unchanged
  assert.equal(formatCursor(c), "2026-01-01T00:00:01.123456Z#5");
  assert.deepEqual(parseCursor(formatCursor(c)), c);
  assert.deepEqual(parseCursor("2026-01-01T00:00:01.500Z"), { ts: "2026-01-01T00:00:01.500Z", id: 0 });
  assert.deepEqual(parseCursor(undefined), { ts: "1970-01-01T00:00:00.000Z", id: 0 });
});

// @spec MEM-REFLECT-002, MEM-REFLECT-008
test("with more than 600 new memories each pass reads the next 600 and nothing is skipped", async () => {
  const t = setup();
  await t.seed(650);
  await t.run();
  assert.equal(t.transcriptLines(0), 600);
  assert.equal(await t.memory.getMeta("last_reflection"), formatCursor({ ts: new Date(T0 + 599_000).toISOString(), id: 600 }));
  await t.run();
  assert.equal(t.transcriptLines(1), 50);
  assert.match(t.prompts[1]!, /line 600\n/);
  assert.equal(t.saved.length, 2);
  await t.run(); // nothing new
  assert.equal(t.prompts.length, 2);
});

// @spec MEM-REFLECT-008
test("rows sharing the last row's timestamp are not skipped between passes", async () => {
  const t = setup();
  await t.seed(700, 0); // every row has the same ts
  await t.run();
  assert.equal(t.transcriptLines(0), 600);
  await t.run();
  assert.equal(t.transcriptLines(1), 100);
  assert.match(t.prompts[1]!, /^[\s\S]*line 600\n/);
  assert.doesNotMatch(t.prompts[1]!, /line 599\n/);
});

// @spec MEM-REFLECT-008
test("a legacy plain-timestamp last_reflection is accepted", async () => {
  const t = setup();
  await t.seed(10);
  await t.memory.setMeta("last_reflection", new Date(T0 + 4_000).toISOString()); // rows 0..3 are older
  await t.run();
  assert.equal(t.transcriptLines(0), 6);
  assert.doesNotMatch(t.prompts[0]!, /line 3\n/);
});

// @spec MEM-REFLECT-003
test("fewer than 5 new memories: no LLM call, nothing saved, cursor unchanged so the rows are read later", async () => {
  const t = setup();
  await t.seed(4);
  await t.run();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.saved.length, 0);
  assert.equal(await t.memory.getMeta("last_reflection"), undefined);
  await t.seed(2);
  await t.run();
  assert.equal(t.transcriptLines(0), 6);
});

// @spec MEM-REFLECT-004, MEM-REFLECT-007
test("bullets become a dated Learned block that is saved and printed", async () => {
  const t = setup();
  await t.seed(5);
  await t.run();
  assert.equal(t.saved[0], "# Coco\n\n## Learned\n\n### 2026-03-04\n- a\n- b\n- c\n");
  assert.equal(t.printed[0], "\n### 2026-03-04\n- a\n- b\n- c\n");
});

// @spec MEM-REFLECT-006
test("a reply without bullets saves nothing and leaves the cursor", async () => {
  const t = setup();
  await t.seed(5);
  t.setReply("I have nothing to add.");
  await t.run();
  assert.equal(t.saved.length, 0);
  assert.equal(await t.memory.getMeta("last_reflection"), undefined);
  assert.equal(t.warnings.length, 1);
});

// @spec MEM-REFLECT-001
test("store=memory: warns and does nothing", async () => {
  const t = setup({ brain: { memory: { store: "memory" } } });
  await t.seed(10);
  await t.run();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.saved.length, 0);
  assert.equal(t.warnings.length, 1);
});

// @spec MEM-REFLECT-010, LLM-MOCK-005
test("a mock chat provider is announced with one warning; a real one is not", async () => {
  const mock = setup({}, "mock");
  await mock.run();
  assert.equal(mock.warnings.filter((w) => /mock/.test(w)).length, 1);
  const real = setup({}, "ollama");
  await real.run();
  assert.equal(real.warnings.filter((w) => /mock/.test(w)).length, 0);
});

// @spec MEM-REFLECT-008
test("the cursor stored after a pass is the newest row's exact microsecond text", async () => {
  const t = setup();
  await t.seed(5);
  const orig = t.memory.recentSince.bind(t.memory);
  t.memory.recentSince = async (c, n) => (await orig(c, n)).map((m) => ({ ...m, tsText: `2026-01-01T00:00:0${m.id}.123456Z` }));
  await t.run();
  assert.equal(await t.memory.getMeta("last_reflection"), "2026-01-01T00:00:05.123456Z#5");
});

// @spec MEM-REFLECT-011
test("reflect opens the store with connect(): no schema work and no embed probe, so an unreachable embedder does not stop it", async () => {
  const t = setup();
  await t.seed(5);
  const calls: string[] = [];
  const m = t.memory as unknown as { init(): Promise<void>; connect(): Promise<void>; embedText(s: string): Promise<number[]> };
  m.init = async () => { calls.push("init"); throw new Error("ollama unreachable"); };
  m.embedText = async () => { calls.push("embed"); throw new Error("ollama unreachable"); };
  const connect = m.connect.bind(m);
  m.connect = async () => { calls.push("connect"); await connect(); };
  await t.run();
  assert.deepEqual(calls, ["connect"]);
  assert.equal(t.saved.length, 1);
});

// @spec MEM-REFLECT-012
test("reflect runs under the consolidation lock and does nothing while another pass holds it", async () => {
  const t = setup();
  await t.seed(5);
  const held = await t.memory.withConsolidationLock(async () => {
    await t.run(); // the lock is taken: this run must stand down
    return "held";
  });
  assert.deepEqual(held, { ran: true, value: "held" });
  assert.equal(t.prompts.length, 0);
  assert.equal(t.saved.length, 0);
  assert.equal(await t.memory.getMeta("last_reflection"), undefined);
  assert.ok(t.warnings.some((w) => /lock/.test(w)));
  await t.run(); // lock free again
  assert.equal(t.saved.length, 1);
});

// @spec MEM-REFLECT-012
test("the reflect lock is released after a pass, even when it throws", async () => {
  const t = setup();
  await t.seed(5);
  await assert.rejects(runReflect({
    cfg: testConfig(), llm: { name: "ollama", chat: async () => { throw new Error("llm down"); } }, memory: t.memory,
    log: { warn() {}, info() {}, error() {}, debug() {} } as never,
    loadPersonality: () => "", savePersonality: () => {}, now: () => new Date(),
  }), /llm down/);
  assert.deepEqual(await t.memory.withConsolidationLock(async () => 1), { ran: true, value: 1 });
});
