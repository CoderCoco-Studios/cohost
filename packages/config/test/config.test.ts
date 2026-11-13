import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substituteEnv, ensureFromExample, loadConfig, loadDotEnv, configDir, findWorkspaceRoot, loadExpressions, loadPersonality, savePersonality, env, envOr, urls, EMOTIONS, dataDir, setConfigLogger, earsSources } from "../src/index.js";

/** Every test starts from the environment the file started with; sandbox() and loaders mutate CONFIG_DIR, COHOST_ENV_FILE and .env values. */
const initialEnv = { ...process.env };
function restoreEnv(to: NodeJS.ProcessEnv = initialEnv): void {
  for (const k of Object.keys(process.env)) if (!(k in to)) delete process.env[k];
  Object.assign(process.env, to);
}
afterEach(() => { restoreEnv(); setConfigLogger(undefined); });

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
  process.env.COHOST_ENV_FILE = join(root, ".env");
  return dir;
}
function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  setConfigLogger({ warn: ((...a: unknown[]) => { out.push(a.map(String).join(" ")); }) as never });
  try { fn(); } finally { setConfigLogger(undefined); }
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
ears: {}
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
    restoreEnv(saved);
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

test("urls has no dashboard(): uploads travel over Redis, so no service needs the dashboard's address", () => {
  assert.equal("dashboard" in urls, false);
});

function loadShipped(env: Record<string, string> = {}) {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  copyFileSync(join(repo, ".env.example"), join(dir, "..", ".env"));
  const saved = { ...process.env };
  for (const k of ["LLM_PROVIDER", "MEMORY_STORE", "MEMORY_EMBEDDER", "VOICE_ENGINE", "CHAT_SOURCE", "VISION_ENABLED", "EARS_SOURCES", "MOUTH_DISCORD_ENABLED", "CONNECTIONS_DISCORD_ENABLED", "DISCORD_GUILD_ID", "DISCORD_VOICE_CHANNEL_ID", "VISION_ENGINE", "EARS_STT_ENGINE", "MOUTH_DRYRUN_ENABLED"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let cfg!: ReturnType<typeof loadConfig>;
    captureWarnings(() => { cfg = loadConfig(true); });
    return cfg;
  } finally {
    restoreEnv(saved);
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
  assert.deepEqual(earsSources(cfg.ears), ["discord"]);
  assert.equal(cfg.mouth.outputs.discord.enabled, true);
  assert.equal(cfg.vision.engine, "ollama");
  assert.equal(cfg.ears.stt_engine, "speaches");
  assert.equal(cfg.mouth.outputs.dryrun.enabled, false);
});

// @spec CFG-ISO-004
test("isolation presets: each env var flips its key without editing config.yaml", () => {
  const cfg = loadShipped({
    LLM_PROVIDER: "mock", MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash",
    VOICE_ENGINE: "stub", CHAT_SOURCE: "fake", VISION_ENABLED: "true", EARS_SOURCES: "[]", MOUTH_DISCORD_ENABLED: "false",
    VISION_ENGINE: "stub", EARS_STT_ENGINE: "stub", MOUTH_DRYRUN_ENABLED: "true",
  });
  assert.equal(cfg.llm.provider, "mock");
  assert.equal(cfg.brain.memory.store, "memory");
  assert.equal(cfg.brain.memory.embedder, "hash");
  assert.equal(cfg.voice.engine, "stub");
  assert.equal(cfg.chat.source, "fake");
  assert.equal(cfg.vision.enabled, true);
  assert.deepEqual(earsSources(cfg.ears), []);
  assert.equal(cfg.mouth.outputs.discord.enabled, false);
  assert.equal(cfg.vision.engine, "stub");
  assert.equal(cfg.ears.stt_engine, "stub");
  assert.equal(cfg.mouth.outputs.dryrun.enabled, true);
});

// @spec CFG-ISO-001, CFG-ISO-003
test("new keys default to live backends when omitted; bad enum values are rejected", () => {
  const base = { cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } }, ears: {}, dashboard: {}, brain: {} };
  const ok = ConfigSchema.parse(base);
  assert.deepEqual([ok.voice.engine, ok.brain.memory.store, ok.brain.memory.embedder, ok.chat.source, earsSources(ok.ears), ok.mouth.outputs.discord.enabled],
    ["kokoro", "postgres", "ollama", "twitch", ["discord"], true]);
  const bad = ConfigSchema.safeParse({ ...base, chat: { source: "irc", twitch: {} } });
  assert.equal(bad.success, false);
  assert.ok(!bad.success && bad.error.issues.some((i) => i.path.join(".") === "chat.source"));
  assert.equal(ConfigSchema.safeParse({ ...base, ears: { sources: ["X"] } }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...base, voice: { engine: "x" } }).success, false);
});

/** Loads the shipped example through the real loader with no .env file and the given env vars set. */
function loadShippedBare(env: Record<string, string> = {}) {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  const saved = { ...process.env };
  for (const k of ["LLM_PROVIDER", "LLM_MODEL", "LLM_API_KEY", "ANTHROPIC_API_KEY", "EMBED_MODEL", "VISION_MODEL", "NOTES_MODEL", "STT_MODEL", "AVATAR_DRIVER", "VTS_PORT", "VMC_PORT", "VTS_HOST", "VMC_HOST", "OBS_PORT", "OBS_HOST", "OBS_PASSWORD", "OBS_SOURCE", "CHAT_SOURCE", "EARS_SOURCES", "EARS_STT_ENGINE", "MEMORY_EMBEDDER", "MEMORY_STORE", "VISION_ENABLED", "VISION_ENGINE", "VOICE_ENGINE", "MOUTH_DISCORD_ENABLED", "MOUTH_DRYRUN_ENABLED", "TWITCH_CHANNEL", "DISCORD_GUILD_ID", "DISCORD_VOICE_CHANNEL_ID"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let cfg!: ReturnType<typeof loadConfig>;
    const warnings = captureWarnings(() => { cfg = loadConfig(true); });
    return { cfg, warnings };
  } finally {
    restoreEnv(saved);
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
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {} });

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
    assert.equal(hook.timeout_ms, 8000);
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

// @spec CFG-SCH-019
test("brain.cortex.fallback_ack_chance defaults to 0.25, accepts 0 to 1 inclusive and rejects anything outside", () => {
  assert.equal(ConfigSchema.parse(baseCfg()).brain.cortex.fallback_ack_chance, 0.25);
  const with_ = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { cortex: { fallback_ack_chance: v } } });
  for (const v of [0, 0.5, 1]) assert.equal(with_(v).data!.brain.cortex.fallback_ack_chance, v);
  for (const v of [-0.01, 1.01, "x", Number.NaN]) assert.equal(with_(v).success, false, `${String(v)}`);
});

// @spec CFG-USR-010
test("the shipped example sets brain.cortex.fallback_ack_chance to 0.25 with a comment that it is a nudge, not an enforced rate", () => {
  const { cfg, warnings } = loadShippedBare();
  assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
  assert.equal(cfg.brain.cortex.fallback_ack_chance, 0.25);
  const yaml = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  assert.match(yaml, /^\s+fallback_ack_chance: 0\.25\s+#.*nudge.*not.*enforced/im);
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
  assert.equal(c.llm.model, "gemma3:4b");
  assert.equal(c.timeout_ms, 20000);
  assert.notEqual(c.llm.model, cfg.llm.model, "its own model slot, not the cortex's");
  assert.equal(loadShippedBare({ NOTES_MODEL: "other:tag" }).cfg.brain.memory.notes.capture.llm.model, "other:tag");
  assert.match(readFileSync(join(repo, "config", "config.example.yaml"), "utf8"), /\$\{NOTES_MODEL:-gemma3:4b\}/);
  assert.match(readFileSync(join(repo, ".env.example"), "utf8"), /^NOTES_MODEL=gemma3:4b$/m);
});

// @spec CFG-DIR-006, CFG-DIR-007
test("dataDir honours COHOST_DATA_DIR, else <workspace root>/data, else <cwd>/data", () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-data-ws-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - services/*\n");
  const svc = join(root, "services", "ears");
  mkdirSync(svc, { recursive: true });
  const prevCwd = process.cwd();
  const prevEnv = process.env.COHOST_DATA_DIR;
  delete process.env.COHOST_DATA_DIR;
  try {
    process.chdir(svc);
    assert.equal(dataDir(), join(realpathSync(root), "data"));
    process.env.COHOST_DATA_DIR = "/explicit/data";
    assert.equal(dataDir(), "/explicit/data");
    process.env.COHOST_DATA_DIR = "relative/data";
    assert.equal(dataDir(), join(realpathSync(svc), "relative", "data"), "resolved to an absolute path");
    delete process.env.COHOST_DATA_DIR;
    const lone = mkdtempSync(join(tmpdir(), "cohost-data-lone-"));
    process.chdir(lone);
    assert.equal(dataDir(), join(realpathSync(lone), "data"));
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.COHOST_DATA_DIR; else process.env.COHOST_DATA_DIR = prevEnv;
  }
});

// @spec CFG-SCH-018
test("the ears section defines no fallback key: an old ears.fallback is dropped and reported as unknown", () => {
  const base = { cohost: { name: "C", streamer: "S" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: { channel: "c" } },
    voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, brain: {} };
  const raw = { ...base, ears: { fallback: { min_interval_ms: 5000 } } };
  const parsed = ConfigSchema.safeParse(raw);
  assert.equal(parsed.success, true);
  assert.equal("fallback" in parsed.data!.ears, false);
  assert.deepEqual(unknownKeys(raw, parsed.data), ["ears.fallback"]);
});

// @spec CFG-SCH-018
test("mouth.fallback.min_interval_ms defaults to 20000, accepts 0, and rejects negatives and fractions", () => {
  const with_ = (fallback?: unknown) => ConfigSchema.safeParse({ ...baseCfg(), ...(fallback === undefined ? {} : { mouth: { fallback } }) });
  assert.equal(with_().data!.mouth.fallback.min_interval_ms, 20000);
  assert.equal(with_({}).data!.mouth.fallback.min_interval_ms, 20000);
  assert.equal(with_({ min_interval_ms: 0 }).data!.mouth.fallback.min_interval_ms, 0);
  assert.equal(with_({ min_interval_ms: 5000 }).data!.mouth.fallback.min_interval_ms, 5000);
  assert.equal(with_({ min_interval_ms: -1 }).success, false);
  assert.equal(with_({ min_interval_ms: 1.5 }).success, false);
});

// @spec CFG-SCH-020
test("the mouth section is optional: absent or partial, it loads with the Discord output on, empty target, gain 0 and interval 20000", () => {
  const absent = ConfigSchema.safeParse(baseCfg());
  assert.ok(absent.success);
  assert.deepEqual(absent.data!.mouth, { outputs: { discord: { enabled: true, gain_db: 0 }, dryrun: { enabled: false, fail_every: 0 }, file: { enabled: false, dir: "mouth/outputs", max_files: 100 }, http: { enabled: false, url: "", timeout_ms: 5000, retries: 3, max_queue: 20 } }, fallback: { min_interval_ms: 20000 } });
  for (const partial of [{}, { outputs: {} }, { outputs: { discord: {} } }, { fallback: {} }]) {
    const r = ConfigSchema.safeParse({ ...baseCfg(), mouth: partial });
    assert.ok(r.success, JSON.stringify(partial));
    assert.deepEqual(r.data.mouth, absent.data!.mouth, JSON.stringify(partial));
  }
  const set = ConfigSchema.parse({ ...baseCfg(), mouth: { outputs: { discord: { enabled: false, gain_db: -6.5 } } } });
  assert.deepEqual(set.mouth.outputs.discord, { enabled: false, gain_db: -6.5 });
});

// @spec CFG-SCH-023
test("mouth.outputs.dryrun defaults to disabled with fail_every 0, and fail_every is an integer of 0 or more", () => {
  const dry = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), mouth: { outputs: { dryrun: v } } });
  assert.deepEqual(dry({}).data!.mouth.outputs.dryrun, { enabled: false, fail_every: 0 });
  assert.deepEqual(dry({ enabled: true, fail_every: 3 }).data!.mouth.outputs.dryrun, { enabled: true, fail_every: 3 });
  for (const bad of [-1, 1.5, "2"]) assert.equal(dry({ fail_every: bad }).success, false, String(bad));
  assert.equal(dry({ enabled: "yes" }).success, false);
});

// @spec CFG-SCH-020
test("mouth.outputs.discord.gain_db accepts -40 to 12 inclusive and a failure names the key outside it", () => {
  const gain = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), mouth: { outputs: { discord: { gain_db: v } } } });
  assert.equal(gain(-40).success, true);
  assert.equal(gain(12).success, true);
  assert.equal(gain(0).success, true);
  for (const bad of [-40.1, 12.1, 100, "loud", null]) {
    const r = gain(bad);
    assert.equal(r.success, false, String(bad));
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === "mouth.outputs.discord.gain_db"), String(bad));
  }
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), mouth: { outputs: { discord: { enabled: "yes" } } } }).success, false);
});

// @spec CFG-SCH-021, EYES-DESC-007
test("vision.engine defaults to ollama (blank too), accepts stub, rejects others; the describer tuning keys default and validate", () => {
  const vision = (v: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), vision: { model: "v", obs: {}, ...v } });
  const d = vision({});
  assert.ok(d.success);
  assert.equal(d.data.vision.engine, "ollama");
  assert.equal(d.data.vision.temperature, 0.2);
  assert.equal(d.data.vision.num_predict, 60);
  assert.equal(d.data.vision.jpeg_quality, 70);
  assert.match(d.data.vision.prompt, /exactly: SAME/);
  assert.equal(vision({ engine: "" }).data!.vision.engine, "ollama");
  assert.equal(vision({ engine: "stub" }).data!.vision.engine, "stub");
  assert.equal(vision({ engine: "openai" }).success, false);
  assert.equal(vision({ prompt: "  " }).data!.vision.prompt, d.data.vision.prompt, "a blank prompt is the default");
  assert.equal(vision({ prompt: "Say SAME or one line." }).data!.vision.prompt, "Say SAME or one line.");
  for (const bad of [{ temperature: -0.1 }, { temperature: 2.1 }, { num_predict: 0 }, { num_predict: 1.5 }, { jpeg_quality: 0 }, { jpeg_quality: 101 }]) {
    assert.equal(vision(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(vision({ temperature: 0, num_predict: 1, jpeg_quality: 100 }).success, true);
});

// @spec CFG-USR-011
test("the shipped config.example.yaml sends the co-host's voice to the Discord connector's channel, at gain 0, with comments; the channel is set once, under connections.discord", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  assert.match(text, /enabled:\s*\$\{MOUTH_DISCORD_ENABLED:-true\}/);
  assert.match(text, /enabled:\s*\$\{CONNECTIONS_DISCORD_ENABLED:-true\}/);
  const connBlock = text.slice(text.indexOf("\nconnections:"), text.indexOf("\nmouth:"));
  assert.match(connBlock, /guild_id:\s*"\$\{DISCORD_GUILD_ID\}"/);
  assert.match(connBlock, /voice_channel_id:\s*"\$\{DISCORD_VOICE_CHANNEL_ID\}"/);
  const mouthBlock = text.slice(text.indexOf("\nmouth:"));
  assert.doesNotMatch(mouthBlock, /guild_id|voice_channel_id/, "mouth has no channel keys of its own");
  assert.doesNotMatch(text.slice(text.indexOf("\nears:"), text.indexOf("\nconnections:")), /guild_id|voice_channel_id/, "ears has no channel keys of its own");
  assert.match(mouthBlock, /gain_db:\s*0\b[^\n]*#/, "gain_db carries a comment");
  assert.match(mouthBlock, /enabled:[^\n]*#/, "enabled carries a comment");
  assert.match(connBlock, /enabled:[^\n]*#/, "connections.discord.enabled carries a comment");
  const cfg = loadShipped({ DISCORD_GUILD_ID: "g-9", DISCORD_VOICE_CHANNEL_ID: "vc-9" });
  assert.deepEqual(cfg.connections.discord, { enabled: true, guild_id: "g-9", voice_channel_id: "vc-9" });
  assert.equal(cfg.mouth.outputs.discord.enabled, true);
  assert.equal(cfg.mouth.outputs.discord.gain_db, 0);
  assert.deepEqual(earsSources(cfg.ears), ["discord"], "ears.sources defaults to [discord]");
  const iso = loadShipped({ EARS_SOURCES: "[]" });
  assert.deepEqual(earsSources(iso.ears), [], "EARS_SOURCES=[] idles ears");
  assert.deepEqual(earsSources(loadShipped({ EARS_SOURCES: "[http, dir]" }).ears), ["http", "dir"]);
});

// @spec CFG-USR-011
test("the shipped example has no unknown mouth keys: loading it warns about none", () => {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  copyFileSync(join(repo, ".env.example"), join(dir, "..", ".env"));
  const saved = { ...process.env };
  try {
    const warnings = captureWarnings(() => { loadConfig(true); });
    assert.deepEqual(warnings.filter((w) => w.includes("mouth")), []);
  } finally {
    restoreEnv(saved);
  }
});

// @spec CFG-SCH-017
test("voice.fallback.lines defaults to an empty list, accepts duplicates, and rejects blank or over-long entries", () => {
  const with_ = (fallback?: unknown) => ConfigSchema.safeParse({ ...baseCfg(), voice: fallback === undefined ? {} : { fallback } });
  assert.deepEqual(with_().data!.voice.fallback.lines, []);
  assert.deepEqual(with_({}).data!.voice.fallback.lines, []);
  assert.deepEqual(with_({ lines: ["Oops.", "Oops."] }).data!.voice.fallback.lines, ["Oops.", "Oops."]);
  assert.equal(with_({ lines: ["x".repeat(200)] }).success, true);
  assert.equal(with_({ lines: ["x".repeat(201)] }).success, false, "over 200 characters");
  assert.equal(with_({ lines: [""] }).success, false, "empty");
  assert.equal(with_({ lines: ["   \t"] }).success, false, "blank after trimming");
  assert.equal(with_({ lines: ["fine", " "] }).success, false, "one bad entry fails the load");
  assert.equal(with_({ lines: "not a list" }).success, false);
});

// @spec CFG-USR-009
test("the shipped config.example.yaml carries a starter fallback list of at least 12 lines, none naming the persona, with an edit comment, and mouth.fallback.min_interval_ms 20000", () => {
  const cfg = loadShipped();
  const lines = cfg.voice.fallback.lines;
  assert.ok(lines.length >= 12, `${lines.length} starter lines`);
  for (const l of lines) {
    assert.ok(!l.toLowerCase().includes(cfg.cohost.name.toLowerCase()), `names the persona: ${l}`);
    assert.ok(l.length <= 120, `short enough to say in a few seconds: ${l}`);
  }
  assert.ok(lines.some((l) => l === "Error: unable to play line."));
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  assert.match(text, /#[^\n]*[Ee]dit[^\n]*\n\s*lines:/, "a comment telling the owner to edit the list sits above it");
  assert.match(text, /min_interval_ms:\s*20000\b/);
  assert.equal(cfg.mouth.fallback.min_interval_ms, 20000);
  assert.match(text, /mouth:[\s\S]*fallback:\s*\n\s*min_interval_ms:\s*20000\b/);
  // @spec CFG-SCH-018
  const earsBlock = text.match(/^ears:\n((?:[ \t]+.*\n|\n)*)/m)![1]!;
  assert.doesNotMatch(earsBlock, /fallback/, "the ears block carries no fallback key");
  assert.equal("fallback" in cfg.ears, false);
});

// @spec CFG-SCH-028
test("brain.affect republish, short-line cutoff and nudge sizes default to the former constants and validate", () => {
  const a = ConfigSchema.parse(baseCfg()).brain.affect;
  assert.deepEqual(
    [a.republish_ms, a.short_line_chars, a.nudge_sub_valence, a.nudge_sub_arousal, a.nudge_screen_arousal, a.nudge_said_valence, a.nudge_said_arousal],
    [15000, 4, 0.05, 0.05, 0.08, 0.08, 0.05],
  );
  const withAffect = (affect: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { affect } }).success;
  assert.equal(withAffect({ republish_ms: 0 }), false);
  assert.equal(withAffect({ republish_ms: 1.5 }), false);
  assert.equal(withAffect({ republish_ms: 30000 }), true);
  assert.equal(withAffect({ short_line_chars: -1 }), false);
  assert.equal(withAffect({ short_line_chars: 0 }), true);
  for (const key of ["nudge_sub_valence", "nudge_sub_arousal", "nudge_screen_arousal", "nudge_said_valence", "nudge_said_arousal"]) {
    assert.equal(withAffect({ [key]: 1.01 }), false, `${key} above 1`);
    assert.equal(withAffect({ [key]: -0.01 }), false, `${key} below 0`);
    assert.equal(withAffect({ [key]: 0 }), true, `${key} at 0`);
    assert.equal(withAffect({ [key]: 1 }), true, `${key} at 1`);
  }
});

// @spec CFG-SCH-030
test("ears.sources accepts http, dir and a connector tag; ears.http and ears.dir default when absent and are validated", async () => {
  const { ConfigSchema } = await import("../src/schema.js");
  const base = {
    cohost: { name: "Coco", streamer: "Chris" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} },
    chat: { twitch: { channel: "c" } }, brain: {}, voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {},
  };
  const ears = (e: Record<string, unknown>) => ConfigSchema.safeParse({ ...base, ears: { ...e } });
  const dflt = ears({});
  assert.ok(dflt.success);
  assert.deepEqual([earsSources(dflt.data.ears), dflt.data.ears.http, dflt.data.ears.dir], [["discord"], { host: "127.0.0.1", port: 8765, token: "" }, { path: "", poll_ms: 1000 }]);
  for (const sources of [["http"], ["dir"], [], ["discord"], ["http", "desktop"]]) assert.ok(ears({ sources }).success, sources.join());
  assert.equal(ears({ sources: ["Mic"] }).success, false);
  assert.equal(ears({ http: { port: 0 } }).success, true);
  assert.equal(ears({ http: { port: 70000 } }).success, false);
  assert.equal(ears({ dir: { poll_ms: 0 } }).success, false);
});
