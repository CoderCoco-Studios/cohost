import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigSchema, ExpressionMapSchema, SECRET_PATHS, SECTION_PATHS, coerceEmptyNumbers, dataDir, findWorkspaceRoot, parseYaml, secretPathOf,
  unknownKeys, type Config, type ExpressionMap,
} from "@cohost/config";
import { isBusy, openDb, type Db, type Row } from "./db.js";
import { NEWER_MESSAGE, StoreError, type StoreIssue } from "./errors.js";
import {
  aadOf, checkPrivateDir, createKeyFile, formatKey, keyId, linkKeyFile, looseMode, open as openSealed, parseKey, readKeyFile, recoveryNotice, seal, stageKeyFile,
  type NoticeOut,
} from "./keys.js";
import { backupDir, keyFilePath, stamp, storeDir, storeFile } from "./paths.js";
import { BearerChecker, MIN_TOKEN_LENGTH, earsListenerKey, makeVerifier, parseVerifier, type BearerResult } from "./token.js";

/** The newest schema version this build knows (STORE-DB-007). */
export const SCHEMA_VERSION = 1;

/**
 * Migrations of the store's own tables, by the version they migrate from: `MIGRATIONS[n]` turns version n into n + 1. Version 1
 * is the first, so there are none yet.
 */
const MIGRATIONS: Readonly<Record<number, (db: Db) => void>> = {};

/** The tables of the LLD § Tables (STORE-DB-005). */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS sections (path TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY CHECK (name IN ('personality', 'expressions')), body TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS secrets (
  path TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, key_id TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS keys (
  name TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, key_id TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
`;
const TABLES = ["meta", "sections", "documents", "secrets", "keys"] as const;
/** The columns of each table, in order: what a backup being restored must have, and what the copy names explicitly. */
const COLUMNS: Readonly<Record<(typeof TABLES)[number], readonly string[]>> = {
  meta: ["key", "value"],
  sections: ["path", "doc", "updated_at"],
  documents: ["name", "body", "updated_at"],
  secrets: ["path", "nonce", "tag", "ciphertext", "key_id", "updated_at"],
  keys: ["name", "nonce", "tag", "ciphertext", "key_id", "updated_at"],
};

/** The longest personality the store holds, in bytes of UTF-8, as the personality route allows. */
export const PERSONALITY_MAX_BYTES = 64 * 1024;

/** The busy timeouts of STORE-DB-003: the dashboard's short one (it retries asynchronously) and everyone else's. */
export const BUSY_TIMEOUT_MS = { dashboard: 250, other: 5000 } as const;
/** The dashboard's retry delays for a write blocked past its timeout (STORE-SET-004). */
export const BUSY_RETRY_MS = [50, 100, 200, 400, 800] as const;

export interface StoreOptions {
  /** The data directory; `dataDir()` by default. */
  dataDir?: string;
  /** The master key file; `keyFilePath()` by default. */
  keyFile?: string;
  /** Which program opens the store: the dashboard's busy timeout is 250 ms, every other program's 5000 ms (STORE-DB-003). */
  profile?: "dashboard" | "other";
  /** Where the seed examples are: `config/` under the workspace root by default (STORE-IO-005). */
  seedDir?: string;
  /** Whether a store this call creates is seeded; false for the new store that replaces a damaged one (STORE-TASK-006). */
  seed?: boolean;
  /** Where the recovery-key notice goes: standard output by default, never a logger (STORE-KEY-002). */
  notice?: NoticeOut;
  /** Where the store's warnings go (a loose file mode); standard error by default. */
  warn?: (message: string) => void;
  /**
   * Open even when the master key is missing, wrong or readable by others: `keyProblem` then says why, and every operation
   * that needs the key throws it. The recovery tasks and `checkStore` open this way.
   */
  keyOptional?: boolean;
  /**
   * Whether a missing key file may be created (STORE-KEY-002); true by default. A restore passes false: it installs the key the
   * backup was encrypted under instead, and must not print a recovery key for a key that is then replaced.
   */
  createKey?: boolean;
  /** The workspace root `config:project` writes `data/projections/` under; the root found from the working directory by default. */
  workspaceRoot?: string;
}

/** A change for `write`: sections, documents and credentials to set (a value) or remove (`null`). */
export interface StoreChange {
  /**
   * Section documents by section path (`llm`, `brain.salience`), sparse: a mapping, or the value itself for a section the schema
   * holds as one value (`brain.working_memory_events`); `null` removes the section's row.
   */
  sections?: Readonly<Record<string, unknown>>;
  /** Remove every section `sections` does not name (an import of settings). */
  replaceSections?: boolean;
  /** The personality's Markdown; `null` removes it. */
  personality?: string | null;
  /** The emotion map (`ExpressionMapSchema`); `null` removes it. */
  expressions?: unknown;
  /** Credentials by concrete secret path; `null` clears one. */
  secrets?: Readonly<Record<string, string | null>>;
  /** Remove every credential `secrets` does not name (an import of credentials). */
  replaceSecrets?: boolean;
}

export interface WriteOptions {
  /** The revision the writer last read (the settings editor's etag); a different current revision applies nothing (STORE-SET-003). */
  expectedRevision?: number;
  /**
   * The keys this write sets or removes. While the stored settings already fail the schema, only issues at or under these keys
   * stop the write, so the first fix of a store with several failing keys can be made (STORE-RCV-002).
   */
  only?: readonly string[];
  /** Validate and report as a write would, then roll back. */
  dryRun?: boolean;
}

export type WriteResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; revision: number }
  | { ok: false; conflict?: false; issues: StoreIssue[] };

/** A problem that stops the store's use (STORE-RCV-001). */
export interface StoreProblem { cause: "damaged" | "newer" | "key" | "settings"; message: string; path?: string }

type Doc = Record<string, unknown>;
const isObj = (x: unknown): x is Doc => !!x && typeof x === "object" && !Array.isArray(x);
const now = (): string => new Date().toISOString();

class Rollback extends Error {
  constructor(readonly result: WriteResult) { super("rollback"); }
}

/** Runs `fn` with the process umask at 0o077, so every file it creates is private to the owner (STORE-DB-002). */
function withUmask<T>(fn: () => T): T {
  const before = process.umask(0o077);
  try { return fn(); } finally { process.umask(before); }
}

const getIn = (root: unknown, segs: readonly string[]): unknown => segs.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
function setIn(root: Doc, segs: readonly string[], value: unknown): void {
  let cur = root;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur[s])) cur[s] = {};
    cur = cur[s] as Doc;
  }
  cur[segs.at(-1)!] = value;
}
/** Deletes the key at `segs` and every parent mapping the deletion leaves empty. */
function deleteIn(root: Doc, segs: readonly string[]): void {
  if (segs.length === 0) return;
  const [head, ...rest] = segs as [string, ...string[]];
  if (rest.length === 0) { delete root[head]; return; }
  const child = root[head];
  if (!isObj(child)) return;
  deleteIn(child, rest);
  if (Object.keys(child).length === 0) delete root[head];
}

/** The section a dotted path belongs to (`brain.salience.cooldown_ms` → `brain.salience`), or undefined. */
export function sectionOf(path: string): string | undefined {
  return SECTION_PATHS.filter((s) => path === s || path.startsWith(`${s}.`)).toSorted((a, b) => b.length - a.length)[0];
}

/** The concrete key lists a secret pattern names inside `node`: a `*` segment expands to each key the map holds. */
function concreteKeys(node: unknown, segs: readonly string[], prefix: string[] = []): string[][] {
  if (segs.length === 0) return [prefix];
  if (!isObj(node)) return [];
  const [head, ...rest] = segs as [string, ...string[]];
  const keys = head === "*" ? Object.keys(node) : Object.hasOwn(node, head) ? [head] : [];
  return keys.flatMap((k) => concreteKeys(node[k], rest, [...prefix, k]));
}

/**
 * Removes every value at a secret path from a section document: an empty one silently, a set one reported by path (never its
 * value). Settings documents never hold a credential.
 */
function stripSecrets(section: string, doc: Doc): string[] {
  const held: string[] = [];
  for (const pattern of SECRET_PATHS) {
    if (!pattern.startsWith(`${section}.`)) continue;
    const segs = pattern.slice(section.length + 1).split(".");
    for (const keys of concreteKeys(doc, segs)) {
      const v = getIn(doc, keys);
      if (v !== undefined && v !== null && v !== "") held.push(`${section}.${keys.join(".")}`);
      deleteIn(doc, keys);
    }
  }
  return held;
}

/**
 * Splits a settings tree, nested as the schema nests it, into section documents (STORE-DB-005). A top-level key or `brain` key
 * that names no section is an issue, as is a section that is not a mapping; values at secret paths are removed and listed.
 */
export function splitSettings(tree: unknown): { sections: Record<string, unknown>; issues: StoreIssue[]; credentials: string[] } {
  const sections: Record<string, unknown> = {};
  const issues: StoreIssue[] = [];
  const credentials: string[] = [];
  if (tree === undefined || tree === null) return { sections, issues, credentials };
  if (!isObj(tree)) return { sections, issues: [{ path: "", message: "the settings must be a mapping of sections" }], credentials };
  const take = (path: string, value: unknown): void => {
    if (!SECTION_PATHS.includes(path)) { issues.push({ path, message: "not a settings section of this build" }); return; }
    if (value === null || value === undefined) return;
    const doc = coerceEmptyNumbers(structuredClone(value));
    if (isObj(doc)) {
      credentials.push(...stripSecrets(path, doc));
      if (Object.keys(doc).length === 0) return;
    }
    sections[path] = doc;
  };
  for (const [k, v] of Object.entries(tree)) {
    if (k === "brain" && (isObj(v) || v === null)) for (const [sub, sv] of Object.entries(v ?? {})) take(`brain.${sub}`, sv);
    else take(k, v);
  }
  return { sections, issues, credentials };
}

/** The nested settings tree of section documents, sparse: what an export's `settings` holds. */
export function assembleSettings(sections: Readonly<Record<string, unknown>>): Doc {
  const tree: Doc = {};
  for (const path of SECTION_PATHS) {
    const doc = sections[path];
    if (doc !== undefined && doc !== null) setIn(tree, path.split("."), structuredClone(doc));
  }
  return tree;
}

/** Every issue of an assembled tree against `ConfigSchema`, null values dropped, unknown keys included. */
function settingsIssues(sections: Readonly<Record<string, unknown>>): StoreIssue[] {
  const tree = coerceEmptyNumbers(assembleSettings(sections)) as Doc;
  tree.brain ??= {};
  const r = ConfigSchema.safeParse(tree);
  const unknown = (raw: Doc, parsed: unknown): StoreIssue[] => unknownKeys(raw, parsed).map((path) => ({ path, message: "not a setting of this build" }));
  if (r.success) return unknown(tree, r.data);
  const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  // Unknown keys are found against a parse that succeeds: drop the failing keys from a copy and parse it again, so one write
  // reports both kinds.
  const rest = structuredClone(tree);
  for (const i of r.error.issues) deleteIn(rest, i.path.map(String));
  rest.brain ??= {};
  const again = ConfigSchema.safeParse(rest);
  return again.success ? [...issues, ...unknown(rest, again.data)] : issues;
}

const covers = (only: readonly string[], path: string): boolean => only.some((k) => path === k || path.startsWith(`${k}.`) || k.startsWith(`${path}.`));

function personalityIssue(text: unknown): StoreIssue | undefined {
  if (typeof text !== "string") return { path: "personality", message: "must be text" };
  if (Buffer.byteLength(text, "utf8") > PERSONALITY_MAX_BYTES) return { path: "personality", message: `is longer than ${PERSONALITY_MAX_BYTES} bytes` };
  return undefined;
}

function expressionsIssues(value: unknown): StoreIssue[] {
  const r = ExpressionMapSchema.safeParse(value ?? {});
  return r.success ? [] : r.error.issues.map((i) => ({ path: ["expressions", ...i.path].join("."), message: i.message }));
}

/** C0 control characters and DEL: never part of a credential (STORE-SET-005). */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** Moves a damaged store aside as `cohost.db.damaged-<stamp>`, with its WAL and shared-memory files (STORE-TASK-006). */
// @spec STORE-TASK-006
export function moveDamagedAside(data: string = dataDir()): string {
  const file = storeFile(data);
  const suffix = `.damaged-${stamp()}`;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(f)) renameSync(f, `${f}${suffix}`);
  }
  return `${file}${suffix}`;
}

/** Runs the integrity check of STORE-DB-004 on an open database; returns its schema version and meta. */
function checkIntegrity(db: Db, file: string): { version: number; meta: Map<string, string> } {
  const damaged = (why: string): StoreError => new StoreError("damaged", `the settings store ${file} is damaged: ${why}`);
  let first: string;
  try {
    const row = db.get("PRAGMA integrity_check");
    first = row ? String(Object.values(row)[0]) : "no answer to the integrity check";
  } catch (e) {
    throw damaged((e as Error).message);
  }
  if (first !== "ok") throw damaged(first);
  const present = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name)));
  const missing = TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) throw damaged(`the table${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing`);
  const meta = new Map(db.all("SELECT key, value FROM meta").map((r) => [String(r.key), String(r.value)]));
  if (!meta.has("schema_version")) throw damaged("meta.schema_version is missing");
  if (!meta.has("store_id")) throw damaged("meta.store_id is missing");
  const version = Number(meta.get("schema_version"));
  if (!Number.isInteger(version) || version < 1) throw damaged(`meta.schema_version is not a version: ${meta.get("schema_version")}`);
  if (version > SCHEMA_VERSION) throw new StoreError("newer", `${NEWER_MESSAGE} (${file} has schema version ${version}; this build knows ${SCHEMA_VERSION})`);
  return { version, meta };
}

/** Warns about each of the database, WAL and shared-memory files that grants group or other a permission (STORE-DB-002). */
function warnLooseModes(file: string, warn: (m: string) => void): void {
  const loose = [file, `${file}-wal`, `${file}-shm`].filter((f) => {
    try { return looseMode(statSync(f).mode); } catch { return false; }
  });
  if (loose.length > 0) warn(`the settings store ${loose.length > 1 ? "files" : "file"} ${loose.join(", ")} can be read by other users; run: chmod 600 ${loose.join(" ")}`);
}

/** The process's own outlets for the recovery-key notice: the key to a terminal on standard output, the pointer to standard error. */
const defaultNotice = (): NoticeOut => ({
  isTTY: process.stdout.isTTY,
  write: (t: string) => process.stdout.write(t),
  warn: (t: string) => process.stderr.write(t),
});

/** The examples a new store is seeded from (STORE-IO-005). */
export const SEED_FILES = { settings: "config.example.yaml", personality: "personality.example.md", expressions: "expressions.example.yaml" } as const;

/** Opens the store, creating and seeding it when it does not exist (STORE-DB-002 to -004, -007, -009; STORE-KEY-002 to -005). */
// @spec STORE-DB-002, STORE-DB-003, STORE-DB-004, STORE-DB-007, STORE-DB-009, STORE-KEY-002, STORE-KEY-003, STORE-KEY-004, STORE-IO-005
export async function openStore(opts: StoreOptions = {}): Promise<Store> {
  const data = opts.dataDir ?? dataDir();
  const file = storeFile(data);
  const keyFile = opts.keyFile ?? keyFilePath();
  const warn = opts.warn ?? ((m: string) => { process.stderr.write(`${m}\n`); });
  const busyTimeoutMs = opts.profile === "dashboard" ? BUSY_TIMEOUT_MS.dashboard : BUSY_TIMEOUT_MS.other;
  const dir = storeDir(data);
  if (existsSync(dir) && looseMode(statSync(dir).mode)) warn(`the settings store directory ${dir} can be read by other users; run: chmod 700 ${dir}`);
  const db = withUmask(() => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let d: Db;
    try {
      d = openDb(file, { busyTimeoutMs });
    } catch (e) {
      throw new StoreError("damaged", `the settings store ${file} cannot be opened: ${(e as Error).message}`);
    }
    try {
      d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    } catch (e) {
      d.close();
      throw new StoreError("damaged", `the settings store ${file} is damaged: ${(e as Error).message}`);
    }
    return d;
  });
  try {
    // A new file has no tables: create them and the meta rows in one transaction; a program that loses the race finds them made.
    let created = false;
    let empty: boolean;
    try {
      empty = db.get("SELECT count(*) AS n FROM sqlite_master")?.n === 0;
    } catch (e) {
      throw new StoreError("damaged", `the settings store ${file} is damaged: ${(e as Error).message}`);
    }
    if (empty) {
      created = withUmask(() => db.immediate(() => {
        db.exec(SCHEMA_SQL);
        if (db.get("SELECT 1 AS x FROM meta WHERE key = 'schema_version'")) return false;
        const ins = (k: string, v: string): void => { db.run("INSERT INTO meta (key, value) VALUES (?, ?)", k, v); };
        ins("schema_version", String(SCHEMA_VERSION));
        ins("store_id", randomBytes(16).toString("hex"));
        ins("revision", "0");
        ins("created_at", now());
        return true;
      }));
    }
    const { version } = checkIntegrity(db, file);
    warnLooseModes(file, warn);
    const store = new Store(db, { data, file, keyFile, busyTimeoutMs, warn });
    if (version < SCHEMA_VERSION) await store.migrate(version);
    store.loadKey(opts.notice ?? defaultNotice(), opts.keyOptional ?? false, opts.createKey ?? true);
    if (created && (opts.seed ?? true)) {
      const issues = store.seed(opts.seedDir ?? join(findWorkspaceRoot() ?? process.cwd(), "config"));
      if (issues.length > 0) {
        db.close();
        for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { unlinkSync(f); } catch { /* not there */ } }
        throw new StoreError("invalid", `the seed examples do not validate:\n${issues.map((i) => `  ${i.path || "(file)"}: ${i.message}`).join("\n")}`, issues);
      }
    }
    return store;
  } catch (e) {
    db.close();
    throw e;
  }
}

interface StoreContext { data: string; file: string; keyFile: string; busyTimeoutMs: number; warn: (m: string) => void }

/** An open settings store. Every write goes through `write` (STORE-SET-001). */
export class Store {
  private key: Buffer | undefined;
  /** Why the master key cannot be used, when the store was opened with `keyOptional`. */
  keyProblem: StoreError | undefined;
  private session: { revision: number; key: Buffer | undefined } | undefined;
  private readonly checker = new BearerChecker(() => this.meta("token_verifier"));

  constructor(private readonly db: Db, private readonly ctx: StoreContext) {}

  get file(): string { return this.ctx.file; }
  get keyFile(): string { return this.ctx.keyFile; }
  get dataDir(): string { return this.ctx.data; }
  get storeId(): string { return this.meta("store_id")!; }

  close(): void { this.db.close(); }

  // ---------------------------------------------------------------- meta and revision

  private meta(key: string): string | undefined {
    const r = this.db.get("SELECT value FROM meta WHERE key = ?", key);
    return r ? String(r.value) : undefined;
  }
  private setMeta(key: string, value: string): void {
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** `meta.revision`: incremented by every committed write (STORE-DB-006); the settings editor's etag. */
  revision(): number { return Number(this.meta("revision") ?? 0); }

  /** Sets the revision to one more than `before` (STORE-DB-006, STORE-DB-011); call inside a write transaction. */
  private bump(before: number = this.revision()): number {
    this.setMeta("revision", String(before + 1));
    return before + 1;
  }

  /** Runs `fn` in one `BEGIN IMMEDIATE` transaction, naming the store when another program holds the lock (STORE-SET-004). */
  private immediate<T>(fn: () => T): T {
    try {
      return this.db.immediate(fn);
    } catch (e) {
      if (isBusy(e)) throw new StoreError("busy", `the settings store ${this.file} is busy: another program is writing (SQLITE_BUSY); nothing was changed`);
      throw e;
    }
  }

  // ---------------------------------------------------------------- opening steps

  /** Migrates from `from` to `SCHEMA_VERSION` after a backup, in one transaction (STORE-DB-007). */
  async migrate(from: number): Promise<void> {
    await this.backup();
    try {
      this.immediate(() => {
        for (let v = from; v < SCHEMA_VERSION; v++) {
          const step = MIGRATIONS[v];
          if (!step) throw new Error(`no migration from schema version ${v}`);
          step(this.db);
        }
        this.setMeta("schema_version", String(SCHEMA_VERSION));
        this.bump();
      });
    } catch (e) {
      throw new StoreError("damaged", `the settings store ${this.file} could not be migrated from schema version ${from}: ${(e as Error).message}`);
    }
  }

  private credentialCounts(): { secrets: number; keys: number } {
    return {
      secrets: Number(this.db.get("SELECT count(*) AS n FROM secrets")?.n ?? 0),
      keys: Number(this.db.get("SELECT count(*) AS n FROM keys")?.n ?? 0),
    };
  }

  /** Reads, or creates, the master key, and checks it against `meta.key_id` (STORE-KEY-002 to -005). */
  loadKey(notice: NoticeOut, optional: boolean, create = true): void {
    try {
      checkPrivateDir(dirname(this.keyFile), "master key");
      let key = readKeyFile(this.keyFile);
      if (!key) {
        const n = this.credentialCounts();
        if (n.secrets + n.keys > 0) {
          throw new StoreError("key-missing",
            `the master key file ${this.keyFile} is missing and the settings store ${this.file} holds ${n.secrets} stored credential${n.secrets === 1 ? "" : "s"} ` +
            `and ${n.keys} generated key${n.keys === 1 ? "" : "s"} encrypted under it. ` +
            this.keptKeysHint() +
            "Restore the key with mise run config:key -- --restore (it asks for the recovery key, which is a key file's text), restore a backup " +
            "with mise run config:restore -- <file> (it uses a kept key file the backup was made under), or discard them with mise run config:reset-credentials");
        }
        if (!create) throw new StoreError("key-missing", `the master key file ${this.keyFile} is missing`);
        const made = createKeyFile(this.keyFile);
        key = made.key;
        if (made.created && !recoveryNotice(notice, key)) this.immediate(() => { this.setMeta("recovery_key_unconfirmed", "1"); this.bump(); });
      }
      const recorded = this.meta("key_id");
      if (recorded !== undefined && recorded !== keyId(key)) {
        throw new StoreError("key-wrong",
          `the master key file ${this.keyFile} holds the key ${keyId(key)}, but the settings store ${this.file} was encrypted under the key ${recorded}: ` +
          "restore the right key with mise run config:key -- --restore, or discard the credentials with mise run config:reset-credentials");
      }
      this.key = key;
      this.keyProblem = undefined;
    } catch (e) {
      if (!optional || !(e instanceof StoreError)) throw e;
      this.key = undefined;
      this.keyProblem = e;
    }
  }

  /** A sentence naming the key files an earlier rotation, restore or discard kept beside the key file, or nothing. */
  private keptKeysHint(): string {
    const kept = keptKeyFiles(this.keyFile);
    return kept.length === 0
      ? `No kept key file (${basename(this.keyFile)}.rotated-…, .replaced-…, .discarded-…) is beside it. `
      : `Kept key files beside it may hold the key: ${kept.join(", ")}. `;
  }

  private requireKey(): Buffer {
    if (this.key) return this.key;
    throw this.keyProblem ?? new StoreError("key-missing", `the master key of ${this.file} is not available`);
  }

  /** Seeds a new store from the committed examples (STORE-IO-005); returns the issues that stop it. */
  seed(dir: string): StoreIssue[] {
    const read = (name: string): string | undefined => { try { return readFileSync(join(dir, name), "utf8"); } catch { return undefined; } };
    const settingsText = read(SEED_FILES.settings);
    if (settingsText === undefined) return [{ path: "", message: `no seed: ${join(dir, SEED_FILES.settings)} cannot be read` }];
    let tree: unknown;
    let expressions: unknown;
    try {
      tree = parseYaml(settingsText);
      const e = read(SEED_FILES.expressions);
      expressions = e === undefined ? undefined : parseYaml(e);
    } catch (e) {
      return [{ path: "", message: `a seed example is not valid YAML: ${(e as Error).message}` }];
    }
    const split = splitSettings(tree);
    if (split.issues.length > 0) return split.issues;
    const change: StoreChange = { sections: split.sections, replaceSections: true };
    const personality = read(SEED_FILES.personality);
    if (personality !== undefined) change.personality = personality;
    if (expressions !== undefined && expressions !== null) change.expressions = expressions;
    const r = this.write(change);
    return r.ok ? [] : "issues" in r ? r.issues : [{ path: "", message: "the store changed while it was being seeded" }];
  }

  // ---------------------------------------------------------------- reads

  /** The stored section documents by section path, sparse (STORE-DB-005). */
  sections(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.all("SELECT path, doc FROM sections")) out[String(r.path)] = JSON.parse(String(r.doc)) as unknown;
    return out;
  }

  /** The stored settings nested as the schema nests them, sparse. */
  settingsTree(): Doc { return assembleSettings(this.sections()); }

  /**
   * The configuration (STORE-DB-010): every stored section assembled and validated with `ConfigSchema`, null values dropped, no
   * isolation override and no credential. Throws an `invalid` error listing every issue when the stored settings fail the schema.
   */
  // @spec STORE-DB-005, STORE-DB-010
  config(): Config {
    const tree = coerceEmptyNumbers(this.settingsTree()) as Doc;
    tree.brain ??= {};
    const r = ConfigSchema.safeParse(tree);
    if (!r.success) {
      const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      throw new StoreError("invalid", `the stored settings fail the schema:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`, issues);
    }
    return r.data;
  }

  /** Every issue of the stored settings and documents against this build's schemas (STORE-RCV-001). */
  issues(): StoreIssue[] {
    const out = settingsIssues(this.sections());
    const e = this.document("expressions");
    if (e !== undefined) out.push(...expressionsIssues(JSON.parse(e)));
    return out;
  }

  private document(name: "personality" | "expressions"): string | undefined {
    const r = this.db.get("SELECT body FROM documents WHERE name = ?", name);
    return r ? String(r.body) : undefined;
  }
  /** The personality's Markdown, or undefined when none is stored. */
  personality(): string | undefined { return this.document("personality"); }
  /** The emotion map, or undefined when none is stored. */
  expressions(): ExpressionMap | undefined {
    const body = this.document("expressions");
    return body === undefined ? undefined : ExpressionMapSchema.parse(JSON.parse(body));
  }
  /** The stored emotion map as written (no defaults filled in), for an export. */
  expressionsRaw(): unknown {
    const body = this.document("expressions");
    return body === undefined ? undefined : JSON.parse(body);
  }

  /** The secret paths the store holds a credential for, sorted. */
  secretPaths(): string[] { return this.db.all("SELECT path FROM secrets ORDER BY path").map((r) => String(r.path)); }

  private unseal(table: "secrets" | "keys", name: string, r: Row): Buffer {
    const key = this.requireKey();
    if (r.key_id !== undefined && String(r.key_id) !== keyId(key)) {
      throw new StoreError("key-wrong", `${table}.${name} in the settings store ${this.file} is encrypted under the key ${String(r.key_id)}, not the current key ${keyId(key)}`);
    }
    const plain = openSealed(key, aadOf(this.storeId, table, name), { nonce: Buffer.from(r.nonce as Uint8Array), tag: Buffer.from(r.tag as Uint8Array), ciphertext: Buffer.from(r.ciphertext as Uint8Array) });
    if (!plain) throw new StoreError("damaged", `the settings store ${this.file} is damaged: ${table}.${name} does not decrypt under the master key`);
    return plain;
  }

  /** The credential at `path`, or undefined when none is stored. */
  secret(path: string): string | undefined {
    const r = this.db.get("SELECT nonce, tag, ciphertext, key_id FROM secrets WHERE path = ?", path);
    return r ? this.unseal("secrets", path, r).toString("utf8") : undefined;
  }
  /** Every stored credential by path. */
  secretValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.all("SELECT path, nonce, tag, ciphertext, key_id FROM secrets ORDER BY path")) out[String(r.path)] = this.unseal("secrets", String(r.path), r).toString("utf8");
    return out;
  }
  private keyRow(name: string): Buffer | undefined {
    const r = this.db.get("SELECT nonce, tag, ciphertext, key_id FROM keys WHERE name = ?", name);
    return r ? this.unseal("keys", name, r) : undefined;
  }

  /** Decrypts every row of `secrets` and `keys`, throwing a `damaged` error naming the first that fails (STORE-KEY-006). */
  verifyRows(): void {
    for (const table of ["secrets", "keys"] as const) {
      const col = table === "secrets" ? "path" : "name";
      for (const r of this.db.all(`SELECT ${col} AS id, nonce, tag, ciphertext, key_id FROM ${table}`)) this.unseal(table, String(r.id), r);
    }
  }

  // ---------------------------------------------------------------- the write operation

  private putSealed(table: "secrets" | "keys", name: string, plain: Buffer): void {
    const key = this.requireKey();
    const id = keyId(key);
    if (this.meta("key_id") === undefined) this.setMeta("key_id", id);
    const s = seal(key, aadOf(this.storeId, table, name), plain);
    const col = table === "secrets" ? "path" : "name";
    this.db.run(
      `INSERT INTO ${table} (${col}, nonce, tag, ciphertext, key_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT (${col}) DO UPDATE SET nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext, key_id = excluded.key_id, updated_at = excluded.updated_at`,
      name, s.nonce, s.tag, s.ciphertext, id, now(),
    );
  }

  /**
   * The one write operation for settings, documents and credentials (STORE-SET-001): one `BEGIN IMMEDIATE` transaction that
   * compares the expected revision, applies the change, validates the whole assembled configuration and the documents, and
   * commits only when everything passes, incrementing `meta.revision` (STORE-SET-002, -003, -005, -006; STORE-DB-006). Issues
   * name paths, never a credential (STORE-SET-007).
   */
  // @spec STORE-SET-001, STORE-SET-002, STORE-SET-003, STORE-SET-005, STORE-SET-006, STORE-SET-007, STORE-DB-006, STORE-RCV-002
  write(change: StoreChange, opts: WriteOptions = {}): WriteResult {
    try {
      return this.immediate(() => {
        const before = this.revision();
        if (opts.expectedRevision !== undefined && opts.expectedRevision !== before) return { ok: false, conflict: true, revision: before } as const;
        const issues: StoreIssue[] = [];
        const current = this.sections();
        const next: Record<string, unknown> = change.replaceSections ? {} : { ...current };
        for (const [path, doc] of Object.entries(change.sections ?? {})) {
          if (!SECTION_PATHS.includes(path)) { issues.push({ path, message: "not a settings section of this build" }); continue; }
          if (doc === null || doc === undefined) { delete next[path]; continue; }
          const clean = coerceEmptyNumbers(structuredClone(doc));
          if (isObj(clean)) {
            for (const p of stripSecrets(path, clean)) issues.push({ path: p, message: "is a credential: set it with mise run config:secret, not as a setting" });
            if (Object.keys(clean).length === 0) { delete next[path]; continue; }
          }
          next[path] = clean;
        }
        let found = settingsIssues(next);
        if (opts.only && found.length > 0 && settingsIssues(current).length > 0) found = found.filter((i) => covers(opts.only!, i.path));
        issues.push(...found);

        const hasPersonality = Object.hasOwn(change, "personality");
        if (hasPersonality && change.personality !== null) {
          const i = personalityIssue(change.personality);
          if (i) issues.push(i);
        }
        const hasExpressions = Object.hasOwn(change, "expressions");
        if (hasExpressions && change.expressions !== null) issues.push(...expressionsIssues(change.expressions));

        // Credentials: trimmed, non-empty, no control character, a path of SECRET_PATHS, and a server token only for a server
        // the stored tools section holds once this write applies (STORE-SET-005).
        const servers = new Set(Object.keys((getIn(next.tools, ["servers"]) ?? {}) as Doc));
        const puts: [string, string][] = [];
        const clears: string[] = [];
        for (const [path, value] of Object.entries(change.secrets ?? {})) {
          const pattern = secretPathOf(path);
          if (pattern === undefined) { issues.push({ path, message: "is not a credential path" }); continue; }
          if (value === null) { clears.push(path); continue; }
          const v = value.trim();
          if (v === "") { issues.push({ path, message: "is empty" }); continue; }
          if (CONTROL_CHAR.test(v)) { issues.push({ path, message: "holds a control character" }); continue; }
          if (pattern.includes("*") && !servers.has(path.split(".")[2]!)) { issues.push({ path, message: `the tools section holds no server ${path.split(".")[2]}` }); continue; }
          puts.push([path, v]);
        }
        if (issues.length > 0) throw new Rollback({ ok: false, issues });

        const stampNow = now();
        for (const path of Object.keys(current)) if (!(path in next)) this.db.run("DELETE FROM sections WHERE path = ?", path);
        for (const [path, doc] of Object.entries(next)) {
          const text = JSON.stringify(doc);
          if (JSON.stringify(current[path]) === text) continue;
          this.db.run("INSERT INTO sections (path, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at", path, text, stampNow);
        }
        const putDoc = (name: string, body: string | null): void => {
          if (body === null) this.db.run("DELETE FROM documents WHERE name = ?", name);
          else this.db.run("INSERT INTO documents (name, body, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at", name, body, stampNow);
        };
        if (hasPersonality) putDoc("personality", change.personality ?? null);
        if (hasExpressions) putDoc("expressions", change.expressions === null || change.expressions === undefined ? null : JSON.stringify(change.expressions));
        if (change.replaceSecrets) {
          const keep = new Set(puts.map(([p]) => p));
          for (const p of this.secretPaths()) if (!keep.has(p)) this.db.run("DELETE FROM secrets WHERE path = ?", p);
        }
        for (const p of clears) this.db.run("DELETE FROM secrets WHERE path = ?", p);
        for (const [p, v] of puts) this.putSealed("secrets", p, Buffer.from(v, "utf8"));
        // A removed tools.servers entry takes its token with it (STORE-SET-006).
        for (const p of this.secretPaths()) {
          if (secretPathOf(p) === "tools.servers.*.token" && !servers.has(p.split(".")[2]!)) this.db.run("DELETE FROM secrets WHERE path = ?", p);
        }
        if (opts.dryRun) throw new Rollback({ ok: true, revision: before });
        return { ok: true, revision: this.bump(before) } as const;
      });
    } catch (e) {
      if (e instanceof Rollback) return e.result;
      throw e;
    }
  }

  /**
   * `write` for the dashboard (STORE-SET-004): a write blocked past the 250 ms busy timeout is retried after 50, 100, 200, 400
   * and 800 ms, yielding the event loop between tries, before it fails naming the store.
   */
  // @spec STORE-SET-004
  async writeWithRetry(change: StoreChange, opts: WriteOptions = {}): Promise<WriteResult> {
    for (let i = 0; ; i++) {
      try {
        return this.write(change, opts);
      } catch (e) {
        if (!(e instanceof StoreError) || e.kind !== "busy" || i >= BUSY_RETRY_MS.length) throw e;
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS[i]));
      }
    }
  }

  /** Sets one setting (a whole section when `path` is a section) through `write` (STORE-TASK-002). */
  setKey(path: string, value: unknown, opts: WriteOptions = {}): WriteResult {
    const section = sectionOf(path);
    if (section === undefined) return { ok: false, issues: [{ path, message: "is not in a settings section of this build" }] };
    if (secretPathOf(path) !== undefined) return { ok: false, issues: [{ path, message: "is a credential: set it with mise run config:secret" }] };
    if (path === section) return this.write({ sections: { [section]: value } }, { ...opts, only: [path] });
    const stored = this.sections()[section];
    const doc: Doc = isObj(stored) ? structuredClone(stored) : {};
    setIn(doc, path.slice(section.length + 1).split("."), value);
    return this.write({ sections: { [section]: doc } }, { ...opts, only: [path] });
  }

  /** Removes one setting so its default applies (a whole section when `path` is a section) (STORE-TASK-002, STORE-RCV-002). */
  resetKey(path: string, opts: WriteOptions = {}): WriteResult {
    const section = sectionOf(path);
    if (section === undefined) return { ok: false, issues: [{ path, message: "is not in a settings section of this build" }] };
    if (path === section) return this.write({ sections: { [section]: null } }, { ...opts, only: [path] });
    const stored = this.sections()[section];
    const doc: Doc = isObj(stored) ? structuredClone(stored) : {};
    deleteIn(doc, path.slice(section.length + 1).split("."));
    return this.write({ sections: { [section]: Object.keys(doc).length > 0 ? doc : null } }, { ...opts, only: [path] });
  }

  // ---------------------------------------------------------------- the control token and generated keys

  /** Whether the store holds a token verifier. */
  hasVerifier(): boolean { return parseVerifier(this.meta("token_verifier")) !== undefined; }

  /**
   * Sets the control token (STORE-TOK-002): in one transaction the scrypt verifier, a new session key and the ears listener key
   * derived from it. The token itself is stored nowhere. Refuses one shorter than 32 characters after trimming, never naming it.
   */
  // @spec STORE-TOK-002
  setToken(token: string): number {
    const t = token.trim();
    if (t.length < MIN_TOKEN_LENGTH) throw new StoreError("usage", `the control token must be at least ${MIN_TOKEN_LENGTH} characters long (after trimming); nothing was changed`);
    this.requireKey();
    const verifier = JSON.stringify(makeVerifier(t));
    return this.immediate(() => {
      this.setMeta("token_verifier", verifier);
      this.putSealed("keys", "session", randomBytes(32));
      this.putSealed("keys", "ears-listener", Buffer.from(earsListenerKey(t), "utf8"));
      return this.bump();
    });
  }

  /**
   * Checks a presented bearer value against the verifier (STORE-TOK-003). When it verifies while the store holds no ears
   * listener key (after the credentials were discarded), the key is derived from it and stored.
   */
  // @spec STORE-TOK-003
  async checkBearer(value: string): Promise<BearerResult> {
    const result = await this.checker.check(value);
    if (result === "ok" && this.key && !this.db.get("SELECT 1 AS x FROM keys WHERE name = 'ears-listener'")) {
      this.immediate(() => {
        this.putSealed("keys", "ears-listener", Buffer.from(earsListenerKey(value), "utf8"));
        this.bump();
      });
    }
    return result;
  }

  /** The session key (`keys.session`), re-read when `meta.revision` changed since it was last read (STORE-TOK-004). */
  // @spec STORE-TOK-004
  sessionKey(): Buffer | undefined {
    const rev = this.revision();
    if (this.session?.revision !== rev) this.session = { revision: rev, key: this.keyRow("session") };
    return this.session.key;
  }

  /** The ears listener key (`keys.ears-listener`) as 64 lowercase hex, or undefined when none is stored. */
  earsListenerKey(): string | undefined { return this.keyRow("ears-listener")?.toString("utf8"); }

  /**
   * The state key of `unit` (`keys.state:<unit>`, STORE-STATE-001): 32 bytes, created at random and stored encrypted when the
   * store holds none, so a unit keeps the key across deliveries and its encrypted state files stay readable.
   */
  // @spec STORE-STATE-001
  stateKey(unit: string): Buffer {
    const name = `state:${unit}`;
    const existing = this.keyRow(name);
    if (existing) return existing;
    return this.immediate(() => {
      const raced = this.keyRow(name);
      if (raced) return raced;
      const key = randomBytes(32);
      this.putSealed("keys", name, key);
      this.bump();
      return key;
    });
  }

  /** Runs `fn` inside one read transaction, so every read it makes sees one revision (STORE-PROJ-003). */
  snapshot<T>(fn: () => T): T {
    if (this.inSnapshot) return fn();
    this.inSnapshot = true;
    try { return this.db.read(fn); } finally { this.inSnapshot = false; }
  }
  private inSnapshot = false;

  // ---------------------------------------------------------------- the master key

  /** The key file's text, which is the recovery key (STORE-KEY-008 `--show`). */
  recoveryKey(): string { return formatKey(this.requireKey()); }

  /** Whether `meta.recovery_key_unconfirmed` is set (STORE-KEY-002, -010). */
  recoveryKeyUnconfirmed(): boolean { return this.meta("recovery_key_unconfirmed") !== undefined; }

  /** Clears `meta.recovery_key_unconfirmed` (STORE-KEY-010). */
  confirmRecoveryKey(): void {
    if (!this.recoveryKeyUnconfirmed()) return;
    this.immediate(() => { this.db.run("DELETE FROM meta WHERE key = 'recovery_key_unconfirmed'"); this.bump(); });
  }

  /**
   * Rotates the master key (STORE-KEY-007): a new key, every row of `secrets` and `keys` re-encrypted under it and `meta.key_id`
   * set in one transaction; then the old key file is kept as `master.key.rotated-<stamp>` (mode 0600, so backups taken before
   * the rotation stay restorable) and the new key, staged in a temporary file before the transaction, is renamed over the key
   * file. When the transaction fails, the key file is unchanged; when the rename fails after the commit, the error names the
   * temporary file that holds the new key. The new recovery key is shown as STORE-KEY-002 shows one. Returns it.
   */
  // @spec STORE-KEY-007
  rotateKey(notice: NoticeOut): string {
    const old = this.requireKey();
    const fresh = randomBytes(32);
    const staged = stageKeyFile(this.keyFile, fresh);
    try {
      this.immediate(() => {
        const rows: [("secrets" | "keys"), string, Buffer][] = [];
        for (const table of ["secrets", "keys"] as const) {
          const col = table === "secrets" ? "path" : "name";
          for (const r of this.db.all(`SELECT ${col} AS id, nonce, tag, ciphertext, key_id FROM ${table}`)) rows.push([table, String(r.id), this.unseal(table, String(r.id), r)]);
        }
        this.key = fresh;
        this.setMeta("key_id", keyId(fresh));
        for (const [table, id, plain] of rows) this.putSealed(table, id, plain);
        this.bump();
      });
    } catch (e) {
      this.key = old;
      staged.abort();
      throw e;
    }
    try {
      this.keepKeyFile("rotated");
      staged.commit();
    } catch (e) {
      throw new StoreError("key-missing",
        `the settings store ${this.file} is now encrypted under a new key, but it could not replace ${this.keyFile} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): ` +
        `the new key is in ${staged.path}; move it to ${this.keyFile} with mode 0600`);
    }
    if (!recoveryNotice(notice, fresh, "The master key was rotated; the old key file is kept beside it for older backups.")) {
      this.immediate(() => { this.setMeta("recovery_key_unconfirmed", "1"); this.bump(); });
    }
    return formatKey(fresh);
  }

  /** Moves an existing key file aside (kept, since older backups may need it) before another is written in its place. */
  private moveKeyAside(label: string): void {
    if (!existsSync(this.keyFile)) return;
    this.keepKeyFile(label);
    unlinkSync(this.keyFile);
  }

  /**
   * Links the key file to `master.key.<label>-<stamp>` (mode 0600) and returns that name. A name already taken (two moves in
   * one second) is never overwritten: the link fails with `EEXIST` and the next second's name is tried, as backups do.
   */
  private keepKeyFile(label: string): string {
    for (let at = Date.now(); ; at += 1000) {
      const kept = `${this.keyFile}.${label}-${stamp(new Date(at))}`;
      try {
        linkSync(this.keyFile, kept);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      chmodSync(kept, 0o600);
      return kept;
    }
  }

  /** Installs `key` as the key file, the current one kept as `master.key.replaced-<stamp>` (a restore under a kept key). */
  installKey(key: Buffer): void {
    this.moveKeyAside("replaced");
    if (!linkKeyFile(this.keyFile, key)) throw new StoreError("usage", `the master key file ${this.keyFile} appeared while it was being replaced`);
    this.key = key;
    this.keyProblem = undefined;
  }

  /**
   * Restores the key file from a recovery key (STORE-KEY-008): refused when it is not of the key file's form or its id differs
   * from `meta.key_id`, then written as a new key file is (a wrong key file is moved aside first).
   */
  // @spec STORE-KEY-008
  restoreKey(text: string): void {
    const key = parseKey(text);
    if (!key) throw new StoreError("usage", "that is not a recovery key: it starts with cohost-key-1: followed by 43 characters; nothing was changed");
    const recorded = this.meta("key_id");
    if (recorded !== undefined && recorded !== keyId(key)) {
      throw new StoreError("key-wrong", `that recovery key is the key ${keyId(key)}, but the settings store ${this.file} was encrypted under the key ${recorded}; nothing was changed`);
    }
    this.moveKeyAside("replaced");
    if (!linkKeyFile(this.keyFile, key)) throw new StoreError("usage", `the master key file ${this.keyFile} appeared while it was being restored; nothing was changed`);
    this.key = key;
    this.keyProblem = undefined;
  }

  /**
   * Discards every credential and generated key (STORE-KEY-009): after a backup, one transaction deletes every row of `secrets`
   * and `keys` and `meta.key_id`; then a new key file is made (the old one moved aside), with a new session key under it. The
   * token verifier stays; ears has no listener key until the next bearer check that succeeds or the next token.
   */
  // @spec STORE-KEY-009
  async resetCredentials(notice: NoticeOut): Promise<void> {
    await this.backup();
    this.immediate(() => {
      this.db.run("DELETE FROM secrets");
      this.db.run("DELETE FROM keys");
      this.db.run("DELETE FROM meta WHERE key = 'key_id'");
      this.bump();
    });
    this.moveKeyAside("discarded");
    const made = createKeyFile(this.keyFile);
    this.key = made.key;
    this.keyProblem = undefined;
    const shown = made.created && recoveryNotice(notice, made.key);
    this.immediate(() => {
      this.putSealed("keys", "session", randomBytes(32));
      if (made.created && !shown) this.setMeta("recovery_key_unconfirmed", "1");
      this.bump();
    });
  }

  /**
   * Replaces every row of every table with a checked backup's (STORE-TASK-005, STORE-DB-011): the file is attached read-only
   * (never created), and one `BEGIN IMMEDIATE` transaction reads the current revision, copies each table by its named columns and
   * sets `meta.revision` to that revision plus one. Returns the new revision. A program that has the store open sees it at its
   * next read.
   */
  replaceFrom(source: string): number {
    if (!existsSync(source)) throw new StoreError("usage", `no backup at ${source}`);
    this.db.run("ATTACH DATABASE ? AS restore_src", `${pathToFileURL(resolve(source)).href}?mode=ro`);
    try {
      const revision = this.immediate(() => {
        const before = this.revision();
        for (const t of TABLES) {
          const cols = COLUMNS[t].join(", ");
          this.db.run(`DELETE FROM main.${t}`);
          this.db.run(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM restore_src.${t}`);
        }
        this.setMeta("revision", String(before + 1));
        return before + 1;
      });
      this.session = undefined;
      return revision;
    } finally {
      this.db.run("DETACH DATABASE restore_src");
    }
  }

  // ---------------------------------------------------------------- backups

  /**
   * Takes a backup with SQLite's online backup to `<dataDir()>/store/backups/cohost-<yyyymmddThhmmssZ>.db`, mode 0600, then
   * keeps the ten newest (STORE-DB-008). Returns the file written.
   */
  // @spec STORE-DB-008
  async backup(opts: { keep?: string } = {}): Promise<string> {
    const dir = backupDir(this.ctx.data);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Two backups in one second (an import right after a restore) must not overwrite each other: the later one takes the next
    // free second.
    let at = Date.now();
    while (existsSync(join(dir, `cohost-${stamp(new Date(at))}.db`))) at += 1000;
    const file = join(dir, `cohost-${stamp(new Date(at))}.db`);
    // Created first with mode 0600, so the copy is never readable by others while it is written.
    writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    await this.db.backupTo(file);
    pruneBackups(dir, opts.keep);
    return file;
  }
}

const BACKUP_NAME = /^cohost-\d{8}T\d{6}Z\.db$/;

/** Deletes all but the ten newest backups of `dir` (STORE-DB-008), never `keep` (the backup a restore is reading). */
function pruneBackups(dir: string, keep?: string): void {
  const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).toSorted();
  for (const n of names.slice(0, Math.max(0, names.length - 10))) {
    if (keep !== undefined && resolve(join(dir, n)) === resolve(keep)) continue;
    unlinkSync(join(dir, n));
  }
}

/** The key files beside `keyFile` that an earlier rotation, restore or discard kept (`master.key.<label>-<stamp>`). */
function keptKeyFiles(keyFile: string): string[] {
  const dir = dirname(keyFile);
  const name = basename(keyFile);
  const kept = (n: string): boolean => n.startsWith(`${name}.`) && /^(rotated|replaced|discarded)-\d{8}T\d{6}Z$/.test(n.slice(name.length + 1));
  try { return readdirSync(dir).filter(kept).toSorted().toReversed().map((n) => join(dir, n)); } catch { return []; }
}

/**
 * Checks a private copy of a backup before it is restored: SQLite's integrity check, the meta rows, exactly this build's schema
 * version, and each table with exactly the columns this build's has. Returns its `meta.key_id`.
 */
function checkBackup(copy: string, source: string): string | undefined {
  const db = openDb(copy, { busyTimeoutMs: BUSY_TIMEOUT_MS.other, readOnly: true });
  try {
    let meta: Map<string, string>;
    let version: number;
    try {
      ({ meta, version } = checkIntegrity(db, source));
    } catch (e) {
      if (e instanceof StoreError && e.kind === "newer") throw new StoreError("usage", `the backup ${source} was made by a newer build of cohost (${e.message}); nothing was changed`);
      if (e instanceof StoreError && e.kind === "damaged") throw new StoreError("usage", `${e.message.replace("the settings store", "the backup")}; nothing was changed`);
      throw e;
    }
    if (version !== SCHEMA_VERSION) {
      throw new StoreError("usage", `the backup ${source} has schema version ${version} and this build restores only version ${SCHEMA_VERSION}; nothing was changed`);
    }
    for (const t of TABLES) {
      const cols = db.all(`SELECT name FROM pragma_table_info('${t}')`).map((r) => String(r.name));
      if (cols.join(",") !== COLUMNS[t].join(",")) {
        throw new StoreError("usage", `the backup ${source} is not a settings store backup: table ${t} has the columns ${cols.join(", ")}; nothing was changed`);
      }
    }
    return meta.get("key_id");
  } finally {
    db.close();
  }
}

/**
 * Restores a backup into the live store (STORE-TASK-005, -006; STORE-DB-011). The backup is first copied, through SQLite's
 * online backup from a read-only connection, to a private 0600 file in the store directory, and every check runs on that copy:
 * integrity, schema version, columns, and its key id, which must be the current key's or that of a kept key file beside it
 * (`master.key.rotated-…`, `.replaced-…`, `.discarded-…`). A readable live store is then backed up (never pruning the backup
 * being restored), a damaged one moved aside for a new, unseeded store; the copy's rows replace the live store's in one
 * transaction that sets the revision to the live one plus one; and a kept key the backup needs becomes the key file, the
 * current one kept as `replaced`. Returns the new revision.
 */
// @spec STORE-TASK-005, STORE-DB-011
export async function restoreBackup(source: string, opts: StoreOptions = {}): Promise<number> {
  const data = opts.dataDir ?? dataDir();
  const file = storeFile(data);
  const keyFile = opts.keyFile ?? keyFilePath();
  if (!existsSync(source)) throw new StoreError("usage", `no backup at ${source}`);
  withUmask(() => mkdirSync(storeDir(data), { recursive: true, mode: 0o700 }));
  const tmp = mkdtempSync(join(storeDir(data), ".restore-"));
  try {
    const copy = join(tmp, "backup.db");
    writeFileSync(copy, "", { mode: 0o600, flag: "wx" });
    let src: Db;
    try {
      src = openDb(source, { busyTimeoutMs: BUSY_TIMEOUT_MS.other, readOnly: true });
    } catch (e) {
      throw new StoreError("usage", `the backup ${source} cannot be opened: ${(e as Error).message}; nothing was changed`);
    }
    try {
      await src.backupTo(copy);
    } catch (e) {
      throw new StoreError("usage", `the backup ${source} cannot be read: ${(e as Error).message}; nothing was changed`);
    } finally {
      src.close();
    }
    const recorded = checkBackup(copy, source);

    // The key the backup's rows are under: the current key file's, or a kept one beside it.
    let installKey: Buffer | undefined;
    if (recorded !== undefined) {
      checkPrivateDir(dirname(keyFile), "master key");
      const current = readKeyFile(keyFile);
      if (!current || keyId(current) !== recorded) {
        installKey = keptKeyFiles(keyFile).map((f) => { try { return readKeyFile(f); } catch { return undefined; } }).find((k) => k && keyId(k) === recorded);
        if (!installKey) {
          throw new StoreError("key-wrong", `the backup ${source} was encrypted under the key ${recorded}, but the master key file ${keyFile} ${current ? `holds the key ${keyId(current)}` : "is missing"} and no kept key file beside it holds that key; nothing was changed`);
        }
      }
    }

    let live: Store | undefined;
    if (existsSync(file)) {
      try {
        live = await openStore({ ...opts, keyOptional: true, seed: false, createKey: false });
        await live.backup({ keep: source });
      } catch (e) {
        live?.close();
        live = undefined;
        if (!(e instanceof StoreError) || e.kind !== "damaged") throw e;
        moveDamagedAside(data);
      }
    }
    live ??= await openStore({ ...opts, keyOptional: true, seed: false, createKey: false });
    try {
      const revision = live.replaceFrom(copy);
      if (installKey) live.installKey(installKey);
      return revision;
    } finally { live.close(); }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The problems that stop the store's use (STORE-RCV-001), of one cause, the first that applies in the order damaged store,
 * newer store, missing or wrong key (or a key file others can read), invalid settings; an empty list when the store can be used.
 * A store that does not exist has no problem: it is created and seeded when a program opens it.
 */
// @spec STORE-RCV-001
export async function checkStore(opts: StoreOptions = {}): Promise<StoreProblem[]> {
  if (!existsSync(storeFile(opts.dataDir ?? dataDir()))) return [];
  let store: Store;
  try {
    store = await openStore({ ...opts, keyOptional: true });
  } catch (e) {
    if (e instanceof StoreError && e.kind === "damaged") return [{ cause: "damaged", message: e.message }];
    if (e instanceof StoreError && e.kind === "newer") return [{ cause: "newer", message: e.message }];
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      return [{ cause: "damaged", message: `the settings store under ${storeDir(opts.dataDir ?? dataDir())} cannot be used: ${code} (${(e as Error).message})` }];
    }
    throw e;
  }
  try {
    if (store.keyProblem) return [{ cause: "key", message: store.keyProblem.message }];
    try {
      store.verifyRows();
    } catch (e) {
      if (e instanceof StoreError && e.kind === "damaged") return [{ cause: "damaged", message: e.message }];
      if (e instanceof StoreError && e.kind === "key-wrong") return [{ cause: "key", message: e.message }];
      throw e;
    }
    return store.issues().map((i) => ({ cause: "settings", path: i.path, message: i.message }));
  } finally {
    store.close();
  }
}
