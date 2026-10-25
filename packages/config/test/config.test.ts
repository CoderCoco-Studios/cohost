import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substituteEnv, ensureFromExample, loadConfig, loadDotEnv, configDir, findWorkspaceRoot, loadExpressions, loadPersonality, savePersonality, env, envOr, urls, EMOTIONS } from "../src/index.js";

test("substituteEnv: ${VAR}, ${VAR:-default}, unset and empty", () => {
  process.env.T_SET = "set";
  process.env.T_EMPTY = "";
  delete process.env.T_UNSET;
  assert.equal(substituteEnv("${T_SET}|${T_EMPTY}|${T_UNSET}"), "set||");
  assert.equal(substituteEnv("${T_SET:-d}|${T_EMPTY:-d}|${T_UNSET:-d}"), "set|d|d");
  assert.equal(substituteEnv("${T_UNSET:-http://x:8000/v1}"), "http://x:8000/v1");
  assert.equal(substituteEnv("no vars here"), "no vars here");
});

test("ensureFromExample seeds the real file once and then leaves it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-cfg-"));
  process.env.CONFIG_DIR = dir;
  writeFileSync(join(dir, "thing.example.yaml"), "a: 1\n");
  const file = ensureFromExample("thing.yaml", "thing.example.yaml");
  assert.equal(file, join(dir, "thing.yaml"));
  assert.ok(existsSync(file));
  writeFileSync(file, "a: 2\n"); // user edits it
  ensureFromExample("thing.yaml", "thing.example.yaml");
  assert.equal(readFileSync(file, "utf8"), "a: 2\n");
  assert.throws(() => ensureFromExample("missing.yaml", "missing.example.yaml"), /no .*missing\.example\.yaml/);
});

import { ConfigSchema, ModuleSchema, unknownKeys } from "../src/index.js";

test("reflex match must be a valid regex (a bad one would crash-loop salience)", () => {
  const reflexes = ConfigSchema.shape.brain.shape.salience.removeDefault().shape.reflexes;
  assert.equal(reflexes.safeParse([{ match: "(you died", say: ["x"] }]).success, false);
  assert.equal(reflexes.safeParse([{ match: "\\b(you died)\\b", say: ["x"] }]).success, true);
});

test("a hook's llm.provider override requires a model; a model alone is fine", () => {
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama" } }).success, false);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama", model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "", model: "" } }).success, true); // empty = inherit
});

test("unknownKeys names settings the schema dropped (pre-split brain.* keys)", () => {
  const raw = { brain: { tick_ms: 900, cooldown_ms: 1, salience: { tick_ms: 1500, typo_key: 1 }, memory: { recall_k: 3 } } };
  const parsed = { brain: { salience: { tick_ms: 1500 }, memory: { recall_k: 3 } } };
  assert.deepEqual(unknownKeys(raw, parsed).sort(), ["brain.cooldown_ms", "brain.salience.typo_key", "brain.tick_ms"]);
  assert.deepEqual(unknownKeys({ a: 1 }, { a: 1 }), []);
});


const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
/** A fresh root/config dir pair; CONFIG_DIR points at it for the test. */
function sandbox(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cohost-root-"));
  const dir = join(root, "config");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(name === ".env" ? root : dir, name), text);
  process.env.CONFIG_DIR = dir;
  return dir;
}
function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { fn(); } finally { console.warn = orig; }
  return out;
}
const minimalYaml = `
cohost: { name: Coco, streamer: Chris }
llm: { model: m, embed_model: e }
vision: { model: v, obs: { port: \${T_OBS_PORT} } }
chat: { twitch: { channel: "\${T_CHANNEL:-somechan}" } }
brain: {}
voice: {}
avatar: { vtube_studio: { host: h, port: 8001 }, vmc: { host: h, port: 39539 } }
ears: { discord: {} }
dashboard: {}
`;

test("the shipped config.example.yaml + .env.example load cleanly, with no unknown keys", () => {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  copyFileSync(join(repo, ".env.example"), join(dir, "..", ".env"));
  const saved = { ...process.env };
  try {
    let cfg!: ReturnType<typeof loadConfig>;
    const warnings = captureWarnings(() => { cfg = loadConfig(true); });
    assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
    assert.equal(cfg.cohost.name, "Coco");
    assert.ok(cfg.llm.model.length > 0, "LLM_MODEL from .env.example filled in llm.model");
  } finally {
    process.env = saved;
  }
});

test("the shipped expressions.example.yaml parses and maps every emotion for each driver", () => {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "expressions.example.yaml"), join(dir, "expressions.example.yaml"));
  const map = loadExpressions();
  assert.ok(Object.keys(map).length > 0);
  for (const [driver, exprs] of Object.entries(map)) {
    for (const e of EMOTIONS) assert.equal(typeof exprs[e], "string", `${driver}.${e}`);
    assert.equal(typeof exprs.gestures, "object");
  }
});

test("loadConfig: env substitution, empty numbers fall back to defaults, results are cached", () => {
  sandbox({ "config.yaml": minimalYaml });
  delete process.env.T_OBS_PORT;
  delete process.env.T_CHANNEL;
  const cfg = loadConfig(true);
  assert.equal(cfg.vision.obs.port, 4455); // `port: ` (null) → schema default, not a validation error
  assert.equal(cfg.chat.twitch.channel, "somechan");
  assert.equal(cfg.brain.salience.cooldown_ms, 6000);
  assert.equal(loadConfig(), cfg);
  process.env.T_CHANNEL = "other";
  assert.equal(loadConfig(true).chat.twitch.channel, "other");
  delete process.env.T_CHANNEL;
});

test("loadConfig: an invalid file names every bad path", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''").replace("voice: {}", "voice: { speed: -1 }") });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && /voice\.speed:/.test(e.message));
});

test("loadConfig: an invalid file with no .env says to copy .env.example", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''") });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && /no \.env/i.test(e.message) && /cp \.env\.example \.env/.test(e.message));
});

test("loadConfig: an invalid file with a .env present gets no .env hint", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''"), ".env": "X=1\n" });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && !/\.env/.test(e.message));
});

test("loadConfig warns about keys the schema doesn't know", () => {
  sandbox({ "config.yaml": minimalYaml.replace("brain: {}", "brain: { tick_ms: 900 }") });
  const warnings = captureWarnings(() => loadConfig(true));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ignoring unknown keys: brain\.tick_ms/);
});

test("loadDotEnv: comments, quotes, blank lines, and never overrides the real environment", () => {
  const dir = sandbox({ ".env": "# comment\n\nT_A=plain\nT_B=\"double quoted\"\nT_C='single'\n  T_D = spaced  \nT_E=from-file\n=novalue\nnoequals\nT_F=a=b\n" });
  process.env.T_E = "from-env";
  for (const k of ["T_A", "T_B", "T_C", "T_D", "T_F"]) delete process.env[k];
  loadDotEnv(join(dir, "..", ".env"));
  assert.equal(process.env.T_A, "plain");
  assert.equal(process.env.T_B, "double quoted");
  assert.equal(process.env.T_C, "single");
  assert.equal(process.env.T_D, "spaced");
  assert.equal(process.env.T_E, "from-env");
  assert.equal(process.env.T_F, "a=b");
  loadDotEnv(join(dir, "nope.env")); // missing file is fine
});

test("personality is seeded from the example, then saved and reloaded in place", () => {
  sandbox({ "personality.example.md": "# Coco\n" });
  assert.equal(loadPersonality(), "# Coco\n");
  savePersonality("# Coco\n\n## Learned\n- likes cats\n");
  assert.equal(loadPersonality(), "# Coco\n\n## Learned\n- likes cats\n");
});

test("env() requires a non-empty value; envOr() and urls fall back", () => {
  process.env.T_REQ = "x";
  assert.equal(env("T_REQ"), "x");
  process.env.T_REQ = "";
  assert.throws(() => env("T_REQ"), /Missing required environment variable T_REQ/);
  assert.equal(envOr("T_REQ", "fb"), "fb");
  const saved = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  assert.equal(urls.redis(), "redis://127.0.0.1:6379");
  process.env.REDIS_URL = "redis://elsewhere:1";
  assert.equal(urls.redis(), "redis://elsewhere:1");
  if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
});

test("configDir finds <workspace root>/config when cwd is a nested package dir", () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-ws-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - services/*\n");
  const svc = join(root, "services", "salience");
  mkdirSync(svc, { recursive: true });
  const prevCwd = process.cwd();
  const prevEnv = process.env.CONFIG_DIR;
  delete process.env.CONFIG_DIR;
  try {
    process.chdir(svc);
    assert.equal(findWorkspaceRoot(), realpathSync(root));
    assert.equal(configDir(), join(realpathSync(root), "config"));
    process.env.CONFIG_DIR = "/explicit";
    assert.equal(configDir(), "/explicit"); // explicit override still wins
    delete process.env.CONFIG_DIR;
    // no workspace file anywhere above: fall back to cwd/config
    const lone = mkdtempSync(join(tmpdir(), "cohost-lone-"));
    process.chdir(lone);
    assert.equal(configDir(), join(realpathSync(lone), "config"));
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = prevEnv;
  }
});

test("urls.voice defaults to loopback (host runs), honours VOICE_PORT, and VOICE_URL overrides (compose)", () => {
  const saved = { u: process.env.VOICE_URL, p: process.env.VOICE_PORT };
  try {
    delete process.env.VOICE_URL;
    delete process.env.VOICE_PORT;
    assert.equal(urls.voice(), "http://127.0.0.1:8700");
    process.env.VOICE_PORT = "9000";
    assert.equal(urls.voice(), "http://127.0.0.1:9000");
    process.env.VOICE_URL = "http://voice:8700";
    assert.equal(urls.voice(), "http://voice:8700");
  } finally {
    if (saved.u === undefined) delete process.env.VOICE_URL; else process.env.VOICE_URL = saved.u;
    if (saved.p === undefined) delete process.env.VOICE_PORT; else process.env.VOICE_PORT = saved.p;
  }
});
