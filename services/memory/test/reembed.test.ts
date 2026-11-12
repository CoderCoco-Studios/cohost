import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { MemoryStore } from "../src/store.js";
import { InMemoryStore } from "../src/fake-store.js";
import { runReembed } from "../src/reembed-run.js";

function fakeStore(over: { locked?: boolean; result?: { dims: number; tables: Record<string, number> }; fail?: boolean } = {}) {
  const calls: string[] = [];
  const store = {
    async withConsolidationLock<T>(fn: () => Promise<T>) {
      calls.push("lock");
      if (over.locked) return { ran: false as const };
      try { return { ran: true as const, value: await fn() }; } finally { calls.push("unlock"); }
    },
    async reembed() {
      calls.push("reembed");
      if (over.fail) throw new Error("ollama unreachable");
      return over.result ?? { dims: 8, tables: { memories: 3 } };
    },
    async close() { calls.push("close"); },
  };
  const logs: string[] = [];
  const log = { warn: (_o: unknown, m?: string) => logs.push(`warn ${m ?? String(_o)}`), info: (_o: unknown, m?: string) => logs.push(`info ${m ?? String(_o)}`), error() {}, debug() {} } as never;
  return { store, calls, logs, log };
}

// @spec MEM-REEMBED-001, MEM-REEMBED-004
test("reembed runs under the consolidation lock, reports the rows it migrated and closes the store", async () => {
  const f = fakeStore();
  const res = await runReembed({ cfg: testConfig(), store: f.store, log: f.log });
  assert.deepEqual(res, { dims: 8, tables: { memories: 3 } });
  assert.deepEqual(f.calls, ["lock", "reembed", "unlock", "close"]);
});

// @spec MEM-REEMBED-002
test("reembed with nothing to migrate says so and succeeds", async () => {
  const f = fakeStore({ result: { dims: 8, tables: {} } });
  const res = await runReembed({ cfg: testConfig(), store: f.store, log: f.log });
  assert.deepEqual(res, { dims: 8, tables: {} });
  assert.ok(f.logs.some((l) => /unchanged/.test(l)));
});

// @spec MEM-REEMBED-004
test("reembed fails without migrating anything while another pass holds the lock", async () => {
  const f = fakeStore({ locked: true });
  await assert.rejects(runReembed({ cfg: testConfig(), store: f.store, log: f.log }), /consolidation lock/);
  assert.ok(!f.calls.includes("reembed"));
  assert.ok(f.calls.includes("close"));
});

// @spec MEM-REEMBED-005
test("reembed with the in-memory store warns and does nothing", async () => {
  const f = fakeStore();
  const cfg = testConfig({ brain: { memory: { store: "memory" } } });
  assert.equal(await runReembed({ cfg, store: f.store, log: f.log }), undefined);
  assert.deepEqual(f.calls, ["close"]);
  assert.ok(f.logs.some((l) => l.startsWith("warn")));
});

// @spec MEM-REEMBED-006
test("a failing step rejects (the entry point exits 1) and the store is still closed, lock released", async () => {
  const f = fakeStore({ fail: true });
  await assert.rejects(runReembed({ cfg: testConfig(), store: f.store, log: f.log }), /ollama unreachable/);
  assert.deepEqual(f.calls, ["lock", "reembed", "unlock", "close"]);
});

// ---- MemoryStore.reembed against a recording fake pool

type Query = { sql: string; params?: unknown[] };
interface Table { dims?: number; staging?: number; rows: { id: string; who?: string; text: string; staged?: boolean }[] }

/** A tiny pool that answers the catalog queries and the paged SELECT/UPDATE of one `reembed` from `tables`. */
function reembedStore(tables: Record<string, Table | undefined>, embedDims: number, opts: { failEmbedAt?: number } = {}) {
  const queries: Query[] = [];
  const embedded: string[] = [];
  const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
  let n = 0;
  const embedder = { embed: async (t: string) => {
    if (t === "hello") return new Array(embedDims).fill(1);
    n++;
    if (opts.failEmbedAt === n) throw new Error("embed down");
    embedded.push(t);
    return new Array(embedDims).fill(0.5);
  } };
  const s = new MemoryStore(embedder, testConfig().brain.memory, log);
  const nameOf = (sql: string) => /(?:FROM|TABLE|UPDATE)\s+(?:IF NOT EXISTS\s+)?(memories|viewer_notes|viewer_note_deletions)\b/.exec(sql)?.[1];
  const query = async (sql: string, params?: unknown[]) => {
    const q = { sql: sql.replace(/\s+/g, " ").trim(), params };
    queries.push(q);
    const exists = /to_regclass\('(\w+)'\)/.exec(q.sql);
    if (q.sql.startsWith("SELECT to_regclass")) return { rows: [{ present: tables[(params?.[0] as string)] ? "x" : null }], rowCount: 1 };
    if (q.sql.includes("FROM pg_attribute")) {
      const t = tables[params?.[0] as string]!;
      const col = params?.[1] as string;
      const dims = col === "embedding" ? t.dims : t.staging;
      return { rows: dims === undefined ? [] : [{ dims }], rowCount: dims === undefined ? 0 : 1 };
    }
    const name = nameOf(q.sql);
    const t = name ? tables[name] : undefined;
    if (t && q.sql.startsWith("ALTER TABLE") && q.sql.includes("DROP COLUMN embedding_new")) { t.staging = undefined; t.rows.forEach((r) => { r.staged = false; }); }
    if (t && q.sql.startsWith("ALTER TABLE") && q.sql.includes("ADD COLUMN IF NOT EXISTS embedding_new")) t.staging ??= embedDims;
    if (t && q.sql.startsWith("SELECT count(*)")) return { rows: [{ n: String(t.rows.length) }], rowCount: 1 };
    if (t && q.sql.startsWith("SELECT id,")) {
      const todo = t.rows.filter((r) => !r.staged).slice(0, 2).map((r) => ({ id: r.id, who: r.who, text: r.text }));
      return { rows: todo, rowCount: todo.length };
    }
    if (t && q.sql.startsWith("UPDATE")) { t.rows.find((r) => r.id === String(params?.[1]))!.staged = true; return { rows: [], rowCount: 1 }; }
    if (q.sql.includes("RENAME COLUMN embedding_new TO embedding") && t) { t.dims = t.staging; t.staging = undefined; }
    void exists;
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }), end: async () => {} };
  void (s as unknown as { pool: { end(): Promise<void> } }).pool.end();
  (s as unknown as { pool: unknown }).pool = pool;
  return { s, queries, embedded, tables };
}

const DROP_OLD = /DROP COLUMN embedding$/;
const memRows = () => [{ id: "1", who: "bob", text: "hi" }, { id: "2", who: "amy", text: "yo" }, { id: "3", who: "bob", text: "gg" }];

// @spec MEM-REEMBED-001, MEM-REEMBED-003
test("MemoryStore.reembed stages new vectors for every table, then swaps all columns in one transaction and rebuilds the index", async () => {
  const t = reembedStore({
    memories: { dims: 4, rows: memRows() },
    viewer_notes: { dims: 4, rows: [{ id: "7", text: "likes cats" }] },
    viewer_note_deletions: { dims: 4, rows: [] },
  }, 8);
  const res = await t.s.reembed();
  assert.deepEqual(res, { dims: 8, tables: { memories: 3, viewer_notes: 1, viewer_note_deletions: 0 } });
  assert.deepEqual(t.embedded, ["bob: hi", "amy: yo", "bob: gg", "likes cats"], "memories embed `who: text`, notes embed `text`");
  const sql = t.queries.map((q) => q.sql);
  const begin = sql.indexOf("BEGIN");
  const commit = sql.indexOf("COMMIT");
  assert.ok(begin > 0 && commit > begin);
  assert.ok(sql.slice(0, begin).every((q) => !DROP_OLD.test(q)), "no old column is dropped before the swap transaction");
  const swap = sql.slice(begin, commit);
  assert.equal(swap.filter((q) => DROP_OLD.test(q)).length, 3);
  assert.equal(swap.filter((q) => q.includes("RENAME COLUMN embedding_new TO embedding")).length, 3);
  assert.ok(sql.slice(commit).some((q) => q.includes("CREATE INDEX IF NOT EXISTS memories_embedding_idx") && q.includes("hnsw")));
  assert.ok(!sql.some((q) => /\bTRUNCATE\b|DELETE FROM/.test(q)));
  assert.equal(t.tables.memories!.dims, 8);
});

// @spec MEM-REEMBED-002
test("MemoryStore.reembed changes nothing when every column already has the embedder's dimension", async () => {
  const t = reembedStore({ memories: { dims: 8, rows: memRows() }, viewer_notes: { dims: 8, rows: [] }, viewer_note_deletions: undefined }, 8);
  assert.deepEqual(await t.s.reembed(), { dims: 8, tables: {} });
  assert.ok(!t.queries.some((q) => q.sql.startsWith("ALTER") || q.sql === "BEGIN"));
  assert.deepEqual(t.embedded, []);
});

// @spec MEM-REEMBED-003
test("a failed run rolls nothing forward: the old columns are never dropped and a rerun embeds only the rows still missing", async () => {
  const tables: Record<string, Table> = { memories: { dims: 4, rows: memRows() }, viewer_notes: { dims: 4, rows: [] }, viewer_note_deletions: { dims: 4, rows: [] } };
  const first = reembedStore(tables, 8, { failEmbedAt: 3 });
  await assert.rejects(first.s.reembed(), /embed down/);
  assert.ok(!first.queries.some((q) => q.sql === "BEGIN" || DROP_OLD.test(q.sql)));
  assert.equal(tables.memories!.dims, 4, "the old column still serves");
  assert.equal(tables.memories!.rows.filter((r) => r.staged).length, 2);
  const second = reembedStore(tables, 8);
  await second.s.reembed();
  assert.deepEqual(second.embedded, ["bob: gg"], "only the unstaged row is embedded again");
  assert.equal(tables.memories!.dims, 8);
});

// @spec MEM-REEMBED-003
test("a staging column left by a run with another embedder (another dimension) is dropped and started afresh", async () => {
  const t = reembedStore({ memories: { dims: 4, staging: 6, rows: memRows().map((r) => ({ ...r, staged: true })) }, viewer_notes: undefined, viewer_note_deletions: undefined }, 8);
  await t.s.reembed();
  assert.equal(t.embedded.length, 3, "every row is embedded again");
  assert.ok(t.queries.some((q) => q.sql.includes("DROP COLUMN embedding_new")));
});

// @spec MEM-REEMBED-001
test("the in-memory store has nothing to migrate", async () => {
  const s = new InMemoryStore(testConfig().brain.memory);
  assert.deepEqual(await s.reembed(), { dims: 64, tables: {} });
});
