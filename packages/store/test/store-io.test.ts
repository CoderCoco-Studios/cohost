import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, stringifyYaml } from "@cohost/config";
import { EXPORT_SCRYPT, exportStore, importPlan, openSecrets, readExport, readParts } from "../src/index.js";
import { sandbox } from "./helpers.js";

/** A stored section document as a mapping. */
const sec = (store: { sections(): Record<string, unknown> }, path: string): Record<string, unknown> => (store.sections()[path] ?? {}) as Record<string, unknown>;

const PASS = "correct horse battery";

/** A store with a changed setting, a personality, expressions and three credentials (one a server token). */
async function populated() {
  const sb = sandbox();
  const s = await sb.open();
  const tools = { ...sec(s, "tools"), servers: { search: { url: "https://search.example/mcp" } } };
  const r = s.write({
    sections: { tools, cohost: { ...sec(s, "cohost"), timezone: "Europe/London" } },
    personality: "# Ava\nWarm.\n",
    expressions: { vmc: { happy: "Joy" } },
    secrets: { "llm.openai.api_key": "sk-OPENAI", "chat.youtube.api_key": "yt-KEY", "tools.servers.search.token": "srv-TOKEN" },
  });
  assert.equal(r.ok, true);
  s.setToken("token-that-is-long-enough-for-the-store-32");
  return { sb, s };
}

// @spec STORE-IO-001, STORE-IO-002
test("an export without credentials holds settings, personality and expressions, and a comment naming the set paths, never a value", async () => {
  const { s } = await populated();
  const text = exportStore(s);
  for (const v of ["sk-OPENAI", "yt-KEY", "srv-TOKEN", "token_verifier", "scrypt"]) assert.ok(!text.includes(v), v);
  assert.match(text.split("\n")[0]!, /^# .*chat\.youtube\.api_key, llm\.openai\.api_key, tools\.servers\.search\.token$/);
  const doc = parseYaml(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc), ["cohost_export", "settings", "personality", "expressions"]);
  assert.equal(doc.cohost_export, 1);
  assert.equal((doc.settings as { cohost: { timezone: string } }).cohost.timezone, "Europe/London");
  assert.ok((doc.settings as { brain?: object }).brain, "the brain sections are nested under brain");
  assert.equal(doc.personality, "# Ava\nWarm.\n");
  s.close();
});

// @spec STORE-IO-002
test("an export with credentials seals each value under a scrypt passphrase key as enc1:, the path bound as associated data", async () => {
  const { s } = await populated();
  const text = exportStore(s, { passphrase: PASS });
  for (const v of ["sk-OPENAI", "yt-KEY", "srv-TOKEN"]) assert.ok(!text.includes(v), v);
  const doc = parseYaml(text) as { secrets: { kdf: Record<string, unknown>; values: Record<string, string> } };
  assert.deepEqual({ ...doc.secrets.kdf, salt: undefined }, { alg: "scrypt", ...EXPORT_SCRYPT, salt: undefined });
  for (const v of Object.values(doc.secrets.values)) assert.match(v, /^enc1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.throws(() => exportStore(s, { passphrase: "short" }));
  // A value moved to another path does not open.
  const moved = { ...doc.secrets, values: { "llm.openai.api_key": doc.secrets.values["chat.youtube.api_key"]! } };
  assert.equal(openSecrets(moved as never, PASS).issues[0]?.path, "llm.openai.api_key");
  assert.match(openSecrets(doc.secrets as never, "the wrong passphrase").issues[0]!.message, /does not decrypt/);
  s.close();
});

// @spec STORE-IO-006, STORE-IO-003, STORE-DB-011
test("an export imported into an empty store with the same passphrase gives equal settings, documents and credentials", async () => {
  const { s } = await populated();
  const text = exportStore(s, { passphrase: PASS });
  const target = await sandbox().open({ seed: false });
  const { plan, issues } = readExport(text);
  assert.deepEqual(issues, []);
  const opened = openSecrets(plan.sealed!, PASS);
  assert.deepEqual(opened.issues, []);
  plan.secrets = opened.values;
  const before = target.revision();
  const { result } = await importPlan(target, plan);
  assert.deepEqual(result, { ok: true, revision: before + 1 });
  assert.deepEqual(target.config(), s.config());
  assert.equal(target.personality(), s.personality());
  assert.deepEqual(target.expressions(), s.expressions());
  assert.deepEqual(target.secretValues(), s.secretValues());
  s.close();
  target.close();
});

// @spec STORE-IO-003
test("an import replaces everything the export holds and removes what it lacks; a dry run reports the change and writes nothing", async () => {
  const { s } = await populated();
  const exported = parseYaml(exportStore(s)) as Record<string, unknown>;
  delete exported.personality;
  const text = stringifyYaml(exported).replace("Europe/London", "Asia/Tokyo");
  const { plan, issues } = readExport(text);
  assert.deepEqual(issues, []);
  const rev = s.revision();
  const dry = await importPlan(s, plan, { dryRun: true });
  assert.equal(dry.result.ok, true);
  assert.deepEqual(dry.summary.changed, ["cohost"]);
  assert.deepEqual(dry.summary.removed, ["personality"]);
  assert.equal(s.revision(), rev);
  assert.equal(s.config().cohost.timezone, "Europe/London");
  const { result } = await importPlan(s, plan);
  assert.equal(result.ok, true);
  assert.equal(s.config().cohost.timezone, "Asia/Tokyo");
  assert.equal(s.personality(), undefined);
  assert.deepEqual(s.secretPaths().length, 3, "an export without secrets leaves the credentials alone");
  s.close();
});

// @spec STORE-IO-003
test("an import with any problem writes nothing and lists each problem by path", async () => {
  const { s } = await populated();
  const rev = s.revision();
  const bad = readExport("cohost_export: 1\nsettings:\n  llm: { temperature: 9 }\n  bogus: {}\nextra: 1\n");
  assert.deepEqual(bad.issues.map((i) => i.path).toSorted(), ["bogus", "extra"]);
  const invalid = readExport("cohost_export: 1\nsettings:\n  cohost: { name: '' }\n");
  const { result } = await importPlan(s, invalid.plan);
  assert.equal(result.ok, false);
  assert.ok((result as { issues: { path: string }[] }).issues.some((i) => i.path.startsWith("cohost")));
  assert.equal(s.revision(), rev);
  assert.deepEqual(readExport("a: [").issues.map((i) => i.path), ["(file)"]);
  assert.deepEqual(readExport("settings: {}\n").issues.map((i) => i.path), ["cohost_export"]);
  s.close();
});

// @spec STORE-IO-004
test("parts replace only themselves: the settings, the personality, the expressions and a plain secrets mapping nested by path", async () => {
  const { s } = await populated();
  const { plan, issues } = readParts({
    personality: "# New\n",
    secrets: "llm:\n  openai:\n    api_key: sk-NEW\n  claude:\n    api_key: \"\"\nears:\n  http:\n    token: retired\n",
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(plan.notes, ["ears.http.token: not a credential path, not imported"]);
  const { result, summary } = await importPlan(s, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(summary.secretsSet, ["llm.openai.api_key"]);
  assert.equal(s.personality(), "# New\n");
  assert.equal(s.config().cohost.timezone, "Europe/London", "settings not given are untouched");
  assert.deepEqual(s.secretValues(), { "llm.openai.api_key": "sk-NEW" }, "a secrets part replaces every credential");
  const settings = readParts({ settings: "cohost: { name: Ava, streamer: Sam }\nllm: { model: m, embed_model: e, openai: { api_key: sk-in-settings } }\n" });
  assert.deepEqual(settings.issues, []);
  assert.deepEqual(settings.plan.notes, ["llm.openai.api_key: a credential in the settings, not imported as a setting (import it with --secrets)"]);
  s.close();
});
