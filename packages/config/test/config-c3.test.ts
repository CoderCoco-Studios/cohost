import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig, loadExpressions, savePersonality, loadPersonality, writeFileAtomic, dotEnvPath, missingDotEnv, setConfigLogger } from "../src/index.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const initialEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in initialEnv)) delete process.env[k];
  Object.assign(process.env, initialEnv);
  setConfigLogger(undefined);
});

function sandbox(files: Record<string, string> = {}): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "cohost-c3-"));
  const dir = join(root, "config");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  process.env.CONFIG_DIR = dir;
  process.env.COHOST_ENV_FILE = join(root, ".env");
  return { root, dir };
}

const base = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: { discord: {} }, dashboard: {}, brain: {},
});
const issuesOf = (r: ReturnType<typeof ConfigSchema.safeParse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));

// @spec CFG-SCH-024
test("a blank plain string key with a default takes the default; a blank required key still fails", () => {
  const b = base();
  b.cohost = { name: "a", streamer: "b", timezone: "" } as never;
  (b.vision as Record<string, unknown>).obs = { host: "", source: "" };
  b.voice = { voice: "" } as never;
  b.avatar = { vtube_studio: { host: "h", plugin_name: "", plugin_developer: "" }, vmc: { host: "h" } } as never;
  b.ears = { discord: {}, stt_model: "" } as never;
  b.llm = { model: "m", embed_model: "e", openai: { base_url: "" }, claude: { effort: "" } } as never;
  const c = ConfigSchema.parse(b);
  assert.deepEqual(
    [c.cohost.timezone, c.vision.obs.host, c.vision.obs.source, c.voice.voice, c.avatar.vtube_studio.plugin_name, c.avatar.vtube_studio.plugin_developer, c.ears.stt_model, c.llm.openai.base_url, c.llm.claude.effort],
    ["UTC", "host.docker.internal", "Game Capture", "af_heart", "cohost", "cohost", "Systran/faster-whisper-small", "https://api.openai.com/v1", "low"],
  );
  const bad = base();
  bad.llm = { model: "", embed_model: "" } as never;
  bad.cohost = { name: "", streamer: "" } as never;
  assert.deepEqual(issuesOf(ConfigSchema.safeParse(bad)).sort(), ["cohost.name", "cohost.streamer", "llm.embed_model", "llm.model"]);
});

// @spec CFG-SCH-024
test("the shipped example loads with STT_MODEL unset or empty and lands on the default model", () => {
  const { dir } = sandbox();
  writeFileSync(join(dir, "config.example.yaml"), readFileSync(join(repo, "config", "config.example.yaml"), "utf8"));
  setConfigLogger({ warn: (() => {}) as never });
  for (const v of [undefined, ""]) {
    if (v === undefined) delete process.env.STT_MODEL; else process.env.STT_MODEL = v;
    assert.equal(loadConfig(true).ears.stt_model, "Systran/faster-whisper-small");
  }
});

// @spec CFG-SCH-025
test("vision.model is required only while vision is enabled", () => {
  const off = base();
  off.vision = { enabled: false, obs: {} } as never;
  assert.equal(ConfigSchema.parse(off).vision.model, "");
  const on = base();
  on.vision = { enabled: true, model: "", obs: {} } as never;
  assert.deepEqual(issuesOf(ConfigSchema.safeParse(on)), ["vision.model"]);
  on.vision = { enabled: true, model: "qwen2.5vl:3b", obs: {} } as never;
  assert.equal(ConfigSchema.parse(on).vision.model, "qwen2.5vl:3b");
});

// @spec CFG-SCH-027
test("@cohost/modules re-exports ModuleConfig from the config package instead of deriving it", () => {
  const src = readFileSync(join(repo, "packages", "modules", "src", "index.ts"), "utf8");
  assert.doesNotMatch(src, /export type ModuleConfig\s*=/);
  assert.match(src, /export type \{[^}]*\bModuleConfig\b[^}]*\} from "@cohost\/config"/);
  const schema = readFileSync(join(repo, "packages", "config", "src", "schema.ts"), "utf8");
  assert.match(schema, /export type ModuleConfig = z\.infer<typeof ModuleSchema>/);
});

// @spec CFG-ENV-010
test("dotEnvPath is .env at the workspace root whatever CONFIG_DIR says, COHOST_ENV_FILE wins, and the container probe is replaceable", () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-c3-ws-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const prevCwd = process.cwd();
  try {
    process.chdir(root);
    delete process.env.COHOST_ENV_FILE;
    process.env.CONFIG_DIR = join(tmpdir(), "elsewhere", "deep", "conf");
    assert.equal(dotEnvPath(), join(process.cwd(), ".env"));
    process.env.COHOST_ENV_FILE = "/explicit/.env";
    assert.equal(dotEnvPath(), "/explicit/.env");
    delete process.env.COHOST_ENV_FILE;
    assert.equal(missingDotEnv(() => false), true);
    assert.equal(missingDotEnv(() => true), false); // a container is exempt
    writeFileSync(join(root, ".env"), "X=1\n");
    assert.equal(missingDotEnv(() => false), false);
  } finally { process.chdir(prevCwd); }
});

// @spec CFG-ENV-010
test("with no workspace root the .env sits in the parent of the config directory", () => {
  const lone = mkdtempSync(join(tmpdir(), "cohost-c3-lone-"));
  const prevCwd = process.cwd();
  try {
    process.chdir(lone);
    delete process.env.COHOST_ENV_FILE;
    process.env.CONFIG_DIR = join(lone, "somewhere", "config");
    assert.equal(dotEnvPath(), join(lone, "somewhere", ".env"));
  } finally { process.chdir(prevCwd); }
});

// @spec CFG-LOG-001, CFG-LOAD-005, CFG-DIR-003
test("loader diagnostics go to the injected logger, never console", () => {
  const seen: string[] = [];
  const origWarn = console.warn;
  console.warn = () => { seen.push("CONSOLE"); };
  setConfigLogger({ warn: ((...a: unknown[]) => { seen.push(a.map(String).join(" ")); }) as never });
  try {
    const { dir } = sandbox();
    writeFileSync(join(dir, "config.example.yaml"), readFileSync(join(repo, "config", "config.example.yaml"), "utf8").replace("dashboard:", "bogus_key: 1\ndashboard:"));
    loadConfig(true); // seeds config.yaml from the example (notice) and warns about bogus_key
  } finally { console.warn = origWarn; }
  assert.equal(seen.filter((s) => s === "CONSOLE").length, 0);
  assert.ok(seen.some((s) => /created .*config\.yaml from config\.example\.yaml/.test(s)));
  assert.ok(seen.some((s) => /ignoring unknown keys: bogus_key/.test(s)));
});

// @spec CFG-USR-002
test("loadExpressions reports a bad file the way loadConfig does and re-reads on every call", () => {
  const { dir } = sandbox({ "expressions.yaml": "vts:\n  happy: 3\n" });
  assert.throws(() => loadExpressions(), (e: Error) => e.message.startsWith(`Invalid ${join(dir, "expressions.yaml")}:`) && /vts\.happy: /.test(e.message));
  writeFileSync(join(dir, "expressions.yaml"), "vts:\n  happy: smile\n");
  assert.equal(loadExpressions().vts!.happy, "smile");
  writeFileSync(join(dir, "expressions.yaml"), "vts:\n  happy: grin\n");
  assert.equal(loadExpressions().vts!.happy, "grin");
});

// @spec CFG-USR-013
test("writeFileAtomic replaces through a temp file and a failed write leaves the old file whole", () => {
  const { dir } = sandbox({ "personality.md": "old\n" });
  savePersonality("new\n");
  assert.equal(loadPersonality(), "new\n");
  assert.deepEqual(readdirSync(dir).sort(), ["personality.md"]); // no temp file left behind
  // rename over a directory fails: the target must be untouched and the temp removed
  const blocked = join(dir, "blocked");
  mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, "x"));
  assert.ok(existsSync(blocked));
  assert.deepEqual(readdirSync(dir).sort(), ["blocked", "personality.md"]);
  assert.equal(readFileSync(join(dir, "personality.md"), "utf8"), "new\n");
});

// @spec CFG-USR-012
test(".env.example lists the isolation presets, control settings, injection limits, compose profiles and Discord/mouth variables", () => {
  const text = readFileSync(join(repo, ".env.example"), "utf8");
  const names = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
  const want = ["LLM_PROVIDER", "MEMORY_STORE", "MEMORY_EMBEDDER", "VOICE_ENGINE", "CHAT_SOURCE", "VISION_ENABLED", "EARS_SOURCE", "MOUTH_DISCORD_ENABLED",
    "CONTROL_ENABLED", "CONTROL_TOKEN", "CONTROL_BIND", "CONTROL_ADVANCED", "COMPOSE_PROFILES", "INJECT_MAX_IMAGE_BYTES", "INJECT_MAX_AUDIO_BYTES", "INJECT_TTL_MS", "DISCORD_TOKEN", "DISCORD_GUILD_ID", "DISCORD_VOICE_CHANNEL_ID", "CONNECTIONS_DISCORD_ENABLED"];
  const example = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  for (const m of example.matchAll(/\$\{(MOUTH_[A-Z0-9_]+)/g)) want.push(m[1]!);
  assert.deepEqual(want.filter((n) => !names.has(n)), []);
  assert.ok(!names.has("EARS_DISCORD_TOKEN"), "the legacy listen-only bot token is gone (DEPLOY-README-004)");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^STT_MODEL=/.test(l));
  const heading = lines.slice(0, at).reverse().find((l) => /^# ---/.test(l))!;
  assert.doesNotMatch(heading, /ollama/i);
});
