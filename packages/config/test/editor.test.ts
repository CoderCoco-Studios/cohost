import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readSection, applySection, sectionJsonSchema, sectionSecrets, schemaAt, etagOf, SECRET_PATHS, ISOLATION_OVERRIDES, parseConfigText } from "../src/index.js";

const FIXTURE = `# top comment kept
cohost:
  name: "Coco"                 # the name
  streamer: Chris
llm:
  provider: "ollama"   # preset
  model: "qwen2.5:7b"  # tag
  embed_model: "e"
vision:
  enabled: false
  model: "m"
  obs:
    host: "obs.lan"
chat: { twitch: { channel: chan } }
brain:
  salience:
    cooldown_ms: 6000   # aligned comment
    reflexes:
      - match: "hello"
        say: ["hi"]   # trailing
  working_memory_events: 30
voice: {}
avatar: { vtube_studio: { host: h }, vmc: { host: h } }
ears: {}
dashboard: {}
`;
const lines = (t: string) => t.split("\n");
/** The lines of `after` that are not in `before`, and vice versa (order-insensitive): the edit's footprint. */
const footprint = (before: string, after: string) => {
  const b = lines(before), a = lines(after);
  return { removed: b.filter((l) => !a.includes(l)), added: a.filter((l) => !b.includes(l)) };
};
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
test("exactly the marked keys are secret: SECRET_PATHS (the seventeen and the tools wildcard), each section's secrets and the schema marks agree", () => {
  assert.deepEqual([...SECRET_PATHS].sort(), [
    "chat.twitch.access_token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.refresh_token", "chat.youtube.api_key", "connections.discord.token", "ears.http.token",
    "ears.kyutai.api_key", "ears.nemotron.api_key", "ears.openai.api_key",
    "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "llm.claude.api_key", "llm.openai.api_key", "vision.obs.password",
    "tools.servers.*.token", "voice.openai.api_key", "voice.pocket.hf_token",
  ]);
  assert.deepEqual(sectionSecrets("ears").sort(), ["http.token", "kyutai.api_key", "nemotron.api_key", "openai.api_key"]);
  assert.deepEqual(sectionSecrets("llm").sort(), ["bedrock.access_key_id", "bedrock.secret_access_key", "claude.api_key", "openai.api_key"]);
  assert.deepEqual(sectionSecrets("chat").sort(), ["twitch.access_token", "twitch.client_id", "twitch.client_secret", "twitch.refresh_token", "youtube.api_key"]);
  assert.deepEqual(sectionSecrets("connections"), ["discord.token"]);
  assert.deepEqual(sectionSecrets("voice").sort(), ["openai.api_key", "pocket.hf_token"]);
  assert.deepEqual(sectionSecrets("tools"), ["servers.*.token"]);
  const marked: string[] = [];
  const walk = (s: any, path: string[]) => {
    if (s["x-secret"]) marked.push(path.join("."));
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) walk(v, [...path, k]);
    // a map's entries (tools.servers) are walked as one `*` segment
    if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, [...path, "*"]);
  };
  for (const sec of ["cohost", "llm", "vision", "chat", "brain", "voice", "avatar", "ears", "mouth", "connections", "dashboard", "tools"]) walk(sectionJsonSchema(sec), [sec]);
  assert.deepEqual(marked.sort(), [...SECRET_PATHS].sort());
});

// @spec MOD-CFG-004
test("readSection reports each key's source (literal or default), editability, effective value and raw text", () => {
  const { keys } = readSection(FIXTURE, "llm");
  assert.deepEqual(keys["provider"], { source: "literal", editable: true, value: "ollama", raw: '"ollama"', isolation: { name: "LLM_PROVIDER", overriddenBy: [] } });
  assert.deepEqual(keys["model"], { source: "literal", editable: true, value: "qwen2.5:7b", raw: '"qwen2.5:7b"' });
  assert.deepEqual(keys["max_tokens"], { source: "default", editable: true, value: 120 });
  const cohost = readSection(FIXTURE, "cohost").keys;
  assert.deepEqual(cohost["name"], { source: "literal", editable: true, value: "Coco", raw: '"Coco"' });
  assert.deepEqual(cohost["timezone"], { source: "default", editable: true, value: "UTC" });
  const arr = readSection(FIXTURE, "brain.salience").keys["reflexes"]!;
  assert.equal(arr.source, "literal");
  assert.deepEqual(arr.value, [{ match: "hello", on: ["chat", "speech", "vision"], say: ["hi"], emotion: "surprised", cooldown_ms: 30000 }]);
  const leaf = readSection(FIXTURE, "brain.working_memory_events").keys;
  assert.deepEqual(leaf, { working_memory_events: { source: "literal", editable: true, value: 30, raw: "30" } });
  const everyKey = Object.values(readSection(FIXTURE, "vision").keys).concat(Object.values(readSection(FIXTURE, "dashboard").keys)).filter((k) => !k.secret);
  assert.ok(everyKey.every((k) => (k.source === "literal" || k.source === "default") && k.editable === true), "every non-secret key is editable and has one of two sources");
  assert.deepEqual(readSection(FIXTURE, "dashboard").keys["lan_port"], { source: "default", editable: true, value: 3001 });
});

// @spec MOD-CFG-004, MOD-CFG-018
test("a key that an isolation override selects carries its override name and the units running with it, an empty list when none", () => {
  const llm = readSection(FIXTURE, "llm").keys;
  assert.deepEqual(llm["provider"]!.isolation, { name: "LLM_PROVIDER", overriddenBy: [] });
  assert.equal(llm["model"]!.isolation, undefined, "llm.model is no override target");
  const running = readSection(FIXTURE, "llm", [], { LLM_PROVIDER: ["cortex"], AVATAR_DRIVER: ["avatar"] }).keys;
  assert.deepEqual(running["provider"]!.isolation, { name: "LLM_PROVIDER", overriddenBy: ["cortex"] });
  assert.deepEqual(readSection(FIXTURE, "avatar", [], { AVATAR_DRIVER: ["avatar"] }).keys["driver"]!.isolation, { name: "AVATAR_DRIVER", overriddenBy: ["avatar"] });
  // every key of the thirteen carries the entry
  for (const [name, path] of Object.entries(ISOLATION_OVERRIDES)) {
    const section = path.split(".").slice(0, path.startsWith("brain.") ? 2 : 1).join(".");
    const key = path.slice(section.length + 1);
    assert.equal(readSection(FIXTURE, section).keys[key]!.isolation?.name, name, path);
  }
});

// @spec MOD-CFG-005, MOD-CFG-017
test("a secret key reports only secret: true and whether secrets.yaml holds it, never a source, value or raw text", () => {
  const unset = readSection(FIXTURE, "llm");
  assert.deepEqual(unset.keys["openai.api_key"], { editable: false, secret: true, set: false });
  const set = readSection(FIXTURE, "llm", ["llm.openai.api_key"]);
  assert.deepEqual(set.keys["openai.api_key"], { editable: false, secret: true, set: true });
  assert.deepEqual(set.keys["claude.api_key"], { editable: false, secret: true, set: false });
  assert.deepEqual(Object.keys(readSection(FIXTURE, "chat", ["chat.twitch.client_id"]).keys).filter((k) => k.startsWith("twitch.")).sort(), ["twitch.access_token", "twitch.channel", "twitch.client_id", "twitch.client_secret", "twitch.refresh_token"]);
  // a value pasted into config.yaml at a secret path is never used and does not make the key set; it is not shown either
  const pasted = readSection(FIXTURE.replace('embed_model: "e"', 'embed_model: "e"\n  openai:\n    api_key: sk-in-file'), "llm");
  assert.doesNotMatch(JSON.stringify(pasted), /sk-in-file/);
  assert.deepEqual(pasted.keys["openai.api_key"], { editable: false, secret: true, set: false });
  const broken = readSection(FIXTURE.replace('name: "Coco"', 'name: ""').replace('embed_model: "e"', 'embed_model: "e"\n  openai:\n    api_key: sk-in-file'), "llm");
  assert.doesNotMatch(JSON.stringify(broken), /sk-in-file/, "not even when the file is invalid");
});

// @spec MOD-CFG-002, MOD-CFG-005, MOD-CFG-017
test("a secret key in an edit is refused without echoing its value, and editing a neighbour leaves it alone", () => {
  const text = FIXTURE.replace("ears: {}", "ears:\n  http:\n    port: 8765");
  const refused = applySection(text, "ears", { "http.token": "tok-very-secret" });
  assert.equal(refused.ok, false);
  assert.doesNotMatch(JSON.stringify(refused), /tok-very-secret/);
  const edited = ok(applySection(text, "ears", { "http.port": 9000 }));
  assert.doesNotMatch(edited.text, /token/);
});

// @spec MOD-CFG-016
test("the settings editor never touches the filesystem or the environment: it reads and writes text", () => {
  const src = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:fs|readFileSync|writeFileSync|writeFileAtomic|process\.env|secrets\.yaml.*(read|write)/);
});

// @spec MOD-CFG-006
test("unknown lists the dotted paths under the section that the schema does not define, even when the file is invalid", () => {
  const text = FIXTURE.replace("cooldown_ms: 6000", "cooldown_ms: 6000\n    bogus: 1").replace('match: "hello"', 'match: "hello"\n        cooldwn_ms: 5').replace("name: \"Coco\"", "name: \"\"");
  assert.deepEqual(readSection(text, "brain.salience").unknown.sort(), ["brain.salience.bogus", "brain.salience.reflexes[0].cooldwn_ms"]);
  assert.deepEqual(readSection(text, "voice").unknown, []);
});

// @spec MOD-CFG-009
test("a value for an unknown or secret key is refused naming each key, and nothing is edited", () => {
  const r = applySection(FIXTURE, "llm", { nope: 1, "openai.api_key": "x", embed_model: "y" });
  assert.equal(r.ok, false);
  assert.deepEqual((r as any).issues.map((i: any) => i.path).sort(), ["nope", "openai.api_key"]);
});

// @spec MOD-CFG-010
test("a literal keeps its quote style, its comment and every other line", () => {
  const r = ok(applySection(FIXTURE, "cohost", { name: "Zed" }));
  assert.deepEqual(footprint(FIXTURE, r.text), { removed: ['  name: "Coco"                 # the name'], added: ['  name: "Zed"                 # the name'] });
  const n = ok(applySection(FIXTURE, "brain.salience", { cooldown_ms: 4000 }));
  assert.deepEqual(footprint(FIXTURE, n.text), { removed: ["    cooldown_ms: 6000   # aligned comment"], added: ["    cooldown_ms: 4000   # aligned comment"] });
});

// @spec MOD-CFG-010
test("a literal or default key is set to the given value whatever the key is, and the footprint is the edited lines", () => {
  const r = ok(applySection(FIXTURE, "llm", { provider: "anthropic", model: "claude-x" }));
  assert.deepEqual(footprint(FIXTURE, r.text), {
    removed: ['  provider: "ollama"   # preset', '  model: "qwen2.5:7b"  # tag'],
    added: ['  provider: "anthropic"   # preset', '  model: "claude-x"  # tag'],
  });
  const plain = ok(applySection(FIXTURE, "vision", { enabled: true }));
  assert.deepEqual(footprint(FIXTURE, plain.text), { removed: ["  enabled: false"], added: ["  enabled: true"] });
  const obs = ok(applySection(FIXTURE, "vision", { "obs.host": "10.0.0.5" }));
  assert.deepEqual(footprint(FIXTURE, obs.text), { removed: ['    host: "obs.lan"'], added: ['    host: "10.0.0.5"'] });
});

// @spec MOD-CFG-015
test("an edit to a key that a running unit overrides warns naming the key and the units; the dashboard section warns about its next start and the new page address", () => {
  const overridden = ok(applySection(FIXTURE, "llm", { provider: "anthropic", model: "x" }, [], { LLM_PROVIDER: ["cortex", "memory"] }));
  assert.equal(overridden.warnings.length, 1);
  assert.match(overridden.warnings[0]!, /llm\.provider/);
  assert.match(overridden.warnings[0]!, /cortex, memory/);
  assert.match(overridden.warnings[0]!, /isolation/);
  assert.deepEqual(ok(applySection(FIXTURE, "llm", { model: "x" }, [], { LLM_PROVIDER: ["cortex"] })).warnings, [], "an unedited overridden key does not warn");
  assert.deepEqual(ok(applySection(FIXTURE, "llm", { provider: "anthropic" })).warnings, [], "no running override, no warning");
  const dash = ok(applySection(FIXTURE, "dashboard", { "inject.ttl_ms": 1000 }));
  assert.equal(dash.warnings.length, 1);
  assert.match(dash.warnings[0]!, /next start/);
  const ports = ok(applySection(FIXTURE, "dashboard", { port: 4000, lan_port: 4001 }));
  assert.equal(ports.warnings.length, 2);
  assert.match(ports.warnings[0]!, /next start/);
  assert.match(ports.warnings[1]!, /address.*4000.*4001/s);
  assert.deepEqual(ok(applySection(FIXTURE, "dashboard", {})).warnings, []);
});

// @spec MOD-CFG-010
test("a key absent from the file is added under its section (block and flow), a missing section is appended", () => {
  const block = ok(applySection(FIXTURE, "brain.salience", { tick_ms: 900 }));
  assert.match(block.text, /        say: \["hi"\]   # trailing\n    tick_ms: 900\n  working_memory_events: 30\n/);
  assert.equal((parseYaml(block.text) as any).brain.salience.tick_ms, 900);
  const flow = ok(applySection(FIXTURE, "chat", { sources: ["fake"] }));
  assert.deepEqual(footprint(FIXTURE, flow.text).removed, ["chat: { twitch: { channel: chan } }"]);
  assert.deepEqual((parseYaml(flow.text) as any).chat.sources, ["fake"]);
  assert.equal((parseYaml(flow.text) as any).chat.twitch.channel, "chan");
  const section = ok(applySection(FIXTURE, "mouth", { "outputs.discord.gain_db": 3 }));
  assert.ok(section.text.startsWith(FIXTURE));
  assert.equal(section.text.slice(FIXTURE.length), "mouth:\n  outputs:\n    discord:\n      gain_db: 3\n");
  const deep = ok(applySection(FIXTURE, "vision", { "obs.width": 640 }));
  assert.equal((parseYaml(deep.text) as any).vision.obs.width, 640);
  const nested = ok(applySection(FIXTURE, "ears", { "http.port": 9000 }));
  assert.equal((parseYaml(nested.text) as any).ears.http.port, 9000);
});

// @spec MOD-CFG-010
test("a leaf section (brain.working_memory_events) is edited at its own path", () => {
  const r = ok(applySection(FIXTURE, "brain.working_memory_events", { working_memory_events: 12 }));
  assert.deepEqual(footprint(FIXTURE, r.text), { removed: ["  working_memory_events: 30"], added: ["  working_memory_events: 12"] });
});

// @spec MOD-CFG-011
test("an array value replaces the whole array, present or absent", () => {
  const reflexes = [{ match: "bye", say: ["later", "cya"], cooldown_ms: 1000 }];
  const r = ok(applySection(FIXTURE, "brain.salience", { reflexes }));
  const parsed = (parseYaml(r.text) as any).brain.salience;
  assert.deepEqual(parsed.reflexes, reflexes);
  assert.equal(parsed.cooldown_ms, 6000);
  assert.match(r.text, /cooldown_ms: 6000   # aligned comment/);
  assert.match(r.text, /\n {2}working_memory_events: 30\n/);
  const lines = ok(applySection(FIXTURE, "voice", { "fallback.lines": ["a: b", "c"] }));
  assert.deepEqual((parseYaml(lines.text) as any).voice.fallback.lines, ["a: b", "c"]);
  const flowArr = ok(applySection(FIXTURE, "brain.salience", { reflexes: [] }));
  assert.deepEqual((parseYaml(flowArr.text) as any).brain.salience.reflexes, []);
});

// @spec MOD-CFG-012
test("the edited file must pass the loader's pipeline; a file already invalid accepts only an edit that makes it valid", () => {
  const bad = applySection(FIXTURE, "voice", { speed: -1 });
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as any).issues.map((i: any) => i.path), ["voice.speed"]);
  const broken = FIXTURE.replace('name: "Coco"', 'name: ""');
  assert.equal(parseConfigText(broken).ok, false);
  const still = applySection(broken, "voice", { speed: 1.2 });
  assert.equal(still.ok, false);
  assert.ok((still as any).issues.some((i: any) => i.path === "cohost.name"));
  const fixed = applySection(broken, "cohost", { name: "Fixed" });
  assert.ok(fixed.ok);
  // the engine-by-voice rule runs too: a Kokoro mix is not a Pocket voice (CFG-SCH-057)
  const mix = applySection(FIXTURE, "voice", { engine: "pocket", voice: "af_bella(2)+af_sky" });
  assert.equal(mix.ok, false);
  assert.ok(applySection(FIXTURE, "voice", { engine: "pocket", voice: "marius" }).ok);
  const v = applySection(FIXTURE, "vision", { enabled: true });
  assert.ok(v.ok); // model is "m"
  // CFG-SCH-025: a blank vision.model loads whether vision is enabled or not (eyes reports it down, not the loader)
  const noModel = applySection(FIXTURE.replace('model: "m"', 'model: ""'), "vision", { enabled: true });
  assert.equal(noModel.ok, true);
});

// @spec MOD-CFG-009, MOD-CFG-012
test("a value the file cannot represent is refused: a placeholder in a literal, a line break in an enum, a type the schema rejects", () => {
  const placeholder = applySection(FIXTURE, "cohost", { name: "${HOME}" });
  assert.equal(placeholder.ok, false);
  assert.match(JSON.stringify(placeholder), /placeholder/);
  assert.equal(applySection(FIXTURE, "llm", { provider: "line1\nline2" }).ok, false);
  assert.equal(applySection(FIXTURE, "cohost", { name: 5 }).ok, false);
  const brace = ok(applySection(FIXTURE, "llm", { model: "a}b" }));
  assert.equal((parseYaml(brace.text) as any).llm.model, "a}b");
  const quoted = ok(applySection(FIXTURE, "llm", { model: 'he said "hi"' }));
  assert.equal((parseYaml(quoted.text) as any).llm.model, 'he said "hi"');
});

// @spec MOD-CFG-014
test("etagOf is the SHA-256 hex of the text", () => {
  assert.equal(etagOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// @spec MOD-CFG-012
test("a no-op edit of the shipped example is valid for every section and changes nothing", () => {
  const text = readFileSync(new URL("../../../config/config.example.yaml", import.meta.url), "utf8");
  assert.ok(parseConfigText(text).ok);
  for (const sec of ["cohost", "llm", "vision", "chat", "brain", "voice", "avatar", "ears", "mouth", "connections", "dashboard", "brain.salience", "brain.memory", "brain.working_memory_events"]) {
    const r = applySection(text, sec, {});
    assert.ok(r.ok && r.text === text, sec);
    for (const [k, v] of Object.entries(readSection(text, sec).keys)) assert.ok(v.secret || v.source, `${sec}.${k}`);
  }
});

// @spec MOD-CFG-012
test("the edited text runs through the loader's placeholder check: a file that holds a placeholder accepts only an edit that removes it", () => {
  const withPlaceholder = FIXTURE.replace('model: "qwen2.5:7b"', 'model: "${LLM_MODEL}"');
  const other = applySection(withPlaceholder, "voice", { speed: 1.2 });
  assert.equal(other.ok, false);
  assert.ok((other as any).issues.some((i: any) => i.path === "llm.model" && /LLM_MODEL/.test(i.message)));
  const fixed = ok(applySection(withPlaceholder, "llm", { model: "qwen2.5:7b" }));
  assert.equal((parseYaml(fixed.text) as any).llm.model, "qwen2.5:7b");
  assert.equal(readSection(withPlaceholder, "llm").keys["model"]!.editable, true);
});
