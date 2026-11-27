import { test } from "node:test";
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
  assert.deepEqual(piped.notices, ["a recovery key was created; run mise run config:key -- --show\n"]);
  assert.ok(!piped.notices.join("").includes(KEY_PREFIX));
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
  for (const part of [sb.keyFile, storeFile(sb.data), "2 stored credentials", "mise run config:key -- --restore", "mise run config:reset-credentials"]) assert.ok(e.message.includes(part), part);
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
test("rotation re-encrypts every row under a new key, updates key_id and the 0600 key file, and returns the new recovery key", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-r" } });
  s.setToken("t".repeat(40));
  const oldText = readFileSync(sb.keyFile, "utf8").trim();
  const session = s.sessionKey();
  const text = s.rotateKey();
  assert.notEqual(text, oldText);
  assert.equal(readFileSync(sb.keyFile, "utf8").trim(), text);
  assert.equal(mode(sb.keyFile), 0o600);
  assert.equal(s.secret("llm.openai.api_key"), "sk-r");
  s.close();
  const again = await sb.open();
  assert.equal(again.secret("llm.openai.api_key"), "sk-r");
  assert.ok(again.sessionKey()?.equals(session!));
  again.close();
  assert.deepEqual(readdirSync(dirname(sb.keyFile)), ["master.key"]);
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
  await r.resetCredentials({ isTTY: true, write: (t) => { notices.push(t); } });
  assert.deepEqual(r.secretPaths(), []);
  assert.ok(r.sessionKey());
  assert.equal(r.earsListenerKey(), undefined);
  assert.equal(r.hasVerifier(), true);
  assert.ok(notices.join("").includes(readFileSync(sb.keyFile, "utf8").trim()));
  assert.equal(readdirSync(join(sb.data, "store", "backups")).length, 1);
  r.close();
  (await sb.open()).close();
});
