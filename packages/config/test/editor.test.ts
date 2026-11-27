import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readSection, applySection, sectionJsonSchema, sectionSecrets, schemaAt, SECRET_PATHS, ISOLATION_OVERRIDES } from "../src/index.js";

/** Stored settings as the settings store nests its sections (`store.settingsTree()`): sparse, only the keys the owner set. */
const TREE: Record<string, unknown> = parseYaml(`
cohost:
  name: Coco
  streamer: Chris
llm:
  provider: ollama
  model: "qwen2.5:7b"
  embed_model: e
vision:
  enabled: false
  model: m
  obs:
    host: obs.lan
chat: { twitch: { channel: chan } }
brain:
  salience:
    cooldown_ms: 6000
    reflexes:
      - match: hello
        say: [hi]
  working_memory_events: 30
voice: {}
avatar: { vtube_studio: { host: h }, vmc: { host: h } }
ears: {}
dashboard: {}
`) as Record<string, unknown>;
const ok = (r: ReturnType<typeof applySection>) => { assert.ok(r.ok, JSON.stringify(r)); return r; };

// @spec MOD-CFG-001, MOD-CFG-002
test("sectionJsonSchema renders a section from the zod schema with defaults, enums, bounds and secret marks", () => {
  const voice = sectionJsonSchema("voice") as any;
  assert.equal(voice.type, "object");
  assert.deepEqual(voice.properties.engine.enum, ["kokoro", "openai", "pocket", "stub"]);
  assert.equal(voice.properties.engine.default, "kokoro");
  assert.equal(voice.properties.speed.type, "number");
  assert.match(voice.properties.sample_rate.description, /stub/); // @spec CFG-SCH-026
  assert.match((sectionJsonSchema("dashboard") as any).properties.port.description, /full surface.*next start/s); // @spec CFG-SCH-026
  assert.match((sectionJsonSchema("dashboard") as any).properties.lan_port.description, /LAN.*next start/s); // @spec CFG-SCH-026
  assert.equal(voice.properties.sample_rate.type, "integer");
  assert.equal(voice.properties.fallback.properties.lines.type, "array");
  const llm = sectionJsonSchema("llm") as any;
  assert.ok(llm.required.includes("model"));
  assert.equal(llm.properties.temperature.maximum, 2);
  assert.equal(llm.properties.openai.properties.api_key["x-secret"], true);
  assert.equal(llm.properties.claude.properties.api_key["x-secret"], true);
  assert.equal(llm.properties.model["x-secret"], undefined);
  const leaf = sectionJsonSchema("brain.working_memory_events") as any;
  assert.equal(leaf.type, "integer");
  assert.deepEqual((sectionJsonSchema("brain.salience") as any).properties.module.properties.kind.enum, ["rules", "llm", "http"]);
  assert.equal(schemaAt("nope"), undefined);
});

// @spec MOD-CFG-002
test("exactly the marked keys are secret: SECRET_PATHS (the sixteen and the tools wildcard), each section's secrets and the schema marks agree", () => {
  assert.deepEqual([...SECRET_PATHS].toSorted(), [
    "chat.twitch.access_token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.refresh_token", "chat.youtube.api_key", "connections.discord.token",
    "ears.kyutai.api_key", "ears.nemotron.api_key", "ears.openai.api_key",
    "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "llm.claude.api_key", "llm.openai.api_key", "tools.servers.*.token",
    "vision.obs.password", "voice.openai.api_key", "voice.pocket.hf_token",
  ]);
  assert.deepEqual(sectionSecrets("ears").toSorted(), ["kyutai.api_key", "nemotron.api_key", "openai.api_key"]);
  assert.deepEqual(sectionSecrets("llm").toSorted(), ["bedrock.access_key_id", "bedrock.secret_access_key", "claude.api_key", "openai.api_key"]);
  assert.deepEqual(sectionSecrets("chat").toSorted(), ["twitch.access_token", "twitch.client_id", "twitch.client_secret", "twitch.refresh_token", "youtube.api_key"]);
  assert.deepEqual(sectionSecrets("connections"), ["discord.token"]);
  assert.deepEqual(sectionSecrets("voice").toSorted(), ["openai.api_key", "pocket.hf_token"]);
  assert.deepEqual(sectionSecrets("tools"), ["servers.*.token"]);
  const marked: string[] = [];
  const walk = (s: any, path: string[]) => {
    if (s["x-secret"]) marked.push(path.join("."));
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) walk(v, [...path, k]);
    // a map's entries (tools.servers) are walked as one `*` segment
    if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, [...path, "*"]);
  };
  for (const sec of ["cohost", "llm", "vision", "chat", "brain", "voice", "avatar", "ears", "mouth", "connections", "dashboard", "tools"]) walk(sectionJsonSchema(sec), [sec]);
  assert.deepEqual(marked.toSorted(), [...SECRET_PATHS].toSorted());
});


// @spec MOD-CFG-004
test("readSection reports each key's source (literal or default), editability, effective value and the stored value as YAML", () => {
  const { keys } = readSection(TREE, "llm");
  assert.deepEqual(keys["provider"], { source: "literal", editable: true, value: "ollama", raw: "ollama", isolation: { name: "LLM_PROVIDER", overriddenBy: [] } });
  assert.deepEqual(keys["model"], { source: "literal", editable: true, value: "qwen2.5:7b", raw: "qwen2.5:7b" });
  assert.deepEqual(keys["max_tokens"], { source: "default", editable: true, value: 120 });
  const cohost = readSection(TREE, "cohost").keys;
  assert.deepEqual(cohost["name"], { source: "literal", editable: true, value: "Coco", raw: "Coco" });
  assert.deepEqual(cohost["timezone"], { source: "default", editable: true, value: "UTC" });
  const arr = readSection(TREE, "brain.salience").keys["reflexes"]!;
  assert.equal(arr.source, "literal");
  assert.deepEqual(arr.value, [{ match: "hello", on: ["chat", "speech", "vision"], say: ["hi"], emotion: "surprised", cooldown_ms: 30000 }]);
  const leaf = readSection(TREE, "brain.working_memory_events").keys;
  assert.deepEqual(leaf, { working_memory_events: { source: "literal", editable: true, value: 30, raw: "30" } });
  const everyKey = Object.values(readSection(TREE, "vision").keys).concat(Object.values(readSection(TREE, "dashboard").keys)).filter((k) => !k.secret);
  assert.ok(everyKey.every((k) => (k.source === "literal" || k.source === "default") && k.editable), "every non-secret key is editable and has one of two sources");
  assert.deepEqual(readSection(TREE, "dashboard").keys["lan_port"], { source: "default", editable: true, value: 3001 });
});

// @spec MOD-CFG-004, MOD-CFG-018
test("a key that an isolation override selects carries its override name and the units running with it, an empty list when none", () => {
  const llm = readSection(TREE, "llm").keys;
  assert.deepEqual(llm["provider"]!.isolation, { name: "LLM_PROVIDER", overriddenBy: [] });
  assert.equal(llm["model"]!.isolation, undefined, "llm.model is no override target");
  const running = readSection(TREE, "llm", [], { LLM_PROVIDER: ["cortex"], AVATAR_DRIVER: ["avatar"] }).keys;
  assert.deepEqual(running["provider"]!.isolation, { name: "LLM_PROVIDER", overriddenBy: ["cortex"] });
  assert.deepEqual(readSection(TREE, "avatar", [], { AVATAR_DRIVER: ["avatar"] }).keys["driver"]!.isolation, { name: "AVATAR_DRIVER", overriddenBy: ["avatar"] });
  for (const [name, path] of Object.entries(ISOLATION_OVERRIDES)) {
    const section = path.split(".").slice(0, path.startsWith("brain.") ? 2 : 1).join(".");
    const key = path.slice(section.length + 1);
    assert.equal(readSection(TREE, section).keys[key]!.isolation?.name, name, path);
  }
});

// @spec MOD-CFG-005, MOD-CFG-017
test("a secret key reports only secret: true and whether the store holds it, never a source, value or raw text; a wildcard is one key per stored entry", () => {
  const unset = readSection(TREE, "llm");
  assert.deepEqual(unset.keys["openai.api_key"], { editable: false, secret: true, set: false });
  const set = readSection(TREE, "llm", ["llm.openai.api_key"]);
  assert.deepEqual(set.keys["openai.api_key"], { editable: false, secret: true, set: true });
  assert.deepEqual(set.keys["claude.api_key"], { editable: false, secret: true, set: false });
  assert.deepEqual(Object.keys(readSection(TREE, "chat", ["chat.twitch.client_id"]).keys).filter((k) => k.startsWith("twitch.")).toSorted(), ["twitch.access_token", "twitch.channel", "twitch.client_id", "twitch.client_secret", "twitch.refresh_token"]);
  const tools = { ...TREE, tools: { servers: { home: { url: "https://h.example/mcp" }, away: { url: "https://a.example/mcp" } } } };
  const read = readSection(tools, "tools", ["tools.servers.home.token"]);
  assert.deepEqual(read.keys["servers.home.token"], { editable: false, secret: true, set: true });
  assert.deepEqual(read.keys["servers.away.token"], { editable: false, secret: true, set: false });
  assert.equal(read.keys["servers.*.token"], undefined, "never an aggregate key");
});

// @spec MOD-CFG-002, MOD-CFG-005, MOD-CFG-017
test("a secret key in an edit is refused without echoing its value, and editing a neighbour leaves the credentials alone", () => {
  const tree = { ...TREE, ears: { http: { port: 8765 } } };
  const refused = applySection(tree, "ears", { "openai.api_key": "tok-very-secret" });
  assert.equal(refused.ok, false);
  assert.doesNotMatch(JSON.stringify(refused), /tok-very-secret/);
  const edited = ok(applySection(tree, "ears", { "http.port": 9000 }));
  assert.deepEqual(edited.doc, { http: { port: 9000 } });
  assert.equal(applySection(tree, "llm", {}, ["llm.openai.api_key"]).ok, false, "a credential is not removed through the settings edit");
});

// @spec MOD-CFG-016
test("the settings editor never touches the filesystem or the environment: it reads and edits the stored tree it is given", () => {
  const src = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:fs|readFileSync|writeFileSync|writeFileAtomic|process\.env/);
});

// @spec MOD-CFG-006
test("unknown lists the dotted paths of stored keys under the section that the schema does not define, even when the settings are invalid", () => {
  const tree = structuredClone(TREE) as any;
  tree.brain.salience.bogus = 1;
  tree.brain.salience.reflexes[0].cooldwn_ms = 5;
  tree.cohost.name = "";
  assert.deepEqual(readSection(tree, "brain.salience").unknown.toSorted(), ["brain.salience.bogus", "brain.salience.reflexes[0].cooldwn_ms"]);
  assert.deepEqual(readSection(tree, "voice").unknown, []);
});

// @spec MOD-CFG-009
test("a value for an unknown or secret key, or a missing value, is refused naming each key, and nothing is edited", () => {
  const r = applySection(TREE, "llm", { nope: 1, "openai.api_key": "x", embed_model: "y", model: null });
  assert.equal(r.ok, false);
  assert.deepEqual((r as any).issues.map((i: any) => i.path).toSorted(), ["model", "nope", "openai.api_key"]);
  assert.equal(applySection(TREE, "llm", {}, ["voice.speed"]).ok, false, "remove names only paths under the section");
});

// @spec MOD-CFG-009
test("remove deletes the stored keys it names, unknown ones included, so the default applies or the key goes", () => {
  const tree = structuredClone(TREE) as any;
  tree.brain.salience.bogus = 1;
  const r = ok(applySection(tree, "brain.salience", {}, ["brain.salience.bogus", "brain.salience.cooldown_ms"]));
  assert.deepEqual(Object.keys(r.doc as object).toSorted(), ["reflexes"]);
  const entry = ok(applySection(tree, "brain.salience", {}, ["brain.salience.reflexes[0]"]));
  assert.deepEqual((entry.doc as any).reflexes, []);
  assert.equal(ok(applySection(TREE, "cohost", {}, ["cohost"])).doc, null, "removing the whole section leaves nothing stored");
});

// @spec MOD-CFG-010
test("a key is set in the section's stored document whatever its source, every other stored key and section left as it was", () => {
  const r = ok(applySection(TREE, "llm", { provider: "anthropic", max_tokens: 200 }));
  assert.deepEqual(r.doc, { provider: "anthropic", model: "qwen2.5:7b", embed_model: "e", max_tokens: 200 });
  assert.deepEqual((TREE as any).llm, { provider: "ollama", model: "qwen2.5:7b", embed_model: "e" }, "the tree given is not changed");
  const deep = ok(applySection(TREE, "vision", { "obs.width": 640 }));
  assert.deepEqual(deep.doc, { enabled: false, model: "m", obs: { host: "obs.lan", width: 640 } });
  const added = ok(applySection(TREE, "mouth", { "outputs.discord.gain_db": 3 }));
  assert.deepEqual(added.doc, { outputs: { discord: { gain_db: 3 } } }, "a section the store does not hold is added");
});

// @spec MOD-CFG-010
test("a leaf section (brain.working_memory_events) is set as its own value", () => {
  assert.equal(ok(applySection(TREE, "brain.working_memory_events", { working_memory_events: 12 })).doc, 12);
});

// @spec MOD-CFG-011
test("an array value replaces the whole array, present or absent", () => {
  const reflexes = [{ match: "bye", say: ["later", "cya"], cooldown_ms: 1000 }];
  const r = ok(applySection(TREE, "brain.salience", { reflexes }));
  assert.deepEqual(r.doc, { cooldown_ms: 6000, reflexes });
  assert.deepEqual((ok(applySection(TREE, "voice", { "fallback.lines": ["a: b", "c"] })).doc as any).fallback.lines, ["a: b", "c"]);
  assert.deepEqual((ok(applySection(TREE, "brain.salience", { reflexes: [] })).doc as any).reflexes, []);
});

// @spec MOD-CFG-015
test("an edit to a key that a running unit overrides warns naming the key and the units; the dashboard and logging sections warn about the dashboard's next start, and the dashboard section about the new page address", () => {
  const overridden = ok(applySection(TREE, "llm", { provider: "anthropic", model: "x" }, [], [], { LLM_PROVIDER: ["cortex", "memory"] }));
  assert.equal(overridden.warnings.length, 1);
  assert.match(overridden.warnings[0]!, /llm\.provider/);
  assert.match(overridden.warnings[0]!, /cortex, memory/);
  assert.match(overridden.warnings[0]!, /isolation/);
  assert.deepEqual(ok(applySection(TREE, "llm", { model: "x" }, [], [], { LLM_PROVIDER: ["cortex"] })).warnings, [], "an unedited overridden key does not warn");
  assert.deepEqual(ok(applySection(TREE, "llm", { provider: "anthropic" })).warnings, [], "no running override, no warning");
  const dash = ok(applySection(TREE, "dashboard", { "inject.ttl_ms": 1000 }));
  assert.equal(dash.warnings.length, 1);
  assert.match(dash.warnings[0]!, /next start/);
  const ports = ok(applySection(TREE, "dashboard", { port: 4000, lan_port: 4001 }));
  assert.equal(ports.warnings.length, 2);
  assert.match(ports.warnings[0]!, /next start/);
  assert.match(ports.warnings[1]!, /address.*4000.*4001/s);
  assert.deepEqual(ok(applySection(TREE, "dashboard", {})).warnings, []);
  const logging = ok(applySection(TREE, "logging", { level: "debug" }));
  assert.equal(logging.warnings.length, 1);
  assert.match(logging.warnings[0]!, /^logging: .*dashboard.*next start/);
  assert.deepEqual(ok(applySection(TREE, "logging", {})).warnings, []);
});

// @spec MOD-CFG-012
test("a no-op edit of the shipped example is a no-op for every section", () => {
  const tree = parseYaml(readFileSync(new URL("../../../config/config.example.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
  for (const sec of ["cohost", "llm", "vision", "chat", "voice", "avatar", "ears", "mouth", "connections", "dashboard", "brain.salience", "brain.memory", "brain.working_memory_events"]) {
    const r = ok(applySection(tree, sec, {}));
    const stored = sec.split(".").reduce<any>((o, k) => o?.[k], tree);
    assert.deepEqual(r.doc, stored === undefined || (typeof stored === "object" && Object.keys(stored).length === 0) ? null : stored, sec);
    for (const [k, v] of Object.entries(readSection(tree, sec).keys)) assert.ok(v.secret || v.source, `${sec}.${k}`);
  }
});

// @spec CFG-SCH-097, CFG-SCH-099, CFG-SCH-100
test("sectionJsonSchema renders the renderer section with its defaults and bounds, and dashboard.models.max_bytes with its range", () => {
  const r = sectionJsonSchema("renderer") as any;
  assert.deepEqual([r.properties.model.default, r.properties.zoom.default, r.properties.offset_y.default, r.properties.turn.default], ["", 1, 0, 0]);
  assert.deepEqual([r.properties.zoom.minimum, r.properties.zoom.maximum], [0.5, 3]);
  assert.deepEqual([r.properties.offset_y.minimum, r.properties.offset_y.maximum], [-1.5, 1.5]);
  assert.deepEqual([r.properties.turn.minimum, r.properties.turn.maximum], [-90, 90]);
  assert.equal(r.properties.model.maxLength, 80);
  const m = (sectionJsonSchema("dashboard") as any).properties.models.properties.max_bytes;
  assert.deepEqual([m.type, m.minimum, m.maximum, m.default], ["integer", 1048576, 1073741824, 104857600]);
});
