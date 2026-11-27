import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { StoreError, storeFile } from "../src/index.js";
import { sandbox } from "./helpers.js";

/** A stored section document as a mapping. */
const sec = (store: { sections(): Record<string, unknown> }, path: string): Record<string, unknown> => (store.sections()[path] ?? {}) as Record<string, unknown>;

const issuesOf = (r: { ok: boolean }): { path: string; message: string }[] => (r as { issues?: { path: string; message: string }[] }).issues ?? [];

// @spec STORE-SET-002, STORE-DB-005
test("a write validates the whole assembled configuration and commits only when it passes, returning every issue by path", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    const before = s.sections() as Record<string, Record<string, unknown>>;
    const r = s.write({ sections: { llm: { ...before.llm, temperature: 7 }, cohost: { ...before.cohost, nonsense: 1 } } });
    assert.equal(r.ok, false);
    assert.deepEqual(issuesOf(r).map((i) => i.path).toSorted(), ["cohost.nonsense", "llm.temperature"]);
    assert.deepEqual(s.sections(), before, "nothing was half-written");
    const ok = s.write({ sections: { llm: { ...before.llm, temperature: null, model: "m2" } } });
    assert.equal(ok.ok, true);
    assert.equal(sec(s, "llm").temperature, undefined, "a null value is dropped, so its default applies");
    assert.equal(s.config().llm.temperature, 0.9);
    assert.equal(s.config().llm.model, "m2");
    assert.equal(issuesOf(s.write({ sections: { "not-a-section": { a: 1 } } }))[0]?.path, "not-a-section");
    assert.equal(issuesOf(s.write({ personality: "x".repeat(64 * 1024 + 1) }))[0]?.path, "personality");
    assert.ok(issuesOf(s.write({ expressions: { vmc: { happy: 3 } } })).some((i) => i.path.startsWith("expressions.vmc")));
  } finally { s.close(); }
});

// @spec STORE-SET-003
test("a write that carries a stale revision applies nothing and returns the current revision", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const rev = s.revision();
  assert.deepEqual(s.setKey("cohost.timezone", "UTC", { expectedRevision: rev }), { ok: true, revision: rev + 1 });
  assert.deepEqual(s.setKey("cohost.timezone", "Europe/Oslo", { expectedRevision: rev }), { ok: false, conflict: true, revision: rev + 1 });
  assert.equal(s.config().cohost.timezone, "UTC");
  s.close();
});

// @spec STORE-SET-005, STORE-SET-007
test("credentials are trimmed and refused when empty, holding a control character, outside SECRET_PATHS or for an unknown server", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    assert.equal(s.write({ secrets: { "llm.openai.api_key": "  sk-trim \n" } }).ok, true);
    assert.equal(s.secret("llm.openai.api_key"), "sk-trim");
    const bad = s.write({ secrets: { "llm.claude.api_key": "   ", "chat.youtube.api_key": "a\u0007b", "llm.model": "x", "tools.servers.nope.token": "SECRET-VALUE" } });
    assert.deepEqual(issuesOf(bad).map((i) => i.path).toSorted(), ["chat.youtube.api_key", "llm.claude.api_key", "llm.model", "tools.servers.nope.token"]);
    assert.ok(!JSON.stringify(bad).includes("SECRET-VALUE") && !JSON.stringify(bad).includes("a\u0007b"));
    assert.deepEqual(s.secretPaths(), ["llm.openai.api_key"]);
    assert.equal(s.write({ secrets: { "llm.openai.api_key": null } }).ok, true);
    assert.deepEqual(s.secretPaths(), []);
    // A credential written as a setting is refused, named by path.
    const tools = sec(s, "tools") ?? {};
    const asSetting = s.write({ sections: { llm: { ...sec(s, "llm"), openai: { api_key: "SECRET-VALUE" } } } });
    assert.deepEqual(issuesOf(asSetting).map((i) => i.path), ["llm.openai.api_key"]);
    assert.ok(!JSON.stringify(asSetting).includes("SECRET-VALUE"));
    assert.deepEqual(sec(s, "tools") ?? {}, tools);
  } finally { s.close(); }
});

// @spec STORE-SET-005, STORE-SET-006
test("a server token needs its server in the stored tools section, and removing the server deletes its token in the same write", async () => {
  const sb = sandbox();
  const s = await sb.open();
  try {
    const tools = { ...sec(s, "tools"), servers: { search: { url: "https://search.example/mcp" } } };
    assert.equal(s.write({ sections: { tools }, secrets: { "tools.servers.search.token": "tok" } }).ok, true);
    assert.equal(s.secret("tools.servers.search.token"), "tok");
    const rev = s.revision();
    assert.equal(s.write({ sections: { tools: { ...tools, servers: {} } } }).ok, true);
    assert.deepEqual(s.secretPaths(), []);
    assert.equal(s.revision(), rev + 1);
  } finally { s.close(); }
});

// @spec STORE-SET-001
test("no file of the package but store.ts changes the settings, documents or secrets tables", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { repo } = await import("./helpers.js");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const offenders = walk(join(repo, "packages/store/src"))
    .filter((f) => !f.endsWith("store.ts"))
    .filter((f) => /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(sections|documents|secrets)\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

// @spec STORE-SET-004
test("a write blocked past the busy timeout fails naming the store and changes nothing; the dashboard's write retries and then succeeds", async () => {
  const sb = sandbox();
  const dash = await sb.open({ profile: "dashboard" });
  const blocker = new DatabaseSync(storeFile(sb.data));
  blocker.exec("BEGIN IMMEDIATE");
  const rev = dash.revision();
  const t0 = performance.now();
  assert.throws(() => dash.setKey("cohost.timezone", "Asia/Seoul"), (e: StoreError) => e.kind === "busy" && e.message.includes(storeFile(sb.data)) && e.message.includes("SQLITE_BUSY"));
  assert.ok(performance.now() - t0 < 1000, "the dashboard waits about 250 ms, not 5 s");
  const pending = dash.writeWithRetry({ sections: { cohost: { ...sec(dash, "cohost"), timezone: "Asia/Seoul" } } });
  setTimeout(() => blocker.exec("COMMIT"), 400);
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(dash.revision(), rev + 1);
  blocker.close();
  dash.close();
});

// @spec STORE-RCV-002
test("while stored settings fail the schema, setting or resetting one failing key validates that key alone", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.close();
  // A newer build's change: two stored keys now fail.
  const db = new DatabaseSync(storeFile(sb.data));
  const llm = JSON.parse(String(db.prepare("SELECT doc FROM sections WHERE path = 'llm'").get()!.doc));
  db.prepare("UPDATE sections SET doc = ? WHERE path = 'llm'").run(JSON.stringify({ ...llm, temperature: 99, retired_key: true }));
  db.close();
  const r = await sb.open();
  assert.deepEqual(r.issues().map((i) => i.path).toSorted(), ["llm.retired_key", "llm.temperature"]);
  assert.equal(r.write({ personality: "# whole-config writes still fail" }).ok, false);
  assert.equal(r.setKey("llm.temperature", 1).ok, true);
  assert.equal(r.setKey("llm.temperature", 50).ok, false, "the key being fixed is still validated");
  assert.equal(r.resetKey("llm.retired_key").ok, true);
  assert.deepEqual(r.issues(), []);
  r.close();
});
