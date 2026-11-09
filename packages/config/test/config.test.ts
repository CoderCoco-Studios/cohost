import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substituteEnv, ensureFromExample, loadConfig, loadDotEnv, configDir, findWorkspaceRoot, loadExpressions, loadPersonality, savePersonality, env, envOr, urls, EMOTIONS } from "../src/index.js";

// @spec CFG-ENV-001, CFG-ENV-002
test("substituteEnv: ${VAR}, ${VAR:-default}, unset and empty", () => {
  process.env.T_SET = "set";
  process.env.T_EMPTY = "";
  delete process.env.T_UNSET;
  assert.equal(substituteEnv("${T_SET}|${T_EMPTY}|${T_UNSET}"), "set||");
  assert.equal(substituteEnv("${T_SET:-d}|${T_EMPTY:-d}|${T_UNSET:-d}"), "set|d|d");
  assert.equal(substituteEnv("${T_UNSET:-http://x:8000/v1}"), "http://x:8000/v1");
  assert.equal(substituteEnv("no vars here"), "no vars here");
});

// @spec CFG-DIR-003, CFG-DIR-004, CFG-DIR-005
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

// @spec CFG-SCH-004
test("reflex match must be a valid regex (a bad one would crash-loop salience)", () => {
  const reflexes = ConfigSchema.shape.brain.shape.salience.removeDefault().shape.reflexes;
  assert.equal(reflexes.safeParse([{ match: "(you died", say: ["x"] }]).success, false);
  assert.equal(reflexes.safeParse([{ match: "\\b(you died)\\b", say: ["x"] }]).success, true);
});

// @spec CFG-SCH-003
test("a hook's llm.provider override requires a model; a model alone is fine", () => {
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama" } }).success, false);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama", model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "", model: "" } }).success, true); // empty = inherit
});

// @spec CFG-LOAD-005
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

// @spec CFG-USR-003, CFG-ENV-004
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

// @spec CFG-USR-002, CFG-USR-004
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

// @spec CFG-LOAD-001, CFG-LOAD-002, CFG-ENV-001, CFG-SCH-005
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

// @spec CFG-LOAD-003, CFG-SCH-001, CFG-SCH-006
test("loadConfig: an invalid file names every bad path", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''").replace("voice: {}", "voice: { speed: -1 }") });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && /voice\.speed:/.test(e.message));
});

// @spec CFG-LOAD-004
test("loadConfig: an invalid file with no .env says to copy .env.example", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''") });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && /no \.env/i.test(e.message) && /cp \.env\.example \.env/.test(e.message));
});

// @spec CFG-LOAD-004
test("loadConfig: an invalid file with a .env present gets no .env hint", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''"), ".env": "X=1\n" });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && !/\.env/.test(e.message));
});

// @spec CFG-LOAD-005
test("loadConfig warns about keys the schema doesn't know", () => {
  sandbox({ "config.yaml": minimalYaml.replace("brain: {}", "brain: { tick_ms: 900 }") });
  const warnings = captureWarnings(() => loadConfig(true));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ignoring unknown keys: brain\.tick_ms/);
});

// @spec CFG-ENV-004, CFG-ENV-005
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

// @spec CFG-USR-001
test("personality is seeded from the example, then saved and reloaded in place", () => {
  sandbox({ "personality.example.md": "# Coco\n" });
  assert.equal(loadPersonality(), "# Coco\n");
  savePersonality("# Coco\n\n## Learned\n- likes cats\n");
  assert.equal(loadPersonality(), "# Coco\n\n## Learned\n- likes cats\n");
});

// @spec CFG-ENV-007, CFG-URL-001
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

// @spec CFG-DIR-001, CFG-DIR-002
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

// @spec CFG-URL-002
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

// @spec CFG-ISO-001, CFG-ISO-003
test("brain.memory.store defaults to postgres; 'memory' selects the in-process fake; others are rejected", async () => {
  const { ConfigSchema } = await import("../src/schema.js");
  const shape = ConfigSchema.shape.brain.shape.memory;
  assert.equal(shape.parse({}).store, "postgres");
  assert.equal(shape.parse({ store: "memory" }).store, "memory");
  assert.equal(shape.safeParse({ store: "sqlite" }).success, false);
});

// @spec CFG-URL-003
test("urls.dashboard() defaults to loopback and honours DASHBOARD_URL", () => {
  const saved = process.env.DASHBOARD_URL;
  delete process.env.DASHBOARD_URL;
  assert.equal(urls.dashboard(), "http://127.0.0.1:3000");
  process.env.DASHBOARD_URL = "http://dashboard:3000";
  assert.equal(urls.dashboard(), "http://dashboard:3000");
  if (saved === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = saved;
});

function loadShipped(env: Record<string, string> = {}) {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  copyFileSync(join(repo, ".env.example"), join(dir, "..", ".env"));
  const saved = { ...process.env };
  for (const k of ["LLM_PROVIDER", "MEMORY_STORE", "MEMORY_EMBEDDER", "VOICE_ENGINE", "CHAT_SOURCE", "VISION_ENABLED", "EARS_SOURCE"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let cfg!: ReturnType<typeof loadConfig>;
    captureWarnings(() => { cfg = loadConfig(true); });
    return cfg;
  } finally {
    process.env = saved;
  }
}

// @spec CFG-ISO-004
test("isolation presets: unset env equals the live defaults", () => {
  const cfg = loadShipped();
  assert.equal(cfg.llm.provider, "ollama");
  assert.equal(cfg.voice.engine, "kokoro");
  assert.equal(cfg.vision.enabled, false);
  assert.equal(cfg.brain.memory.store, "postgres");
  assert.equal(cfg.brain.memory.embedder, "ollama");
  assert.equal(cfg.chat.source, "twitch");
  assert.equal(cfg.chat.fake.interval_ms, 8000);
  assert.equal(cfg.ears.source, "discord");
});

// @spec CFG-ISO-004
test("isolation presets: each env var flips its key without editing config.yaml", () => {
  const cfg = loadShipped({
    LLM_PROVIDER: "mock", MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash",
    VOICE_ENGINE: "stub", CHAT_SOURCE: "fake", VISION_ENABLED: "true", EARS_SOURCE: "off",
  });
  assert.equal(cfg.llm.provider, "mock");
  assert.equal(cfg.brain.memory.store, "memory");
  assert.equal(cfg.brain.memory.embedder, "hash");
  assert.equal(cfg.voice.engine, "stub");
  assert.equal(cfg.chat.source, "fake");
  assert.equal(cfg.vision.enabled, true);
  assert.equal(cfg.ears.source, "off");
});

// @spec CFG-ISO-001, CFG-ISO-003
test("new keys default to live backends when omitted; bad enum values are rejected", () => {
  const base = { cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } }, ears: { discord: {} }, dashboard: {}, brain: {} };
  const ok = ConfigSchema.parse(base);
  assert.deepEqual([ok.voice.engine, ok.brain.memory.store, ok.brain.memory.embedder, ok.chat.source, ok.ears.source],
    ["kokoro", "postgres", "ollama", "twitch", "discord"]);
  const bad = ConfigSchema.safeParse({ ...base, chat: { source: "irc", twitch: {} } });
  assert.equal(bad.success, false);
  assert.ok(!bad.success && bad.error.issues.some((i) => i.path.join(".") === "chat.source"));
  assert.equal(ConfigSchema.safeParse({ ...base, ears: { source: "x", discord: {} } }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...base, voice: { engine: "x" } }).success, false);
});

/** Loads the shipped example through the real loader with no .env file and the given env vars set. */
function loadShippedBare(env: Record<string, string> = {}) {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  const saved = { ...process.env };
  for (const k of ["LLM_PROVIDER", "LLM_MODEL", "EMBED_MODEL", "VISION_MODEL", "AVATAR_DRIVER", "VTS_PORT", "VMC_PORT", "VTS_HOST", "VMC_HOST", "OBS_PORT"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let cfg!: ReturnType<typeof loadConfig>;
    const warnings = captureWarnings(() => { cfg = loadConfig(true); });
    return { cfg, warnings };
  } finally {
    process.env = saved;
  }
}

// @spec CFG-ISO-005
test("the shipped example loads with no .env: model defaults, avatar.driver null, default avatar ports", () => {
  const { cfg, warnings } = loadShippedBare();
  assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
  assert.equal(cfg.llm.model, "qwen2.5:7b-instruct-q4_K_M");
  assert.equal(cfg.llm.embed_model, "nomic-embed-text");
  assert.equal(cfg.vision.model, "qwen2.5vl:3b");
  assert.equal(cfg.avatar.driver, "null");
  assert.equal(cfg.avatar.vtube_studio.port, 8001);
  assert.equal(cfg.avatar.vmc.port, 39539);
  assert.equal(loadShippedBare({ AVATAR_DRIVER: "", VTS_PORT: "", VMC_PORT: "" }).cfg.avatar.driver, "null");
});

// @spec CFG-ISO-005
test("an unknown avatar.driver still fails the load, naming avatar.driver", () => {
  assert.throws(() => loadShippedBare({ AVATAR_DRIVER: "bogus" }), (e: Error) => /avatar\.driver:/.test(e.message));
  assert.equal(loadShippedBare({ AVATAR_DRIVER: "vmc", VMC_PORT: "1234" }).cfg.avatar.driver, "vmc");
});

// @spec CFG-ENV-006
test("loadDotEnv strips an unquoted ' #' suffix, keeps '#' in quotes and inside a word", () => {
  const keys = ["T_C1", "T_C2", "T_C3", "T_C4", "T_C5", "T_C6", "T_C7"];
  for (const k of keys) delete process.env[k];
  const dir = sandbox({ ".env": "T_C1= # only a comment\nT_C2=value # trailing\nT_C3=\"a # b\"\nT_C4=a#b\nT_C5='x # y' # note\nT_C6=tab\t# tabbed\nT_C7=#nospace\n" });
  loadDotEnv(join(dir, "..", ".env"));
  assert.equal(process.env.T_C1, "");
  assert.equal(process.env.T_C2, "value");
  assert.equal(process.env.T_C3, "a # b");
  assert.equal(process.env.T_C4, "a#b");
  assert.equal(process.env.T_C5, "x # y");
  assert.equal(process.env.T_C6, "tab");
  assert.equal(process.env.T_C7, "#nospace");
  for (const k of keys) delete process.env[k];
});

// @spec CFG-LOAD-006
test("unknownKeys descends into arrays and reports path[index].key", () => {
  const raw = { brain: { salience: { reflexes: [{ match: "a", say: ["x"] }, { match: "b", say: ["y"], emtion: "happy" }] } } };
  const parsed = { brain: { salience: { reflexes: [{ match: "a", say: ["x"] }, { match: "b", say: ["y"] }] } } };
  assert.deepEqual(unknownKeys(raw, parsed), ["brain.salience.reflexes[1].emtion"]);
});

// @spec CFG-LOAD-006
test("loadConfig warns about a typo inside a reflex, without migration advice", () => {
  const yaml = minimalYaml.replace("brain: {}", "brain: { salience: { reflexes: [{ match: 'x', say: ['y'], cooldwn_ms: 5 }] } }");
  sandbox({ "config.yaml": yaml });
  const warnings = captureWarnings(() => loadConfig(true));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ignoring unknown keys: brain\.salience\.reflexes\[0\]\.cooldwn_ms/);
  assert.doesNotMatch(warnings[0]!, /used to sit|moved into/);
});

// @spec CFG-ENV-008
test("ConfigSchema has no control section and no key for CONTROL_* or HEARTBEAT_INTERVAL_MS", () => {
  const top = Object.keys(ConfigSchema.shape);
  assert.ok(!top.includes("control"));
  const banned = /control|heartbeat/i;
  const walk = (s: unknown, path: string): string[] => {
    let t = s as { _zod?: { def: Record<string, unknown> } };
    while (t?._zod && (t._zod.def.innerType || t._zod.def.out)) t = (t._zod.def.innerType ?? t._zod.def.out) as typeof t;
    const shape = t?._zod?.def.shape as Record<string, unknown> | undefined;
    if (!shape) return [];
    return Object.entries(shape).flatMap(([k, v]) => [`${path}${k}`, ...walk(v, `${path}${k}.`)]);
  };
  assert.deepEqual(walk(ConfigSchema, "").filter((p) => banned.test(p)), []);
});

// @spec CFG-SCH-009
test("a hook's explicit llm.provider 'mock' is rejected (it can only be inherited)", () => {
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "mock", model: "x" } }).success, false);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama", model: "x" } }).success, true);
});

const baseCfg = () => ({ cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: { discord: {} }, dashboard: {}, brain: {} });

// @spec CFG-SCH-011
test("brain.salience.thinking_timeout_ms and brain.affect.baseline_arousal default and validate", () => {
  const ok = ConfigSchema.parse(baseCfg());
  assert.equal(ok.brain.salience.thinking_timeout_ms, 60000);
  assert.equal(ok.brain.affect.baseline_arousal, 0.1);
  const withBrain = (b: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: b });
  assert.equal(withBrain({ salience: { thinking_timeout_ms: 0 } }).success, false);
  assert.equal(withBrain({ salience: { thinking_timeout_ms: 1.5 } }).success, false);
  assert.equal(withBrain({ salience: { thinking_timeout_ms: 5000 } }).success, true);
  assert.equal(withBrain({ affect: { baseline_arousal: 1.1 } }).success, false);
  assert.equal(withBrain({ affect: { baseline_arousal: -0.1 } }).success, false);
  assert.equal(withBrain({ affect: { baseline_arousal: 0 } }).success, true);
  assert.equal(withBrain({ affect: { baseline_arousal: 1 } }).success, true);
});

// @spec CFG-SCH-012
test("vision.timeout_ms, upload_timeout_ms and upload_max_bytes default and validate", () => {
  const ok = ConfigSchema.parse(baseCfg());
  assert.equal(ok.vision.timeout_ms, 30000);
  assert.equal(ok.vision.upload_timeout_ms, 10000);
  assert.equal(ok.vision.upload_max_bytes, 8388608);
  for (const k of ["timeout_ms", "upload_timeout_ms", "upload_max_bytes"]) {
    for (const v of [0, -1, 1.5]) {
      assert.equal(ConfigSchema.safeParse({ ...baseCfg(), vision: { model: "v", obs: {}, [k]: v } }).success, false, `${k}=${v}`);
    }
  }
});

// @spec CFG-SCH-013
test("llm.timeout_ms defaults to 60000 and must be a positive integer", () => {
  assert.equal(ConfigSchema.parse(baseCfg()).llm.timeout_ms, 60000);
  for (const v of [0, -1, 1.5]) {
    assert.equal(ConfigSchema.safeParse({ ...baseCfg(), llm: { model: "m", embed_model: "e", timeout_ms: v } }).success, false, `${v}`);
  }
});

// @spec CFG-SCH-011, CFG-SCH-012, CFG-SCH-013
test("the shipped example shows the new timeout keys with their schema defaults", () => {
  const { cfg, warnings } = loadShippedBare();
  assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
  assert.equal(cfg.brain.salience.thinking_timeout_ms, 60000);
  assert.equal(cfg.brain.affect.baseline_arousal, 0.1);
  assert.equal(cfg.vision.timeout_ms, 30000);
  assert.equal(cfg.vision.upload_timeout_ms, 10000);
  assert.equal(cfg.vision.upload_max_bytes, 8388608);
  assert.equal(cfg.llm.timeout_ms, 60000);
});

// @spec CFG-SCH-014
test("brain.memory.regular_messages defaults to 25 and must be a positive integer", () => {
  assert.equal(ConfigSchema.parse(baseCfg()).brain.memory.regular_messages, 25);
  const with_ = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { memory: { regular_messages: v } } });
  for (const v of [0, -1, 1.5]) assert.equal(with_(v).success, false, `${v}`);
  assert.equal(with_(40).success, true);
});

// @spec CFG-SCH-015
test("brain.memory.notes defaults to the documented numbers and rejects out-of-range values", () => {
  const { capture: _c, consolidator: _k, ...numbers } = ConfigSchema.parse(baseCfg()).brain.memory.notes;
  assert.deepEqual(numbers, {
    dirty_threshold: 20, recent_half_life_days: 7, core_half_life_days: 60, reinforce: 0.6, promote_mentions: 3,
    demote_below: 0.3, drop_below: 0.1, returning_strength: 0.3, suppress_similarity: 0.8, capture_min_chars: 8,
    max_notes_per_viewer: 5, max_notes_total: 15, sensitive_cooldown_hours: 24, deleted_retention_days: 30,
  });
  const with_ = (k: string, v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { memory: { notes: { [k]: v } } } });
  const bad: [string, unknown[]][] = [
    ["dirty_threshold", [0, -1, 1.5]], ["recent_half_life_days", [0, -1]], ["core_half_life_days", [0, -1]],
    ["reinforce", [-0.1, 1.1]], ["promote_mentions", [0, 1.5]], ["demote_below", [-0.1, 1.1]], ["drop_below", [-0.1, 1.1]],
    ["returning_strength", [-0.1, 1.1]], ["suppress_similarity", [-0.1, 1.1]], ["capture_min_chars", [-1, 1.5]],
    ["max_notes_per_viewer", [0, 1.5]], ["max_notes_total", [0, 1.5]], ["sensitive_cooldown_hours", [-1]], ["deleted_retention_days", [0, -1]],
  ];
  for (const [k, vs] of bad) for (const v of vs) assert.equal(with_(k, v).success, false, `${k}=${v}`);
  assert.equal(with_("capture_min_chars", 0).success, true);
  assert.equal(with_("sensitive_cooldown_hours", 0).success, true);
  assert.equal(with_("recent_half_life_days", 0.5).success, true);
  assert.equal(with_("reinforce", 0).success && with_("reinforce", 1).success, true);
});

// @spec CFG-SCH-016
test("brain.memory.notes.capture and consolidator are hook configs defaulting to rules, with the hook provider/model rules", () => {
  const notes = ConfigSchema.parse(baseCfg()).brain.memory.notes;
  for (const hook of [notes.capture, notes.consolidator]) {
    assert.equal(hook.kind, "rules");
    assert.equal(hook.timeout_ms, 1500);
    assert.equal(hook.llm.provider, undefined);
  }
  const with_ = (hook: string, v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { memory: { notes: { [hook]: v } } } });
  for (const hook of ["capture", "consolidator"] as const) {
    assert.equal(with_(hook, { kind: "llm", llm: { provider: "ollama", model: "x" } }).success, true);
    assert.equal(with_(hook, { kind: "llm", llm: { provider: "ollama" } }).success, false, "provider without a model");
    assert.equal(with_(hook, { kind: "llm", llm: { provider: "mock", model: "x" } }).success, false, "mock cannot be named");
    assert.equal(with_(hook, { kind: "" }).data!.brain.memory.notes[hook].kind, "rules");
  }
});

// @spec CFG-USR-007
test("the shipped example configures the consolidator on the cortex's model via ollama and lists the notes keys with their defaults", () => {
  const { cfg, warnings } = loadShippedBare();
  assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
  const c = cfg.brain.memory.notes.consolidator;
  assert.equal(c.kind, "llm");
  assert.equal(c.llm.provider, "ollama");
  assert.equal(c.llm.model, cfg.llm.model);
  assert.equal(c.llm.model, "qwen2.5:7b-instruct-q4_K_M");
  assert.equal(loadShippedBare({ LLM_MODEL: "other:tag" }).cfg.brain.memory.notes.consolidator.llm.model, "other:tag");
  assert.equal(cfg.brain.memory.regular_messages, 25);
  const { capture: _c, consolidator: _k, ...numbers } = cfg.brain.memory.notes;
  const { capture: _c2, consolidator: _k2, ...expected } = ConfigSchema.parse(baseCfg()).brain.memory.notes;
  assert.deepEqual(numbers, expected);
  const yaml = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  for (const key of Object.keys(expected)) assert.match(yaml, new RegExp(`^\\s+${key}:`, "m"), `${key} listed in the example`);
});

// @spec CFG-ENV-009
test("VIEWERS_TOKEN is env-only: no schema key at any depth, and a YAML key for it is reported as unknown", () => {
  const keys = (o: unknown, out: string[] = []): string[] => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.push(k); keys(v, out); }
    return out;
  };
  assert.equal(keys(loadShipped()).some((k) => /viewers?_?token/i.test(k)), false);
  { const raw = { dashboard: { viewers_token: "x" } }; assert.ok(unknownKeys(raw, loadShipped()).some((p) => /viewers_token/.test(p))); }
});

// @spec CFG-USR-008
test("the shipped example configures the capture hook on its own small ollama model, overridable with NOTES_MODEL, and .env.example documents it", () => {
  const { cfg } = loadShippedBare();
  const c = cfg.brain.memory.notes.capture;
  assert.equal(c.kind, "llm");
  assert.equal(c.llm.provider, "ollama");
  assert.equal(c.llm.model, "gemma3:1b");
  assert.notEqual(c.llm.model, cfg.llm.model, "its own model slot, not the cortex's");
  assert.equal(loadShippedBare({ NOTES_MODEL: "other:tag" }).cfg.brain.memory.notes.capture.llm.model, "other:tag");
  assert.match(readFileSync(join(repo, "config", "config.example.yaml"), "utf8"), /\$\{NOTES_MODEL:-gemma3:1b\}/);
  assert.match(readFileSync(join(repo, ".env.example"), "utf8"), /^NOTES_MODEL=gemma3:1b$/m);
});
