import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError, canSetKey, checkConfig, loadConfig, parseConfigText, placeholderFallback, resetConfigKey, schemaAt, secretRepair, setConfigKey, type ConfigProblem } from "../src/index.js";
import { MINIMAL_YAML, captureWarnings, isolateEnv, repo, sandbox, secretsIn } from "./helpers/config-sandbox.js";

isolateEnv();

/** The error `loadConfig(true)` throws for the sandbox as it stands. */
const loadError = (): unknown => {
  try { loadConfig(true); } catch (e) { return e; }
  return assert.fail("expected the load to fail");
};

const kinds = (problems: readonly ConfigProblem[]): string[] => problems.map((p) => `${p.kind} ${p.path}`);

// @spec CFG-RCV-001
test("a placeholder failure is a ConfigError with the same message and one placeholder problem per placeholder, list entries as [i]", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML.replace("llm: { model: m, embed_model: e }", "llm: { model: \"${LLM_MODEL:-qwen}\", embed_model: e }").replace("chat: { twitch: {} }", "chat: { twitch: {}, ignore_users: [ok, \"${BOT}\"] }") });
  const e = loadError();
  assert.ok(e instanceof ConfigError, "a ConfigError");
  assert.ok(e instanceof Error);
  assert.ok(e.message.startsWith(`Invalid ${join(dir, "config.yaml")}:\n  `), e.message);
  assert.match(e.message, /llm\.model: uses the placeholder \$\{LLM_MODEL\}/);
  assert.deepEqual(kinds(e.problems).toSorted(), ["placeholder chat.ignore_users[1]", "placeholder llm.model"]);
  assert.ok(e.problems.every((p) => p.file === join(dir, "config.yaml")));
  assert.ok(e.problems.every((p) => e.message.includes(`  ${p.path}: ${p.message}`)), "each problem is a line of the message");
});

// @spec CFG-RCV-001
test("a schema failure is a ConfigError of kind schema, list indexes written [i]; a syntax error is kind syntax at the empty path", () => {
  sandbox({ "config.yaml": MINIMAL_YAML.replace("cohost: { name: Coco, streamer: Chris }", "cohost: { name: \"\", streamer: Chris }").replace("brain: {}", "brain: { salience: { reflexes: [{ match: 3 }] } }") });
  const e = loadError();
  assert.ok(e instanceof ConfigError);
  assert.ok(e.problems.length >= 2);
  assert.ok(e.problems.every((p) => p.kind === "schema"));
  assert.ok(e.problems.some((p) => p.path === "cohost.name"));
  assert.ok(e.problems.some((p) => p.path.startsWith("brain.salience.reflexes[0]")), kinds(e.problems).join(", "));
  assert.ok(!e.problems.some((p) => /\.\d+(\.|$)/.test(p.path)), "no list index is written as a dotted number");

  sandbox({ "config.yaml": "cohost: [unclosed\n" });
  const s = loadError();
  assert.ok(s instanceof ConfigError);
  assert.deepEqual(s.problems.map((p) => [p.kind, p.path]), [["syntax", ""]]);
  assert.match(s.problems[0]!.message, /^not valid YAML at line \d+, column \d+/);
});

// @spec CFG-RCV-001
test("a malformed secrets.yaml is a ConfigError of kind secrets naming the path, never the value; an unreadable or isolation failure stays a plain Error", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": "llm:\n  openai:\n    api_key: 12345\n" });
  const e = loadError();
  assert.ok(e instanceof ConfigError);
  assert.deepEqual(e.problems.map((p) => [p.kind, p.path, p.file]), [["secrets", "llm.openai.api_key", secretsIn(dir)]]);
  assert.doesNotMatch(JSON.stringify(e.problems), /12345/);

  sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": "llm: [x\n" });
  const s = loadError();
  assert.ok(s instanceof ConfigError);
  assert.deepEqual(s.problems.map((p) => [p.kind, p.path]), [["secrets", ""]]);

  sandbox({ "config.yaml": MINIMAL_YAML });
  process.env.COHOST_ISOLATION = "not json";
  const iso = loadError();
  assert.ok(iso instanceof Error);
  assert.ok(!(iso instanceof ConfigError), "COHOST_ISOLATION is not a fault of the files");
});

// @spec CFG-RCV-002
test("checkConfig lists the problems of both files, secrets first, without caching or logging, and is empty for a valid pair", () => {
  sandbox({ "config.yaml": MINIMAL_YAML });
  const ok = loadConfig(true);
  assert.deepEqual(checkConfig(), []);
  const dir = sandbox({ "config.yaml": MINIMAL_YAML.replace("name: Coco", "name: \"${NAME}\""), "secrets.yaml": "voice:\n  openai:\n    api_key: [a]\n" });
  const warnings = captureWarnings(() => {
    const problems = checkConfig();
    assert.deepEqual(kinds(problems), ["secrets voice.openai.api_key", "placeholder cohost.name"]);
    assert.equal(problems[1]!.file, join(dir, "config.yaml"));
  });
  assert.deepEqual(warnings, []);
  assert.equal(loadConfig(), ok, "checkConfig leaves the loader's cache alone");
});

// @spec CFG-RCV-002
test("checkConfig applies no isolation override and throws a failure that is not about the files", () => {
  sandbox({ "config.yaml": MINIMAL_YAML });
  process.env.COHOST_ISOLATION = JSON.stringify({ VOICE_ENGINE: "not-an-engine" });
  assert.deepEqual(checkConfig(), []);
  const dir = sandbox({});
  writeFileSync(join(dir, "config.yaml"), MINIMAL_YAML);
  assert.deepEqual(checkConfig({ configFile: join(dir, "config.yaml"), secretsFile: join(dir, "none.yaml") }), []);
  assert.throws(() => checkConfig({ configFile: join(dir, "missing.yaml"), secretsFile: join(dir, "none.yaml") }), (e: unknown) => e instanceof Error && !(e instanceof ConfigError));
});

const STALE = `# the operator's notes
cohost:
  name: "\${COHOST_NAME:-Coco}"   # the name
  streamer: Chris
llm:
  provider: "\${LLM_PROVIDER:-ollama}"
  model: m
  embed_model: e
  openai:
    api_key: "\${LLM_API_KEY}"   # a credential
vision: { model: v, obs: { host: "\${OBS_HOST}" } }
chat: { twitch: {} }
brain: {}
voice: {}
avatar:
  vtube_studio: {}
  vmc:
    port: \${VMC_PORT}
ears:
  sources: \${EARS_SOURCES:-[discord]}
dashboard: {}
`;

// @spec CFG-RCV-003
test("setConfigKey replaces or inserts one key, keeps every other byte, and validates the key alone", () => {
  const set = setConfigKey(STALE, "cohost.name", "Mika");
  assert.ok(set.ok);
  assert.equal(set.text, STALE.replace("\"${COHOST_NAME:-Coco}\"", "\"Mika\""), "the quote style and the comment are kept");
  const insert = setConfigKey(STALE, "dashboard.port", 3100);
  assert.ok(insert.ok);
  assert.equal(parseYaml(insert.text).dashboard.port, 3100);
  assert.ok(insert.text.startsWith("# the operator's notes\n"));
  const nested = setConfigKey(STALE, "avatar.vmc.port", 39540);
  assert.ok(nested.ok);
  assert.equal(nested.text, STALE.replace("port: ${VMC_PORT}", "port: 39540"));
  assert.equal(parseConfigText(STALE).ok, false, "the rest of the file still fails, and that does not stop a set");
});

// @spec CFG-RCV-003
test("setConfigKey refuses an unknown key, a list entry, a secret path, a placeholder, a value the key's schema rejects", () => {
  const refused = (path: string, value: unknown): string => {
    const r = setConfigKey(STALE, path, value);
    assert.equal(r.ok, false, `${path} must be refused`);
    return !r.ok ? r.issues.map((i) => i.message).join("; ") : "";
  };
  assert.match(refused("cohost.nmae", "x"), /not a key/);
  assert.match(refused("brain.salience.reflexes[0].match", "x"), /list/);
  assert.match(refused("cohost.name[0]", "x"), /not a list/);
  for (const path of ["__proto__", "constructor", "llm.toString", "llm.__proto__.model"]) assert.match(refused(path, "x"), /not a key/, path);
  assert.match(refused("llm.openai.api_key", "sk-1"), /secrets\.yaml/);
  assert.match(refused("cohost.name", "${OTHER}"), /placeholder/);
  assert.match(refused("dashboard.port", "not a port"), /./);
  assert.match(refused("avatar.vmc.port", "abc"), /./);
});

// @spec CFG-RCV-004
test("resetConfigKey removes the key's lines with their comment, keeps the rest, and writes {} for a mapping it empties", () => {
  const name = resetConfigKey(STALE, "cohost.name");
  assert.ok(name.ok);
  assert.equal(name.path, "cohost.name");
  assert.equal(name.text, STALE.replace("  name: \"${COHOST_NAME:-Coco}\"   # the name\n", ""));
  const vmc = resetConfigKey(STALE, "avatar.vmc.port");
  assert.ok(vmc.ok);
  assert.match(vmc.text, /\n {2}vmc: \{\}\n/);
  assert.deepEqual(parseYaml(vmc.text).avatar.vmc, {});
  const secret = resetConfigKey(STALE, "llm.openai.api_key");
  assert.ok(secret.ok);
  assert.doesNotMatch(secret.text, /LLM_API_KEY/);
  assert.deepEqual(parseYaml(secret.text).llm.openai, {});
});

// @spec CFG-RCV-004
test("resetConfigKey resets a whole list for a path inside it, removes from a flow mapping, and refuses a key the file does not hold", () => {
  const text = STALE.replace("ears:\n  sources: ${EARS_SOURCES:-[discord]}\n", "ears:\n  sources:\n    - discord\n    - \"${X}\"\n  silence_ms: 700\n");
  const list = resetConfigKey(text, "ears.sources[1]");
  assert.ok(list.ok);
  assert.equal(list.path, "ears.sources");
  assert.match(list.text, /\nears:\n {2}silence_ms: 700\n/);
  const flow = resetConfigKey(STALE, "vision.obs.host");
  assert.ok(flow.ok);
  assert.deepEqual(parseYaml(flow.text).vision, { model: "v", obs: {} });
  assert.ok(flow.text.startsWith("# the operator's notes\n"));
  const absent = resetConfigKey(STALE, "dashboard.port");
  assert.equal(absent.ok, false);
  const after = parseConfigText(name(STALE));
  assert.equal(after.ok, false);
  function name(t: string): string { const r = resetConfigKey(t, "cohost.name"); assert.ok(r.ok); return r.text; }
});

// @spec CFG-RCV-005
test("placeholderFallback reads an unquoted placeholder's fallback as YAML and a quoted one as a string", () => {
  assert.deepEqual(placeholderFallback(STALE, "ears.sources"), { value: ["discord"] });
  assert.deepEqual(placeholderFallback(STALE, "cohost.name"), { value: "Coco" });
  assert.deepEqual(placeholderFallback(STALE, "llm.provider"), { value: "ollama" });
  assert.deepEqual(placeholderFallback("a:\n  b: ${X:-false}\n  c: \"${Y:-null}\"\n  d: http://${H:-localhost}:80\n", "a.b"), { value: false });
  assert.deepEqual(placeholderFallback("a:\n  c: \"${Y:-null}\"\n", "a.c"), { value: "null" });
  assert.deepEqual(placeholderFallback("a:\n  d: http://${H:-localhost}:80\n", "a.d"), { value: "http://localhost:80" });
  assert.equal(placeholderFallback(STALE, "avatar.vmc.port"), undefined, "no fallback");
  assert.equal(placeholderFallback(STALE, "llm.model"), undefined, "no placeholder");
  assert.equal(placeholderFallback("a: [x\n", "a"), undefined, "unparseable");
});

// @spec CFG-RCV-003, CFG-RCV-004, CFG-RCV-005
test("the stale example of the ${...} era is brought to a valid file by its fallbacks and resets alone", () => {
  const old = readFileSync(join(repo, "services", "dashboard", "test", "fixtures", "stale-config.yaml"), "utf8");
  let text = old;
  for (let round = 0; round < 10; round++) {
    const r = parseConfigText(text);
    if (r.ok) break;
    let changed = false;
    for (const issue of r.issues) {
      const fb = placeholderFallback(text, issue.path);
      const set = fb && setConfigKey(text, issue.path, fb.value);
      if (set && set.ok) { text = set.text; changed = true; continue; }
      const reset = resetConfigKey(text, issue.path);
      if (reset.ok) { text = reset.text; changed = true; }
    }
    if (!changed) break;
  }
  const r = parseConfigText(text);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
  assert.ok(text.includes("# "), "comments survive");
});

// @spec CFG-RCV-003
test("setConfigKey sets one scalar entry of a list in place, keeping the rest of the list and the file", () => {
  const text = "# notes\nchat:\n  twitch: {}\n  ignore_users: [nightbot, \"${BOT:-moobot}\"]   # bots\n";
  const fb = placeholderFallback(text, "chat.ignore_users[1]");
  assert.deepEqual(fb, { value: "moobot" });
  const r = setConfigKey(text, "chat.ignore_users[1]", fb!.value);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.text, text.replace('"${BOT:-moobot}"', '"moobot"'));
  assert.equal(canSetKey("chat.ignore_users[1]"), true);
  assert.equal(setConfigKey(text, "chat.ignore_users[5]", "x").ok, false, "no entry there");
});

// @spec CFG-RCV-003
test("schemaAt names only the schema's own keys", () => {
  for (const path of ["__proto__", "constructor", "llm.toString", "llm.hasOwnProperty"]) assert.equal(schemaAt(path), undefined, path);
  assert.ok(schemaAt("llm.model"));
});

// @spec CFG-RCV-006
test("secretRepair keeps a plain non-string scalar as its source text and clears what cannot be kept", () => {
  const text = "llm:\n  openai:\n    api_key: 0123456\nvoice:\n  openai:\n    api_key: [a, b]\nears:\n  http:\n    token: true\n";
  assert.deepEqual(secretRepair(text, "llm.openai.api_key"), { value: "0123456" }, "leading zeros survive");
  assert.deepEqual(secretRepair(text, "ears.http.token"), { value: "true" });
  assert.deepEqual(secretRepair(text, "voice.openai.api_key"), { value: null });
  assert.deepEqual(secretRepair("a: |\n  x\n  y\n", "a"), { value: null });
  assert.deepEqual(secretRepair("a: [x\n", "a"), { value: null });
});
