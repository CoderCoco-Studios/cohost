import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KEY_PREFIX, StoreError, checkStore, formatKey, keyFilePath, keyId, parseKey, storeFile } from "../src/index.js";
import { createKeyFile } from "../src/keys.js";
import { sandbox } from "./helpers.js";

const mode = (f: string): number => statSync(f).mode & 0o777;
const rejection = async (p: Promise<unknown>): Promise<StoreError> => {
  try { await p; } catch (e) { assert.ok(e instanceof StoreError, String(e)); return e; }
  return assert.fail("expected the store to refuse");
};

// @spec STORE-KEY-001
test("the key file is COHOST_KEY_FILE, else $XDG_CONFIG_HOME/cohost/master.key, else ~/.config/cohost/master.key", () => {
  assert.equal(keyFilePath({ COHOST_KEY_FILE: "/k/x.key", XDG_CONFIG_HOME: "/xdg" }), "/k/x.key");
  assert.equal(keyFilePath({ COHOST_KEY_FILE: "", XDG_CONFIG_HOME: "/xdg" }), "/xdg/cohost/master.key");
  assert.equal(keyFilePath({ XDG_CONFIG_HOME: "" }), join(homedir(), ".config", "cohost", "master.key"));
});

// @spec STORE-KEY-001, STORE-KEY-002
test("a missing key is created on open: 0700 directory, 0600 file holding cohost-key-1: and 32 bytes of base64url, no temporary file left", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  assert.equal(mode(dirname(sb.keyFile)), 0o700);
  assert.equal(mode(sb.keyFile), 0o600);
  const text = readFileSync(sb.keyFile, "utf8");
  assert.match(text, /^cohost-key-1:[A-Za-z0-9_-]{43}\n$/);
  assert.equal(parseKey(text)?.length, 32);
  assert.deepEqual(readdirSync(dirname(sb.keyFile)), ["master.key"]);
});

// @spec STORE-KEY-002
test("on a terminal the recovery key is printed with why to keep it; otherwise only a pointer is printed and the unconfirmed flag set", async () => {
  const tty = sandbox(true);
  const a = await tty.open();
  const notice = tty.notices.join("");
  assert.ok(notice.includes(readFileSync(tty.keyFile, "utf8").trim()));
  assert.match(notice, /only way to recover the stored credentials.*password manager/s);
  assert.equal(a.recoveryKeyUnconfirmed(), false);
  a.close();

  const piped = sandbox(false);
  const b = await piped.open();
  assert.deepEqual(piped.notices, [], "nothing reaches standard output");
  assert.deepEqual(piped.pointers, ["a recovery key was created; run mise run config:key -- --show\n"]);
  assert.ok(!piped.pointers.join("").includes(KEY_PREFIX));
  assert.equal(b.recoveryKeyUnconfirmed(), true);
  b.confirmRecoveryKey();
  assert.equal(b.recoveryKeyUnconfirmed(), false);
  b.close();
  assert.deepEqual(piped.warnings, [], "the notice never goes through the warning (logger) path");
});

// @spec STORE-KEY-002
test("two programs creating the key at once agree on one key: the loser reads the winner's file", () => {
  const sb = sandbox();
  const first = createKeyFile(sb.keyFile);
  const second = createKeyFile(sb.keyFile);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.ok(second.key.equals(first.key));
});

// @spec STORE-KEY-003
test("a missing key while the store holds credentials is refused, naming the key file, the store, the count and both ways forward; no key is made", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-a", "chat.youtube.api_key": "yt" } });
  s.close();
  unlinkSync(sb.keyFile);
  const e = await rejection(sb.open());
  assert.equal(e.kind, "key-missing");
  for (const part of [sb.keyFile, storeFile(sb.data), "2 stored credentials", "mise run config:key -- --restore", "mise run config:restore", "mise run config:reset-credentials", "No kept key file"]) assert.ok(e.message.includes(part), part);
  assert.equal(existsSync(sb.keyFile), false);
  assert.deepEqual((await checkStore(sb.opts)).map((p) => p.cause), ["key"]);
  assert.equal(existsSync(sb.keyFile), false);
});

// @spec STORE-KEY-004
test("the key id is HMAC-SHA256 of cohost/key-id/v1, 16 hex digits, recorded at the first encryption; another key is refused naming both ids", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const key = parseKey(readFileSync(sb.keyFile, "utf8"))!;
  assert.equal(keyId(key), createHmac("sha256", key).update("cohost/key-id/v1").digest("hex").slice(0, 16));
  s.write({ secrets: { "llm.openai.api_key": "sk-a" } });
  s.close();
  const db = new DatabaseSync(storeFile(sb.data));
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'key_id'").get()!.value, keyId(key));
  db.close();
  const other = Buffer.alloc(32, 7);
  writeFileSync(sb.keyFile, `${formatKey(other)}\n`, { mode: 0o600 });
  const e = await rejection(sb.open());
  assert.equal(e.kind, "key-wrong");
  assert.ok(e.message.includes(keyId(key)) && e.message.includes(keyId(other)));
  assert.ok(!e.message.includes(formatKey(other)));
});

// @spec STORE-KEY-005
test("a key file group or other can read is refused naming it and chmod 600", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  chmodSync(sb.keyFile, 0o640);
  const e = await rejection(sb.open());
  assert.equal(e.kind, "key-mode");
  assert.ok(e.message.includes(sb.keyFile) && e.message.includes("chmod 600"));
});

// @spec STORE-KEY-006
test("each credential is AES-256-GCM with a fresh nonce, bound to store, table and path: a row moved to another path does not decrypt", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-same", "chat.youtube.api_key": "sk-same" } });
  const db = new DatabaseSync(storeFile(sb.data));
  const rows = db.prepare("SELECT path, nonce, tag, ciphertext, key_id FROM secrets").all();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal((r.nonce as Uint8Array).length, 12);
    assert.equal((r.tag as Uint8Array).length, 16);
    assert.ok(!Buffer.from(r.ciphertext as Uint8Array).toString("utf8").includes("sk-same"));
  }
  assert.notDeepEqual(rows[0]!.nonce, rows[1]!.nonce);
  // Copy one row's sealed value over the other: authentication fails, reported by table and path, never a value.
  db.prepare("UPDATE secrets SET nonce = ?, tag = ?, ciphertext = ? WHERE path = 'chat.youtube.api_key'").run(rows.find((r) => r.path === "llm.openai.api_key")!.nonce as Uint8Array, rows.find((r) => r.path === "llm.openai.api_key")!.tag as Uint8Array, rows.find((r) => r.path === "llm.openai.api_key")!.ciphertext as Uint8Array);
  db.close();
  assert.equal(s.secret("llm.openai.api_key"), "sk-same");
  assert.throws(() => s.secret("chat.youtube.api_key"), (e: StoreError) => e.kind === "damaged" && e.message.includes("secrets.chat.youtube.api_key") && !e.message.includes("sk-same"));
  s.close();
  assert.equal((await checkStore(sb.opts))[0]?.cause, "damaged");
});

// @spec STORE-KEY-007
test("rotation re-encrypts every row under a new key, keeps the old key file as rotated-<stamp> 0600, and shows the new recovery key", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.confirmRecoveryKey();
  s.write({ secrets: { "llm.openai.api_key": "sk-r" } });
  s.setToken("t".repeat(40));
  const oldText = readFileSync(sb.keyFile, "utf8").trim();
  const session = s.sessionKey();
  const shown: string[] = [];
  const text = s.rotateKey({ isTTY: true, write: (t) => { shown.push(t); }, warn: () => undefined });
  assert.notEqual(text, oldText);
  assert.ok(shown.join("").includes(text), "the new recovery key is shown on a terminal");
  assert.equal(s.recoveryKeyUnconfirmed(), false);
  assert.equal(readFileSync(sb.keyFile, "utf8").trim(), text);
  assert.equal(mode(sb.keyFile), 0o600);
  assert.equal(s.secret("llm.openai.api_key"), "sk-r");
  s.close();
  const again = await sb.open();
  assert.equal(again.secret("llm.openai.api_key"), "sk-r");
  assert.ok(again.sessionKey()?.equals(session!));
  again.close();
  const names = readdirSync(dirname(sb.keyFile)).toSorted();
  assert.equal(names.length, 2, names.join(","));
  const kept = join(dirname(sb.keyFile), names.find((n) => n !== "master.key")!);
  assert.match(kept, /master\.key\.rotated-\d{8}T\d{6}Z$/);
  assert.equal(mode(kept), 0o600);
  assert.equal(readFileSync(kept, "utf8").trim(), oldText);
});

// @spec STORE-KEY-007, STORE-KEY-002
test("without a terminal, rotation prints only the pointer, on standard error, and sets the unconfirmed flag", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.confirmRecoveryKey();
  const out: string[] = [];
  const err: string[] = [];
  s.rotateKey({ isTTY: false, write: (t) => { out.push(t); }, warn: (t) => { err.push(t); } });
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["a recovery key was created; run mise run config:key -- --show\n"]);
  assert.equal(s.recoveryKeyUnconfirmed(), true);
  s.close();
});

// @spec STORE-KEY-006
test("a row copied from another store, or a secrets row swapped into keys, fails to decrypt: the associated data binds store id and table", async () => {
  const a = sandbox();
  const sa = await a.open();
  sa.write({ secrets: { "llm.openai.api_key": "sk-a" } });
  const key = readFileSync(a.keyFile, "utf8");
  sa.close();
  // A second store under the same key: only the store id differs.
  const b = sandbox();
  const sb2 = await b.open({ keyFile: a.keyFile });
  sb2.write({ secrets: { "chat.youtube.api_key": "yt-b" } });
  sb2.close();
  const da = new DatabaseSync(storeFile(a.data));
  const row = da.prepare("SELECT nonce, tag, ciphertext, key_id FROM secrets WHERE path = 'llm.openai.api_key'").get()!;
  // Same path, same key, the other store.
  const db2 = new DatabaseSync(storeFile(b.data));
  db2.prepare("INSERT INTO secrets (path, nonce, tag, ciphertext, key_id, updated_at) VALUES ('llm.openai.api_key', ?, ?, ?, ?, 'x')")
    .run(row.nonce as Uint8Array, row.tag as Uint8Array, row.ciphertext as Uint8Array, String(row.key_id));
  db2.close();
  const s2 = await b.open({ keyFile: a.keyFile });
  assert.throws(() => s2.secret("llm.openai.api_key"), (e: StoreError) => e.kind === "damaged");
  s2.close();
  // The same row moved to the keys table under the same name.
  da.prepare("INSERT INTO keys (name, nonce, tag, ciphertext, key_id, updated_at) VALUES ('session', ?, ?, ?, ?, 'x')")
    .run(row.nonce as Uint8Array, row.tag as Uint8Array, row.ciphertext as Uint8Array, String(row.key_id));
  da.close();
  const s1 = await a.open();
  assert.throws(() => s1.sessionKey(), (e: StoreError) => e.kind === "damaged" && e.message.includes("keys.session"));
  s1.close();
  assert.equal(readFileSync(a.keyFile, "utf8"), key);
});

// @spec STORE-KEY-006
test("a row whose key id is not the current key's is reported as under another key, not as damage", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-x" } });
  s.close();
  const db = new DatabaseSync(storeFile(sb.data));
  db.exec("UPDATE secrets SET key_id = '0123456789abcdef'");
  db.close();
  const r = await sb.open();
  assert.throws(() => r.secret("llm.openai.api_key"), (e: StoreError) => e.kind === "key-wrong" && e.message.includes("0123456789abcdef"));
  r.close();
  assert.equal((await checkStore(sb.opts))[0]?.cause, "key");
});

// @spec STORE-KEY-005
test("a key directory group or other can write is refused naming it and chmod 700", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  chmodSync(dirname(sb.keyFile), 0o770);
  const e = await rejection(sb.open());
  assert.equal(e.kind, "key-mode");
  assert.ok(e.message.includes(dirname(sb.keyFile)) && e.message.includes("chmod 700"));
});

// @spec STORE-KEY-008
test("a recovery key restores a lost key file; a malformed one or one with another id is refused and writes nothing", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-k" } });
  const recovery = s.recoveryKey();
  s.close();
  unlinkSync(sb.keyFile);
  const opened = await sb.open({ keyOptional: true });
  assert.equal(opened.keyProblem?.kind, "key-missing");
  assert.throws(() => opened.restoreKey("cohost-key-1:short"), (e: StoreError) => e.kind === "usage");
  assert.throws(() => opened.restoreKey(formatKey(Buffer.alloc(32, 1))), (e: StoreError) => e.kind === "key-wrong");
  assert.equal(existsSync(sb.keyFile), false);
  opened.restoreKey(`  ${recovery}\n`);
  assert.equal(mode(sb.keyFile), 0o600);
  assert.equal(opened.secret("llm.openai.api_key"), "sk-k");
  opened.close();
});

// @spec STORE-KEY-009
test("discarding credentials deletes every secret and key row, makes a new key and session key, keeps the verifier, and backs up first", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-d" } });
  s.setToken("z".repeat(40));
  s.close();
  unlinkSync(sb.keyFile);
  const r = await sb.open({ keyOptional: true });
  const notices: string[] = [];
  await r.resetCredentials({ isTTY: true, write: (t) => { notices.push(t); }, warn: () => undefined });
  assert.deepEqual(r.secretPaths(), []);
  assert.ok(r.sessionKey());
  assert.equal(r.earsListenerKey(), undefined);
  assert.equal(r.hasVerifier(), true);
  assert.ok(notices.join("").includes(readFileSync(sb.keyFile, "utf8").trim()));
  assert.equal(readdirSync(join(sb.data, "store", "backups")).length, 1);
  r.close();
  // The key file present at the reset is kept beside it, 0600, so the pre-reset backup still decrypts with it.
  const sb2 = sandbox();
  const s2 = await sb2.open();
  s2.write({ secrets: { "llm.openai.api_key": "sk-old" } });
  const oldKey = readFileSync(sb2.keyFile, "utf8");
  await s2.resetCredentials({ isTTY: false, write: () => undefined, warn: () => undefined });
  s2.close();
  const kept = readdirSync(dirname(sb2.keyFile)).filter((n) => /^master\.key\.discarded-\d{8}T\d{6}Z$/.test(n));
  assert.equal(kept.length, 1);
  assert.equal(mode(join(dirname(sb2.keyFile), kept[0]!)), 0o600);
  assert.equal(readFileSync(join(dirname(sb2.keyFile), kept[0]!), "utf8"), oldKey);
  (await sb.open()).close();
});

// @spec STORE-KEY-005, STORE-KEY-009
test("two key files moved aside in the same second both survive: the later takes the next free name", async () => {
  const sb = sandbox();
  const s = await sb.open();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T12:00:00Z") });
  try {
    const first = readFileSync(sb.keyFile, "utf8");
    await s.resetCredentials({ isTTY: false, write: () => undefined, warn: () => undefined });
    const second = readFileSync(sb.keyFile, "utf8");
    await s.resetCredentials({ isTTY: false, write: () => undefined, warn: () => undefined });
    const kept = readdirSync(dirname(sb.keyFile)).filter((n) => n.startsWith("master.key.discarded-")).toSorted();
    assert.deepEqual(kept, ["master.key.discarded-20261127T120000Z", "master.key.discarded-20261127T120001Z"]);
    assert.deepEqual(kept.map((n) => readFileSync(join(dirname(sb.keyFile), n), "utf8")), [first, second]);
  } finally {
    mock.timers.reset();
    s.close();
  }
});

// @spec STORE-KEY-003
test("the missing-key refusal lists the kept key files beside the key file", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-a" } });
  s.rotateKey({ isTTY: false, write: () => undefined, warn: () => undefined });
  s.close();
  unlinkSync(sb.keyFile);
  const e = await rejection(sb.open());
  assert.match(e.message, /Kept key files beside it may hold the key: .*master\.key\.rotated-\d{8}T\d{6}Z/);
});
