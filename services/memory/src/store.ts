import pg from "pg";
import { urls, type Config, type Logger } from "@cohost/config";
import type { Embedder } from "@cohost/llm";
import { tracked } from "@cohost/bus";
import type { ReflectCursor } from "./cursor.js";
import {
  clamp01, effectiveStrength, reinforcedStrength, withDefaultHint,
  type Category, type DeletionRow, type Layer, type NewNote, type NoteOp, type NoteRow, type ViewerRow,
} from "./notes.js";

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
  /** Count one chat line for the viewer: upsert by lowercased key, keep `display` and the subscriber flag current, claim a matching placeholder row (MEM-REG-004). */
  touchViewer(userKey: string, display: string, opts?: { isSub?: boolean }): Promise<ViewerTouch>;
  getViewer(userKey: string): Promise<ViewerRow | undefined>;
  /** The viewer's row, created with `msg_count` 0 when missing (claiming a matching placeholder like `touchViewer` does) and never counting a message: capture's way to write a note before the `memory` group has seen the line (MEM-CAPTURE-011). */
  ensureViewer(userKey: string, display: string): Promise<ViewerRow>;
  /** Embed `text` with the same embedder the store uses for notes, so the vectors compare with stored note and deletion embeddings (MEM-CAPTURE-005). */
  embedText(text: string): Promise<number[]>;
  /** Set or clear the owner's regular flag by key or display name; a name with no row gets a placeholder when setting (MEM-REG-003). Clearing a name with no row returns undefined. */
  setRegular(keyOrName: string, regular: boolean): Promise<ViewerRow | undefined>;
  insertNote(note: NewNote): Promise<NoteRow>;
  /** Reinforce a note with a fresh mention (MEM-NOTE-005); undefined when it no longer exists. */
  reinforceNote(id: number): Promise<NoteRow | undefined>;
  listNotes(userKey: string): Promise<NoteRow[]>;
  listDeletions(userKey: string): Promise<DeletionRow[]>;
  /** Delete a note and record it (with its effective strength and the trimmed reason, none when blank); false when it does not exist. */
  deleteNote(id: number, reason?: string): Promise<boolean>;
  dirtyNoteCount(): Promise<number>;
  /** Keys of viewers with at least one dirty note. */
  dirtyViewerKeys(): Promise<string[]>;
  /** Apply a consolidation pass's changes for one viewer in one transaction, each only while the note's version is unchanged (MEM-CONSOL-007). */
  commitViewer(userKey: string, ops: NoteOp[]): Promise<void>;
  /** Delete deletion records without a reason older than `olderThan`; returns how many. */
  purgeSoftDeletions(olderThan: Date): Promise<number>;
  /** Run `fn` holding the consolidation lock; `{ ran: false }` when another pass holds it (MEM-CONSOL-010). */
  withConsolidationLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  recentSince(after: ReflectCursor, limit?: number): Promise<Memory[]>;
  getMeta(k: string): Promise<string | undefined>;
  setMeta(k: string, v: string): Promise<void>;
  close(): Promise<void>;
}

export interface ViewerTouch {
  msgCount: number;
  /** The legacy `viewers.notes` text (not written by anything). */
  notes: string;
  isNew: boolean;
  /** MEM-REG-001. */
  regular: boolean;
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
  constructor(
    private llm: Embedder,
    private cfg: Config["brain"]["memory"],
    private log: Logger,
    private onQuery?: (ok: boolean) => void,
    /** Milliseconds since the epoch; injectable so note fade and retention are testable. */
    private clock: () => number = Date.now,
  ) {
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
    // Additive only: an existing viewers table keeps every row and column (including the legacy `notes`).
    await this.query("ALTER TABLE viewers ADD COLUMN IF NOT EXISTS regular_manual BOOLEAN NOT NULL DEFAULT false");
    await this.query("ALTER TABLE viewers ADD COLUMN IF NOT EXISTS is_sub BOOLEAN NOT NULL DEFAULT false");
    await this.query("ALTER TABLE viewers ADD COLUMN IF NOT EXISTS placeholder BOOLEAN NOT NULL DEFAULT false");
    await this.query("CREATE INDEX IF NOT EXISTS viewers_placeholder_idx ON viewers (lower(display)) WHERE placeholder");
    await this.query(`
      CREATE TABLE IF NOT EXISTS viewer_notes (
        id BIGSERIAL PRIMARY KEY,
        user_key TEXT NOT NULL REFERENCES viewers (user_key) ON UPDATE CASCADE ON DELETE CASCADE,
        layer TEXT NOT NULL,
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        hint TEXT,
        strength DOUBLE PRECISION NOT NULL,
        strength_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        mentions INT NOT NULL DEFAULT 1,
        dirty BOOLEAN NOT NULL DEFAULT true,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_surfaced_at TIMESTAMPTZ,
        embedding vector(${this.dims})
      )`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS viewer_note_deletions (
        id BIGSERIAL PRIMARY KEY,
        user_key TEXT NOT NULL REFERENCES viewers (user_key) ON UPDATE CASCADE ON DELETE CASCADE,
        layer TEXT NOT NULL,
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        hint TEXT,
        strength DOUBLE PRECISION NOT NULL,
        reason TEXT,
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        embedding vector(${this.dims})
      )`);
    await this.query("CREATE INDEX IF NOT EXISTS viewer_notes_user_idx ON viewer_notes (user_key)");
    await this.query("CREATE INDEX IF NOT EXISTS viewer_notes_dirty_idx ON viewer_notes (user_key) WHERE dirty");
    await this.query("CREATE INDEX IF NOT EXISTS viewer_note_deletions_user_idx ON viewer_note_deletions (user_key)");
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

  // @spec MEM-VIEWER-001, MEM-VIEWER-003, MEM-REG-001, MEM-REG-004, MEM-REG-005
  async touchViewer(userKey: string, display: string, opts: { isSub?: boolean } = {}): Promise<ViewerTouch> {
    const key = userKey.toLowerCase();
    const isSub = opts.isSub ?? false;
    type Counted = { msg_count: number; notes: string; regular_manual: boolean };
    // A placeholder the owner created before this viewer chatted is re-keyed to the viewer's key (only when that key has no row yet).
    const claimed = await this.query<Counted>(
      `UPDATE viewers SET user_key = $1, display = $2, placeholder = false, msg_count = msg_count + 1, last_seen = now(), is_sub = $3
        WHERE user_key = (SELECT p.user_key FROM viewers p
                           WHERE p.placeholder AND lower(p.display) = lower($2)
                             AND NOT EXISTS (SELECT 1 FROM viewers e WHERE e.user_key = $1)
                           ORDER BY p.last_seen DESC LIMIT 1)
        RETURNING msg_count, notes, regular_manual`,
      [key, display, isSub],
    );
    const { rows } = claimed.rows.length ? claimed : await this.query<Counted>(
      `INSERT INTO viewers (user_key, display, msg_count, is_sub) VALUES ($1,$2,1,$3)
       ON CONFLICT (user_key) DO UPDATE SET display = EXCLUDED.display, last_seen = now(), msg_count = viewers.msg_count + 1, is_sub = EXCLUDED.is_sub, placeholder = false
       RETURNING msg_count, notes, regular_manual`,
      [key, display, isSub],
    );
    const r = rows[0]!;
    return { msgCount: r.msg_count, notes: r.notes, isNew: r.msg_count <= 1, regular: r.regular_manual || r.msg_count > this.cfg.regular_messages };
  }

  async getViewer(userKey: string): Promise<ViewerRow | undefined> {
    const { rows } = await this.query<ViewerSql>(`SELECT ${VIEWER_COLS} FROM viewers WHERE user_key = $1`, [userKey.toLowerCase()]);
    return rows[0] && this.toViewer(rows[0]);
  }

  // @spec MEM-CAPTURE-011, MEM-REG-004
  async ensureViewer(userKey: string, display: string): Promise<ViewerRow> {
    const key = userKey.toLowerCase();
    const existing = await this.getViewer(key);
    if (existing) return existing;
    const claimed = await this.query<ViewerSql>(
      `UPDATE viewers SET user_key = $1, display = $2, placeholder = false
        WHERE user_key = (SELECT p.user_key FROM viewers p
                           WHERE p.placeholder AND lower(p.display) = lower($2)
                             AND NOT EXISTS (SELECT 1 FROM viewers e WHERE e.user_key = $1)
                           ORDER BY p.last_seen DESC LIMIT 1)
        RETURNING ${VIEWER_COLS}`,
      [key, display],
    );
    if (claimed.rows.length) return this.toViewer(claimed.rows[0]!);
    const { rows } = await this.query<ViewerSql>(
      `INSERT INTO viewers (user_key, display, msg_count) VALUES ($1,$2,0)
       ON CONFLICT (user_key) DO UPDATE SET display = viewers.display
       RETURNING ${VIEWER_COLS}`,
      [key, display],
    );
    return this.toViewer(rows[0]!);
  }

  // @spec MEM-CAPTURE-005
  async embedText(text: string): Promise<number[]> {
    return this.llm.embed(text);
  }

  // @spec MEM-REG-001, MEM-REG-003
  async setRegular(keyOrName: string, regular: boolean): Promise<ViewerRow | undefined> {
    const key = keyOrName.toLowerCase();
    const updated = await this.query<ViewerSql>(
      `UPDATE viewers SET regular_manual = $2
        WHERE user_key = COALESCE((SELECT user_key FROM viewers WHERE user_key = $1),
                                  (SELECT user_key FROM viewers WHERE lower(display) = $1 ORDER BY last_seen DESC LIMIT 1))
        RETURNING ${VIEWER_COLS}`,
      [key, regular],
    );
    if (updated.rows.length) return this.toViewer(updated.rows[0]!);
    if (!regular) return undefined;
    const { rows } = await this.query<ViewerSql>(
      `INSERT INTO viewers (user_key, display, msg_count, regular_manual, placeholder) VALUES ($1,$2,0,true,true)
       ON CONFLICT (user_key) DO UPDATE SET regular_manual = true
       RETURNING ${VIEWER_COLS}`,
      [key, keyOrName],
    );
    return this.toViewer(rows[0]!);
  }

  private toViewer(r: ViewerSql): ViewerRow {
    return {
      key: r.user_key, display: r.display, msgCount: r.msg_count, regularManual: r.regular_manual, isSub: r.is_sub,
      placeholder: r.placeholder, firstSeen: r.first_seen, lastSeen: r.last_seen,
      regular: r.regular_manual || r.msg_count > this.cfg.regular_messages,
    };
  }

  /** Run `fn` in a transaction on one pooled connection; every statement still reports to `onQuery`. */
  private async tx<R>(fn: (q: <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<T>>) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => this.run(() => client.query<T>(sql, params)) as Promise<pg.QueryResult<T>>;
    try {
      await q("BEGIN");
      const out = await fn(q);
      await q("COMMIT");
      return out;
    } catch (err) {
      await q("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // @spec MEM-NOTE-001, MEM-NOTE-004, MEM-NOTE-010
  async insertNote(n: NewNote): Promise<NoteRow> {
    const text = n.text.trim();
    const embedding = toVector(n.embedding ?? await this.llm.embed(text));
    const { rows } = await this.query<NoteSql>(
      `INSERT INTO viewer_notes (user_key, layer, category, text, hint, strength, strength_at, mentions, dirty, version, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
       RETURNING ${NOTE_COLS}`,
      [
        n.userKey.toLowerCase(), n.layer ?? "recent", n.category, text, withDefaultHint(n.category, n.hint) ?? null,
        clamp01(n.strength ?? 1), new Date(this.clock()), n.mentions ?? 1, n.dirty ?? true, embedding,
      ],
    );
    return toNote(rows[0]!);
  }

  // @spec MEM-NOTE-004, MEM-NOTE-005
  async reinforceNote(id: number): Promise<NoteRow | undefined> {
    return this.tx(async (q) => {
      const { rows } = await q<NoteSql>(`SELECT ${NOTE_COLS} FROM viewer_notes WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return undefined;
      const n = toNote(rows[0]);
      const now = new Date(this.clock());
      const strength = reinforcedStrength(effectiveStrength(n, now, this.cfg.notes), this.cfg.notes);
      const out = await q<NoteSql>(
        `UPDATE viewer_notes SET strength = $2, strength_at = $3, mentions = mentions + 1, dirty = true, version = version + 1
          WHERE id = $1 RETURNING ${NOTE_COLS}`,
        [id, strength, now],
      );
      return toNote(out.rows[0]!);
    });
  }

  async listNotes(userKey: string): Promise<NoteRow[]> {
    const { rows } = await this.query<NoteSql>(`SELECT ${NOTE_COLS} FROM viewer_notes WHERE user_key = $1 ORDER BY id`, [userKey.toLowerCase()]);
    return rows.map(toNote);
  }

  async listDeletions(userKey: string): Promise<DeletionRow[]> {
    const { rows } = await this.query<DeletionSql>(
      `SELECT id, user_key, layer, category, text, hint, strength, reason, deleted_at, embedding::text AS embedding
         FROM viewer_note_deletions WHERE user_key = $1 ORDER BY id`,
      [userKey.toLowerCase()],
    );
    return rows.map((r) => ({
      id: Number(r.id), userKey: r.user_key, layer: r.layer, category: r.category, text: r.text, hint: r.hint,
      strength: r.strength, reason: r.reason, deletedAt: r.deleted_at, embedding: parseVector(r.embedding),
    }));
  }

  async deleteNote(id: number, reason?: string): Promise<boolean> {
    return this.tx(async (q) => {
      const { rows } = await q<NoteSql>(`SELECT ${NOTE_COLS} FROM viewer_notes WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return false;
      const n = toNote(rows[0]);
      await q("DELETE FROM viewer_notes WHERE id = $1", [id]);
      await q(
        `INSERT INTO viewer_note_deletions (user_key, layer, category, text, hint, strength, reason, deleted_at, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [n.userKey, n.layer, n.category, n.text, n.hint, effectiveStrength(n, this.clock(), this.cfg.notes), reason?.trim() || null, new Date(this.clock()), toVector(n.embedding)],
      );
      return true;
    });
  }

  async dirtyNoteCount(): Promise<number> {
    const { rows } = await this.query<{ n: number }>("SELECT count(*)::int AS n FROM viewer_notes WHERE dirty");
    return rows[0]?.n ?? 0;
  }

  async dirtyViewerKeys(): Promise<string[]> {
    const { rows } = await this.query<{ user_key: string }>("SELECT DISTINCT user_key FROM viewer_notes WHERE dirty ORDER BY user_key");
    return rows.map((r) => r.user_key);
  }

  // @spec MEM-CONSOL-007, MEM-CONSOL-008, MEM-NOTE-004
  async commitViewer(userKey: string, ops: NoteOp[]): Promise<void> {
    const key = userKey.toLowerCase();
    // Rewritten text needs a new embedding; embed before the transaction so no connection waits on the model.
    const embeddings = new Map<number, string>();
    for (const op of ops) if (op.kind === "update" && op.set.text !== undefined) embeddings.set(op.id, toVector(await this.llm.embed(op.set.text.trim())));
    await this.tx(async (q) => {
      const { rows } = await q<{ id: number | string; version: number; category: Category; hint: string | null }>(
        "SELECT id, version, category, hint FROM viewer_notes WHERE user_key = $1 FOR UPDATE", [key]);
      const current = new Map(rows.map((r) => [Number(r.id), r]));
      const fresh = (id: number, version: number) => current.get(id)?.version === version;
      for (const op of ops) {
        if (!fresh(op.id, op.version)) continue; // changed or deleted meanwhile: the newer state wins and the note stays dirty
        if (op.kind === "clean") {
          await q("UPDATE viewer_notes SET dirty = false WHERE id = $1 AND version = $2", [op.id, op.version]);
        } else if (op.kind === "delete") {
          await q("DELETE FROM viewer_notes WHERE id = $1 AND version = $2", [op.id, op.version]);
        } else {
          const members = op.absorb ?? [];
          if (!members.every((m) => fresh(m.id, m.version))) continue;
          const cur = current.get(op.id)!;
          const set = op.set;
          const category = set.category ?? cur.category;
          const hint = withDefaultHint(category, set.hint !== undefined ? set.hint : cur.hint) ?? null;
          await q(
            `UPDATE viewer_notes SET
               layer = COALESCE($3, layer), category = $4, text = COALESCE($5, text), hint = $6,
               strength = COALESCE($7, strength), strength_at = COALESCE($8, strength_at), mentions = COALESCE($9, mentions),
               embedding = COALESCE($10::vector, embedding), dirty = false, version = version + 1
             WHERE id = $1 AND version = $2`,
            [
              op.id, op.version, set.layer ?? null, category, set.text?.trim() ?? null, hint,
              set.strength === undefined ? null : clamp01(set.strength), set.strengthAt ?? null, set.mentions ?? null,
              embeddings.get(op.id) ?? null,
            ],
          );
          for (const m of members) await q("DELETE FROM viewer_notes WHERE id = $1 AND version = $2", [m.id, m.version]);
        }
      }
    });
  }

  // @spec MEM-CONSOL-016
  async purgeSoftDeletions(olderThan: Date): Promise<number> {
    const res = await this.query("DELETE FROM viewer_note_deletions WHERE reason IS NULL AND deleted_at < $1", [olderThan]);
    return res.rowCount ?? 0;
  }

  // @spec MEM-CONSOL-010
  /** A session-level advisory lock on one pooled connection: released on unlock, or by Postgres if the connection dies. */
  async withConsolidationLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const client = await this.pool.connect();
    const q = <R extends pg.QueryResultRow>(sql: string, params?: unknown[]) => this.run(() => client.query<R>(sql, params)) as Promise<pg.QueryResult<R>>;
    try {
      const { rows } = await q<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [CONSOLIDATION_LOCK]);
      if (!rows[0]?.locked) return { ran: false };
      try { return { ran: true, value: await fn() }; }
      finally { await q("SELECT pg_advisory_unlock($1)", [CONSOLIDATION_LOCK]).catch(() => {}); }
    } finally {
      client.release();
    }
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

/** pgvector's text form is `[a,b,...]`, which is valid JSON. */
function parseVector(text: string | null): number[] {
  return text ? (JSON.parse(text) as number[]) : [];
}

/** Arbitrary constant naming the consolidation advisory lock. */
const CONSOLIDATION_LOCK = 7_431_900_601;

const VIEWER_COLS = "user_key, display, msg_count, regular_manual, is_sub, placeholder, first_seen, last_seen";
interface ViewerSql {
  user_key: string; display: string; msg_count: number; regular_manual: boolean; is_sub: boolean; placeholder: boolean;
  first_seen: Date; last_seen: Date;
}

const NOTE_COLS = "id, user_key, layer, category, text, hint, strength, strength_at, mentions, dirty, version, created_at, last_surfaced_at, embedding::text AS embedding";
interface NoteSql {
  id: number | string; user_key: string; layer: Layer; category: Category; text: string; hint: string | null; strength: number;
  strength_at: Date; mentions: number; dirty: boolean; version: number; created_at: Date; last_surfaced_at: Date | null; embedding: string | null;
}
interface DeletionSql {
  id: number | string; user_key: string; layer: Layer; category: Category; text: string; hint: string | null; strength: number;
  reason: string | null; deleted_at: Date; embedding: string | null;
}
function toNote(r: NoteSql): NoteRow {
  return {
    id: Number(r.id), userKey: r.user_key, layer: r.layer, category: r.category, text: r.text, hint: r.hint, strength: r.strength,
    strengthAt: r.strength_at, mentions: r.mentions, dirty: r.dirty, version: r.version, createdAt: r.created_at,
    lastSurfacedAt: r.last_surfaced_at, embedding: parseVector(r.embedding),
  };
}
