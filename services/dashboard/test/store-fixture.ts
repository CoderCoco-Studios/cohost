/**
 * A settings store for the dashboard tests: a throwaway data directory and key file, seeded from the committed examples
 * (settings-store STORE-IO-005), with the test control token set (STORE-TOK-001), and optional edits of the stored sections.
 * Nothing touches the owner's store or key file.
 */
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, openStore, storeFile, type Store, type StoreOptions } from "@cohost/store";
import { TOKEN } from "./control-fixture.js";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `{section: {key: value}}`, keys relative to the section, dotted for nested keys (`openai.base_url` under `voice`). */
export type Edits = Record<string, Record<string, unknown>>;

export interface TestStore {
  store: Store;
  /** The options that open this store again (a data directory and key file of its own). */
  opts: StoreOptions;
  /** The workspace root projections are written under (a temporary directory). */
  root: string;
  close: () => void;
}

const quiet = { isTTY: false, write: () => undefined, warn: () => undefined };

/** Opens a new store at `opts` (default a fresh sandbox), seeded, with `TOKEN` set (unless `token: false`) and `edits` applied. */
export async function testStore(o: { edits?: Edits; token?: boolean; opts?: StoreOptions } = {}): Promise<TestStore> {
  const dir = mkdtempSync(join(tmpdir(), "cohost-dash-store-"));
  const opts: StoreOptions = o.opts ?? { dataDir: join(dir, "data"), keyFile: join(dir, "key", "master.key"), seedDir: join(repo, "config"), notice: quiet, warn: () => undefined };
  const store = await openStore({ ...opts, profile: "dashboard" });
  if (o.token !== false) store.setToken(TOKEN);
  for (const [section, values] of Object.entries(o.edits ?? {})) {
    for (const [key, value] of Object.entries(values)) {
      const r = store.setKey(`${section}.${key}`, value);
      if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r)}`);
    }
  }
  return { store, opts, root: join(dir, "root"), close: () => store.close() };
}

/**
 * Writes a stored section document as it is, past the store's checks (what a newer or older build may leave behind), straight
 * into the database file under `dataDir`, and bumps the revision; `doc` null removes the row.
 */
export function rawSection(dataDir: string, path: string, doc: unknown): void {
  const db = new DatabaseSync(storeFile(dataDir));
  try {
    if (doc === null) db.prepare("DELETE FROM sections WHERE path = ?").run(path);
    else db.prepare("INSERT INTO sections (path, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET doc = excluded.doc").run(path, JSON.stringify(doc), new Date().toISOString());
    db.exec("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'");
  } finally {
    db.close();
  }
}

/** The stored document of section `path`, `{}` when none is stored. */
export const storedSection = (store: Store, path: string): Record<string, unknown> => (store.sections()[path] ?? {}) as Record<string, unknown>;

/** Why config recovery mode runs (dashboard DASH-RCV-001, settings-store STORE-RCV-001). */
export type BrokenCause = "damaged-store" | "newer-store" | "missing-key" | "invalid-settings";

/**
 * A store that `checkStore` finds a problem with, closed so recovery mode opens it on its own: `invalid-settings` stores
 * `llm.temperature: 99` and an unknown `llm.retired_key` (two failing keys; set and reset both apply to the first, reset alone
 * to the second); `damaged-store` overwrites the database file; `newer-store` raises `meta.schema_version`; `missing-key`
 * deletes the key file. `edits` are applied, and `before` runs, while the store is still usable (a port for the recovery
 * listener, a backup, the recovery key).
 */
export async function brokenStore(cause: BrokenCause, o: { edits?: Edits; token?: boolean; before?: (store: Store) => unknown } = {}): Promise<TestStore> {
  const t = await testStore(o);
  await o.before?.(t.store);
  const llm = storedSection(t.store, "llm");
  t.close();
  const data = t.opts.dataDir!;
  if (cause === "invalid-settings") rawSection(data, "llm", { ...llm, temperature: 99, retired_key: true });
  if (cause === "damaged-store") writeFileSync(storeFile(data), "broken ".repeat(1000));
  if (cause === "newer-store") {
    const db = new DatabaseSync(storeFile(data));
    db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    db.close();
  }
  if (cause === "missing-key") unlinkSync(t.opts.keyFile!);
  return t;
}

/**
 * What the database under `dataDir` holds, read past the store (no key needed): `meta`, the stored sections, the credential
 * paths and the key rows' names. Unchanged text means nothing was written.
 */
export function dbState(dataDir: string): string {
  const db = new DatabaseSync(storeFile(dataDir), { readOnly: true });
  try {
    return JSON.stringify({
      meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      sections: db.prepare("SELECT path, doc FROM sections ORDER BY path").all(),
      secrets: db.prepare("SELECT path FROM secrets ORDER BY path").all(),
      keys: db.prepare("SELECT name FROM keys ORDER BY name").all(),
    });
  } finally {
    db.close();
  }
}
