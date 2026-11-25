import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, loadConfig } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, shippedSandbox, repo, secretsIn } from "./helpers/config-sandbox.js";

isolateEnv();

const base = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
});
const parse = (over: Record<string, unknown> = {}) => ConfigSchema.safeParse({ ...base(), ...over });
const ok = (over: Record<string, unknown> = {}) => {
  const r = parse(over);
  assert.ok(r.success, JSON.stringify(r.success ? [] : r.error.issues));
  return r.data;
};
const issues = (over: Record<string, unknown>): string[] => {
  const r = parse(over);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};
const rejects = (over: Record<string, unknown>, key: string): void => {
  assert.ok(issues(over).includes(key), `${JSON.stringify(over)} should fail naming ${key}, got [${issues(over)}]`);
};
const vision = (v: Record<string, unknown>) => ({ vision: { model: "v", obs: {}, ...v } });

// @spec CFG-SCH-055, CFG-ISO-001, CFG-ISO-002
test("voice.engine takes kokoro, openai, pocket or stub, blank and omitted mean kokoro, anything else fails naming voice.engine", () => {
  assert.equal(ok().voice.engine, "kokoro");
  assert.equal(ok({ voice: { engine: "" } }).voice.engine, "kokoro");
  for (const e of ["kokoro", "pocket", "stub"]) assert.equal(ok({ voice: { engine: e } }).voice.engine, e);
  assert.equal(ok({ voice: { engine: "openai", voice: "nova" } }).voice.engine, "openai");
  rejects({ voice: { engine: "elevenlabs" } }, "voice.engine");
});

// @spec CFG-SCH-056
test("a blank voice.voice resolves to af_heart under kokoro and alba under pocket, and loads blank under openai", () => {
  assert.equal(ok({ voice: { engine: "kokoro", voice: "" } }).voice.voice, "af_heart");
  assert.equal(ok({ voice: { engine: "kokoro" } }).voice.voice, "af_heart");
  assert.equal(ok({ voice: { engine: "pocket", voice: "" } }).voice.voice, "alba");
  assert.equal(ok({ voice: { engine: "pocket" } }).voice.voice, "alba");
  assert.equal(ok({ voice: { engine: "openai", voice: "" } }).voice.voice, "");
});

// @spec CFG-SCH-029, CFG-SCH-057
test("voice.voice is checked in the form of the selected engine and a violation names voice.voice", () => {
  assert.equal(ok({ voice: { engine: "kokoro", voice: "af_bella(2)+af_sky" } }).voice.voice, "af_bella(2)+af_sky");
  rejects({ voice: { engine: "kokoro", voice: "../x" } }, "voice.voice");
  rejects({ voice: { engine: "kokoro", voice: "http://host/v.wav" } }, "voice.voice");
  assert.equal(ok({ voice: { engine: "pocket", voice: "marius" } }).voice.voice, "marius");
  assert.equal(ok({ voice: { engine: "pocket", voice: "my-voice_2" } }).voice.voice, "my-voice_2");
  assert.equal(ok({ voice: { engine: "pocket", voice: "https://example.com/v.wav" } }).voice.voice, "https://example.com/v.wav");
  rejects({ voice: { engine: "pocket", voice: "af_bella(2)+af_sky" } }, "voice.voice");
  rejects({ voice: { engine: "pocket", voice: "ftp://example.com/v.wav" } }, "voice.voice");
  assert.equal(ok({ voice: { engine: "openai", voice: "ash (warm) + 2" } }).voice.voice, "ash (warm) + 2", "openai takes any non-blank text");
});

// @spec CFG-SCH-029, CFG-ISO-001
test("the stub engine takes any voice text, since it calls no voice server, and a blank stub voice is af_heart", () => {
  assert.equal(ok({ voice: { engine: "stub", voice: "http://x" } }).voice.voice, "http://x");
  assert.equal(ok({ voice: { engine: "stub", voice: "af_bella(2)+af_sky" } }).voice.voice, "af_bella(2)+af_sky");
  assert.equal(ok({ voice: { engine: "stub", voice: "" } }).voice.voice, "af_heart");
});

// @spec CFG-SCH-060, CFG-SCH-061
test("a URL option must parse as an absolute http or https URL: a scheme-less host:port form or an empty host fails", () => {
  for (const bad of ["localhost:1234/v1", "http://"]) rejects({ voice: { openai: { base_url: bad } } }, "voice.openai.base_url");
  rejects({ voice: { pocket: { url: "localhost:8000" } } }, "voice.pocket.url");
  assert.equal(ok({ voice: { pocket: { url: "http://tts-pocket:8000" } } }).voice.pocket.url, "http://tts-pocket:8000");
});

// @spec CFG-SCH-058
test("voice.timeout_ms is a positive integer defaulting to 15000", () => {
  assert.equal(ok().voice.timeout_ms, 15000);
  assert.equal(ok({ voice: { timeout_ms: 1 } }).voice.timeout_ms, 1);
  for (const bad of [0, -5, 1.5]) rejects({ voice: { timeout_ms: bad } }, "voice.timeout_ms");
});

// @spec CFG-SCH-059, CFG-SCH-060
test("voice.openai defaults empty when absent, requires an http(s) base_url when non-blank and drops trailing slashes", () => {
  assert.deepEqual({ ...ok().voice.openai }, { base_url: "", model: "", api_key: "" });
  assert.equal(ok({ voice: { openai: { base_url: "https://api.openai.com/v1//" } } }).voice.openai.base_url, "https://api.openai.com/v1");
  assert.equal(ok({ voice: { openai: { base_url: "http://nas:8080/v1" } } }).voice.openai.base_url, "http://nas:8080/v1");
  for (const bad of ["ftp://x/v1", "not a url", "nas:8080"]) rejects({ voice: { openai: { base_url: bad } } }, "voice.openai.base_url");
});

// @spec CFG-SCH-061
test("voice.pocket defaults url to http://tts-pocket:8000 and hf_token to empty, and a non-blank non-http url fails", () => {
  assert.deepEqual({ ...ok().voice.pocket }, { url: "http://tts-pocket:8000", hf_token: "" });
  assert.equal(ok({ voice: { pocket: {} } }).voice.pocket.url, "http://tts-pocket:8000");
  assert.equal(ok({ voice: { pocket: { url: "https://gpu:9000" } } }).voice.pocket.url, "https://gpu:9000");
  rejects({ voice: { pocket: { url: "gpu:9000" } } }, "voice.pocket.url");
  rejects({ voice: { pocket: { url: "ftp://gpu" } } }, "voice.pocket.url");
});

// @spec CFG-SCH-062, CFG-SCH-024
test("voice configuration gaps load: a blank openai base_url, model or voice, and a blank pocket url (which stays blank)", () => {
  const openai = (o: Record<string, unknown>, voice = "nova") => ok({ voice: { engine: "openai", voice, openai: o } });
  openai({ base_url: "", model: "tts-1" });
  openai({ base_url: "http://x/v1", model: "" });
  openai({ base_url: "http://x/v1", model: "tts-1" }, "");
  assert.equal(ok({ voice: { engine: "pocket", pocket: { url: "" } } }).voice.pocket.url, "", "an empty url stays empty, it does not take the default");
});

// @spec CFG-SCH-022, CFG-ISO-001, CFG-ISO-002
test("ears.stt_engine takes speaches, openai, nemotron, kyutai or stub; blank and omitted mean speaches", () => {
  assert.equal(ok().ears.stt_engine, "speaches");
  assert.equal(ok({ ears: { stt_engine: "" } }).ears.stt_engine, "speaches");
  for (const e of ["speaches", "openai", "nemotron", "kyutai", "stub"]) assert.equal(ok({ ears: { stt_engine: e } }).ears.stt_engine, e);
  rejects({ ears: { stt_engine: "whisper" } }, "ears.stt_engine");
});

// @spec CFG-SCH-063, CFG-ISO-001, CFG-ISO-002
test("ears.stt_fallback_engine takes speaches, openai or none; blank and omitted mean speaches", () => {
  assert.equal(ok().ears.stt_fallback_engine, "speaches");
  assert.equal(ok({ ears: { stt_fallback_engine: "" } }).ears.stt_fallback_engine, "speaches");
  for (const e of ["speaches", "openai", "none"]) assert.equal(ok({ ears: { stt_fallback_engine: e } }).ears.stt_fallback_engine, e);
  rejects({ ears: { stt_fallback_engine: "stub" } }, "ears.stt_fallback_engine");
  rejects({ ears: { stt_fallback_engine: "kyutai" } }, "ears.stt_fallback_engine");
});

// @spec CFG-SCH-064
test("ears.stt_timeout_ms defaults to 20000 and ears.max_stt_sessions to 2, with their bounds", () => {
  const e = ok().ears;
  assert.equal(e.stt_timeout_ms, 20000);
  assert.equal(e.max_stt_sessions, 2);
  assert.equal(ok({ ears: { stt_timeout_ms: 1, max_stt_sessions: 1 } }).ears.max_stt_sessions, 1);
  for (const bad of [0, -1, 2.5]) rejects({ ears: { stt_timeout_ms: bad } }, "ears.stt_timeout_ms");
  for (const bad of [0, -1, 1.5]) rejects({ ears: { max_stt_sessions: bad } }, "ears.max_stt_sessions");
});

// @spec CFG-SCH-065
test("ears.openai defaults base_url and api_key to empty, requires http(s) when non-blank and drops trailing slashes", () => {
  assert.deepEqual({ ...ok().ears.openai }, { base_url: "", api_key: "" });
  assert.equal(ok({ ears: { openai: { base_url: "https://api.openai.com/v1/" } } }).ears.openai.base_url, "https://api.openai.com/v1");
  rejects({ ears: { openai: { base_url: "api.openai.com" } } }, "ears.openai.base_url");
});

// @spec CFG-SCH-066, CFG-SCH-067
test("ears.nemotron and ears.kyutai default their url and an empty api_key, and a non-blank non-http url fails naming it", () => {
  assert.equal(ok().ears.nemotron.url, "http://stt-nemotron:8080");
  assert.equal(ok().ears.nemotron.api_key, "");
  assert.equal(ok().ears.kyutai.url, "http://stt-kyutai:8080");
  assert.equal(ok().ears.kyutai.api_key, "");
  assert.equal(ok({ ears: { nemotron: { url: "http://gpu:8081" } } }).ears.nemotron.url, "http://gpu:8081");
  rejects({ ears: { nemotron: { url: "ws://gpu" } } }, "ears.nemotron.url");
  rejects({ ears: { kyutai: { url: "gpu:8080" } } }, "ears.kyutai.url");
});

// @spec CFG-SCH-068
test("ears.kyutai end_of_turn is on or off (blank off) and end_of_turn_threshold is above 0 and below 1, default 0.5", () => {
  assert.equal(ok().ears.kyutai.end_of_turn, "off");
  assert.equal(ok().ears.kyutai.end_of_turn_threshold, 0.5);
  assert.equal(ok({ ears: { kyutai: { end_of_turn: "" } } }).ears.kyutai.end_of_turn, "off");
  assert.equal(ok({ ears: { kyutai: { end_of_turn: "on", end_of_turn_threshold: 0.9 } } }).ears.kyutai.end_of_turn, "on");
  rejects({ ears: { kyutai: { end_of_turn: "auto" } } }, "ears.kyutai.end_of_turn");
  for (const bad of [0, 1, -0.2, 1.5]) rejects({ ears: { kyutai: { end_of_turn_threshold: bad } } }, "ears.kyutai.end_of_turn_threshold");
});

// @spec CFG-SCH-069, CFG-SCH-024
test("ears configuration gaps load, and the three engine-server urls keep an empty string as empty while an absent key takes its default", () => {
  ok({ ears: { stt_engine: "openai", openai: { base_url: "" } } });
  ok({ ears: { stt_engine: "nemotron", stt_fallback_engine: "openai", openai: { base_url: "" } } });
  ok({ ears: { stt_engine: "kyutai", stt_fallback_engine: "openai", openai: { base_url: "" } } });
  const blank = ok({ ears: { stt_engine: "nemotron", nemotron: { url: "" }, kyutai: { url: "" } } }).ears;
  assert.equal(blank.nemotron.url, "");
  assert.equal(blank.kyutai.url, "");
  assert.equal(ok({ ears: { nemotron: {}, kyutai: {} } }).ears.nemotron.url, "http://stt-nemotron:8080");
  assert.equal(ok({ voice: { pocket: {} } }).voice.pocket.url, "http://tts-pocket:8000");
});

// @spec CFG-SCH-024
test("a blank listed string key takes its default, so ears.stt_model and the OBS host and source are never blank", () => {
  const c = ok({ ears: { stt_model: "" }, ...vision({ obs: { host: "", source: "" } }) });
  assert.equal(c.ears.stt_model, "Systran/faster-whisper-small");
  assert.equal(c.vision.obs.host, "host.docker.internal");
  assert.equal(c.vision.obs.source, "Game Capture");
});

// @spec CFG-SCH-021, CFG-SCH-001, CFG-ISO-001, CFG-ISO-002
test("vision.provider takes ollama, openai, anthropic, bedrock or stub, blank and omitted mean ollama, and the schema defines no vision.engine key", () => {
  assert.equal(ok().vision.provider, "ollama");
  assert.equal(ok(vision({ provider: "" })).vision.provider, "ollama");
  for (const p of ["ollama", "openai", "anthropic", "bedrock", "stub"]) assert.equal(ok(vision({ provider: p })).vision.provider, p);
  rejects(vision({ provider: "gemini" }), "vision.provider");
  assert.equal("engine" in ok().vision, false);
  assert.equal("engine" in ok(vision({ engine: "stub" })).vision, false, "an old vision.engine value is not carried");
});

// @spec CFG-SCH-025, CFG-SCH-001
test("vision.model defaults to empty and a blank model loads whether vision.enabled is true or false", () => {
  assert.equal(ok({ vision: { obs: {} } }).vision.model, "");
  assert.equal(ok({ vision: { enabled: false, model: "", obs: {} } }).vision.model, "");
  assert.equal(ok({ vision: { enabled: true, model: "", obs: {} } }).vision.model, "");
  assert.equal(ok({ vision: { enabled: true, obs: {} } }).vision.enabled, true);
});

// @spec CFG-SCH-070
test("a hosted vision provider with blank credentials still loads", () => {
  ok({ ...vision({ model: "", provider: "anthropic", enabled: true }), llm: { model: "m", embed_model: "e", claude: { api_key: "" } } });
  ok({ ...vision({ model: "", provider: "bedrock", enabled: true }), llm: { model: "m", embed_model: "e", bedrock: { region: "", access_key_id: "", secret_access_key: "" } } });
  ok(vision({ model: "", provider: "openai", enabled: true }));
});

// @spec CFG-SCH-071
test("network.lan is optional, defaults to the empty list and validates each entry, naming network.lan.<n>", () => {
  assert.deepEqual(ok().network?.lan ?? [], []);
  assert.deepEqual(ok({ network: {} }).network?.lan ?? [], []);
  const good = ["nas", "NAS.example.com", "10.0.0.5", "fd7a:115c::5", "::1", ".ts.net", "100.64.0.0/10", "fd7a:115c::/32"];
  assert.deepEqual(ok({ network: { lan: good } }).network?.lan, good);
  rejects({ network: { lan: ["nas", "bad host!"] } }, "network.lan.1");
  rejects({ network: { lan: ["10.0.0.0/33"] } }, "network.lan.0");
  rejects({ network: { lan: ["10.0.0.0/abc"] } }, "network.lan.0");
  rejects({ network: { lan: ["ok", "ok", "http://nas"] } }, "network.lan.2");
  rejects({ network: { lan: "nas" } }, "network.lan");
});

// @spec CFG-SCH-071
test("a config.yaml without a network section loads through loadConfig, one with network.lan keeps it and a bad entry fails naming it", () => {
  sandbox({ "config.yaml": MINIMAL_YAML });
  loadConfig(true);
  sandbox({ "config.yaml": `${MINIMAL_YAML}network:\n  lan: [".ts.net"]\n` });
  assert.deepEqual(loadConfig(true).network?.lan, [".ts.net"]);
  sandbox({ "config.yaml": `${MINIMAL_YAML}network:\n  lan: ["bad host!"]\n` });
  assert.throws(() => loadConfig(true), (e: Error) => /network\.lan\.0/.test(e.message));
});

// @spec CFG-SCH-039, CFG-SEC-003
test("the five engine secret keys default to the empty string and merge from secrets.yaml, while config.yaml values at those paths are ignored", () => {
  const c = ok();
  assert.equal(c.ears.openai.api_key, "");
  assert.equal(c.ears.nemotron.api_key, "");
  assert.equal(c.ears.kyutai.api_key, "");
  assert.equal(c.voice.openai.api_key, "");
  assert.equal(c.voice.pocket.hf_token, "");
  const dir = sandbox({
    "config.yaml": MINIMAL_YAML.replace("ears: {}", "ears: { openai: { api_key: pasted } }"),
    "secrets.yaml": "ears:\n  nemotron:\n    api_key: nem\n  kyutai:\n    api_key: kyu\nvoice:\n  openai:\n    api_key: vk\n  pocket:\n    hf_token: hf\n",
  });
  chmodSync(secretsIn(dir), 0o600);
  const cfg = loadConfig(true);
  assert.equal(cfg.ears.nemotron.api_key, "nem");
  assert.equal(cfg.ears.kyutai.api_key, "kyu");
  assert.equal(cfg.voice.openai.api_key, "vk");
  assert.equal(cfg.voice.pocket.hf_token, "hf");
  assert.equal(cfg.ears.openai.api_key, "", "a value pasted into config.yaml is never used");
});

// @spec CFG-USR-019
test("the shipped example writes the engine keys as commented literals, network.lan as an empty list, no placeholder and no secret", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const lines = text.split("\n");
  const raw = parseYaml(text) as Record<string, unknown>;
  const at = (p: string) => p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], raw);
  const expected: Array<[string, unknown]> = [
    ["voice.engine", "kokoro"], ["voice.timeout_ms", 15000], ["voice.pocket.url", "http://tts-pocket:8000"],
    ["ears.stt_fallback_engine", "speaches"], ["ears.stt_timeout_ms", 20000], ["ears.max_stt_sessions", 2],
    ["ears.nemotron.url", "http://stt-nemotron:8080"], ["ears.kyutai.url", "http://stt-kyutai:8080"],
    ["ears.kyutai.end_of_turn", "off"], ["ears.kyutai.end_of_turn_threshold", 0.5], ["network.lan", []],
  ];
  for (const [path, value] of expected) {
    assert.deepEqual(at(path), value, path);
    let idx = -1;
    for (const seg of path.split(".")) {
      idx = lines.findIndex((l, i) => i > idx && new RegExp(`^\\s*${seg}:`).test(l));
      assert.ok(idx >= 0, `${path}: line of ${seg}`);
    }
    assert.ok(/\s#\s*\S/.test(lines[idx]!) || /^\s*#/.test(lines[idx - 1] ?? ""), `${path} has a comment`);
  }
  assert.doesNotMatch(lines.filter((l) => !/^\s*#/.test(l)).join("\n"), /\$\{|hf_token/);
  for (const secret of ["voice.openai.api_key", "voice.pocket.hf_token", "ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key"]) assert.equal(at(secret), undefined, secret);
  shippedSandbox();
  assert.doesNotThrow(() => loadConfig(true));
});
