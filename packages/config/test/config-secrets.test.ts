import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, chmodSync, copyFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadDotEnv, secretsPath, updateSecrets, setSecretPaths, writeFileAtomic, SECRET_PATHS, ConfigSchema, sectionJsonSchema } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, captureWarnings, repo } from "./helpers/config-sandbox.js";

isolateEnv();

const mode = (f: string): number => statSync(f).mode & 0o777;
// The seventeen wildcard-free paths of CFG-SEC-003; `tools.servers.*.token` joins them when #204 adds CFG-SEC-016, and this list then
// gains a wildcard entry (its test builds a config with a server entry).
const TWELVE = [
  "llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "vision.obs.password",
  "ears.http.token", "ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key", "voice.openai.api_key", "voice.pocket.hf_token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token", "chat.youtube.api_key", "connections.discord.token",
];
const getPath = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

// @spec CFG-SEC-003, CFG-SCH-039
test("SECRET_PATHS lists exactly the seventeen wildcard-free credentials, and each is a schema key that defaults to the empty string", () => {
  assert.deepEqual([...SECRET_PATHS].sort(), [...TWELVE].sort());
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
  });
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
});

// @spec CFG-SEC-001
test("secretsPath is secrets.yaml in the config directory; with no file every secret is empty, nothing is warned and the file is not created", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  assert.equal(secretsPath(), join(dir, "secrets.yaml"));
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(warnings, []);
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
  assert.equal(existsSync(join(dir, "secrets.yaml")), false);
});

// @spec CFG-SEC-002, CFG-LOAD-001
test("loadConfig merges each non-empty string at a secret path, in the same cached read", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML,
    "secrets.yaml": "llm:\n  openai:\n    api_key: sk-openai\n  bedrock:\n    access_key_id: AKIA1\nvision:\n  obs:\n    password: obs-pw\nchat:\n  twitch:\n    client_id: cid\n    client_secret: ''\nconnections:\n  discord:\n    token: disc-tok\n",
  });
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  const cfg = loadConfig(true);
  assert.equal(cfg.llm.openai.api_key, "sk-openai");
  assert.equal(cfg.llm.bedrock.access_key_id, "AKIA1");
  assert.equal(cfg.vision.obs.password, "obs-pw");
  assert.equal(cfg.chat.twitch.client_id, "cid");
  assert.equal(cfg.chat.twitch.client_secret, "");
  assert.equal(cfg.connections.discord.token, "disc-tok");
  assert.equal(cfg.llm.claude.api_key, "");
  writeFileSync(join(dir, "secrets.yaml"), "llm:\n  openai:\n    api_key: changed\n");
  assert.equal(loadConfig(), cfg, "cached until forced");
  assert.equal(loadConfig(true).llm.openai.api_key, "changed");
});

// @spec CFG-SEC-004, CFG-SEC-011
test("a value in secrets.yaml wins; a value config.yaml holds at a secret path is never used and is warned about by path only", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML.replace("llm: { model: m, embed_model: e }", "llm: { model: m, embed_model: e, openai: { api_key: pasted-in-config }, claude: { api_key: also-in-config } }"),
    "secrets.yaml": "llm:\n  openai:\n    api_key: from-secrets\n",
  });
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.equal(cfg.llm.openai.api_key, "from-secrets");
  assert.equal(cfg.llm.claude.api_key, "", "the config.yaml value is not used even with no secrets.yaml value");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /llm\.openai\.api_key/);
  assert.match(warnings[0]!, /llm\.claude\.api_key/);
  assert.doesNotMatch(warnings.join("\n"), /pasted-in-config|also-in-config|from-secrets/);
});

// @spec CFG-SEC-005
test("a secrets.yaml key outside SECRET_PATHS is ignored with one warning listing the paths, and cannot override a setting", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML,
    "secrets.yaml": "llm:\n  model: hijacked\n  openai:\n    api_key: sk-ok\n    typo_key: v\nextra: 1\n",
  });
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.equal(cfg.llm.model, "m");
  assert.equal(cfg.llm.openai.api_key, "sk-ok");
  assert.equal(warnings.length, 1);
  for (const p of ["llm.model", "llm.openai.typo_key", "extra"]) assert.ok(warnings[0]!.includes(p), p);
  assert.doesNotMatch(warnings[0]!, /hijacked|sk-ok/);
});

// @spec CFG-SEC-006, CFG-SEC-010
test("a secrets.yaml that is not YAML, not a mapping or holds a non-string fails the load naming position or path and quoting nothing", () => {
  const fails = (text: string) => {
    const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": text });
    chmodSync(join(dir, "secrets.yaml"), 0o600);
    try { loadConfig(true); } catch (e) { return (e as Error).message; }
    return assert.fail("expected the load to fail");
  };
  const syntax = fails("llm:\n  openai:\n    api_key: [sk-leak-1\n  claude: {\n");
  assert.ok(syntax.startsWith(`Invalid ${join(process.env.CONFIG_DIR!, "secrets.yaml")}:`));
  assert.match(syntax, /line \d+, column \d+/);
  assert.doesNotMatch(syntax, /sk-leak-1/);
  const root = fails("- sk-leak-2\n- b\n");
  assert.ok(root.startsWith("Invalid "));
  assert.doesNotMatch(root, /sk-leak-2/);
  assert.match(root, /mapping/);
  const wrong = fails("ears:\n  http:\n    token: 123456789\nvision:\n  obs:\n    password: [sk-leak-3]\n");
  assert.ok(wrong.startsWith("Invalid "));
  assert.match(wrong, /ears\.http\.token/);
  assert.match(wrong, /vision\.obs\.password/);
  assert.doesNotMatch(wrong, /123456789|sk-leak-3/);
});

// @spec CFG-SEC-007
test("a secrets.yaml that cannot be read fails the load naming the file and the OS error code, not an empty set of secrets", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  mkdirSync(join(dir, "secrets.yaml")); // reading a directory fails with EISDIR
  assert.throws(() => loadConfig(true), (e: Error) => e.message.includes(join(dir, "secrets.yaml")) && /EISDIR/.test(e.message));
});

// @spec CFG-SEC-008
test("a secrets.yaml open to group or other loads with one chmod 600 warning, except on Windows or at mode 0777", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": "llm:\n  openai:\n    api_key: sk-x\n" });
  const file = join(dir, "secrets.yaml");
  const load = () => { const w = captureWarnings(() => { loadConfig(true); }); return w; };
  chmodSync(file, 0o600);
  assert.deepEqual(load(), []);
  chmodSync(file, 0o640);
  let w = load();
  assert.equal(w.length, 1);
  assert.ok(w[0]!.includes(file));
  assert.match(w[0]!, /chmod 600/);
  chmodSync(file, 0o604);
  assert.equal(load().length, 1);
  chmodSync(file, 0o777);
  assert.deepEqual(load(), [], "drvfs reports 0777 for every file");
  chmodSync(file, 0o644);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { w = load(); } finally { Object.defineProperty(process, "platform", platform); }
  assert.deepEqual(w, []);
});

// @spec CFG-SEC-009, CFG-SEC-012
test("updateSecrets sets and clears secret paths, keeps other keys and comments, and leaves the file at mode 0600 after a create and an update", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  const file = join(dir, "secrets.yaml");
  const prevUmask = process.umask(0);
  try {
    assert.equal(updateSecrets(file, { "llm.openai.api_key": "sk-1" }), undefined, "returns nothing");
    assert.equal(mode(file), 0o600, "created with 0600 even under umask 0");
    assert.equal(loadConfig(true).llm.openai.api_key, "sk-1");
    writeFileSync(file, "# my credentials\nllm:\n  openai:\n    api_key: sk-1   # the key\n  claude:\n    api_key: ''\nnotes: keep me # a stray key\n");
    chmodSync(file, 0o644);
    updateSecrets(file, { "llm.claude.api_key": "sk-claude", "connections.discord.token": "disc" });
    assert.equal(mode(file), 0o600, "an update tightens a loose file");
    const text = readFileSync(file, "utf8");
    assert.match(text, /# my credentials/);
    assert.match(text, /api_key: sk-1\s+# the key/);
    assert.match(text, /notes: keep me # a stray key/);
    const cfg = loadConfig(true);
    assert.equal(cfg.llm.openai.api_key, "sk-1");
    assert.equal(cfg.llm.claude.api_key, "sk-claude");
    assert.equal(cfg.connections.discord.token, "disc");
    updateSecrets(file, { "llm.openai.api_key": null });
    assert.equal(loadConfig(true).llm.openai.api_key, "", "clearing is an explicit null");
    assert.deepEqual(setSecretPaths(file).sort(), ["connections.discord.token", "llm.claude.api_key"]);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  } finally { process.umask(prevUmask); }
});

// @spec CFG-SEC-009
test("updateSecrets refuses a path outside SECRET_PATHS and changes nothing when any change is refused", () => {
  const dir = sandbox({});
  const file = join(dir, "secrets.yaml");
  writeFileSync(file, "llm:\n  openai:\n    api_key: keep\n", { mode: 0o600 });
  const before = readFileSync(file, "utf8");
  assert.throws(() => updateSecrets(file, { "llm.model": "x" }), /llm\.model/);
  assert.throws(() => updateSecrets(file, { "llm.openai.api_key": "new-value", "cohost.name": "x" }), /cohost\.name/);
  assert.equal(readFileSync(file, "utf8"), before);
});

// @spec CFG-SEC-013, CFG-SEC-010
test("updateSecrets trims a value, refuses one that is empty after trimming naming only the path, and clears only on null", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  const file = join(dir, "secrets.yaml");
  updateSecrets(file, { "ears.http.token": "  tok-1 \n" });
  assert.equal(loadConfig(true).ears.http.token, "tok-1");
  for (const v of ["", "   ", "\n\t"]) {
    assert.throws(() => updateSecrets(file, { "ears.http.token": v }), (e: Error) => e.message.includes("ears.http.token") && /empty/.test(e.message));
  }
  assert.equal(loadConfig(true).ears.http.token, "tok-1", "a refused set left the value alone");
  assert.throws(() => updateSecrets(file, { "vision.obs.password": "pw\nline2" }), /vision\.obs\.password/);
  try { updateSecrets(file, { "llm.model": "super-secret-value" }); } catch (e) { assert.doesNotMatch((e as Error).message, /super-secret-value/); }
});

// @spec CFG-SEC-012
test("writeFileAtomic takes a mode for the temporary file it creates", () => {
  const dir = sandbox({});
  const f = join(dir, "x.yaml");
  const prevUmask = process.umask(0);
  try {
    writeFileAtomic(f, "a: 1\n", { mode: 0o600 });
    assert.equal(mode(f), 0o600);
    writeFileAtomic(join(dir, "y.yaml"), "a: 1\n");
    assert.equal(mode(join(dir, "y.yaml")), 0o666, "no mode given: the process default applies");
  } finally { process.umask(prevUmask); }
});

// @spec CFG-SEC-010
test("no warning or error of the loader contains a secret value or text of secrets.yaml", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML.replace("name: Coco", "name: ''").replace("brain: {}", "brain: { tick_ms: 9 }"),
    "secrets.yaml": "llm:\n  openai:\n    api_key: sk-LEAKME\nunknown_top: sk-LEAKME2\n",
  });
  chmodSync(join(dir, "secrets.yaml"), 0o644);
  const warnings: string[] = [];
  let err = "";
  warnings.push(...captureWarnings(() => { try { loadConfig(true); } catch (e) { err = (e as Error).message; } }));
  assert.match(err, /cohost\.name/);
  assert.doesNotMatch(`${err}\n${warnings.join("\n")}`, /LEAKME/);
});

// @spec CFG-SEC-002
test("loadDotEnv still works beside secrets: a credential-looking variable in .env reaches no config key", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, ".env": "LLM_API_KEY=from-env\nANTHROPIC_API_KEY=from-env\nDISCORD_TOKEN=from-env\nOBS_PASSWORD=from-env\nTWITCH_CLIENT_ID=from-env\n" });
  loadDotEnv(join(dir, "..", ".env"));
  const cfg = loadConfig(true);
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
});

// @spec CFG-USR-016
test("the shipped secrets.example.yaml lists the secret paths as empty strings with a comment each and loads with no warning", () => {
  const text = readFileSync(join(repo, "config", "secrets.example.yaml"), "utf8");
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  copyFileSync(join(repo, "config", "secrets.example.yaml"), join(dir, "secrets.yaml"));
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(warnings, []);
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
  // each leaf the example writes is the empty string with a comment beside it or on the line above (chat.youtube.api_key is not written there, CFG-USR-016)
  const lines = text.split("\n");
  const leafLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s+[a-z_]+:\s*(""|'')/.test(l));
  assert.equal(leafLines.length, 11);
  for (const { l, i } of leafLines) assert.ok(/#/.test(l) || /^\s*#/.test(lines[i - 1] ?? ""), `comment for: ${l.trim()}`);
  assert.deepEqual(setSecretPaths(join(dir, "secrets.yaml")), []);
});

// @spec CFG-SEC-014
test("loadConfig trims every secret value: a block scalar's trailing newline and padding are dropped, a blank value counts as not set", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML,
    "secrets.yaml": 'llm:\n  openai:\n    api_key: |\n      sk-block\n  claude:\n    api_key: "  sk-padded \\t"\nvision:\n  obs:\n    password: "   "\nconnections:\n  discord:\n    token: >\n      disc-folded\n',
  });
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  const cfg = loadConfig(true);
  assert.equal(cfg.llm.openai.api_key, "sk-block");
  assert.equal(cfg.llm.claude.api_key, "sk-padded");
  assert.equal(cfg.vision.obs.password, "");
  assert.equal(cfg.connections.discord.token, "disc-folded");
});

// @spec CFG-SEC-014, CFG-SEC-010
test("a secret value that still holds a line break after trimming fails the load naming the path, never the value", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": 'llm:\n  openai:\n    api_key: "first-LINE-MARKER\\nsecond"\n' });
  chmodSync(join(dir, "secrets.yaml"), 0o600);
  assert.throws(() => loadConfig(true), (e: Error) =>
    e.message.startsWith(`Invalid ${join(dir, "secrets.yaml")}:`) && e.message.includes("llm.openai.api_key") && !/LINE-MARKER|second/.test(e.message));
});

// @spec CFG-SEC-015
test("updateSecrets on a symlinked secrets.yaml writes the file the link resolves to and keeps the link", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  mkdirSync(join(dir, "store"));
  const target = join(dir, "store", "real-secrets.yaml");
  writeFileSync(target, "# mine\nllm:\n  openai:\n    api_key: old\n", { mode: 0o600 });
  const link = join(dir, "secrets.yaml");
  symlinkSync(target, link);
  updateSecrets(link, { "llm.openai.api_key": "sk-new" });
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is kept");
  assert.match(readFileSync(target, "utf8"), /# mine[\s\S]*api_key: sk-new/);
  assert.equal(mode(target), 0o600);
  assert.deepEqual(readdirSync(join(dir, "store")), ["real-secrets.yaml"], "no temp file is left in the target's directory");
  assert.equal(loadConfig(true).llm.openai.api_key, "sk-new");
});

// @spec CFG-SEC-015
test("updateSecrets on a dangling symlink fails naming the path and writes nothing", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  const link = join(dir, "secrets.yaml");
  symlinkSync(join(dir, "nowhere", "secrets.yaml"), link);
  assert.throws(() => updateSecrets(link, { "llm.openai.api_key": "sk-new" }), (e: Error) => e.message.includes(link) && !e.message.includes("sk-new"));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(existsSync(join(dir, "nowhere")), false);
});

// @spec CFG-SEC-003, CFG-SCH-049
test("chat.youtube.api_key is a secret path (owned by CFG-SEC-003): listed, defaulting to empty, merged from secrets.yaml and marked in the editor schema", () => {
  assert.ok((SECRET_PATHS as readonly string[]).includes("chat.youtube.api_key"));
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: {},
    voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
  });
  assert.equal(getPath(cfg, "chat.youtube.api_key"), "");
  sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": "chat:\n  youtube:\n    api_key: yt-key\n" });
  assert.equal(loadConfig(true).chat.youtube.api_key, "yt-key");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((sectionJsonSchema("chat") as any).properties.youtube.properties.api_key["x-secret"], true);
});
