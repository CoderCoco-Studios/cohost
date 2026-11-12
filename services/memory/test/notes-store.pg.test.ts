/**
 * The same store contract, plus the Postgres-only behaviour, against a real Postgres with the pgvector extension.
 * Set COHOST_TEST_DATABASE_URL (for example postgres://cohost:cohost@127.0.0.1:5432/cohost_test); CI does. Without it, or
 * outside CI when the database does not answer, the file skips with a message saying so. In CI an unreachable database
 * fails the run, so the coverage cannot disappear silently. The first run creates the tables, every test uses fresh keys,
 * so a database can be shared across runs; the re-embedding test restores the 64-dimension columns before it ends.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { HashEmbedder, type Embedder } from "@cohost/llm";
import { testConfig, silentLog } from "@cohost/testing";
import { DimensionMismatchError, MemoryStore } from "../src/store.js";
import { registerStoreContract, T0, uid, type Harness } from "./store-contract.js";

const url = process.env.COHOST_TEST_DATABASE_URL;
const REGULAR = 3;

/** Whether the database answers within 3 s. */
async function reachable(connectionString: string): Promise<string | undefined> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
  try { await client.connect(); await client.query("SELECT 1"); return undefined; }
  catch (err) { return err instanceof Error ? err.message : String(err); }
  finally { await client.end().catch(() => {}); }
}

const unreachable = url ? await reachable(url) : undefined;
if (unreachable && process.env.CI) throw new Error(`COHOST_TEST_DATABASE_URL is set but Postgres is unreachable in CI: ${unreachable}`);

if (!url) {
  test("MemoryStore against real Postgres: skipped, COHOST_TEST_DATABASE_URL is not set", { skip: "set COHOST_TEST_DATABASE_URL to a pgvector database to run" }, () => {});
} else if (unreachable) {
  test("MemoryStore against real Postgres: skipped, the database does not answer", { skip: `Postgres at COHOST_TEST_DATABASE_URL is unreachable (${unreachable})` }, () => {});
} else {
  process.env.DATABASE_URL = url;
  const stores: MemoryStore[] = [];
  const cfg = () => testConfig({ brain: { memory: { regular_messages: REGULAR } } }).brain.memory;
  const open = (embedder: Embedder, clock?: () => number): MemoryStore => {
    const s = new MemoryStore(embedder, cfg(), silentLog, undefined, clock);
    stores.push(s);
    return s;
  };
  let initialised = false;
  registerStoreContract("MemoryStore (postgres)", async (): Promise<Harness> => {
    let now = T0;
    const store = open(new HashEmbedder(), () => now);
    if (!initialised) { await store.init(); initialised = true; } // idempotent; a second store needs no init because the schema exists
    return { store, advance: (ms) => { now += ms; }, now: () => now };
  }, { regular_messages: REGULAR });

  /** A fixed-size embedder: every text maps to the same unit-ish vector of `dims` numbers. */
  const sized = (dims: number): Embedder => ({ embed: async () => new Array<number>(dims).fill(1 / Math.sqrt(dims)) }) as Embedder;

  // @spec MEM-REFLECT-011
  test("MemoryStore (postgres): connect finds the tables the service created, without any embedder", async () => {
    const seed = open(new HashEmbedder());
    await seed.init();
    const reader = open({ embed: async () => { throw new Error("no embedder here"); } } as Embedder);
    await reader.connect();
    assert.deepEqual((await reader.recentSince({ ts: "9999-01-01T00:00:00.000Z", id: 0 }, 5)), []);
  });

  // @spec MEM-CONSOL-010, MEM-REFLECT-012
  test("MemoryStore (postgres): the consolidation lock is exclusive across connections and released afterwards", async () => {
    const a = open(new HashEmbedder());
    const b = open(new HashEmbedder());
    const inner = await a.withConsolidationLock(async () => b.withConsolidationLock(async () => "never"));
    assert.deepEqual(inner, { ran: true, value: { ran: false } });
    assert.deepEqual(await b.withConsolidationLock(async () => "free"), { ran: true, value: "free" });
  });

  // @spec MEM-STORE-002, MEM-REEMBED-001, MEM-REEMBED-002, MEM-REEMBED-003, MEM-REEMBED-004
  test("MemoryStore (postgres): a table at another dimension is refused, reembed moves every vector, and the rows survive both ways", async () => {
    const base = open(new HashEmbedder()); // 64 dimensions
    await base.init();
    const tag = uid("reembed");
    await base.remember("chat", "bob", `${tag} the cursed sword`);
    await base.touchViewer(tag, "Bob");
    const note = await base.insertNote({ userKey: tag, category: "general", text: `${tag} plays celeste` });
    await base.deleteNote((await base.insertNote({ userKey: tag, category: "general", text: `${tag} dropped note` })).id, "owner said so");

    const small = open(sized(32));
    try {
      await assert.rejects(small.init(), (err: unknown) => {
        assert.ok(err instanceof DimensionMismatchError, "startup refuses the mismatching table (MEM-STORE-002)");
        assert.equal(err.embedderDims, 32);
        assert.equal(err.tableDims, 64);
        return true;
      });
      const res = await small.reembed();
      assert.equal(res.dims, 32);
      assert.ok(res.tables.memories! >= 1 && res.tables.viewer_notes! >= 1 && res.tables.viewer_note_deletions! >= 1, JSON.stringify(res));
      await small.init(); // the 32-dimension embedder is now accepted
      assert.deepEqual(await small.reembed(), { dims: 32, tables: {} }, "a second run finds nothing to do");
      assert.equal((await small.listNotes(tag)).find((n) => n.id === note.id)?.text, `${tag} plays celeste`, "notes keep their text and ids");
      assert.equal((await small.listDeletions(tag)).length, 1);
      assert.ok((await small.recentSince({ ts: "1970-01-01T00:00:00.000Z", id: 0 }, 1_000_000)).some((m) => m.text === `${tag} the cursed sword`));
    } finally {
      await open(new HashEmbedder()).reembed(); // back to the 64 dimensions every other test expects
    }
    await open(new HashEmbedder()).init();
  });

  after(async () => { await Promise.all(stores.map((s) => s.close())); });
}
