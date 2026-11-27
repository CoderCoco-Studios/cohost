import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dailyBackup, listBackups, peekStore, storeFile } from "../src/index.js";
import { sandbox } from "./helpers.js";

const TOKEN = "a-control-token-of-at-least-32-characters";

// @spec CFG-ENV-011, STORE-SET-002
test("a settings write holding a ${NAME} placeholder fails with one issue per placeholder at its path, and nothing is written", async () => {
  const s = await (sandbox()).open();
  const before = s.revision();
  const r = s.write({ sections: { cohost: { name: "${HOME}", streamer: "Chris" }, dashboard: { allowed_hosts: ["ok.lan", "${HOST:-x}"] } } });
  assert.equal(r.ok, false);
  const issues = (r as { issues: { path: string; message: string }[] }).issues;
  assert.deepEqual(issues.filter((i) => /placeholder/.test(i.message)).map((i) => i.path).toSorted(), ["cohost.name", "dashboard.allowed_hosts[1]"]);
  assert.equal(s.revision(), before);
  assert.equal(s.setKey("llm.model", "${LLM_MODEL}").ok, false, "config:set refuses it too");
  s.close();
});

// @spec STORE-RCV-002
test("resetKeys removes several keys in one write, the whole section when a path is the section", async () => {
  const s = await (sandbox()).open();
  assert.ok(s.setKey("voice.speed", 1.2).ok);
  assert.ok(s.setKey("dashboard.port", 4000).ok);
  const before = s.revision();
  const r = s.resetKeys(["voice.speed", "dashboard"]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.revision(), before + 1, "one write");
  assert.equal((s.sections().voice as Record<string, unknown> | undefined)?.speed, undefined);
  assert.equal(s.sections().dashboard, undefined);
  s.close();
});

// @spec STORE-TOK-003, STORE-RCV-001
test("peekStore reads the verifier, the stored dashboard section and the revision read-only, and nothing from a missing or unreadable file", async () => {
  const sb = sandbox();
  assert.equal(peekStore({ dataDir: sb.data }), undefined, "no store yet");
  const s = await sb.open();
  assert.deepEqual(peekStore({ dataDir: sb.data })?.verifier, undefined, "no token set");
  s.setToken(TOKEN);
  assert.ok(s.setKey("dashboard.port", 4100).ok);
  const peek = peekStore({ dataDir: sb.data })!;
  assert.match(peek.verifier!, /"alg":"scrypt"/);
  assert.equal((peek.dashboard as { port?: number }).port, 4100);
  assert.equal(peek.revision, s.revision());
  s.close();
  writeFileSync(storeFile(sb.data), "not a database at all, just text long enough to be read as a header");
  assert.equal(peekStore({ dataDir: sb.data }), undefined, "unreadable");
});

// @spec STORE-DB-008
test("listBackups lists the backups newest first with their times; dailyBackup takes one only when today has none", async () => {
  const s = await (sandbox()).open();
  assert.deepEqual(listBackups(s.dataDir), []);
  const day = new Date();
  const first = await dailyBackup(s, day);
  assert.ok(first, "the day's first start takes a backup");
  assert.equal(await dailyBackup(s, day), undefined, "a second start the same day takes none");
  await s.backup();
  const list = listBackups(s.dataDir);
  assert.equal(list.length, 2);
  assert.ok(list[0]!.name > list[1]!.name, "newest first");
  assert.match(list[0]!.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  s.close();
});
