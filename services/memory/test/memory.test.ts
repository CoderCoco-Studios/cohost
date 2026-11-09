import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLearned, learnedBlock, parseBullets } from "../src/learned.js";
import { DimensionMismatchError, MemoryStore } from "../src/store.js";
import { MemoryHealth } from "../src/health.js";
import { runHeartbeat, testConfig } from "@cohost/testing";

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
  const s = new MemoryStore(embedder, { ...testConfig().brain.memory, recall_k: 3, min_similarity: 0.4 }, log, opts.onQuery);
  const query = async (sql: string, params?: unknown[]) => {
    const q = { sql: sql.replace(/\s+/g, " ").trim(), params };
    queries.push(q);
    if (opts.fail?.(q)) throw new Error("db down");
    const rows = opts.rows?.(q) ?? [];
    return { rows, rowCount: rows.length };
  };
  let released = 0;
  const pool = {
    query,
    connect: async () => ({ query, release: () => { released++; } }),
    released: () => released,
    end: async () => {},
  };
  void (s as unknown as { pool: { end(): Promise<void> } }).pool.end();
  (s as unknown as { pool: unknown }).pool = pool;
  return { s, queries, warnings, embedded, pool };
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

// @spec MEM-STORE-001
test("init creates the notes tables with embeddings and adds the viewer columns without dropping anything", async () => {
  const { s, queries } = store();
  await s.init();
  const sql = queries.map((q) => q.sql);
  const notes = sql.find((q) => q.includes("CREATE TABLE IF NOT EXISTS viewer_notes"))!;
  for (const col of ["layer TEXT", "category TEXT", "hint TEXT", "strength DOUBLE PRECISION", "strength_at TIMESTAMPTZ", "mentions INT", "dirty BOOLEAN", "version INT", "last_surfaced_at TIMESTAMPTZ", "embedding vector(3)"]) {
    assert.ok(notes.includes(col), `viewer_notes has ${col}`);
  }
  const deletions = sql.find((q) => q.includes("CREATE TABLE IF NOT EXISTS viewer_note_deletions"))!;
  for (const col of ["reason TEXT", "deleted_at TIMESTAMPTZ", "embedding vector(3)", "strength DOUBLE PRECISION"]) assert.ok(deletions.includes(col), `viewer_note_deletions has ${col}`);
  const viewersTable = sql.findIndex((q) => q.includes("CREATE TABLE IF NOT EXISTS viewers ("));
  for (const col of ["regular_manual", "is_sub", "placeholder"]) {
    const at = sql.findIndex((q) => q.startsWith(`ALTER TABLE viewers ADD COLUMN IF NOT EXISTS ${col} `));
    assert.ok(at > viewersTable, `viewers gains ${col} after the table is ensured`);
  }
  assert.ok(!sql.some((q) => /DROP |TRUNCATE|DELETE FROM viewers/i.test(q)), "no destructive statement");
  assert.ok(sql[viewersTable]!.includes("notes TEXT"), "the legacy notes column stays");
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

// @spec MEM-VIEWER-001, MEM-VIEWER-003, MEM-REG-001, MEM-REG-005
test("touchViewer keys viewers case-insensitively, flags first-timers, stores isSub and derives regular", async () => {
  let row: Record<string, unknown> = { msg_count: 1, notes: "likes cats", regular_manual: false };
  const { s, queries } = store({ rows: (q) => (q.sql.startsWith("INSERT INTO viewers") ? [row] : []) });
  assert.deepEqual(await s.touchViewer("BoB123", "Bob", { isSub: true }), { msgCount: 1, notes: "likes cats", isNew: true, regular: false });
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO viewers"))!;
  assert.deepEqual(insert.params, ["bob123", "Bob", true]);
  assert.match(insert.sql, /ON CONFLICT \(user_key\) DO UPDATE .*msg_count = viewers\.msg_count \+ 1.*is_sub = EXCLUDED\.is_sub/);
  row = { msg_count: 2, notes: "", regular_manual: false };
  assert.equal((await s.touchViewer("bob123", "Bob")).isNew, false);
  assert.equal((await s.touchViewer("bob123", "Bob")).regular, false);
  row = { msg_count: 26, notes: "", regular_manual: false }; // default threshold 25: above it
  assert.equal((await s.touchViewer("bob123", "Bob")).regular, true);
  row = { msg_count: 2, notes: "", regular_manual: true }; // the owner's flag
  assert.equal((await s.touchViewer("bob123", "Bob")).regular, true);
});

// @spec MEM-REG-004
test("touchViewer first tries to claim a placeholder with the same display for a key that has no row", async () => {
  const { s, queries } = store({ rows: (q) => (q.sql.startsWith("UPDATE viewers") ? [{ msg_count: 1, notes: "", regular_manual: true }] : []) });
  assert.deepEqual(await s.touchViewer("Id77", "Pat"), { msgCount: 1, notes: "", isNew: true, regular: true });
  assert.equal(queries.length, 1, "a claimed placeholder needs no upsert");
  assert.match(queries[0]!.sql, /SET user_key = \$1, display = \$2, placeholder = false, msg_count = msg_count \+ 1/);
  assert.match(queries[0]!.sql, /p\.placeholder AND lower\(p\.display\) = lower\(\$2\) AND NOT EXISTS \(SELECT 1 FROM viewers e WHERE e\.user_key = \$1\)/);
  assert.deepEqual(queries[0]!.params, ["id77", "Pat", false]);
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
  const { s, queries } = store({ rows: (q) => (q.sql.startsWith("INSERT INTO viewers") ? [{ msg_count: 1, notes: "", regular_manual: false }] : []) });
  await s.touchViewer("Bob", "Bob");
  assert.match(queries.at(-1)!.sql, /^INSERT INTO viewers \(user_key, display, msg_count, is_sub\) VALUES \(\$1,\$2,1,\$3\) ON CONFLICT/);
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

// @spec MEM-CONSOL-010
test("the consolidation lock is a session advisory lock: taken, held while fn runs, released after, and a pass without it does not run", async () => {
  const held = store({ rows: (q) => (q.sql.startsWith("SELECT pg_try_advisory_lock") ? [{ locked: true }] : []) });
  const out = await held.s.withConsolidationLock(async () => { held.queries.push({ sql: "FN", params: [] }); return 7; });
  assert.deepEqual(out, { ran: true, value: 7 });
  assert.deepEqual(held.queries.map((q) => q.sql.split(" (")[0]!.split("(")[0]), ["SELECT pg_try_advisory_lock", "FN", "SELECT pg_advisory_unlock"]);
  assert.equal(held.queries[0]!.params![0], held.queries[2]!.params![0], "same lock key");
  assert.equal(held.pool.released(), 1);
  const busy = store({ rows: (q) => (q.sql.startsWith("SELECT pg_try_advisory_lock") ? [{ locked: false }] : []) });
  let ran = false;
  assert.deepEqual(await busy.s.withConsolidationLock(async () => { ran = true; }), { ran: false });
  assert.equal(ran, false);
  assert.equal(busy.queries.length, 1, "no unlock for a lock never taken");
  assert.equal(busy.pool.released(), 1);
  const boom = store({ rows: (q) => (q.sql.startsWith("SELECT pg_try_advisory_lock") ? [{ locked: true }] : []) });
  await assert.rejects(boom.s.withConsolidationLock(async () => { throw new Error("pass failed"); }), /pass failed/);
  assert.ok(boom.queries.some((q) => q.sql.startsWith("SELECT pg_advisory_unlock")), "unlocked after a throw");
});

// @spec MEM-CONSOL-007, MEM-CONSOL-008, MEM-NOTE-004
test("commitViewer runs in one transaction, locks the viewer's notes and writes only notes still at the version it read", async () => {
  const current = [{ id: "1", version: 2, category: "general", hint: null }, { id: "2", version: 1, category: "general", hint: null }, { id: "3", version: 1, category: "general", hint: null }];
  const { s, queries } = store({ rows: (q) => (q.sql.startsWith("SELECT id, version") ? current : []) });
  await s.commitViewer("BOB", [
    { kind: "update", id: 1, version: 2, set: { text: "new text", layer: "core" } },
    { kind: "update", id: 2, version: 9, set: { text: "stale" } }, // read at an older version
    { kind: "delete", id: 3, version: 1 },
    { kind: "clean", id: 4, version: 1 }, // deleted meanwhile
  ]);
  const sql = queries.map((q) => q.sql);
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql.at(-1), "COMMIT");
  assert.match(sql[1]!, /^SELECT id, version, category, hint FROM viewer_notes WHERE user_key = \$1 FOR UPDATE$/);
  assert.deepEqual(queries[1]!.params, ["bob"]);
  const updates = queries.filter((q) => q.sql.startsWith("UPDATE viewer_notes SET layer"));
  assert.equal(updates.length, 1, "only the note at its read version is rewritten");
  assert.match(updates[0]!.sql, /dirty = false, version = version \+ 1 WHERE id = \$1 AND version = \$2/);
  assert.deepEqual(updates[0]!.params!.slice(0, 2), [1, 2]);
  assert.deepEqual(queries.filter((q) => q.sql.startsWith("DELETE FROM viewer_notes")).map((q) => q.params), [[3, 1]]);
  assert.equal(queries.filter((q) => q.sql.includes("SET dirty = false")).length, 0);
});

// @spec MEM-CONSOL-007
test("commitViewer rolls back when a statement fails, so a viewer is committed whole or not at all", async () => {
  const { s, queries } = store({ rows: (q) => (q.sql.startsWith("SELECT id, version") ? [{ id: "1", version: 1, category: "general", hint: null }] : []), fail: (q) => q.sql.startsWith("UPDATE viewer_notes") });
  await assert.rejects(s.commitViewer("bob", [{ kind: "update", id: 1, version: 1, set: { text: "x" } }]), /db down/);
  assert.equal(queries.at(-1)!.sql, "ROLLBACK");
  assert.ok(!queries.some((q) => q.sql === "COMMIT"));
});

// @spec MEM-NOTE-004, MEM-NOTE-005
test("reinforceNote reads the note under a row lock, then writes the reinforced strength, mentions + 1, dirty and version + 1", async () => {
  const note = { id: "5", user_key: "bob", layer: "recent", category: "general", text: "t", hint: null, strength: 0.5, strength_at: new Date(Date.UTC(2026, 0, 1)), mentions: 1, dirty: false, version: 3, created_at: new Date(), last_surfaced_at: null, embedding: "[1,2,3]" };
  const { s, queries } = store({ rows: (q) => (q.sql.includes("FROM viewer_notes WHERE id = $1 FOR UPDATE") || q.sql.startsWith("UPDATE viewer_notes") ? [note] : []) });
  (s as unknown as { clock: () => number }).clock = () => Date.UTC(2026, 0, 1); // no time passed: effective 0.5
  await s.reinforceNote(5);
  const update = queries.find((q) => q.sql.startsWith("UPDATE viewer_notes"))!;
  assert.match(update.sql, /strength = \$2, strength_at = \$3, mentions = mentions \+ 1, dirty = true, version = version \+ 1/);
  assert.ok(Math.abs((update.params![1] as number) - 0.8) < 1e-9);
  assert.deepEqual(queries.map((q) => q.sql).filter((x) => x === "BEGIN" || x === "COMMIT"), ["BEGIN", "COMMIT"]);
});

// @spec MEM-CONSOL-016
test("purging deletes only deletion records without a reason older than the cutoff", async () => {
  const { s, queries } = store({ rows: () => [] });
  const cutoff = new Date("2026-01-01T00:00:00Z");
  await s.purgeSoftDeletions(cutoff);
  assert.match(queries[0]!.sql, /^DELETE FROM viewer_note_deletions WHERE reason IS NULL AND deleted_at < \$1$/);
  assert.deepEqual(queries[0]!.params, [cutoff]);
});

// @spec MEM-NOTE-001, MEM-NOTE-010
test("insertNote embeds the text, defaults a sensitive hint and stores strength clamped to 0..1", async () => {
  const row = { id: "1", user_key: "bob", layer: "recent", category: "health", text: "t", hint: "h", strength: 1, strength_at: new Date(), mentions: 1, dirty: true, version: 1, created_at: new Date(), last_surfaced_at: null, embedding: "[0.5,-1,2]" };
  const { s, queries, embedded } = store({ rows: () => [row] });
  const n = await s.insertNote({ userKey: "BOB", category: "health", text: " had surgery ", strength: 4 });
  assert.deepEqual(embedded, ["had surgery"]);
  assert.match(queries[0]!.sql, /^INSERT INTO viewer_notes \(user_key, layer, category, text, hint, strength, strength_at, mentions, dirty, version, embedding\)/);
  const p = queries[0]!.params!;
  assert.deepEqual([p[0], p[1], p[2], p[3], p[4], p[5], p[7], p[8], p[9]], ["bob", "recent", "health", "had surgery", "only if they bring it up; never quote it", 1, 1, true, "[0.5,-1,2]"]);
  assert.deepEqual(n.embedding, [0.5, -1, 2]);
});
