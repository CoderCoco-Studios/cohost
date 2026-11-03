import pg from "pg";
import { urls, type Config, type Logger } from "@cohost/config";
import type { Embedder } from "@cohost/llm";
import { tracked } from "@cohost/bus";
import type { ReflectCursor } from "./cursor.js";

export type MemoryKind = "chat" | "speech" | "self" | "note";

export interface Memory {
  id: number;
  ts: Date;
  kind: MemoryKind;
  who: string;
  text: string;
  similarity?: number;
  /** Set by `recentSince` on Postgres: `ts` as ISO UTC text with microsecond precision (a JS `Date` keeps only milliseconds). */
  tsText?: string;
}

/** What the region needs from a memory store: Postgres-backed (MemoryStore) or in-process (InMemoryStore). */
export interface MemoryBackend {
  init(): Promise<void>;
  remember(kind: MemoryKind, who: string, text: string): Promise<void>;
  recall(query: string, k?: number): Promise<Memory[]>;
  touchViewer(userKey: string, display: string): Promise<{ msgCount: number; notes: string; isNew: boolean }>;
  recentSince(after: ReflectCursor, limit?: number): Promise<Memory[]>;
  getMeta(k: string): Promise<string | undefined>;
  setMeta(k: string, v: string): Promise<void>;
  close(): Promise<void>;
}

/** The `memories` table already exists with a different vector size than the configured embedder produces. */
export class DimensionMismatchError extends Error {
  readonly code = "MEMORY_DIM_MISMATCH";
  constructor(readonly tableDims: number, readonly embedderDims: number) {
    super(
      `memories table has vector(${tableDims}) but the configured embedder produces ${embedderDims}-dimension vectors; ` +
      "use the embedder the table was created with, or start from an empty database",
    );
    this.name = "DimensionMismatchError";
  }
}

/**
 * Long-term memory: every meaningful exchange is embedded and stored in
 * Postgres (pgvector). Recall = cosine similarity against the current moment.
 * Viewer table tracks who's a regular.
 */
export class MemoryStore implements MemoryBackend {
  private pool: pg.Pool;
  private dims: number | undefined;

  /** Every pool query goes through here so `onQuery` sees each outcome. */
  private run = tracked(<R>(go: () => Promise<R>) => go(), (ok) => this.onQuery?.(ok));

  /** `onQuery(ok)` is called after every Postgres query with its outcome (feeds `deps.postgres`). */
  constructor(private llm: Embedder, private cfg: Config["brain"]["memory"], private log: Logger, private onQuery?: (ok: boolean) => void) {
    this.pool = new pg.Pool({ connectionString: urls.database(), max: 4 });
  }

  // @spec MEM-HEALTH-005
  private query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.run(() => this.pool.query<R>(sql, params)) as Promise<pg.QueryResult<R>>;
  }

  // @spec MEM-STORE-001
  async init(): Promise<void> {
    // Probe embedding size so the table matches whatever model is configured.
    this.dims = (await this.llm.embed("hello")).length;
    await this.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind TEXT NOT NULL,
        who TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding vector(${this.dims})
      )`);
    await this.checkDimensions();
    await this.query(`
      CREATE TABLE IF NOT EXISTS viewers (
        user_key TEXT PRIMARY KEY,
        display TEXT NOT NULL,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        msg_count INT NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT ''
      )`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await this.query(
      "CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
    ).catch((e) => this.log.warn({ e: String(e) }, "hnsw index not created (fine on tiny tables)"));
    this.log.info({ dims: this.dims }, "memory ready");
  }

  // @spec MEM-STORE-002
  /** pgvector keeps a column's dimension in `atttypmod` (-1 when unconstrained). */
  private async checkDimensions(): Promise<void> {
    const { rows } = await this.query<{ dims: number }>(
      "SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = to_regclass('memories') AND attname = 'embedding'",
    );
    const tableDims = Number(rows[0]?.dims);
    if (tableDims > 0 && tableDims !== this.dims) throw new DimensionMismatchError(tableDims, this.dims!);
  }

  // @spec MEM-WRITE-004, MEM-WRITE-005
  async remember(kind: MemoryKind, who: string, text: string): Promise<void> {
    try {
      const emb = await this.llm.embed(`${who}: ${text}`);
      await this.query(
        "INSERT INTO memories (kind, who, text, embedding) VALUES ($1,$2,$3,$4)",
        [kind, who, text, toVector(emb)],
      );
    } catch (err) {
      this.log.warn({ err }, "remember failed");
    }
  }

  // @spec MEM-RECALL-002, MEM-RECALL-003, MEM-RECALL-004, MEM-RECALL-005, MEM-RECALL-006
  async recall(query: string, k = this.cfg.recall_k): Promise<Memory[]> {
    if (k <= 0) return [];
    try {
      const emb = toVector(await this.llm.embed(query));
      const { rows } = await this.query<Memory & { similarity: number }>(
        `SELECT id, ts, kind, who, text, 1 - (embedding <=> $1) AS similarity
           FROM memories
          WHERE ts < now() - interval '2 minutes'
          ORDER BY embedding <=> $1
          LIMIT $2`,
        [emb, k],
      );
      return rows.filter((r) => r.similarity >= this.cfg.min_similarity);
    } catch (err) {
      this.log.warn({ err }, "recall failed");
      return [];
    }
  }

  // @spec MEM-VIEWER-001, MEM-VIEWER-003, MEM-VIEWER-004
  async touchViewer(userKey: string, display: string): Promise<{ msgCount: number; notes: string; isNew: boolean }> {
    const { rows } = await this.query<{ msg_count: number; notes: string; first_seen: Date; last_seen: Date }>(
      `INSERT INTO viewers (user_key, display, msg_count) VALUES ($1,$2,1)
       ON CONFLICT (user_key) DO UPDATE SET display = EXCLUDED.display, last_seen = now(), msg_count = viewers.msg_count + 1
       RETURNING msg_count, notes, first_seen, last_seen`,
      [userKey.toLowerCase(), display],
    );
    const r = rows[0]!;
    return { msgCount: r.msg_count, notes: r.notes, isNew: r.msg_count <= 1 };
  }

  // @spec MEM-STORE-003, MEM-REFLECT-008
  async recentSince(after: ReflectCursor, limit = 400): Promise<Memory[]> {
    const { rows } = await this.query<Memory>(
      `SELECT id, ts, kind, who, text, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "tsText"
         FROM memories WHERE (ts, id) > ($1::timestamptz, $2) ORDER BY ts, id LIMIT $3`,
      [after.ts, after.id, limit],
    );
    return rows;
  }

  // @spec MEM-STORE-003
  async getMeta(k: string): Promise<string | undefined> {
    const { rows } = await this.query<{ v: string }>("SELECT v FROM meta WHERE k=$1", [k]);
    return rows[0]?.v;
  }
  async setMeta(k: string, v: string): Promise<void> {
    await this.query("INSERT INTO meta (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [k, v]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
