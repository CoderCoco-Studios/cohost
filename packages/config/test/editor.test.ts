import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readSection, applySection, sectionJsonSchema, sectionSecrets, schemaAt, etagOf, SECRET_PATHS, ConfigSchema, parseConfigText } from "../src/index.js";

const FIXTURE = `# top comment kept
cohost:
  name: "Coco"                 # the name
  streamer: Chris
llm:
  provider: "\${LLM_PROVIDER:-ollama}"   # preset
  model: "\${LLM_MODEL:-qwen2.5:7b}"  # tag
  embed_model: "\${EMBED_MODEL}"
  openai:
    api_key: "\${LLM_API_KEY}"
vision:
  enabled: \${VISION_ENABLED:-false}
  model: "m"
  obs:
    host: "\${OBS_HOST} and more"
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
const ENV = { EMBED_MODEL: "e" } as NodeJS.ProcessEnv;
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
  assert.deepEqual(voice.properties.engine.enum, ["kokoro", "stub"]);
  assert.equal(voice.properties.engine.default, "kokoro");
  assert.equal(voice.properties.speed.type, "number");
  assert.match(voice.properties.sample_rate.description, /stub/); // @spec CFG-SCH-026
  assert.match((sectionJsonSchema("dashboard") as any).properties.port.description, /PORT environment variable/); // @spec CFG-SCH-026
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
test("exactly the marked keys are secret: SECRET_PATHS, each section's secrets and the schema marks agree", () => {
  assert.ok(["llm.openai.api_key", "llm.claude.api_key"].every((p) => SECRET_PATHS.includes(p)));
  assert.deepEqual(sectionSecrets("llm").sort(), ["claude.api_key", "openai.api_key"]);
  assert.deepEqual(sectionSecrets("voice"), []);
  const marked: string[] = [];
  const walk = (s: any, path: string[]) => {
    if (s["x-secret"]) marked.push(path.join("."));
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) walk(v, [...path, k]);
  };
  for (const sec of ["cohost", "llm", "vision", "chat", "brain", "voice", "avatar", "ears", "mouth", "dashboard"]) walk(sectionJsonSchema(sec), [sec]);
  assert.deepEqual(marked.sort(), [...SECRET_PATHS].sort());
});

// @spec MOD-CFG-004
test("readSection reports each key's source, editability, effective value, raw text and variable", () => {
  const { keys } = readSection(FIXTURE, "llm", { ...ENV, LLM_MODEL: "from-env" });
  assert.deepEqual(keys["provider"], { source: "env-default", editable: true, value: "ollama", raw: "ollama", env: { name: "LLM_PROVIDER", set: false } });
  assert.deepEqual(keys["model"], { source: "env-default", editable: true, value: "from-env", raw: "qwen2.5:7b", env: { name: "LLM_MODEL", set: true } });
  assert.deepEqual(keys["embed_model"], { source: "env", editable: false, value: "e", env: { name: "EMBED_MODEL", set: true } });
  assert.deepEqual(keys["max_tokens"], { source: "default", editable: true, value: 120 });
  const cohost = readSection(FIXTURE, "cohost", ENV).keys;
  assert.deepEqual(cohost["name"], { source: "literal", editable: true, value: "Coco", raw: '"Coco"' });
  assert.deepEqual(cohost["timezone"], { source: "default", editable: true, value: "UTC" });
  const vision = readSection(FIXTURE, "vision", ENV).keys;
  assert.deepEqual(vision["enabled"], { source: "env-default", editable: true, value: false, raw: "false", env: { name: "VISION_ENABLED", set: false } });
  assert.deepEqual(vision["obs.host"], { source: "composite", editable: false, value: " and more", raw: '"${OBS_HOST} and more"' });
  const arr = readSection(FIXTURE, "brain.salience", ENV).keys["reflexes"]!;
  assert.equal(arr.source, "literal");
  assert.deepEqual(arr.value, [{ match: "hello", on: ["chat", "speech", "vision"], say: ["hi"], emotion: "surprised", cooldown_ms: 30000 }]);
  const leaf = readSection(FIXTURE, "brain.working_memory_events", ENV).keys;
  assert.deepEqual(leaf, { working_memory_events: { source: "literal", editable: true, value: 30, raw: "30" } });
});

// @spec MOD-CFG-005
test("a secret key reports only whether it is set, never its value or raw text", () => {
  const set = readSection(FIXTURE, "llm", { ...ENV, LLM_API_KEY: "sk-very-secret" });
  const k = set.keys["openai.api_key"]!;
  assert.deepEqual(k, { source: "env", editable: false, secret: true, set: true, env: { name: "LLM_API_KEY", set: true } });
  assert.doesNotMatch(JSON.stringify(set), /sk-very-secret/);
  assert.deepEqual(readSection(FIXTURE, "llm", ENV).keys["openai.api_key"], { source: "env", editable: false, secret: true, set: false, env: { name: "LLM_API_KEY", set: false } });
  const literal = readSection(FIXTURE.replace('"${LLM_API_KEY}"', "sk-in-file"), "llm", ENV);
  assert.doesNotMatch(JSON.stringify(literal), /sk-in-file/);
  assert.deepEqual(literal.keys["openai.api_key"], { source: "literal", editable: false, secret: true, set: true });
});

// @spec MOD-CFG-006
test("unknown lists the dotted paths under the section that the schema does not define, even when the file is invalid", () => {
  const text = FIXTURE.replace("cooldown_ms: 6000", "cooldown_ms: 6000\n    bogus: 1").replace('match: "hello"', 'match: "hello"\n        cooldwn_ms: 5').replace("name: \"Coco\"", "name: \"\"");
  assert.deepEqual(readSection(text, "brain.salience", ENV).unknown.sort(), ["brain.salience.bogus", "brain.salience.reflexes[0].cooldwn_ms"]);
  assert.deepEqual(readSection(text, "voice", ENV).unknown, []);
});

// @spec MOD-CFG-009
test("a value for an unknown, secret, env or composite key is refused naming each key, and nothing is edited", () => {
  const r = applySection(FIXTURE, "llm", { nope: 1, "openai.api_key": "x", embed_model: "y" }, ENV);
  assert.equal(r.ok, false);
  assert.deepEqual((r as any).issues.map((i: any) => i.path).sort(), ["embed_model", "nope", "openai.api_key"]);
  const c = applySection(FIXTURE, "vision", { "obs.host": "z" }, ENV);
  assert.deepEqual((c as any).issues.map((i: any) => i.path), ["obs.host"]);
});

// @spec MOD-CFG-010
test("a literal keeps its quote style, its comment and every other line", () => {
  const r = ok(applySection(FIXTURE, "cohost", { name: "Zed" }, ENV));
  assert.deepEqual(footprint(FIXTURE, r.text), { removed: ['  name: "Coco"                 # the name'], added: ['  name: "Zed"                 # the name'] });
  const n = ok(applySection(FIXTURE, "brain.salience", { cooldown_ms: 4000 }, ENV));
  assert.deepEqual(footprint(FIXTURE, n.text), { removed: ["    cooldown_ms: 6000   # aligned comment"], added: ["    cooldown_ms: 4000   # aligned comment"] });
});

// @spec MOD-CFG-010, MOD-CFG-015
test("an env-default key keeps ${VAR:-...} and gets the new default; a set variable is named as shadowing it", () => {
  const r = ok(applySection(FIXTURE, "llm", { provider: "anthropic", model: "claude-x" }, { ...ENV, LLM_MODEL: "set-in-env" }));
  assert.deepEqual(footprint(FIXTURE, r.text), {
    removed: ['  provider: "${LLM_PROVIDER:-ollama}"   # preset', '  model: "${LLM_MODEL:-qwen2.5:7b}"  # tag'],
    added: ['  provider: "${LLM_PROVIDER:-anthropic}"   # preset', '  model: "${LLM_MODEL:-claude-x}"  # tag'],
  });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /llm\.model.*LLM_MODEL.*set/);
  const plain = ok(applySection(FIXTURE, "vision", { enabled: true }, ENV));
  assert.deepEqual(footprint(FIXTURE, plain.text), { removed: ["  enabled: ${VISION_ENABLED:-false}"], added: ["  enabled: ${VISION_ENABLED:-true}"] });
});

// @spec MOD-CFG-010
test("a key absent from the file is added under its section (block and flow), a missing section is appended", () => {
  const block = ok(applySection(FIXTURE, "brain.salience", { tick_ms: 900 }, ENV));
  assert.match(block.text, /        say: \["hi"\]   # trailing\n    tick_ms: 900\n  working_memory_events: 30\n/);
  assert.equal((parseYaml(block.text) as any).brain.salience.tick_ms, 900);
  const flow = ok(applySection(FIXTURE, "chat", { source: "fake" }, ENV));
  assert.deepEqual(footprint(FIXTURE, flow.text).removed, ["chat: { twitch: { channel: chan } }"]);
  assert.equal((parseYaml(flow.text) as any).chat.source, "fake");
  assert.equal((parseYaml(flow.text) as any).chat.twitch.channel, "chan");
  const section = ok(applySection(FIXTURE, "mouth", { "outputs.discord.gain_db": 3 }, ENV));
  assert.ok(section.text.startsWith(FIXTURE));
  assert.equal(section.text.slice(FIXTURE.length), "mouth:\n  outputs:\n    discord:\n      gain_db: 3\n");
  const deep = ok(applySection(FIXTURE, "vision", { "obs.width": 640 }, ENV));
  assert.equal((parseYaml(deep.text) as any).vision.obs.width, 640);
  const nested = ok(applySection(FIXTURE, "ears", { "http.port": 9000 }, ENV));
  assert.equal((parseYaml(nested.text) as any).ears.http.port, 9000);
});

// @spec MOD-CFG-010
test("a leaf section (brain.working_memory_events) is edited at its own path", () => {
  const r = ok(applySection(FIXTURE, "brain.working_memory_events", { working_memory_events: 12 }, ENV));
  assert.deepEqual(footprint(FIXTURE, r.text), { removed: ["  working_memory_events: 30"], added: ["  working_memory_events: 12"] });
});

// @spec MOD-CFG-011
test("an array value replaces the whole array, present or absent", () => {
  const reflexes = [{ match: "bye", say: ["later", "cya"], cooldown_ms: 1000 }];
  const r = ok(applySection(FIXTURE, "brain.salience", { reflexes }, ENV));
  const parsed = (parseYaml(r.text) as any).brain.salience;
  assert.deepEqual(parsed.reflexes, reflexes);
  assert.equal(parsed.cooldown_ms, 6000);
  assert.match(r.text, /cooldown_ms: 6000   # aligned comment/);
  assert.match(r.text, /\n {2}working_memory_events: 30\n/);
  const lines = ok(applySection(FIXTURE, "voice", { "fallback.lines": ["a: b", "c"] }, ENV));
  assert.deepEqual((parseYaml(lines.text) as any).voice.fallback.lines, ["a: b", "c"]);
  const flowArr = ok(applySection(FIXTURE, "brain.salience", { reflexes: [] }, ENV));
  assert.deepEqual((parseYaml(flowArr.text) as any).brain.salience.reflexes, []);
});

// @spec MOD-CFG-012
test("the edited file must pass the loader's pipeline; a file already invalid accepts only an edit that makes it valid", () => {
  const bad = applySection(FIXTURE, "voice", { speed: -1 }, ENV);
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as any).issues.map((i: any) => i.path), ["voice.speed"]);
  const broken = FIXTURE.replace('name: "Coco"', 'name: ""');
  assert.equal(parseConfigText(broken, ENV).ok, false);
  const still = applySection(broken, "voice", { speed: 1.2 }, ENV);
  assert.equal(still.ok, false);
  assert.ok((still as any).issues.some((i: any) => i.path === "cohost.name"));
  const fixed = applySection(broken, "cohost", { name: "Fixed" }, ENV);
  assert.ok(fixed.ok);
  // the schema's own cross-key rule runs too
  const v = applySection(FIXTURE, "vision", { enabled: true }, ENV);
  assert.ok(v.ok); // model is "m"
  const noModel = applySection(FIXTURE.replace('model: "m"', 'model: ""'), "vision", { enabled: true }, ENV);
  assert.equal(noModel.ok, false);
});

// @spec MOD-CFG-009, MOD-CFG-012
test("a value the file cannot represent is refused: a placeholder in a literal, a brace in an env default, a type the schema rejects", () => {
  assert.equal(applySection(FIXTURE, "cohost", { name: "${HOME}" }, ENV).ok, false);
  assert.equal(applySection(FIXTURE, "llm", { model: "a}b" }, ENV).ok, false);
  assert.equal(applySection(FIXTURE, "llm", { provider: "line1\nline2" }, ENV).ok, false);
  assert.equal(applySection(FIXTURE, "cohost", { name: 5 }, ENV).ok, false);
  const quoted = ok(applySection(FIXTURE, "llm", { model: 'he said "hi"' }, ENV));
  assert.equal((parseYaml(quoted.text.replace(/\$\{LLM_MODEL:-([^}]*)\}/, "$1")) as any).llm.model, 'he said "hi"');
});

// @spec MOD-CFG-014
test("etagOf is the SHA-256 hex of the text", () => {
  assert.equal(etagOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// @spec MOD-CFG-012
test("a no-op edit of the shipped example is valid for every section and changes nothing", () => {
  const text = readFileSync(new URL("../../../config/config.example.yaml", import.meta.url), "utf8");
  const env = { LLM_MODEL: "", EMBED_MODEL: "", VISION_MODEL: "" } as NodeJS.ProcessEnv;
  assert.ok(parseConfigText(text, env).ok);
  for (const sec of ["cohost", "llm", "vision", "chat", "brain", "voice", "avatar", "ears", "mouth", "dashboard", "brain.salience", "brain.memory", "brain.working_memory_events"]) {
    const r = applySection(text, sec, {}, env);
    assert.ok(r.ok && r.text === text, sec);
    for (const [k, v] of Object.entries(readSection(text, sec, env).keys)) assert.ok(v.source, `${sec}.${k}`);
  }
});
