import pg from "pg";
import { urls, type Config, type Logger } from "@cohost/config";
import type { Embedder } from "@cohost/llm";

export type MemoryKind = "chat" | "speech" | "self" | "note";

export interface Memory {
  id: number;
  ts: Date;
  kind: MemoryKind;
  who: string;
  text: string;
  similarity?: number;
}

/**
 * Long-term memory: every meaningful exchange is embedded and stored in
 * Postgres (pgvector). Recall = cosine similarity against the current moment.
 * Viewer table tracks who's a regular.
 */
export class MemoryStore {
  private pool: pg.Pool;
  private dims: number | undefined;

  constructor(private llm: Embedder, private cfg: Config["brain"]["memory"], private log: Logger) {
    this.pool = new pg.Pool({ connectionString: urls.database(), max: 4 });
  }

  async init(): Promise<void> {
    // Probe embedding size so the table matches whatever model is configured.
    this.dims = (await this.llm.embed("hello")).length;
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind TEXT NOT NULL,
        who TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding vector(${this.dims})
      )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS viewers (
        user_key TEXT PRIMARY KEY,
        display TEXT NOT NULL,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        msg_count INT NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT ''
      )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
    ).catch((e) => this.log.warn({ e: String(e) }, "hnsw index not created (fine on tiny tables)"));
    this.log.info({ dims: this.dims }, "memory ready");
  }

  async remember(kind: MemoryKind, who: string, text: string): Promise<void> {
    try {
      const emb = await this.llm.embed(`${who}: ${text}`);
      await this.pool.query(
        "INSERT INTO memories (kind, who, text, embedding) VALUES ($1,$2,$3,$4)",
        [kind, who, text, toVector(emb)],
      );
    } catch (err) {
      this.log.warn({ err }, "remember failed");
    }
  }

  async recall(query: string, k = this.cfg.recall_k): Promise<Memory[]> {
    if (k <= 0) return [];
    try {
      const emb = toVector(await this.llm.embed(query));
      const { rows } = await this.pool.query<Memory & { similarity: number }>(
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

  async touchViewer(userKey: string, display: string): Promise<{ msgCount: number; notes: string; isNew: boolean }> {
    const { rows } = await this.pool.query<{ msg_count: number; notes: string; first_seen: Date; last_seen: Date }>(
      `INSERT INTO viewers (user_key, display) VALUES ($1,$2)
       ON CONFLICT (user_key) DO UPDATE SET display = EXCLUDED.display, last_seen = now(), msg_count = viewers.msg_count + 1
       RETURNING msg_count, notes, first_seen, last_seen`,
      [userKey.toLowerCase(), display],
    );
    const r = rows[0]!;
    return { msgCount: r.msg_count, notes: r.notes, isNew: r.msg_count <= 1 };
  }

  async recentSince(ts: Date, limit = 400): Promise<Memory[]> {
    const { rows } = await this.pool.query<Memory>(
      "SELECT id, ts, kind, who, text FROM memories WHERE ts > $1 ORDER BY ts ASC LIMIT $2",
      [ts, limit],
    );
    return rows;
  }

  async getMeta(k: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ v: string }>("SELECT v FROM meta WHERE k=$1", [k]);
    return rows[0]?.v;
  }
  async setMeta(k: string, v: string): Promise<void> {
    await this.pool.query("INSERT INTO meta (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [k, v]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
