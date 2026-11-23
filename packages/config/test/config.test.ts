import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFromExample, loadConfig, loadDotEnv, configDir, findWorkspaceRoot, loadExpressions, loadPersonality, savePersonality, env, envOr, urls, EMOTIONS, dataDir, setConfigLogger, earsSources, createLogger, parseConfigText, ExpressionMapSchema, Emotion } from "../src/index.js";

/** Every test starts from the environment the file started with; sandbox() and loaders mutate CONFIG_DIR, COHOST_ENV_FILE and .env values. */
const initialEnv = { ...process.env };
function restoreEnv(to: NodeJS.ProcessEnv = initialEnv): void {
  for (const k of Object.keys(process.env)) if (!(k in to)) delete process.env[k];
  Object.assign(process.env, to);
}
afterEach(() => { restoreEnv(); setConfigLogger(undefined); });

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
  const reflexes = ConfigSchema.shape.brain.shape.salience.def.innerType.shape.reflexes;
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
vision: { model: v, obs: { port: } }
chat: { twitch: { channel: somechan } }
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

// @spec CFG-LOAD-001, CFG-LOAD-002, CFG-SCH-005
test("loadConfig: empty numbers fall back to defaults, no environment variable changes a value, results are cached", () => {
  sandbox({ "config.yaml": minimalYaml });
  process.env.T_CHANNEL = "from-env";
  const cfg = loadConfig(true);
  assert.equal(cfg.vision.obs.port, 4455); // `port: ` (null) → schema default, not a validation error
  assert.equal(cfg.chat.twitch.channel, "somechan");
  assert.equal(cfg.brain.salience.cooldown_ms, 6000);
  assert.equal(loadConfig(), cfg);
});

// @spec CFG-LOAD-003, CFG-SCH-001, CFG-SCH-006
test("loadConfig: an invalid file names every bad path", () => {
  sandbox({ "config.yaml": minimalYaml.replace("name: Coco", "name: ''").replace("voice: {}", "voice: { speed: -1 }") });
  assert.throws(() => loadConfig(true), (e: Error) => /cohost\.name:/.test(e.message) && /voice\.speed:/.test(e.message));
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
test("urls has no dashboard(): uploads travel over Redis, so no service needs the dashboard's address", () => {
  assert.equal("dashboard" in urls, false);
});

function loadShipped() {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  copyFileSync(join(repo, ".env.example"), join(dir, "..", ".env"));
  let cfg!: ReturnType<typeof loadConfig>;
  captureWarnings(() => { cfg = loadConfig(true); });
  return cfg;
}

// @spec CFG-ISO-001, CFG-ISO-003
test("new keys default to live backends when omitted; bad enum values are rejected", () => {
  const base = { cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } }, ears: {}, dashboard: {}, brain: {} };
  const ok = ConfigSchema.parse(base);
  assert.deepEqual([ok.voice.engine, ok.brain.memory.store, ok.brain.memory.embedder, ok.chat.sources, earsSources(ok.ears), ok.mouth.outputs.discord.enabled],
    ["kokoro", "postgres", "ollama", ["twitch"], ["discord"], true]);
  const bad = ConfigSchema.safeParse({ ...base, chat: { sources: ["irc"], twitch: {} } });
  assert.equal(bad.success, false);
  assert.ok(!bad.success && bad.error.issues.some((i) => i.path.join(".").startsWith("chat.sources")));
  assert.equal(ConfigSchema.safeParse({ ...base, ears: { sources: ["X"] } }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...base, voice: { engine: "x" } }).success, false);
});

/** Loads the shipped example through the real loader with no .env file, no secrets.yaml and no override. */
function loadShippedBare() {
  const dir = sandbox();
  copyFileSync(join(repo, "config", "config.example.yaml"), join(dir, "config.example.yaml"));
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  return { cfg, warnings };
}

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
test("the shipped example configures the capture hook on its own small ollama model as a literal, and .env.example holds no model name", () => {
  const { cfg } = loadShippedBare();
  const c = cfg.brain.memory.notes.capture;
  assert.equal(c.kind, "llm");
  assert.equal(c.llm.provider, "ollama");
  assert.equal(c.llm.model, "gemma3:4b");
  assert.equal(c.timeout_ms, 20000);
  assert.notEqual(c.llm.model, cfg.llm.model, "its own model slot, not the cortex's");
  assert.match(readFileSync(join(repo, "config", "config.example.yaml"), "utf8"), /^\s+model: "gemma3:4b"/m, "a literal in the file");
  assert.doesNotMatch(readFileSync(join(repo, ".env.example"), "utf8"), /NOTES_MODEL/);
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
test("vision.provider defaults to ollama (blank too), accepts the five providers, rejects others; the describer tuning keys default and validate", () => {
  const vision = (v: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), vision: { model: "v", obs: {}, ...v } });
  const d = vision({});
  assert.ok(d.success);
  assert.equal(d.data.vision.provider, "ollama");
  assert.equal(d.data.vision.temperature, 0.2);
  assert.equal(d.data.vision.num_predict, 60);
  assert.equal(d.data.vision.jpeg_quality, 70);
  assert.match(d.data.vision.prompt, /exactly: SAME/);
  assert.equal(vision({ provider: "" }).data!.vision.provider, "ollama");
  assert.equal(vision({ provider: "stub" }).data!.vision.provider, "stub");
  assert.equal(vision({ provider: "bedrock" }).data!.vision.provider, "bedrock");
  assert.equal(vision({ provider: "gemini" }).success, false);
  assert.equal(vision({ prompt: "  " }).data!.vision.prompt, d.data.vision.prompt, "a blank prompt is the default");
  assert.equal(vision({ prompt: "Say SAME or one line." }).data!.vision.prompt, "Say SAME or one line.");
  for (const bad of [{ temperature: -0.1 }, { temperature: 2.1 }, { num_predict: 0 }, { num_predict: 1.5 }, { jpeg_quality: 0 }, { jpeg_quality: 101 }]) {
    assert.equal(vision(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(vision({ temperature: 0, num_predict: 1, jpeg_quality: 100 }).success, true);
});

// @spec CFG-USR-011
test("the shipped config.example.yaml sends the co-host's voice to the Discord connector's channel, at gain 0, with literals and comments; the channel is set once, under connections.discord", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const connBlock = text.slice(text.indexOf("\nconnections:"), text.indexOf("\nmouth:"));
  assert.match(connBlock, /^\s+enabled: true\s+#/m, "connections.discord.enabled: true, with a comment");
  assert.match(connBlock, /guild_id: ""\s*#/);
  assert.match(connBlock, /voice_channel_id: ""\s*#/);
  const mouthBlock = text.slice(text.indexOf("\nmouth:"));
  assert.doesNotMatch(mouthBlock, /guild_id|voice_channel_id/, "mouth has no channel keys of its own");
  assert.doesNotMatch(text.slice(text.indexOf("\nears:"), text.indexOf("\nconnections:")), /guild_id|voice_channel_id/, "ears has no channel keys of its own");
  assert.match(mouthBlock, /discord:[^\n]*\n\s+enabled: true\s+#/, "mouth.outputs.discord.enabled: true, with a comment");
  assert.match(mouthBlock, /gain_db: 0\s+#/, "gain_db carries a comment");
  assert.match(text, /^\s+sources: \[discord\]\s+#/m, "ears.sources in flow syntax, with a comment");
  assert.match(text, /^\s+# .*\[\]/m, "a comment shows [] for idle");
  const cfg = loadShipped();
  assert.deepEqual(cfg.connections.discord, { enabled: true, guild_id: "", voice_channel_id: "", token: "" });
  assert.equal(cfg.mouth.outputs.discord.enabled, true);
  assert.equal(cfg.mouth.outputs.discord.gain_db, 0);
  assert.deepEqual(earsSources(cfg.ears), ["discord"], "ears.sources is [discord]");
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
  // CFG-SCH-018: no `fallback` key (the spoken fallback lives under voice). CFG-SCH-063 adds `stt_fallback_engine`, a different key.
  assert.doesNotMatch(earsBlock, /^ {2}fallback:/m, "the ears block carries no fallback key");
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

// @spec CFG-SCH-010, CFG-SCH-037
test("vision.obs, avatar.vtube_studio and avatar.vmc are required objects whose hosts and ports default; chat.twitch is optional", () => {
  assert.equal(ConfigSchema.safeParse(baseCfg()).success, true);
  const without = (mutate: (c: ReturnType<typeof baseCfg>) => void) => { const c = baseCfg(); mutate(c); return ConfigSchema.safeParse(c).success; };
  assert.equal(without((c) => { delete (c.vision as Record<string, unknown>).obs; }), false, "vision.obs");
  assert.equal(without((c) => { delete (c.chat as Record<string, unknown>).twitch; }), true, "chat.twitch is optional (CFG-SCH-054)");
  assert.equal(without((c) => { delete (c.avatar as Record<string, unknown>).vtube_studio; }), false, "avatar.vtube_studio");
  assert.equal(without((c) => { delete (c.avatar as Record<string, unknown>).vmc; }), false, "avatar.vmc");
  const c = ConfigSchema.parse({ ...baseCfg(), avatar: { vtube_studio: {}, vmc: {} } });
  assert.deepEqual([c.avatar.vtube_studio.host, c.avatar.vtube_studio.port, c.avatar.vmc.host, c.avatar.vmc.port], ["host.docker.internal", 8001, "host.docker.internal", 39539]);
  assert.equal(c.vision.obs.port, 4455);
  const blank = ConfigSchema.parse({ ...baseCfg(), avatar: { vtube_studio: { host: "" }, vmc: { host: "" } } });
  assert.deepEqual([blank.avatar.vtube_studio.host, blank.avatar.vmc.host], ["host.docker.internal", "host.docker.internal"], "an empty host means the default");
  assert.equal(ConfigSchema.parse({ ...baseCfg(), avatar: { vtube_studio: { host: "10.0.0.2", port: 9 }, vmc: { host: "h", port: 1 } } }).avatar.vtube_studio.host, "10.0.0.2");
});

// @spec CFG-SCH-038, CFG-SCH-100
test("dashboard.port and lan_port are ports 1 to 65535 defaulting to 3000 and 3001, inject limits default, and equal ports fail on dashboard.lan_port", () => {
  const dash = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), dashboard: v });
  assert.deepEqual(dash({}).data!.dashboard, { port: 3000, lan_port: 3001, allowed_hosts: [], inject: { max_image_bytes: 8388608, max_audio_bytes: 26214400, ttl_ms: 300000 }, models: { max_bytes: 104857600 } });
  assert.deepEqual(dash({ inject: {} }).data!.dashboard.inject, { max_image_bytes: 8388608, max_audio_bytes: 26214400, ttl_ms: 300000 });
  assert.deepEqual(dash({ port: 8080, lan_port: 8081, inject: { ttl_ms: 1000 } }).data!.dashboard, { port: 8080, lan_port: 8081, allowed_hosts: [], inject: { max_image_bytes: 8388608, max_audio_bytes: 26214400, ttl_ms: 1000 }, models: { max_bytes: 104857600 } });
  for (const [k, v] of [["port", 0], ["port", 65536], ["port", 1.5], ["lan_port", 0], ["lan_port", 70000]] as const) {
    const r = dash({ [k]: v });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === `dashboard.${k}`), `${k}=${v}`);
  }
  for (const k of ["max_image_bytes", "max_audio_bytes", "ttl_ms"]) {
    for (const v of [0, -1, 1.5]) {
      const r = dash({ inject: { [k]: v } });
      assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === `dashboard.inject.${k}`), `${k}=${v}`);
    }
  }
  const same = dash({ port: 4000, lan_port: 4000 });
  assert.ok(!same.success);
  assert.deepEqual(same.error.issues.map((i) => i.path.join(".")), ["dashboard.lan_port"]);
  assert.match(same.error.issues[0]!.message, /differ/);
  assert.equal(dash({ port: 3001 }).success, false, "port equal to the default lan_port");
  assert.equal(dash({ port: 3001, lan_port: 3000 }).success, true);
});

// @spec CFG-URL-004
test("createLogger returns a pino logger named for the service at LOG_LEVEL, info by default and when blank", () => {
  delete process.env.LOG_LEVEL;
  const def = createLogger("svc-a");
  assert.equal(def.bindings().name, "svc-a");
  assert.equal(def.level, "info");
  process.env.LOG_LEVEL = "debug";
  assert.equal(createLogger("svc-b").level, "debug");
  assert.equal(createLogger("svc-b").bindings().name, "svc-b");
  process.env.LOG_LEVEL = "";
  assert.equal(createLogger("svc-c").level, "info");
});

// @spec CFG-ISO-002
test("a backend-selection value that is blank takes the live default", () => {
  const blanks = (v: unknown) => ConfigSchema.parse({
    ...baseCfg(),
    llm: { model: "m", embed_model: "e", provider: v },
    chat: { source: v, twitch: {} },
    voice: { engine: v },
    brain: { memory: { store: v, embedder: v } },
  });
  for (const v of ["", null, undefined]) {
    const c = blanks(v);
    assert.deepEqual([c.llm.provider, c.chat.sources, c.voice.engine, c.brain.memory.store, c.brain.memory.embedder], ["ollama", ["twitch"], "kokoro", "postgres", "ollama"], String(v));
  }
  // a key written as an empty string in the file is the same case
  const text = [
    "cohost: { name: a, streamer: b }",
    "llm:", "  provider: ''", "  model: m", "  embed_model: e",
    "vision: { model: v, obs: {} }",
    "chat:", "  source: ''", "  twitch: {}",
    "voice: { engine: '' }",
    "avatar: { vtube_studio: {}, vmc: {} }",
    "ears: {}", "dashboard: {}",
    "brain: { memory: { store: '', embedder: '' } }",
  ].join("\n");
  const parsed = parseConfigText(text);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.issues));
  const c = parsed.config;
  assert.deepEqual([c.llm.provider, c.chat.sources, c.voice.engine, c.brain.memory.store, c.brain.memory.embedder], ["ollama", ["twitch"], "kokoro", "postgres", "ollama"]);
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), chat: { sources: ["bogus"], twitch: {} } }).success, false, "a non-blank unknown value still fails");
});

// @spec CFG-SCH-002
test("llm: provider values and a blank provider, and the num_ctx, temperature, max_tokens and claude defaults and limits", () => {
  const llm = (over: Record<string, unknown> = {}) => ({ ...baseCfg(), llm: { model: "m", embed_model: "e", ...over } });
  for (const p of ["ollama", "openai", "anthropic", "bedrock", "mock"]) assert.equal(ConfigSchema.parse(llm({ provider: p })).llm.provider, p);
  assert.equal(ConfigSchema.safeParse(llm({ provider: "gemini" })).success, false);
  assert.equal(ConfigSchema.parse(llm({ provider: "" })).llm.provider, "ollama");
  const d = ConfigSchema.parse(llm()).llm;
  assert.equal(d.provider, "ollama");
  assert.equal(d.num_ctx, 8192);
  assert.equal(d.temperature, 0.9);
  assert.equal(d.max_tokens, 120);
  assert.deepEqual(d.claude, { api_key: "", effort: "low", max_tokens: 2048, fallbacks: true });
  assert.equal(d.openai.base_url, "https://api.openai.com/v1");
  assert.equal(ConfigSchema.parse(llm({ openai: { base_url: "" } })).llm.openai.base_url, "https://api.openai.com/v1");
  const ok = (over: Record<string, unknown>) => ConfigSchema.safeParse(llm(over)).success;
  assert.equal(ok({ temperature: 0 }), true);
  assert.equal(ok({ temperature: 2 }), true);
  assert.equal(ok({ temperature: -0.1 }), false);
  assert.equal(ok({ temperature: 2.1 }), false);
  assert.equal(ok({ num_ctx: 0 }), false);
  assert.equal(ok({ claude: { max_tokens: 255 } }), false);
  assert.equal(ok({ claude: { max_tokens: 256 } }), true);
  for (const e of ["low", "medium", "high", "xhigh", "max"]) assert.equal(ConfigSchema.parse(llm({ claude: { effort: e } })).llm.claude.effort, e);
  assert.equal(ConfigSchema.parse(llm({ claude: { effort: "" } })).llm.claude.effort, "low");
  assert.equal(ok({ claude: { effort: "ultra" } }), false);
  assert.equal(ConfigSchema.parse(llm({ claude: { fallbacks: false } })).llm.claude.fallbacks, false);
});

// @spec CFG-SCH-007
test("the nine canonical emotions are the Emotion enum and EMOTIONS; an expression map takes per-driver emotion strings and a gestures map defaulting to empty", () => {
  assert.deepEqual([...EMOTIONS], ["neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think"]);
  assert.deepEqual(Emotion.options, EMOTIONS);
  const m = ExpressionMapSchema.parse({ vmc: { happy: "Joy" }, "vtube-studio": { sad: "Cry", gestures: { wave: "WAVE" } } });
  assert.deepEqual(m.vmc, { happy: "Joy", gestures: {} });
  assert.deepEqual(m["vtube-studio"], { sad: "Cry", gestures: { wave: "WAVE" } });
  assert.equal(ExpressionMapSchema.safeParse({ vmc: { happy: 3 } }).success, false, "entries are strings");
  assert.equal(ExpressionMapSchema.safeParse({ vmc: { gestures: { wave: 1 } } }).success, false, "gestures is a string map");
});

// @spec CFG-SCH-008
test("ConfigSchema defaults: timezone, OBS, twitch channel, ignore_users, idle_motion, VTube Studio plugin identity and the empty API keys and region", () => {
  const c = ConfigSchema.parse(baseCfg());
  assert.equal(c.cohost.timezone, "UTC");
  assert.deepEqual(c.vision.obs, { host: "host.docker.internal", port: 4455, password: "", source: "Game Capture", width: 896 });
  assert.equal(c.chat.twitch.channel, "");
  assert.deepEqual(c.chat.ignore_users, []);
  assert.equal(c.avatar.idle_motion, true);
  assert.equal(c.avatar.vtube_studio.plugin_name, "cohost");
  assert.equal(c.avatar.vtube_studio.plugin_developer, "cohost");
  assert.equal(c.llm.openai.api_key, "");
  assert.equal(c.llm.claude.api_key, "");
  assert.equal(c.llm.bedrock.region, "");
  const blank = ConfigSchema.parse({ ...baseCfg(), cohost: { name: "a", streamer: "b", timezone: "" }, vision: { model: "v", obs: { host: "", source: "" } } });
  assert.equal(blank.cohost.timezone, "UTC", "a blank timezone takes the default");
  assert.equal(blank.vision.obs.host, "host.docker.internal");
  assert.equal(blank.vision.obs.source, "Game Capture");
});

// @spec CFG-SCH-041
test("dashboard.allowed_hosts is a list of host names, empty by default; a scheme, port, path, space or empty entry fails the load naming the entry", () => {
  const dash = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), dashboard: v });
  assert.deepEqual(dash({}).data!.dashboard.allowed_hosts, []);
  assert.deepEqual(dash({ allowed_hosts: ["streampc", "Stream-PC.local", "streampc."] }).data!.dashboard.allowed_hosts, ["streampc", "Stream-PC.local", "streampc."]);
  for (const bad of ["http://streampc", "streampc:3001", "streampc/x", "stream pc", "", "*.lan", "192.168.1.5:3001"]) {
    const r = dash({ allowed_hosts: [bad] });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === "dashboard.allowed_hosts.0"), JSON.stringify(bad));
  }
  assert.ok(!dash({ allowed_hosts: "streampc" }).success, "a string is not a list");
});

/** The dotted paths of the issues a parse reports. */
const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] => (r.error?.issues ?? []).map((i) => i.path.join("."));

// @spec CFG-SCH-042
test("viewer_text is optional: absent, empty or partly set it defaults max_chars to 500 and max_name_chars to 40", () => {
  assert.deepEqual(ConfigSchema.parse(baseCfg()).viewer_text, { max_chars: 500, max_name_chars: 40 });
  assert.deepEqual(ConfigSchema.parse({ ...baseCfg(), viewer_text: {} }).viewer_text, { max_chars: 500, max_name_chars: 40 });
  assert.deepEqual(ConfigSchema.parse({ ...baseCfg(), viewer_text: { max_chars: 200 } }).viewer_text, { max_chars: 200, max_name_chars: 40 });
  assert.deepEqual(ConfigSchema.parse({ ...baseCfg(), viewer_text: { max_name_chars: 25 } }).viewer_text, { max_chars: 500, max_name_chars: 25 });
});

// @spec CFG-SCH-043
test("viewer_text.max_chars is an integer of at least 16 and max_name_chars of at least 8; the loader names the key of a smaller value", () => {
  const vt = (v: unknown) => ConfigSchema.safeParse({ ...baseCfg(), viewer_text: v });
  assert.equal(vt({ max_chars: 16, max_name_chars: 8 }).success, true);
  assert.deepEqual(issuePaths(vt({ max_chars: 15 })), ["viewer_text.max_chars"]);
  assert.deepEqual(issuePaths(vt({ max_name_chars: 7 })), ["viewer_text.max_name_chars"]);
  assert.deepEqual(issuePaths(vt({ max_chars: 100.5 })), ["viewer_text.max_chars"]);
  assert.deepEqual(issuePaths(vt({ max_name_chars: 8.5 })), ["viewer_text.max_name_chars"]);
  sandbox({ "config.yaml": `${minimalYaml}viewer_text: { max_chars: 15 }\n` });
  assert.throws(() => loadConfig(true), /viewer_text\.max_chars:/);
  sandbox({ "config.yaml": `${minimalYaml}viewer_text: { max_name_chars: 7 }\n` });
  assert.throws(() => loadConfig(true), /viewer_text\.max_name_chars:/);
});

// @spec CFG-SCH-044
test("brain.input_limits defaults speech_max_chars to 1000 and vision_max_chars to 500, and rejects a value under 16 naming the key", () => {
  const brain = (b: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: b });
  assert.deepEqual(ConfigSchema.parse(baseCfg()).brain.input_limits, { speech_max_chars: 1000, vision_max_chars: 500 });
  assert.deepEqual(brain({ input_limits: {} }).data!.brain.input_limits, { speech_max_chars: 1000, vision_max_chars: 500 });
  assert.deepEqual(brain({ input_limits: { vision_max_chars: 16 } }).data!.brain.input_limits, { speech_max_chars: 1000, vision_max_chars: 16 });
  for (const k of ["speech_max_chars", "vision_max_chars"]) {
    assert.equal(brain({ input_limits: { [k]: 16 } }).success, true, `${k} at 16`);
    for (const v of [15, 0, 20.5]) assert.deepEqual(issuePaths(brain({ input_limits: { [k]: v } })), [`brain.input_limits.${k}`], `${k}=${v}`);
  }
  sandbox({ "config.yaml": minimalYaml.replace("brain: {}", "brain: { input_limits: { speech_max_chars: 15 } }") });
  assert.throws(() => loadConfig(true), /brain\.input_limits\.speech_max_chars:/);
  sandbox({ "config.yaml": minimalYaml.replace("brain: {}", "brain: { input_limits: { vision_max_chars: 15 } }") });
  assert.throws(() => loadConfig(true), /brain\.input_limits\.vision_max_chars:/);
});

// @spec CFG-SCH-045
test("brain.working_memory_own_lines defaults to 4, is an integer of at least 1, and must be less than working_memory_events, failing on its own key", () => {
  const brain = (b: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: b });
  assert.equal(ConfigSchema.parse(baseCfg()).brain.working_memory_own_lines, 4);
  assert.equal(brain({ working_memory_own_lines: 1 }).success, true);
  assert.equal(brain({ working_memory_own_lines: 23 }).success, true); // one less than the default 24 events
  for (const v of [0, -1, 2.5]) assert.deepEqual(issuePaths(brain({ working_memory_own_lines: v })), ["brain.working_memory_own_lines"], `own_lines=${v}`);
  // The cross-field rule: equal or greater fails, and the issue is on the key, not on `brain`.
  for (const b of [{ working_memory_own_lines: 24 }, { working_memory_own_lines: 30 }, { working_memory_events: 8, working_memory_own_lines: 8 }, { working_memory_events: 4 }]) {
    const r = brain(b);
    assert.deepEqual(issuePaths(r), ["brain.working_memory_own_lines"], JSON.stringify(b));
    assert.match(r.error!.issues[0]!.message, /less than brain\.working_memory_events/);
  }
  assert.equal(brain({ working_memory_events: 5 }).success, true); // the default 4 own lines fit under 5
  assert.equal(brain({ working_memory_events: 3, working_memory_own_lines: 2 }).success, true);
  sandbox({ "config.yaml": minimalYaml.replace("brain: {}", "brain: { working_memory_events: 6, working_memory_own_lines: 6 }") });
  assert.throws(() => loadConfig(true), /brain\.working_memory_own_lines:/);
});

// @spec CFG-SCH-046
test("brain.cortex.repeat_similarity defaults to 0.8 and is a number from 0 to 1 inclusive; 0 (the check off) is accepted", () => {
  const cortex = (c: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { cortex: c } });
  assert.equal(ConfigSchema.parse(baseCfg()).brain.cortex.repeat_similarity, 0.8);
  assert.equal(cortex({ repeat_similarity: 0 }).data!.brain.cortex.repeat_similarity, 0);
  assert.equal(cortex({ repeat_similarity: 1 }).success, true);
  assert.equal(cortex({ repeat_similarity: 0.35 }).success, true);
  for (const v of [-0.1, 1.1]) assert.deepEqual(issuePaths(cortex({ repeat_similarity: v })), ["brain.cortex.repeat_similarity"], `repeat_similarity=${v}`);
});

// @spec CFG-SCH-047
test("brain.affect.count_window_ms defaults to 30000 and is a positive integer", () => {
  const affect = (a: unknown) => ConfigSchema.safeParse({ ...baseCfg(), brain: { affect: a } });
  assert.equal(ConfigSchema.parse(baseCfg()).brain.affect.count_window_ms, 30000);
  assert.equal(affect({ count_window_ms: 1 }).success, true);
  for (const v of [0, -5, 1.5]) assert.deepEqual(issuePaths(affect({ count_window_ms: v })), ["brain.affect.count_window_ms"], `count_window_ms=${v}`);
});
