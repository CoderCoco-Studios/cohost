import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BearerChecker, StoreError, earsListenerKey, makeVerifier, parseVerifier, storeFile } from "../src/index.js";
import { sandbox } from "./helpers.js";

const TOKEN = "a-control-token-of-at-least-32-characters";

// @spec STORE-TOK-002, CTRL-RUNTIME-017
test("setting the token stores an scrypt verifier, a new session key and the derived ears listener key, and never the token", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.setToken(`  ${TOKEN}  `);
  const db = new DatabaseSync(storeFile(sb.data));
  const v = parseVerifier(String(db.prepare("SELECT value FROM meta WHERE key = 'token_verifier'").get()!.value))!;
  assert.deepEqual({ alg: v.alg, N: v.N, r: v.r, p: v.p, maxmem: v.maxmem }, { alg: "scrypt", N: 32768, r: 8, p: 1, maxmem: 67108864 });
  assert.equal(Buffer.from(v.salt, "base64url").length, 16);
  assert.ok(scryptSync(TOKEN, Buffer.from(v.salt, "base64url"), 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).equals(Buffer.from(v.hash, "base64url")));
  const names = db.prepare("SELECT name FROM keys ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, ["ears-listener", "session"]);
  // The token appears nowhere in the file.
  const dump = JSON.stringify(db.prepare("SELECT * FROM meta").all()) + JSON.stringify(db.prepare("SELECT hex(ciphertext) AS c FROM keys").all());
  assert.ok(!dump.includes(TOKEN));
  db.close();
  assert.equal(s.earsListenerKey(), createHmac("sha256", TOKEN).update("cohost/ears-listener/v1").digest("hex"));
  assert.equal(earsListenerKey(` ${TOKEN}\n`), s.earsListenerKey());
  const first = s.sessionKey();
  assert.equal(first?.length, 32);
  assert.notEqual(first!.toString("hex"), s.earsListenerKey(), "the session key is not the ears listener key (CTRL-RUNTIME-017)");
  s.setToken(TOKEN);
  assert.ok(!s.sessionKey()!.equals(first!), "setting the token again replaces the session key");
  s.close();
});

// @spec STORE-TOK-001
test("a token shorter than 32 characters after trimming is refused without naming it, and nothing changes", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const rev = s.revision();
  assert.throws(() => s.setToken(`   ${"x".repeat(31)}   `), (e: StoreError) => e.kind === "usage" && !e.message.includes("xxxx"));
  assert.equal(s.revision(), rev);
  assert.equal(s.hasVerifier(), false);
  s.close();
});

// @spec STORE-TOK-003
test("a bearer is checked by scrypt in constant time; a verified value is remembered, and forgotten when the verifier changes", async () => {
  let verifier = JSON.stringify(makeVerifier(TOKEN));
  const c = new BearerChecker(() => verifier);
  assert.equal(await c.check("wrong-value"), "bad");
  assert.equal(await c.check(""), "bad");
  assert.equal(await c.check(TOKEN), "ok");
  const t0 = performance.now();
  assert.equal(await c.check(TOKEN), "ok");
  assert.ok(performance.now() - t0 < 5, "a remembered value skips scrypt");
  verifier = JSON.stringify(makeVerifier("another-token-that-is-long-enough-to-use"));
  assert.equal(await c.check(TOKEN), "bad", "the remembered value is forgotten with the old verifier");
  assert.equal(await new BearerChecker(() => undefined).check(TOKEN), "bad");
});

// @spec STORE-TOK-003
test("one scrypt runs at a time with at most four waiting: a fifth waiting check is answered busy at once", async () => {
  const verifier = JSON.stringify(makeVerifier(TOKEN));
  const c = new BearerChecker(() => verifier);
  const checks = Array.from({ length: 6 }, (_, i) => c.check(`bad-${i}`));
  const results = await Promise.all(checks);
  assert.deepEqual(results.toSorted(), ["bad", "bad", "bad", "bad", "bad", "busy"]);
  assert.equal(await c.check("bad-again"), "bad", "the queue drains");
});

// @spec STORE-TOK-003, STORE-KEY-009
test("a bearer that verifies while the store has no listener key re-derives it", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.setToken(TOKEN);
  await s.resetCredentials({ isTTY: false, write: () => undefined, warn: () => undefined });
  assert.equal(s.earsListenerKey(), undefined);
  assert.equal(await s.checkBearer("not-the-token-at-all-not-the-token"), "bad");
  assert.equal(s.earsListenerKey(), undefined);
  assert.equal(await s.checkBearer(TOKEN), "ok");
  assert.equal(s.earsListenerKey(), earsListenerKey(TOKEN));
  s.close();
});

// @spec STORE-TOK-004
test("the session key is re-read when the revision changed, so a token set by another program ends sessions", async () => {
  const sb = sandbox();
  const dash = await sb.open({ profile: "dashboard" });
  const task = await sb.open();
  task.setToken(TOKEN);
  const first = dash.sessionKey();
  assert.ok(first);
  task.setToken(TOKEN);
  assert.ok(!dash.sessionKey()!.equals(first));
  dash.close();
  task.close();
});
