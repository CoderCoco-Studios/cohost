import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, loadDotEnv, earsSources, parseConfigText, ISOLATION_OVERRIDES, ISOLATION_ENV, encodeIsolation, isolationOverriddenKeys } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, shippedSandbox, captureWarnings, repo } from "./helpers/config-sandbox.js";

isolateEnv();

const MAP = {
  LLM_PROVIDER: "llm.provider", MEMORY_STORE: "brain.memory.store", MEMORY_EMBEDDER: "brain.memory.embedder", VOICE_ENGINE: "voice.engine",
  CHAT_SOURCES: "chat.sources", VISION_ENABLED: "vision.enabled", VISION_PROVIDER: "vision.provider", EARS_SOURCES: "ears.sources",
  EARS_STT_ENGINE: "ears.stt_engine", CONNECTIONS_DISCORD_ENABLED: "connections.discord.enabled", MOUTH_DISCORD_ENABLED: "mouth.outputs.discord.enabled",
  MOUTH_DRYRUN_ENABLED: "mouth.outputs.dryrun.enabled", AVATAR_DRIVER: "avatar.driver",
} as const;

function loadShipped(isolation?: Record<string, string>) {
  shippedSandbox();
  if (isolation) process.env.COHOST_ISOLATION = JSON.stringify(isolation);
  let cfg!: ReturnType<typeof loadConfig>;
  const warnings = captureWarnings(() => { cfg = loadConfig(true); });
  return { cfg, warnings };
}

// @spec CFG-ISO-006
test("ISOLATION_OVERRIDES maps the thirteen override names to the keys they set, and the variable is COHOST_ISOLATION", () => {
  assert.deepEqual({ ...ISOLATION_OVERRIDES }, MAP);
  assert.equal(Object.keys(ISOLATION_OVERRIDES).length, 13);
  assert.equal(ISOLATION_ENV, "COHOST_ISOLATION");
});

// @spec CFG-ISO-004
test("the shipped example writes each of the thirteen override keys as a literal holding its live default", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  assert.doesNotMatch(text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"), /\$\{/);
  const raw = parseYaml(text) as Record<string, unknown>;
  const at = (p: string) => p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], raw);
  assert.deepEqual(
    Object.values(MAP).map((p) => [p, at(p)]),
    [["llm.provider", "ollama"], ["brain.memory.store", "postgres"], ["brain.memory.embedder", "ollama"], ["voice.engine", "kokoro"], ["chat.sources", ["twitch"]],
      ["vision.enabled", false], ["vision.provider", "ollama"], ["ears.sources", ["discord"]], ["ears.stt_engine", "speaches"], ["connections.discord.enabled", true],
      ["mouth.outputs.discord.enabled", true], ["mouth.outputs.dryrun.enabled", false], ["avatar.driver", "null"]],
  );
  const { cfg } = loadShipped();
  assert.equal(cfg.llm.provider, "ollama");
  assert.equal(cfg.voice.engine, "kokoro");
  assert.equal(cfg.vision.enabled, false);
  assert.equal(cfg.vision.provider, "ollama");
  assert.equal(cfg.brain.memory.store, "postgres");
  assert.equal(cfg.brain.memory.embedder, "ollama");
  assert.deepEqual(cfg.chat.sources, ["twitch"]);
  assert.deepEqual(earsSources(cfg.ears), ["discord"]);
  assert.equal(cfg.ears.stt_engine, "speaches");
  assert.equal(cfg.connections.discord.enabled, true);
  assert.equal(cfg.mouth.outputs.discord.enabled, true);
  assert.equal(cfg.mouth.outputs.dryrun.enabled, false);
  assert.equal(cfg.avatar.driver, "null");
});

// @spec CFG-ISO-005
test("with no .env, no secrets.yaml and no override the shipped example loads: literal model names, avatar.driver null, default avatar ports", () => {
  const { cfg, warnings } = loadShipped();
  assert.deepEqual(warnings.filter((w) => w.includes("unknown keys")), []);
  assert.equal(cfg.llm.model, "qwen2.5:7b-instruct-q4_K_M");
  assert.equal(cfg.llm.embed_model, "nomic-embed-text");
  assert.equal(cfg.vision.model, "qwen2.5vl:3b");
  assert.equal(cfg.avatar.driver, "null");
  assert.equal(cfg.avatar.vtube_studio.port, 8001);
  assert.equal(cfg.avatar.vmc.port, 39539);
});

// @spec CFG-ISO-005
test("an unknown avatar.driver still fails the load naming avatar.driver, and a blank one means null", () => {
  const withDriver = (v: string) => MINIMAL_YAML.replace("avatar: {", `avatar: { driver: ${v},`);
  sandbox({ "config.yaml": withDriver("bogus") });
  assert.throws(() => loadConfig(true), (e: Error) => /avatar\.driver:/.test(e.message));
  sandbox({ "config.yaml": withDriver("''") });
  assert.equal(loadConfig(true).avatar.driver, "null");
});

// @spec CFG-ISO-007
test("COHOST_ISOLATION sets each entry at its key path, wins over the file, parses booleans and ears.sources as YAML and keeps the rest as strings", () => {
  const { cfg } = loadShipped({
    LLM_PROVIDER: "mock", MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash", VOICE_ENGINE: "stub", CHAT_SOURCES: "[fake]", VISION_ENABLED: "true",
    VISION_PROVIDER: "stub", EARS_SOURCES: "[http, dir]", EARS_STT_ENGINE: "stub", CONNECTIONS_DISCORD_ENABLED: "false", MOUTH_DISCORD_ENABLED: "false",
    MOUTH_DRYRUN_ENABLED: "true", AVATAR_DRIVER: "vmc",
  });
  assert.equal(cfg.llm.provider, "mock");
  assert.equal(cfg.brain.memory.store, "memory");
  assert.equal(cfg.brain.memory.embedder, "hash");
  assert.equal(cfg.voice.engine, "stub");
  assert.deepEqual(cfg.chat.sources, ["fake"]);
  assert.equal(cfg.vision.enabled, true);
  assert.equal(cfg.vision.provider, "stub");
  assert.deepEqual(earsSources(cfg.ears), ["http", "dir"]);
  assert.equal(cfg.ears.stt_engine, "stub");
  assert.equal(cfg.connections.discord.enabled, false);
  assert.equal(cfg.mouth.outputs.discord.enabled, false);
  assert.equal(cfg.mouth.outputs.dryrun.enabled, true);
  assert.equal(cfg.avatar.driver, "vmc");
  assert.deepEqual(earsSources(loadShipped({ EARS_SOURCES: "[]" }).cfg.ears), []);
  // an override of one key leaves every other key as the file has it
  assert.equal(loadShipped({ AVATAR_DRIVER: "null" }).cfg.llm.provider, "ollama");
});

// @spec CFG-ISO-007
test("an override applies after secrets.yaml and the file, and creates a section the file leaves out", () => {
  sandbox({ "config.yaml": MINIMAL_YAML.replace("llm: { model: m, embed_model: e }", "llm: { provider: anthropic, model: m, embed_model: e }") });
  process.env.COHOST_ISOLATION = JSON.stringify({ LLM_PROVIDER: "mock", MOUTH_DRYRUN_ENABLED: "true", AVATAR_DRIVER: "vmc" });
  const cfg = loadConfig(true);
  assert.equal(cfg.llm.provider, "mock");
  assert.equal(cfg.mouth.outputs.dryrun.enabled, true);
  assert.equal(cfg.avatar.driver, "vmc");
});

// @spec CFG-ISO-007
test("the settings editor's validation applies no override: parseConfigText reads the file alone", () => {
  process.env.COHOST_ISOLATION = JSON.stringify({ LLM_PROVIDER: "mock" });
  const r = parseConfigText(MINIMAL_YAML.replace("llm: { model", "llm: { provider: openai, model"));
  assert.ok(r.ok);
  assert.equal(r.config.llm.provider, "openai");
});

// @spec CFG-ISO-007
test("encodeIsolation writes the JSON object loadConfig reads, and nothing for an empty set", () => {
  assert.equal(encodeIsolation({}), "");
  const v = encodeIsolation({ EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" });
  assert.deepEqual(JSON.parse(v), { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" });
  assert.throws(() => encodeIsolation({ NOT_AN_OVERRIDE: "x" }), /NOT_AN_OVERRIDE/);
  shippedSandbox();
  process.env.COHOST_ISOLATION = v;
  captureWarnings(() => { assert.deepEqual(earsSources(loadConfig(true).ears), []); });
  process.env.COHOST_ISOLATION = "";
  captureWarnings(() => { assert.deepEqual(earsSources(loadConfig(true).ears), ["discord"], "empty means no override"); });
});

// @spec CFG-ISO-007
test("isolationOverriddenKeys reports the name and key of each override in a COHOST_ISOLATION value, and none for an empty, absent or malformed one", () => {
  assert.deepEqual(isolationOverriddenKeys(JSON.stringify({ AVATAR_DRIVER: "null", MOUTH_DRYRUN_ENABLED: "true" })), [
    { name: "AVATAR_DRIVER", key: "avatar.driver" }, { name: "MOUTH_DRYRUN_ENABLED", key: "mouth.outputs.dryrun.enabled" },
  ]);
  for (const v of [undefined, "", "not json", "[1]", JSON.stringify({ NOPE: "x" })]) assert.deepEqual(isolationOverriddenKeys(v), [], String(v));
  process.env.COHOST_ISOLATION = JSON.stringify({ LLM_PROVIDER: "mock" });
  assert.deepEqual(isolationOverriddenKeys(), [{ name: "LLM_PROVIDER", key: "llm.provider" }]);
});

// @spec CFG-ISO-008
test("loadDotEnv never sets COHOST_ISOLATION, so only the process environment can supply an override", () => {
  const dir = sandbox({ ".env": `COHOST_ISOLATION={"AVATAR_DRIVER":"vmc"}\nT_OTHER=1\n` });
  delete process.env.COHOST_ISOLATION;
  delete process.env.T_OTHER;
  loadDotEnv(join(dir, "..", ".env"));
  assert.equal(process.env.T_OTHER, "1");
  assert.equal(process.env.COHOST_ISOLATION, undefined);
});

// @spec CFG-ISO-009
test("variables and .env lines named like an override have no effect on the loaded config", () => {
  const lines = Object.keys(MAP).map((n) => `${n}=bogus-value`).join("\n");
  shippedSandbox({ ".env": `${lines}\n` });
  for (const n of Object.keys(MAP)) process.env[n] = "bogus-value";
  let cfg!: ReturnType<typeof loadConfig>;
  captureWarnings(() => { cfg = loadConfig(true); });
  assert.equal(cfg.llm.provider, "ollama");
  assert.equal(cfg.avatar.driver, "null");
  assert.deepEqual(earsSources(cfg.ears), ["discord"]);
  assert.equal(cfg.vision.enabled, false);
});

// @spec CFG-ISO-010
test("a COHOST_ISOLATION that is not a JSON object of strings, or names an unknown override, fails the load naming COHOST_ISOLATION and the unknown name", () => {
  const fails = (value: string): string => {
    shippedSandbox();
    process.env.COHOST_ISOLATION = value;
    try { loadConfig(true); } catch (e) { return (e as Error).message; }
    return assert.fail(`expected a failure for ${value}`);
  };
  for (const bad of ["{not json", "[\"AVATAR_DRIVER\"]", "\"AVATAR_DRIVER\"", "42", JSON.stringify({ AVATAR_DRIVER: 1 }), JSON.stringify({ VISION_ENABLED: true }), JSON.stringify({ AVATAR_DRIVER: null })]) {
    assert.match(fails(bad), /COHOST_ISOLATION/, bad);
  }
  const unknown = fails(JSON.stringify({ AVATAR_DRIVER: "null", TWITCH_CHANNEL: "x" }));
  assert.match(unknown, /COHOST_ISOLATION/);
  assert.match(unknown, /TWITCH_CHANNEL/);
});

// @spec CFG-ISO-007
test("a value an override gives that fails the schema fails the load and names the key and the override", () => {
  shippedSandbox();
  process.env.COHOST_ISOLATION = JSON.stringify({ AVATAR_DRIVER: "bogus" });
  assert.throws(() => loadConfig(true), (e: Error) => /avatar\.driver:/.test(e.message) && /COHOST_ISOLATION/.test(e.message));
});

// @spec CFG-ISO-007, CFG-ISO-006
test("COHOST_ISOLATION CHAT_SOURCES parses as a YAML flow value into chat.sources; the retired CHAT_SOURCE name is gone", () => {
  assert.deepEqual(loadShipped({ CHAT_SOURCES: "[fake]" }).cfg.chat.sources, ["fake"]);
  assert.deepEqual(loadShipped({ CHAT_SOURCES: "[twitch, youtube]" }).cfg.chat.sources, ["twitch", "youtube"]);
  assert.deepEqual(loadShipped({ CHAT_SOURCES: "[]" }).cfg.chat.sources, []);
  assert.deepEqual(loadShipped().cfg.chat.sources, ["twitch"], "no override leaves the file's value");
  assert.equal((ISOLATION_OVERRIDES as Record<string, string>).CHAT_SOURCES, "chat.sources");
  assert.equal("CHAT_SOURCE" in ISOLATION_OVERRIDES, false);
});

// @spec CFG-ISO-003, CFG-ISO-007
test("an isolation override naming an unknown chat source fails the load naming chat.sources", () => {
  shippedSandbox();
  process.env.COHOST_ISOLATION = JSON.stringify({ CHAT_SOURCES: "[irc]" });
  assert.throws(() => loadConfig(true), /chat\.sources/);
});

// @spec CFG-ISO-007
test("the settings editor's validation of an edited file applies no CHAT_SOURCES override", () => {
  shippedSandbox();
  process.env.COHOST_ISOLATION = JSON.stringify({ CHAT_SOURCES: "[fake]" });
  const r = parseConfigText(readFileSync(join(repo, "config", "config.example.yaml"), "utf8"));
  assert.ok(r.ok);
  assert.deepEqual(r.config.chat.sources, ["twitch"]);
});
