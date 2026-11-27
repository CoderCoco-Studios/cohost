import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigSchema, parseYaml } from "@cohost/config";
import { NEWER_MESSAGE, SCHEMA_VERSION, StoreError, checkStore, moveDamagedAside, restoreBackup, storeFile } from "../src/index.js";
import { repo, sandbox } from "./helpers.js";

const mode = (f: string): number => statSync(f).mode & 0o777;
const raw = (file: string): DatabaseSync => new DatabaseSync(file);
const metaOf = (file: string): Record<string, string> => {
  const db = raw(file);
  try { return Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [String(r.key), String(r.value)])); } finally { db.close(); }
};
const rejection = async (p: Promise<unknown>): Promise<StoreError> => {
  try { await p; } catch (e) { assert.ok(e instanceof StoreError, String(e)); return e; }
  return assert.fail("expected the store to refuse");
};

// @spec STORE-DB-002, STORE-DB-009
test("a new store is <dataDir>/store/cohost.db in a 0700 directory, its files 0600, with schema version 1, a store id, revision and created_at", async () => {
  const sb = sandbox(true);
  const s = await sb.open();
  s.close();
  const file = storeFile(sb.data);
  assert.equal(file, join(sb.data, "store", "cohost.db"));
  assert.equal(mode(join(sb.data, "store")), 0o700);
  assert.equal(mode(file), 0o600);
  const meta = metaOf(file);
  assert.equal(meta.schema_version, "1");
  assert.match(meta.store_id!, /^[0-9a-f]{32}$/);
  assert.ok(!Number.isNaN(Date.parse(meta.created_at!)));
  assert.equal(meta.revision, "1", "revision 0 at creation, then one write: the seed");
  assert.deepEqual(sb.warnings, []);
});

// @spec STORE-DB-002
test("a store file others can read gets one warning naming it and chmod 600, and is still opened", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  chmodSync(storeFile(sb.data), 0o644);
  (await sb.open()).close();
  assert.equal(sb.warnings.length, 1, sb.warnings.join("\n"));
  assert.ok(sb.warnings[0]!.includes(storeFile(sb.data)) && sb.warnings[0]!.includes("chmod 600"), sb.warnings.join("\n"));
});

// @spec STORE-DB-003
test("the connection runs in WAL mode with synchronous NORMAL, foreign keys and secure delete, and the busy timeout of its program", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  assert.equal(readFileSync(storeFile(sb.data)).subarray(18, 20).toString("hex"), "0202", "the file header records WAL");
  const db = raw(storeFile(sb.data));
  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  db.close();
  const src = readFileSync(join(repo, "packages/store/src/store.ts"), "utf8");
  assert.match(src, /PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;/);
  assert.match(src, /BUSY_TIMEOUT_MS = \{ dashboard: 250, other: 5000 \}/);
});

// @spec STORE-DB-005, STORE-IO-005, STORE-DB-010
test("a new store is seeded from the committed examples: one row per section, the personality and the expressions, and config() validates", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    const example = parseYaml(readFileSync(join(repo, "config/config.example.yaml"), "utf8")) as Record<string, unknown>;
    assert.equal(s.config().cohost.name, (example.cohost as { name: string }).name);
    const paths = Object.keys(s.sections());
    assert.ok(paths.includes("cohost") && paths.includes("llm"), paths.join(","));
    assert.ok(paths.every((p) => !p.includes(".") || p.startsWith("brain.")), paths.join(","));
    assert.equal(s.personality(), readFileSync(join(repo, "config/personality.example.md"), "utf8"));
    assert.ok(s.expressions());
    assert.equal(ConfigSchema.safeParse(s.config()).success, true);
    assert.deepEqual(s.secretPaths(), []);
  } finally { s.close(); }
});

// @spec STORE-IO-005
test("a seed that does not validate refuses the store and leaves no store file", async () => {
  const sb = sandbox();
  const seed = join(sb.data, "..", "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "config.example.yaml"), "cohost: { name: '' }\n");
  const e = await rejection(sb.open({ seedDir: seed }));
  assert.equal(e.kind, "invalid");
  assert.match(e.message, /cohost\.name/);
  assert.equal(existsSync(storeFile(sb.data)), false);
});

// @spec STORE-DB-004
test("a file that is not a database, a failed integrity check or missing meta rows is a damaged store naming the file", async () => {
  const sb = sandbox();
  mkdirSync(join(sb.data, "store"), { recursive: true });
  writeFileSync(storeFile(sb.data), "this is not a database, just text that is long enough to have a header ".repeat(20));
  let e = await rejection(sb.open());
  assert.equal(e.kind, "damaged");
  assert.ok(e.message.includes(storeFile(sb.data)));

  const sb2 = sandbox();
  (await sb2.open()).close();
  const db = raw(storeFile(sb2.data));
  db.exec("DELETE FROM meta WHERE key = 'store_id'");
  db.close();
  e = await rejection(sb2.open());
  assert.equal(e.kind, "damaged");
  assert.match(e.message, /meta\.store_id is missing/);
  assert.deepEqual(await checkStore(sb2.opts), [{ cause: "damaged", message: e.message }]);
});

// @spec STORE-DB-004
test("a store with a newer schema version is refused as newer, with the update message, and is not changed", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  const db = raw(storeFile(sb.data));
  db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
  db.close();
  const before = metaOf(storeFile(sb.data));
  const e = await rejection(sb.open());
  assert.equal(e.kind, "newer");
  assert.ok(e.message.startsWith(NEWER_MESSAGE));
  assert.deepEqual(metaOf(storeFile(sb.data)), before);
  assert.equal((await checkStore(sb.opts))[0]?.cause, "newer");
});

// @spec STORE-DB-006
test("every committed write increments meta.revision by one; a refused write changes nothing", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    const r0 = s.revision();
    assert.deepEqual(s.setKey("cohost.timezone", "Europe/London"), { ok: true, revision: r0 + 1 });
    assert.equal(s.write({ personality: "# P" }).ok, true);
    assert.equal(s.revision(), r0 + 2);
    assert.equal(s.setKey("llm.temperature", 9).ok, false);
    assert.equal(s.revision(), r0 + 2);
  } finally { s.close(); }
});

// @spec STORE-DB-008
test("a backup is a 0600 copy in store/backups named cohost-<UTC stamp>.db, and only the ten newest are kept", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    const dir = join(sb.data, "store", "backups");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `cohost-2020010${i < 10 ? 1 : 2}T0000${String(i).padStart(2, "0")}Z.db`), "");
    writeFileSync(join(dir, "keep-me.txt"), "");
    const file = await s.backup();
    assert.match(file, /backups\/cohost-\d{8}T\d{6}Z\.db$/);
    assert.equal(mode(file), 0o600);
    const left = readdirSync(dir);
    assert.equal(left.filter((n) => n.startsWith("cohost-")).length, 10);
    assert.ok(left.includes("keep-me.txt"));
    assert.ok(left.includes(file.split("/").at(-1)!));
    assert.equal(metaOf(file).store_id, s.storeId);
  } finally { s.close(); }
});

// @spec STORE-TASK-005, STORE-DB-011
test("a restore checks the backup, copies it in and sets the revision to the live store's previous revision plus one", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.setKey("cohost.timezone", "Asia/Tokyo");
  const backup = await s.backup();
  s.setKey("cohost.timezone", "Europe/Paris");
  s.setKey("cohost.timezone", "Europe/Rome");
  const previous = s.revision();
  const r = await restoreBackup(backup, sb.opts);
  assert.equal(r, previous + 1);
  assert.equal(s.revision(), previous + 1, "a program that has the store open sees the new revision");
  assert.equal(s.config().cohost.timezone, "Asia/Tokyo");
  s.close();
});

// @spec STORE-TASK-005
test("a restore refuses a backup that is damaged or was encrypted under another key, and changes nothing", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-one" } });
  const rev = s.revision();
  const bad = join(sb.data, "bad.db");
  writeFileSync(bad, "not a database ".repeat(100));
  assert.equal((await rejection(restoreBackup(bad, sb.opts))).kind, "usage");

  const other = sandbox();
  const o = await other.open();
  o.write({ secrets: { "llm.openai.api_key": "sk-two" } });
  const foreign = await o.backup();
  o.close();
  const e = await rejection(restoreBackup(foreign, sb.opts));
  assert.equal(e.kind, "key-wrong");
  assert.equal(s.revision(), rev);
  assert.equal(s.secret("llm.openai.api_key"), "sk-one");
  s.close();
});

// @spec STORE-TASK-006, STORE-DB-011
test("a restore over a damaged store moves it aside as cohost.db.damaged-<stamp> and leaves revision 1", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const backup = await s.backup();
  s.close();
  writeFileSync(storeFile(sb.data), "damaged ".repeat(600));
  assert.equal(await restoreBackup(backup, sb.opts), 1);
  const names = readdirSync(join(sb.data, "store"));
  assert.ok(names.some((n) => /^cohost\.db\.damaged-\d{8}T\d{6}Z$/.test(n)), names.join(","));
  const again = await sb.open();
  assert.equal(again.revision(), 1);
  again.close();
});

// @spec STORE-TASK-006
test("moving a damaged store aside renames the database and its WAL and shared-memory files with one suffix", () => {
  const sb = sandbox();
  mkdirSync(join(sb.data, "store"), { recursive: true });
  for (const f of ["", "-wal", "-shm"]) writeFileSync(`${storeFile(sb.data)}${f}`, "x");
  const moved = moveDamagedAside(sb.data);
  const suffix = moved.slice(storeFile(sb.data).length);
  assert.match(suffix, /^\.damaged-\d{8}T\d{6}Z$/);
  assert.deepEqual(readdirSync(join(sb.data, "store")).toSorted(), [`cohost.db${suffix}`, `cohost.db-shm${suffix}`, `cohost.db-wal${suffix}`].toSorted());
});

// @spec STORE-TASK-005, STORE-DB-008
test("restoring the oldest of ten backups works: the pre-restore backup never prunes the backup being restored", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.setKey("cohost.timezone", "Asia/Tokyo");
  const oldest = await s.backup();
  s.setKey("cohost.timezone", "Europe/Rome");
  for (let i = 0; i < 9; i++) await s.backup();
  assert.equal(readdirSync(join(sb.data, "store", "backups")).length, 10);
  await restoreBackup(oldest, sb.opts);
  assert.equal(s.config().cohost.timezone, "Asia/Tokyo");
  assert.ok(existsSync(oldest), "the restored backup is kept");
  assert.deepEqual(readdirSync(join(sb.data, "store")).filter((n) => n.startsWith(".restore-")), [], "the private copy is removed");
  s.close();
});

// @spec STORE-DB-011
test("the restored revision is read inside the copy's transaction: a write that lands first is counted", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const backup = await s.backup();
  const other = await sb.open();
  other.setKey("cohost.timezone", "Europe/Oslo");
  const before = other.revision();
  assert.equal(s.replaceFrom(backup), before + 1);
  assert.equal(other.revision(), before + 1);
  other.close();
  s.close();
});

// @spec STORE-TASK-005
test("a backup with another schema version or other columns is refused; the source is read only and a missing one is never created", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const rev = s.revision();
  const newer = await s.backup();
  let db = raw(newer);
  db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
  db.close();
  const older = await s.backup();
  db = raw(older);
  db.exec("ALTER TABLE documents ADD COLUMN extra TEXT");
  db.close();
  const before = readFileSync(older);
  for (const f of [newer, older]) {
    const e = await rejection(restoreBackup(f, sb.opts));
    assert.equal(e.kind, "usage", e.message);
    assert.ok(e.message.includes(f) && e.message.includes("nothing was changed"), e.message);
  }
  assert.ok(readFileSync(older).equals(before), "the source is not written");
  const missing = join(sb.data, "no-such-backup.db");
  assert.equal((await rejection(restoreBackup(missing, sb.opts))).kind, "usage");
  assert.equal(existsSync(missing), false);
  assert.throws(() => s.replaceFrom(missing), (e: StoreError) => e.kind === "usage");
  assert.equal(existsSync(missing), false);
  assert.equal(s.revision(), rev);
  s.close();
});

// @spec STORE-TASK-005, STORE-KEY-007
test("a backup taken before a rotation restores with the kept rotated key, which becomes the key file again", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-before" } });
  const backup = await s.backup();
  const oldKey = readFileSync(sb.keyFile, "utf8");
  s.rotateKey({ isTTY: false, write: () => undefined, warn: () => undefined });
  s.write({ secrets: { "llm.openai.api_key": "sk-after" } });
  s.close();
  await restoreBackup(backup, sb.opts);
  assert.equal(readFileSync(sb.keyFile, "utf8"), oldKey);
  const r = await sb.open();
  assert.equal(r.secret("llm.openai.api_key"), "sk-before");
  r.close();
  assert.ok(readdirSync(join(sb.keyFile, "..")).some((n) => n.startsWith("master.key.replaced-")), "the rotated-to key is kept as replaced");
});

// @spec STORE-TASK-005, STORE-KEY-003
test("a restore with the key file missing creates no key and prints no recovery key: it installs the backup's kept key", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-kept" } });
  const backup = await s.backup();
  const oldKey = readFileSync(sb.keyFile, "utf8");
  // The live store holds no credential, so opening it with the key file missing would otherwise make a new key.
  s.write({ secrets: { "llm.openai.api_key": null } });
  s.rotateKey({ isTTY: false, write: () => undefined, warn: () => undefined });
  s.close();
  rmSync(sb.keyFile);
  sb.notices.length = 0;
  sb.pointers.length = 0;
  await restoreBackup(backup, sb.opts);
  assert.deepEqual(sb.notices, []);
  assert.deepEqual(sb.pointers, []);
  assert.ok(!readdirSync(join(sb.keyFile, "..")).some((n) => n.startsWith("master.key.replaced-")), "no key was made and then replaced");
  assert.equal(readFileSync(sb.keyFile, "utf8"), oldKey);
  const r = await sb.open();
  assert.equal(r.secret("llm.openai.api_key"), "sk-kept");
  r.close();
});
