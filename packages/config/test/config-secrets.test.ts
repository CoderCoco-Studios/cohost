import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, chmodSync, copyFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadDotEnv, secretsPath, updateSecrets, setSecretPaths, writeFileAtomic, SECRET_PATHS, ConfigSchema, sectionJsonSchema } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, captureWarnings, repo, secretsIn } from "./helpers/config-sandbox.js";

isolateEnv();

const mode = (f: string): number => statSync(f).mode & 0o777;
// The seventeen wildcard-free paths of CFG-SEC-003; `tools.servers.*.token` (CFG-SEC-016) is the eighteenth entry of SECRET_PATHS.
const TWELVE = [
  "llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "vision.obs.password",
  "ears.http.token", "ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key", "voice.openai.api_key", "voice.pocket.hf_token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token", "chat.youtube.api_key", "connections.discord.token",
];
const getPath = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

// @spec CFG-SEC-003, CFG-SCH-039
test("SECRET_PATHS lists exactly the seventeen wildcard-free credentials and tools.servers.*.token, and each wildcard-free one defaults to the empty string", () => {
  assert.deepEqual([...SECRET_PATHS].toSorted(), [...TWELVE, "tools.servers.*.token"].toSorted());
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
  });
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
});

// @spec CFG-SEC-001
test("secretsPath is COHOST_SECRETS_FILE when set and non-empty; with no file every secret is empty, nothing is warned and the file is not created", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  assert.equal(process.env.COHOST_SECRETS_FILE, secretsIn(dir), "the sandbox points the loader at its own secrets directory");
  assert.equal(secretsPath(), secretsIn(dir));
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(warnings, []);
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
  assert.equal(existsSync(secretsIn(dir)), false);
  assert.equal(existsSync(join(dir, "secrets.yaml")), false, "nothing is created in the config directory either");
});

// @spec CFG-SEC-001
test("with COHOST_SECRETS_FILE unset or empty, secretsPath is secrets/secrets.yaml under the workspace root, whatever CONFIG_DIR says", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  for (const unset of [undefined, ""]) {
    if (unset === undefined) delete process.env.COHOST_SECRETS_FILE; else process.env.COHOST_SECRETS_FILE = unset;
    assert.equal(secretsPath(), join(repo, "secrets", "secrets.yaml"), "the workspace root is the repository these tests run in");
    assert.notEqual(secretsPath(), join(dir, "secrets.yaml"), "never beside config.yaml");
  }
});

// @spec CFG-SEC-001
test("with no workspace root, secretsPath is secrets/secrets.yaml in the parent of the config directory", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  delete process.env.COHOST_SECRETS_FILE;
  const here = process.cwd();
  process.chdir(tmpdir()); // /tmp holds no pnpm-workspace.yaml above it
  try {
    assert.equal(secretsPath(), join(dirname(dir), "secrets", "secrets.yaml"));
  } finally { process.chdir(here); }
});

// @spec CFG-SEC-002, CFG-LOAD-001
test("loadConfig merges each non-empty string at a secret path, in the same cached read", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML,
    "secrets.yaml": "llm:\n  openai:\n    api_key: sk-openai\n  bedrock:\n    access_key_id: AKIA1\nvision:\n  obs:\n    password: obs-pw\nchat:\n  twitch:\n    client_id: cid\n    client_secret: ''\nconnections:\n  discord:\n    token: disc-tok\n",
  });
  chmodSync(secretsIn(dir), 0o600);
  const cfg = loadConfig(true);
  assert.equal(cfg.llm.openai.api_key, "sk-openai");
  assert.equal(cfg.llm.bedrock.access_key_id, "AKIA1");
  assert.equal(cfg.vision.obs.password, "obs-pw");
  assert.equal(cfg.chat.twitch.client_id, "cid");
  assert.equal(cfg.chat.twitch.client_secret, "");
  assert.equal(cfg.connections.discord.token, "disc-tok");
  assert.equal(cfg.llm.claude.api_key, "");
  writeFileSync(secretsIn(dir), "llm:\n  openai:\n    api_key: changed\n");
  assert.equal(loadConfig(), cfg, "cached until forced");
  assert.equal(loadConfig(true).llm.openai.api_key, "changed");
});

// @spec CFG-SEC-004, CFG-SEC-011
test("a value in secrets.yaml wins; a value config.yaml holds at a secret path is never used and is warned about by path only", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML.replace("llm: { model: m, embed_model: e }", "llm: { model: m, embed_model: e, openai: { api_key: pasted-in-config }, claude: { api_key: also-in-config } }"),
    "secrets.yaml": "llm:\n  openai:\n    api_key: from-secrets\n",
  });
  chmodSync(secretsIn(dir), 0o600);
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
  chmodSync(secretsIn(dir), 0o600);
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
    chmodSync(secretsIn(dir), 0o600);
    try { loadConfig(true); } catch (e) { return (e as Error).message; }
    return assert.fail("expected the load to fail");
  };
  const syntax = fails("llm:\n  openai:\n    api_key: [sk-leak-1\n  claude: {\n");
  assert.ok(syntax.startsWith(`Invalid ${secretsIn(process.env.CONFIG_DIR!)}:`));
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
  mkdirSync(secretsIn(dir)); // reading a directory fails with EISDIR
  assert.throws(() => loadConfig(true), (e: Error) => e.message.includes(secretsIn(dir)) && /EISDIR/.test(e.message));
});

// @spec CFG-SEC-008
test("a secrets.yaml open to group or other loads with one chmod 600 warning, except on Windows or at mode 0777", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": "llm:\n  openai:\n    api_key: sk-x\n" });
  const file = secretsIn(dir);
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
  const file = secretsIn(dir);
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
    assert.deepEqual(setSecretPaths(file).toSorted(), ["connections.discord.token", "llm.claude.api_key"]);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  } finally { process.umask(prevUmask); }
});

// @spec CFG-SEC-009
test("updateSecrets refuses a path outside SECRET_PATHS and changes nothing when any change is refused", () => {
  const dir = sandbox({});
  const file = secretsIn(dir);
  writeFileSync(file, "llm:\n  openai:\n    api_key: keep\n", { mode: 0o600 });
  const before = readFileSync(file, "utf8");
  assert.throws(() => updateSecrets(file, { "llm.model": "x" }), /llm\.model/);
  assert.throws(() => updateSecrets(file, { "llm.openai.api_key": "new-value", "cohost.name": "x" }), /cohost\.name/);
  assert.equal(readFileSync(file, "utf8"), before);
});

// @spec CFG-SEC-013, CFG-SEC-010
test("updateSecrets trims a value, refuses one that is empty after trimming naming only the path, and clears only on null", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  const file = secretsIn(dir);
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
  chmodSync(secretsIn(dir), 0o644);
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
  copyFileSync(join(repo, "config", "secrets.example.yaml"), secretsIn(dir));
  chmodSync(secretsIn(dir), 0o600);
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(warnings, []);
  for (const p of TWELVE) assert.equal(getPath(cfg, p), "", p);
  // each leaf the example writes is the empty string with a comment beside it or on the line above (chat.youtube.api_key is not written there, CFG-USR-016)
  const lines = text.split("\n");
  const leafLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s+[a-z_]+:\s*(""|'')/.test(l));
  assert.equal(leafLines.length, 11);
  for (const { l, i } of leafLines) assert.ok(/#/.test(l) || /^\s*#/.test(lines[i - 1] ?? ""), `comment for: ${l.trim()}`);
  assert.deepEqual(setSecretPaths(secretsIn(dir)), []);
});

// @spec CFG-SEC-014
test("loadConfig trims every secret value: a block scalar's trailing newline and padding are dropped, a blank value counts as not set", () => {
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML,
    "secrets.yaml": 'llm:\n  openai:\n    api_key: |\n      sk-block\n  claude:\n    api_key: "  sk-padded \\t"\nvision:\n  obs:\n    password: "   "\nconnections:\n  discord:\n    token: >\n      disc-folded\n',
  });
  chmodSync(secretsIn(dir), 0o600);
  const cfg = loadConfig(true);
  assert.equal(cfg.llm.openai.api_key, "sk-block");
  assert.equal(cfg.llm.claude.api_key, "sk-padded");
  assert.equal(cfg.vision.obs.password, "");
  assert.equal(cfg.connections.discord.token, "disc-folded");
});

// @spec CFG-SEC-014, CFG-SEC-010
test("a secret value that still holds a line break after trimming fails the load naming the path, never the value", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML, "secrets.yaml": 'llm:\n  openai:\n    api_key: "first-LINE-MARKER\\nsecond"\n' });
  chmodSync(secretsIn(dir), 0o600);
  assert.throws(() => loadConfig(true), (e: Error) =>
    e.message.startsWith(`Invalid ${secretsIn(dir)}:`) && e.message.includes("llm.openai.api_key") && !/LINE-MARKER|second/.test(e.message));
});

// @spec CFG-SEC-015
test("updateSecrets on a symlinked secrets.yaml writes the file the link resolves to and keeps the link", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  mkdirSync(join(dir, "store"));
  const target = join(dir, "store", "real-secrets.yaml");
  writeFileSync(target, "# mine\nllm:\n  openai:\n    api_key: old\n", { mode: 0o600 });
  const link = secretsIn(dir);
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
  const link = secretsIn(dir);
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
  assert.equal((sectionJsonSchema("chat") as any).properties.youtube.properties.api_key["x-secret"], true);
});

const TOOLS_YAML = `${MINIMAL_YAML}tools:\n  servers:\n    weather:\n      url: "http://h:1/mcp"\n    search:\n      url: "http://h:2/mcp"\n`;
const secretsFile = (dir: string, text: string): string => {
  const f = secretsIn(dir);
  writeFileSync(f, text);
  chmodSync(f, 0o600);
  return f;
};

// @spec CFG-SEC-016, CFG-SCH-087
test("tools.servers.*.token matches one key of the map config.yaml holds: each configured server gets its own token, others stay empty", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  secretsFile(dir, "tools:\n  servers:\n    weather:\n      token: tok-weather\n");
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(warnings, []);
  assert.equal(cfg.tools.servers.weather!.token, "tok-weather");
  assert.equal(cfg.tools.servers.search!.token, "");
  secretsFile(dir, "tools:\n  servers:\n    weather:\n      token: ''\n    search:\n      token: '  tok-search '\n");
  cfg = loadConfig(true);
  assert.equal(cfg.tools.servers.weather!.token, "");
  assert.equal(cfg.tools.servers.search!.token, "tok-search", "trimmed like every secret");
});

// @spec CFG-SEC-016
test("the wildcard matches exactly one segment: another key under a server entry is not a secret path", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  secretsFile(dir, "tools:\n  servers:\n    weather:\n      url: http://evil/mcp\n      token: ok-tok\n");
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.equal(cfg.tools.servers.weather!.token, "ok-tok");
  assert.equal(cfg.tools.servers.weather!.url, "http://h:1/mcp", "secrets.yaml cannot override a setting");
  const ignored = warnings.filter((w) => /not secret keys/.test(w));
  assert.equal(ignored.length, 1);
  assert.match(ignored[0]!, /tools\.servers\.weather\.url/);
  assert.doesNotMatch(warnings.join("\n"), /ok-tok|evil/);
});

// @spec CFG-SEC-016
test("a non-string token at a wildcard path fails the load naming the concrete path, never the value", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  secretsFile(dir, "tools:\n  servers:\n    weather:\n      token: 12345\n");
  assert.throws(() => loadConfig(true), (e: Error) => e.message.includes("tools.servers.weather.token") && !e.message.includes("12345"));
});

// @spec CFG-SEC-017
test("a token for a server config.yaml does not hold is not merged and is warned by path, once, in the CFG-SEC-005 warning", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  secretsFile(dir, "llm:\n  openai:\n    api_key: sk-ok\ntools:\n  servers:\n    gone:\n      token: tok-gone-secret\n    weather:\n      token: tok-w\n");
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.equal(cfg.tools.servers.gone, undefined, "the merge never creates the entry a credential belongs to");
  assert.equal(cfg.tools.servers.weather!.token, "tok-w");
  assert.equal(warnings.filter((w) => w.includes("tools.servers.gone.token")).length, 1);
  assert.equal(warnings.filter((w) => /not secret keys/.test(w)).length, 1, "one warning, the CFG-SEC-005 one");
  assert.doesNotMatch(warnings.join("\n"), /tok-gone-secret|tok-w\b/);
});

// @spec CFG-SEC-017
test("with no tools section in config.yaml a token under tools.servers is ignored by path and creates no entry", () => {
  const dir = sandbox({ "config.yaml": MINIMAL_YAML });
  secretsFile(dir, "tools:\n  servers:\n    weather:\n      token: tok-w\n");
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  assert.deepEqual(cfg.tools.servers, {});
  assert.equal(warnings.filter((w) => w.includes("tools.servers.weather.token")).length, 1);
});

// @spec CFG-SEC-018
test("updateSecrets sets, trims and clears a token at a wildcard path; clearing works whatever entries config.yaml holds", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  const file = secretsIn(dir);
  updateSecrets(file, { "tools.servers.weather.token": "  tok-1 " });
  assert.equal(loadConfig(true).tools.servers.weather!.token, "tok-1");
  assert.equal(mode(file), 0o600);
  // a removed server's token is cleared by path although config.yaml no longer holds the server
  writeFileSync(join(dir, "config.yaml"), MINIMAL_YAML);
  updateSecrets(file, { "tools.servers.weather.token": null });
  assert.match(readFileSync(file, "utf8"), /weather:\s*\n\s+token: ""/);
  const warnings = captureWarnings(() => { loadConfig(true); });
  assert.deepEqual(warnings.filter((w) => w.includes("tools.servers.weather.token")), [], "an empty value is not warned about");
});

// @spec CFG-SEC-018, CFG-SEC-003
test("updateSecrets refuses a path that only looks like the wildcard path, and applies no change when any is refused", () => {
  const dir = sandbox({ "config.yaml": TOOLS_YAML });
  const file = secretsIn(dir);
  for (const bad of ["tools.servers.weather.url", "tools.servers.token", "tools.servers.weather.extra.token", "tools.allow.x.token", "tools.servers..token"]) {
    assert.throws(() => updateSecrets(file, { "llm.openai.api_key": "sk-new", [bad]: "x" }), (e: Error) => e.message.includes(bad), bad);
  }
  assert.equal(existsSync(file), false, "nothing is written when any change is refused");
});

// @spec CFG-USR-016
test("the shipped secrets.example.yaml carries a commented tools.servers.<name>.token example, and holds no live tools key", () => {
  const text = readFileSync(join(repo, "config", "secrets.example.yaml"), "utf8");
  const commented = text.split("\n").filter((l) => /^\s*#/.test(l));
  assert.ok(commented.some((l) => /tools:/.test(l)) || commented.some((l) => /tools\.servers\.<name>\.token/.test(l)), "a commented tools.servers.<name>.token example");
  assert.ok(commented.some((l) => /token/.test(l)));
  assert.doesNotMatch(text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"), /tools:/, "the example is commented out");
});

// @spec CFG-SCH-083, CFG-SEC-016
test("a tools.servers name that holds a dot fails the load naming the entry, and a token for such a name in secrets.yaml is warned about by path, never dropped silently", () => {
  sandbox({
    "config.yaml": `${MINIMAL_YAML}tools: { servers: { "a.b": { url: "https://x.example/mcp" } } }\n`,
    "secrets.yaml": "tools:\n  servers:\n    a.b:\n      token: tk-SECRET\n",
  });
  chmodSync(process.env.COHOST_SECRETS_FILE!, 0o600);
  let thrown = "";
  const warnings = captureWarnings(() => { try { loadConfig(true); } catch (e) { thrown = (e as Error).message; } });
  assert.match(thrown, /tools\.servers\.a\.b/, "the load fails and names the entry");
  assert.ok(warnings.some((w) => w.includes("tools.servers.a.b") && !w.includes("tk-SECRET")), `the stray token is warned about by path: ${warnings.join(" | ")}`);
});
