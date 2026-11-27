import * as sqlite from "node:sqlite";

/**
 * The one module of the store that touches `node:sqlite` (settings-store STORE-DB-001): open, `exec`, prepared statements, the
 * transaction helpers and the online backup. A change of SQLite library changes this file only.
 */

/** A value SQLite hands back. */
export type SqlValue = sqlite.SQLOutputValue;
/** A value bound to a statement parameter. */
export type SqlParam = sqlite.SQLInputValue;
/** One result row, by column name. */
export type Row = Record<string, SqlValue>;

/** The connection settings of one opening program (STORE-DB-003). */
export interface DbOptions {
  /** How long a statement waits for another writer's lock before it fails with `SQLITE_BUSY`. */
  busyTimeoutMs: number;
  /** Open the file read-only (a backup being checked); it is never created. */
  readOnly?: boolean;
}

/** An open connection to one database file. */
export interface Db {
  readonly file: string;
  exec(sql: string): void;
  get(sql: string, ...params: SqlParam[]): Row | undefined;
  all(sql: string, ...params: SqlParam[]): Row[];
  run(sql: string, ...params: SqlParam[]): number;
  /** Runs `fn` inside `BEGIN IMMEDIATE` and commits, or rolls back when it throws. */
  immediate<T>(fn: () => T): T;
  /** Runs `fn` inside a read transaction, so every read sees one snapshot. */
  read<T>(fn: () => T): T;
  /** Copies the whole database to `path` with SQLite's online backup API. */
  backupTo(path: string): Promise<void>;
  close(): void;
}

/**
 * Node 26 names the class `Database` and keeps `DatabaseSync` as its deprecated alias; @types/node knows only the alias, which
 * has the same shape.
 */
const DatabaseClass: typeof sqlite.DatabaseSync = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;

/** SQLite's primary result code for a lock held by another connection. */
const SQLITE_BUSY = 5;

/** Whether `e` is SQLite's `SQLITE_BUSY` (or `SQLITE_BUSY_*`): another connection holds the lock past the busy timeout. */
export function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: unknown }).errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

/** Opens (creating when missing) the database at `file`. Pragmas are the caller's. */
// @spec STORE-DB-001
export function openDb(file: string, opts: DbOptions): Db {
  // Defensive mode and trusted_schema off: a database file is data, and nothing in its schema (a view, a trigger, a function
  // call in a default) may act with this connection's rights, which matters when a backup from elsewhere is attached.
  const db = new DatabaseClass(file, { timeout: opts.busyTimeoutMs, enableForeignKeyConstraints: true, readOnly: opts.readOnly ?? false, defensive: true } as sqlite.DatabaseSyncOptions);
  db.exec("PRAGMA trusted_schema = OFF;");
  const run = (sql: string, params: SqlParam[]): number => Number(db.prepare(sql).run(...params).changes);
  const txn = <T>(begin: string, fn: () => T): T => {
    db.exec(begin);
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    file,
    exec: (sql) => db.exec(sql),
    get: (sql, ...params) => db.prepare(sql).get(...params) as Row | undefined,
    all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
    run: (sql, ...params) => run(sql, params),
    immediate: (fn) => txn("BEGIN IMMEDIATE", fn),
    read: (fn) => txn("BEGIN", fn),
    backupTo: async (path) => { await sqlite.backup(db, path); },
    close: () => { if (db.isOpen) db.close(); },
  };
}
