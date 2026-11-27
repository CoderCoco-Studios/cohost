import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, writeFileAtomic, SECRET_PATHS, ConfigSchema, sectionJsonSchema, earsListenerVerifier, type Config } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, captureWarnings, loadSettings } from "./helpers/config-sandbox.js";

isolateEnv();

const mode = (f: string): number => statSync(f).mode & 0o777;
// The sixteen wildcard-free paths of CFG-SEC-003; `tools.servers.*.token` (CFG-SEC-016) is the seventeenth entry of SECRET_PATHS.
const SIXTEEN = [
  "llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "vision.obs.password",
  "ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key", "voice.openai.api_key", "voice.pocket.hf_token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token", "chat.youtube.api_key", "connections.discord.token",
];
const getPath = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

// @spec CFG-SEC-003, CFG-SCH-039
test("SECRET_PATHS lists exactly the sixteen wildcard-free credentials and tools.servers.*.token, and each wildcard-free one defaults to the empty string", () => {
  assert.deepEqual([...SECRET_PATHS].toSorted(), [...SIXTEEN, "tools.servers.*.token"].toSorted());
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
  });
  for (const p of SIXTEEN) assert.equal(getPath(cfg, p), "", p);
});

// @spec CFG-SEC-002, CFG-LOAD-001
test("loadConfig sets each delivered non-empty string at its secret path; an empty one and one not delivered stay empty", () => {
  const cfg = loadSettings(MINIMAL_YAML, {
    credentials: {
      "llm.openai.api_key": "sk-openai", "llm.bedrock.access_key_id": "AKIA1", "vision.obs.password": "obs-pw", "chat.twitch.client_id": "cid",
      "chat.twitch.client_secret": "", "connections.discord.token": "disc-tok",
    },
  });
  assert.equal(cfg.llm.openai.api_key, "sk-openai");
  assert.equal(cfg.llm.bedrock.access_key_id, "AKIA1");
  assert.equal(cfg.vision.obs.password, "obs-pw");
  assert.equal(cfg.chat.twitch.client_id, "cid");
  assert.equal(cfg.chat.twitch.client_secret, "");
  assert.equal(cfg.connections.discord.token, "disc-tok");
  assert.equal(cfg.llm.claude.api_key, "");
});

// @spec STORE-PROJ-002
test("writeFileAtomic takes a mode for the temporary file it creates", () => {
  const dir = sandbox({});
  const f = join(dir, "x.json");
  const prevUmask = process.umask(0);
  try {
    writeFileAtomic(f, "{}\n", { mode: 0o600 });
    assert.equal(mode(f), 0o600);
    writeFileAtomic(join(dir, "y.json"), "{}\n");
    assert.equal(mode(join(dir, "y.json")), 0o666, "no mode given: the process default applies");
  } finally { process.umask(prevUmask); }
});

// @spec CFG-SEC-010
test("no warning or error of the loader contains a credential value", () => {
  const credentials = { "llm.openai.api_key": "sk-LEAKME", "unknown_top.key": "sk-LEAKME2", "tools.servers.gone.token": "sk-LEAKME3", "ears.http.verifier": "sk-LEAKME4" };
  let err = "";
  const warnings = captureWarnings(() => {
    try { loadSettings(MINIMAL_YAML.replace("name: Coco", "name: ''"), { credentials }); } catch (e) { err = (e as Error).message; }
    loadSettings(MINIMAL_YAML, { credentials });
  });
  assert.match(err, /cohost\.name/);
  assert.ok(warnings.length >= 3, warnings.join(" | "));
  assert.doesNotMatch(`${err}\n${warnings.join("\n")}`, /LEAKME/);
});

// @spec CFG-SEC-002
test("loadDotEnv still works beside credentials: a credential-looking variable in .env reaches no config key", () => {
  const dir = sandbox({ ".env": "LLM_API_KEY=from-env\nANTHROPIC_API_KEY=from-env\nDISCORD_TOKEN=from-env\nOBS_PASSWORD=from-env\nTWITCH_CLIENT_ID=from-env\n" });
  loadDotEnv(join(dir, "..", ".env"));
  const cfg = loadSettings(MINIMAL_YAML);
  for (const p of SIXTEEN) assert.equal(getPath(cfg, p), "", p);
});

// @spec CFG-SEC-003, CFG-SCH-049
test("chat.youtube.api_key is a secret path (owned by CFG-SEC-003): listed, defaulting to empty, set from the delivery and marked in the editor schema", () => {
  assert.ok((SECRET_PATHS as readonly string[]).includes("chat.youtube.api_key"));
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: {},
    voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
  });
  assert.equal(getPath(cfg, "chat.youtube.api_key"), "");
  assert.equal(loadSettings(MINIMAL_YAML, { credentials: { "chat.youtube.api_key": "yt-key" } }).chat.youtube.api_key, "yt-key");
  assert.equal((sectionJsonSchema("chat") as any).properties.youtube.properties.api_key["x-secret"], true);
});

const TOOLS_YAML = `${MINIMAL_YAML}tools:\n  servers:\n    weather:\n      url: "http://h:1/mcp"\n    search:\n      url: "http://h:2/mcp"\n`;

// @spec CFG-SEC-016, CFG-SCH-087
test("tools.servers.*.token matches one key of the stored map: each configured server gets its own token, others stay empty", () => {
  let cfg!: Config;
  const warnings = captureWarnings(() => { cfg = loadSettings(TOOLS_YAML, { credentials: { "tools.servers.weather.token": "tok-weather" } }); });
  assert.deepEqual(warnings, []);
  assert.equal(cfg.tools.servers.weather!.token, "tok-weather");
  assert.equal(cfg.tools.servers.search!.token, "");
  cfg = loadSettings(TOOLS_YAML, { credentials: { "tools.servers.weather.token": "", "tools.servers.search.token": "tok-search" } });
  assert.equal(cfg.tools.servers.weather!.token, "");
  assert.equal(cfg.tools.servers.search!.token, "tok-search");
});

// @spec CFG-SEC-016
test("the wildcard matches exactly one segment: another key under a server entry is not a secret path", () => {
  let cfg!: Config;
  const warnings = captureWarnings(() => {
    cfg = loadSettings(TOOLS_YAML, { credentials: { "tools.servers.weather.url": "http://evil/mcp", "tools.servers.weather.token": "ok-tok" } });
  });
  assert.equal(cfg.tools.servers.weather!.token, "ok-tok");
  assert.equal(cfg.tools.servers.weather!.url, "http://h:1/mcp", "a delivery cannot override a setting");
  const ignored = warnings.filter((w) => w.includes("tools.servers.weather.url"));
  assert.equal(ignored.length, 1, warnings.join(" | "));
  assert.doesNotMatch(warnings.join("\n"), /ok-tok|evil/);
});

// @spec CFG-SEC-017
test("a token for a server the tools section does not hold is not set and is warned by path, once, never by value", () => {
  let cfg!: Config;
  const warnings = captureWarnings(() => {
    cfg = loadSettings(TOOLS_YAML, { credentials: { "llm.openai.api_key": "sk-ok", "tools.servers.gone.token": "tok-gone-secret", "tools.servers.weather.token": "tok-w" } });
  });
  assert.equal(cfg.tools.servers.gone, undefined, "setting a credential never creates the entry it belongs to");
  assert.equal(cfg.tools.servers.weather!.token, "tok-w");
  assert.equal(warnings.filter((w) => w.includes("tools.servers.gone.token")).length, 1);
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.doesNotMatch(warnings.join("\n"), /tok-gone-secret|tok-w\b/);
});

// @spec CFG-SEC-017
test("with no servers in the tools section a token under tools.servers is ignored by path and creates no entry", () => {
  let cfg!: Config;
  const warnings = captureWarnings(() => { cfg = loadSettings(MINIMAL_YAML, { credentials: { "tools.servers.weather.token": "tok-w" } }); });
  assert.deepEqual(cfg.tools.servers, {});
  assert.equal(warnings.filter((w) => w.includes("tools.servers.weather.token")).length, 1);
});

// @spec CFG-SCH-083
test("a tools.servers name that holds a dot fails the load naming the entry", () => {
  assert.throws(
    () => loadSettings(`${MINIMAL_YAML}tools: { servers: { "a.b": { url: "https://x.example/mcp" } } }\n`, { credentials: { "tools.servers.a.b.token": "tk-SECRET" } }),
    (e: Error) => /tools\.servers\.a\.b/.test(e.message) && !e.message.includes("tk-SECRET"),
  );
});

// @spec CFG-SEC-020, CFG-SEC-003
test("the loader sets a well-formed ears.http.verifier from the delivery; it is not a secret path", () => {
  const key = "0123456789abcdef".repeat(4);
  const warnings = captureWarnings(() => {
    const cfg = loadSettings(MINIMAL_YAML, { credentials: { "ears.http.verifier": key, "ears.openai.api_key": "sk-e" } });
    assert.equal(earsListenerVerifier(cfg), key);
    assert.equal(cfg.ears.openai.api_key, "sk-e");
  });
  assert.deepEqual(warnings, [], "a well-formed key is set without a warning");
  assert.ok(!SECRET_PATHS.includes("ears.http.verifier"));
});

// @spec CFG-SEC-020
test("an ears.http.verifier that is not 64 lowercase hex digits is dropped with one warning naming the path, never the value, and the load still succeeds", () => {
  for (const bad of ["ABCDEF".repeat(10) + "abcd", "a".repeat(63), "a".repeat(65), "not-a-key-value-at-all"]) {
    const warnings = captureWarnings(() => assert.equal(earsListenerVerifier(loadSettings(MINIMAL_YAML, { credentials: { "ears.http.verifier": bad } })), undefined, bad));
    const about = warnings.filter((w) => w.includes("ears.http.verifier"));
    assert.equal(about.length, 1, warnings.join(" | "));
    assert.ok(!about[0]!.includes(bad), "the value is never in the warning");
  }
  assert.equal(earsListenerVerifier(loadSettings(MINIMAL_YAML)), undefined, "no delivery: no key");
});

// @spec CFG-SEC-021
test("no module of @cohost/config reads, writes or names a credentials file, the settings store's database or the master key file", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /secrets\.yaml|secrets\/units|COHOST_SECRETS_FILE|master\.key|COHOST_KEY_FILE|cohost\.db|data\/store/, `${name} names a credentials file, the store or the key`);
    assert.doesNotMatch(text, /from\s+["'](?:@cohost\/store|node:sqlite)["']/, `${name} imports the store`);
  }
});
