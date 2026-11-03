import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLearned, learnedBlock, parseBullets } from "../src/learned.js";
import { DimensionMismatchError, MemoryStore } from "../src/store.js";
import { MemoryHealth } from "../src/health.js";
import { runHeartbeat } from "@cohost/testing";

// ---- reflection → personality.md

// @spec MEM-REFLECT-005
test("parseBullets keeps only bullet lines, trimmed", () => {
  const raw = "Sure! Here's what I learned:\n\n- bob loves speedruns\n  - running joke: the cursed sword  \n* not this\n-nor this\nThanks!";
  assert.deepEqual(parseBullets(raw), ["- bob loves speedruns", "- running joke: the cursed sword"]);
  assert.deepEqual(parseBullets("no bullets at all"), []);
});

// @spec MEM-REFLECT-007
test("appendLearned adds the heading the first time, then appends dated blocks under it", () => {
  const block1 = learnedBlock(["- a", "- b"], "2026-10-01");
  assert.equal(block1, "\n### 2026-10-01\n- a\n- b\n");
  const once = appendLearned("# Coco\n\n## Rules\n- be nice\n\n\n", block1);
  assert.equal(once, "# Coco\n\n## Rules\n- be nice\n\n## Learned\n\n### 2026-10-01\n- a\n- b\n");
  const twice = appendLearned(once, learnedBlock(["- c"], "2026-10-08"));
  assert.equal(twice, `${once.trimEnd()}\n\n### 2026-10-08\n- c\n`);
  assert.equal(twice.match(/## Learned/g)!.length, 1);
});

// @spec MEM-REFLECT-007
test("appendLearned inserts at the end of the Learned section, before the next ## heading", () => {
  const block = learnedBlock(["- c"], "2026-10-08");
  const mid = "# Coco\n\n## Learned\n\n### 2026-10-01\n- a\n\n## Rules\n- be nice\n";
  assert.equal(appendLearned(mid, block), "# Coco\n\n## Learned\n\n### 2026-10-01\n- a\n\n### 2026-10-08\n- c\n\n## Rules\n- be nice\n");
  // a ### subheading inside Learned does not end the section, and ### Learned is not the marker
  const sub = "## Learned\n### 2026-10-01\n- a\n";
  assert.equal(appendLearned(sub, block), "## Learned\n### 2026-10-01\n- a\n\n### 2026-10-08\n- c\n");
  const fake = "# Coco\n### Learned things\n- x\n";
  assert.equal(appendLearned(fake, block), "# Coco\n### Learned things\n- x\n\n## Learned\n\n### 2026-10-08\n- c\n");
});

// ---- MemoryStore against a recording fake pool

type Query = { sql: string; params?: unknown[] };
function store(opts: { rows?: (q: Query) => unknown[]; fail?: (q: Query) => boolean; embed?: (t: string) => Promise<number[]>; onQuery?: (ok: boolean) => void } = {}) {
  const queries: Query[] = [];
  const warnings: unknown[] = [];
  const embedded: string[] = [];
  const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
  const embedder = { embed: opts.embed ?? (async (t: string) => { embedded.push(t); return [0.5, -1, 2]; }) };
  const s = new MemoryStore(embedder, { recall_k: 3, min_similarity: 0.4 }, log, opts.onQuery);
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const q = { sql: sql.replace(/\s+/g, " ").trim(), params };
      queries.push(q);
      if (opts.fail?.(q)) throw new Error("db down");
      return { rows: opts.rows?.(q) ?? [] };
    },
    end: async () => {},
  };
  void (s as unknown as { pool: { end(): Promise<void> } }).pool.end();
  (s as unknown as { pool: unknown }).pool = pool;
  return { s, queries, warnings, embedded };
}

// @spec MEM-STORE-001
test("init sizes the vector column from a probe embedding and survives a missing hnsw index", async () => {
  const { s, queries, warnings } = store({ fail: (q) => q.sql.includes("hnsw") });
  await s.init();
  assert.ok(queries.some((q) => q.sql.includes("CREATE EXTENSION IF NOT EXISTS vector")));
  assert.ok(queries.some((q) => q.sql.includes("embedding vector(3)")));
  assert.ok(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS viewers")));
  assert.ok(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS meta")));
  assert.equal(warnings.length, 1);
});

// @spec MEM-WRITE-004
test("remember embeds 'who: text' and stores the vector as a pgvector literal", async () => {
  const { s, queries, embedded } = store();
  await s.remember("chat", "bob", "I love speedruns");
  assert.deepEqual(embedded, ["bob: I love speedruns"]);
  assert.match(queries[0]!.sql, /^INSERT INTO memories/);
  assert.deepEqual(queries[0]!.params, ["chat", "bob", "I love speedruns", "[0.5,-1,2]"]);
});

// @spec MEM-WRITE-005
test("remember never throws: a failed embed or insert is a warning", async () => {
  const bad = store({ embed: async () => { throw new Error("ollama down"); } });
  await bad.s.remember("chat", "bob", "x");
  assert.equal(bad.queries.length, 0);
  assert.equal(bad.warnings.length, 1);
  const dbDown = store({ fail: () => true });
  await dbDown.s.remember("chat", "bob", "x");
  assert.equal(dbDown.warnings.length, 1);
});

// @spec MEM-RECALL-002, MEM-RECALL-003, MEM-RECALL-004
test("recall: top-k by cosine distance, older than 2 minutes, filtered by min_similarity", async () => {
  const rows = [
    { id: 1, ts: new Date(), kind: "chat", who: "bob", text: "close", similarity: 0.9 },
    { id: 2, ts: new Date(), kind: "chat", who: "amy", text: "edge", similarity: 0.4 },
    { id: 3, ts: new Date(), kind: "chat", who: "cat", text: "far", similarity: 0.39 },
  ];
  const { s, queries, embedded } = store({ rows: () => rows });
  const got = await s.recall("speedrun");
  assert.deepEqual(got.map((r) => r.text), ["close", "edge"]);
  assert.deepEqual(embedded, ["speedrun"]);
  assert.match(queries[0]!.sql, /interval '2 minutes'.*ORDER BY embedding <=> \$1 LIMIT \$2/);
  assert.deepEqual(queries[0]!.params, ["[0.5,-1,2]", 3]); // default k from config
  await s.recall("x", 7);
  assert.equal(queries[1]!.params![1], 7);
});

// @spec MEM-RECALL-005, MEM-RECALL-006
test("recall: k=0 skips the database, and failures return nothing instead of throwing", async () => {
  const { s, queries } = store();
  assert.deepEqual(await s.recall("x", 0), []);
  assert.equal(queries.length, 0);
  const down = store({ fail: () => true });
  assert.deepEqual(await down.s.recall("x"), []);
  assert.equal(down.warnings.length, 1);
});

// @spec MEM-VIEWER-001, MEM-VIEWER-003, MEM-VIEWER-004
test("touchViewer keys viewers case-insensitively and flags first-timers", async () => {
  let count = 1;
  const { s, queries } = store({ rows: () => [{ msg_count: count, notes: "likes cats", first_seen: new Date(), last_seen: new Date() }] });
  assert.deepEqual(await s.touchViewer("BoB123", "Bob"), { msgCount: 1, notes: "likes cats", isNew: true });
  assert.deepEqual(queries[0]!.params, ["bob123", "Bob"]);
  assert.match(queries[0]!.sql, /ON CONFLICT \(user_key\) DO UPDATE .*msg_count = viewers\.msg_count \+ 1/);
  count = 2;
  assert.equal((await s.touchViewer("bob123", "Bob")).isNew, false);
});

// @spec MEM-STORE-003
test("meta get/set and recentSince", async () => {
  const meta = new Map<string, string>();
  const { s, queries } = store({
    rows: (q) => {
      if (q.sql.startsWith("INSERT INTO meta")) { meta.set(q.params![0] as string, q.params![1] as string); return []; }
      if (q.sql.startsWith("SELECT v FROM meta")) { const v = meta.get(q.params![0] as string); return v === undefined ? [] : [{ v }]; }
      return [{ id: 1, ts: new Date(0), kind: "self", who: "Coco", text: "hi" }];
    },
  });
  assert.equal(await s.getMeta("last_reflection"), undefined);
  await s.setMeta("last_reflection", "2026-10-01");
  assert.equal(await s.getMeta("last_reflection"), "2026-10-01");
  const since = "2026-10-01T00:00:00.123456Z";
  assert.equal((await s.recentSince({ ts: since, id: 7 })).length, 1);
  assert.deepEqual(queries.at(-1)!.params, [since, 7, 400]); // microsecond text goes to Postgres untouched
  assert.match(queries.at(-1)!.sql, /to_char\(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS "tsText"/);
  assert.match(queries.at(-1)!.sql, /WHERE \(ts, id\) > \(\$1::timestamptz, \$2\) ORDER BY ts, id LIMIT \$3/);
});

// @spec MEM-VIEWER-001
test("touchViewer inserts a new viewer row with msg_count 1", async () => {
  const { s, queries } = store({ rows: () => [{ msg_count: 1, notes: "", first_seen: new Date(), last_seen: new Date() }] });
  await s.touchViewer("Bob", "Bob");
  assert.match(queries[0]!.sql, /^INSERT INTO viewers \(user_key, display, msg_count\) VALUES \(\$1,\$2,1\) ON CONFLICT/);
});

// @spec MEM-STORE-002
test("init fails with an error naming both dimensions when the existing table has another vector size", async () => {
  const mismatch = store({ rows: (q) => (q.sql.includes("pg_attribute") ? [{ dims: 768 }] : []) });
  await assert.rejects(mismatch.s.init(), (err: unknown) => {
    assert.ok(err instanceof DimensionMismatchError);
    assert.equal(err.name, "DimensionMismatchError");
    assert.match(err.message, /768/);
    assert.match(err.message, /\b3\b/);
    return true;
  });
  assert.ok(!mismatch.queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS viewers")));
  const same = store({ rows: (q) => (q.sql.includes("pg_attribute") ? [{ dims: 3 }] : []) });
  await same.s.init();
  assert.ok(same.queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS meta")));
});

// @spec MEM-HEALTH-005
test("deps.postgres follows the outcome of the latest pool query", async () => {
  const h = new MemoryHealth();
  h.setPostgres(true);
  let down = false;
  const { s } = store({ fail: () => down, onQuery: (ok) => h.setPostgres(ok) });
  const deps = async () => (await runHeartbeat(h.spec))[1]!;
  down = true;
  await s.remember("chat", "bob", "x"); // swallows the error, but the query failed
  assert.deepEqual((await deps()).deps, { postgres: "down", ollama: "down" });
  down = false;
  await s.getMeta("k");
  assert.deepEqual((await deps()).deps, { postgres: "ok", ollama: "down" });
});
