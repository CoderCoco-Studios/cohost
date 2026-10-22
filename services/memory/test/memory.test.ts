import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLearned, learnedBlock, parseBullets } from "../src/learned.js";
import { MemoryStore } from "../src/store.js";

// ---- reflection → personality.md

test("parseBullets keeps only bullet lines, trimmed", () => {
  const raw = "Sure! Here's what I learned:\n\n- bob loves speedruns\n  - running joke: the cursed sword  \n* not this\n-nor this\nThanks!";
  assert.deepEqual(parseBullets(raw), ["- bob loves speedruns", "- running joke: the cursed sword"]);
  assert.deepEqual(parseBullets("no bullets at all"), []);
});

test("appendLearned adds the heading the first time, then appends dated blocks under it", () => {
  const block1 = learnedBlock(["- a", "- b"], "2026-10-01");
  assert.equal(block1, "\n### 2026-10-01\n- a\n- b\n");
  const once = appendLearned("# Coco\n\n## Rules\n- be nice\n\n\n", block1);
  assert.equal(once, "# Coco\n\n## Rules\n- be nice\n\n## Learned\n\n### 2026-10-01\n- a\n- b\n");
  const twice = appendLearned(once, learnedBlock(["- c"], "2026-10-08"));
  assert.equal(twice, `${once.trimEnd()}\n\n### 2026-10-08\n- c\n`);
  assert.equal(twice.match(/## Learned/g)!.length, 1);
});

// ---- MemoryStore against a recording fake pool

type Query = { sql: string; params?: unknown[] };
function store(opts: { rows?: (q: Query) => unknown[]; fail?: (q: Query) => boolean; embed?: (t: string) => Promise<number[]> } = {}) {
  const queries: Query[] = [];
  const warnings: unknown[] = [];
  const embedded: string[] = [];
  const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
  const embedder = { embed: opts.embed ?? (async (t: string) => { embedded.push(t); return [0.5, -1, 2]; }) };
  const s = new MemoryStore(embedder, { recall_k: 3, min_similarity: 0.4 }, log);
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

test("init sizes the vector column from a probe embedding and survives a missing hnsw index", async () => {
  const { s, queries, warnings } = store({ fail: (q) => q.sql.includes("hnsw") });
  await s.init();
  assert.ok(queries.some((q) => q.sql.includes("CREATE EXTENSION IF NOT EXISTS vector")));
  assert.ok(queries.some((q) => q.sql.includes("embedding vector(3)")));
  assert.ok(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS viewers")));
  assert.ok(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS meta")));
  assert.equal(warnings.length, 1);
});

test("remember embeds 'who: text' and stores the vector as a pgvector literal", async () => {
  const { s, queries, embedded } = store();
  await s.remember("chat", "bob", "I love speedruns");
  assert.deepEqual(embedded, ["bob: I love speedruns"]);
  assert.match(queries[0]!.sql, /^INSERT INTO memories/);
  assert.deepEqual(queries[0]!.params, ["chat", "bob", "I love speedruns", "[0.5,-1,2]"]);
});

test("remember never throws: a failed embed or insert is a warning", async () => {
  const bad = store({ embed: async () => { throw new Error("ollama down"); } });
  await bad.s.remember("chat", "bob", "x");
  assert.equal(bad.queries.length, 0);
  assert.equal(bad.warnings.length, 1);
  const dbDown = store({ fail: () => true });
  await dbDown.s.remember("chat", "bob", "x");
  assert.equal(dbDown.warnings.length, 1);
});

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

test("recall: k=0 skips the database, and failures return nothing instead of throwing", async () => {
  const { s, queries } = store();
  assert.deepEqual(await s.recall("x", 0), []);
  assert.equal(queries.length, 0);
  const down = store({ fail: () => true });
  assert.deepEqual(await down.s.recall("x"), []);
  assert.equal(down.warnings.length, 1);
});

test("touchViewer keys viewers case-insensitively and flags first-timers", async () => {
  let count = 1;
  const { s, queries } = store({ rows: () => [{ msg_count: count, notes: "likes cats", first_seen: new Date(), last_seen: new Date() }] });
  assert.deepEqual(await s.touchViewer("BoB123", "Bob"), { msgCount: 1, notes: "likes cats", isNew: true });
  assert.deepEqual(queries[0]!.params, ["bob123", "Bob"]);
  assert.match(queries[0]!.sql, /ON CONFLICT \(user_key\) DO UPDATE .*msg_count = viewers\.msg_count \+ 1/);
  count = 2;
  assert.equal((await s.touchViewer("bob123", "Bob")).isNew, false);
});

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
  const since = new Date("2026-10-01");
  assert.equal((await s.recentSince(since)).length, 1);
  assert.deepEqual(queries.at(-1)!.params, [since, 400]);
  assert.match(queries.at(-1)!.sql, /WHERE ts > \$1 ORDER BY ts ASC LIMIT \$2/);
});
