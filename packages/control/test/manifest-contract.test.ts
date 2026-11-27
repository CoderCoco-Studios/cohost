import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES } from "@cohost/bus";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ISOLATION_OVERRIDES, SECRET_PATHS, UNIT_SETTINGS, schemaAt, unitsReadingSection } from "@cohost/config";
import { SERVICE_MANIFEST, findService } from "../src/index.js";

const units = SERVICE_MANIFEST.filter((s) => s.pnpmFilter);
const SERVICE_LEVEL = ["text", "image", "audio"];

// @spec MOD-MAN-001
test("every unit carries config, uses, pause and test (inputs and observe)", () => {
  assert.equal(units.length, 12);
  for (const s of units) {
    assert.ok(Array.isArray(s.config) && s.config.length > 0, `${s.id} config`);
    assert.ok(Array.isArray(s.uses), `${s.id} uses`);
    assert.equal(typeof s.pause, "boolean", `${s.id} pause`);
    assert.ok(Array.isArray(s.test.inputs) && s.test.inputs.length > 0, `${s.id} test.inputs`);
    assert.ok(Array.isArray(s.test.observe) && s.test.observe.length > 0, `${s.id} test.observe`);
  }
  for (const s of SERVICE_MANIFEST.filter((x) => !x.pnpmFilter)) {
    assert.deepEqual([s.config, s.uses, s.pause, s.test], [[], [], false, { inputs: [], observe: [] }], `${s.id} carries empty declarations`);
  }
});

// @spec MOD-MAN-002
test("config sections are the declared ones and each is a path of ConfigSchema", () => {
  const want: Record<string, string[]> = {
    chat: ["chat", "viewer_text", "cohost"], eyes: ["vision", "llm", "network"], ears: ["ears", "network"],
    salience: ["brain.salience", "brain.cortex", "brain.working_memory_events", "brain.working_memory_own_lines", "brain.input_limits", "viewer_text", "cohost", "llm", "tools"],
    affect: ["brain.affect", "brain.input_limits", "viewer_text", "cohost", "llm"],
    memory: ["brain.memory", "brain.input_limits", "viewer_text", "cohost", "llm"],
    cortex: ["brain.cortex", "brain.memory", "brain.salience", "brain.working_memory_events", "brain.working_memory_own_lines", "brain.input_limits", "viewer_text", "cohost", "llm", "tools"],
    voice: ["voice", "network"], mouth: ["mouth"], avatar: ["avatar"], "connector-discord": ["connections"],
    tools: ["tools", "cohost", "chat", "viewer_text", "network"],
  };
  for (const [id, config] of Object.entries(want)) assert.deepEqual(findService(id)!.config, [...config, "logging"], id);
  for (const s of units) for (const sec of s.config) assert.ok(schemaAt(sec), `${s.id}: ${sec} is not a config path`);
});

// @spec MOD-MAN-003
test("uses are the declared ones and requires is a subset of uses", () => {
  const want: Record<string, string[]> = { salience: ["affect", "cortex"], cortex: ["salience", "affect", "memory", "tools"], tools: ["memory"], mouth: ["voice"], avatar: ["voice"] };
  for (const s of units) assert.deepEqual(s.uses, want[s.id] ?? [], s.id);
  for (const s of SERVICE_MANIFEST) for (const r of s.requires ?? []) assert.ok(s.uses.includes(r), `${s.id} requires ${r} without using it`);
});

// @spec MOD-MAN-004
test("pause is true for salience, cortex and affect only", () => {
  assert.deepEqual(SERVICE_MANIFEST.filter((s) => s.pause).map((s) => s.id).toSorted(), ["affect", "cortex", "salience"]);
});

// @spec MOD-MAN-005
test("test inputs and observed types are the declared ones and name registered bus events", () => {
  const inputs: Record<string, string[]> = {
    chat: ["text"], eyes: ["image"], ears: ["audio"],
    salience: ["chat.message", "speech.heard", "vision.summary"],
    affect: ["chat.message", "speech.heard", "vision.summary", "brain.say"],
    memory: ["chat.message", "memory.recall.request"],
    cortex: ["attention.focus"], voice: ["brain.say"], mouth: ["brain.say"], avatar: ["brain.say", "affect.state"], "connector-discord": ["audio"], tools: ["text"],
  };
  const observe: Record<string, string[]> = {
    chat: ["chat.message", "inject.result"], eyes: ["vision.summary", "inject.result"], ears: ["speech.heard", "inject.result"],
    salience: ["attention.focus", "brain.say"], affect: ["affect.state"], memory: ["memory.recall.reply", "memory.viewer"],
    cortex: ["brain.status", "brain.say"], voice: ["voice.utterance", "voice.playing", "voice.done"],
    mouth: ["voice.playing", "voice.done", "voice.failed"], avatar: ["avatar.state"], "connector-discord": ["inject.result"], tools: ["tool.result", "inject.result"],
  };
  assert.ok(findService("tools"), "the tools unit is declared");
  const registered = new Set<string>(EVENT_TYPES);
  const barred = (t: string) => t === "service.heartbeat" || t === "service.lifecycle" || /^memory\.(notes|viewers)\./.test(t);
  for (const s of units) {
    assert.deepEqual(s.test.inputs, inputs[s.id], `${s.id} inputs`);
    assert.deepEqual(s.test.observe, observe[s.id], `${s.id} observe`);
    for (const t of [...s.test.inputs.filter((i) => !SERVICE_LEVEL.includes(i)), ...s.test.observe]) {
      assert.ok(registered.has(t) && !barred(t), `${s.id}: ${t} is not an allowed bus event type`);
    }
  }
});

// @spec CFG-ISO-006
test("every name in a unit's isolatedEnv is an isolation override of the config package, and every override is used by a unit", () => {
  const used = new Set(SERVICE_MANIFEST.flatMap((s) => Object.keys(s.isolatedEnv)));
  for (const name of used) assert.ok(Object.hasOwn(ISOLATION_OVERRIDES, name), `${name} is in ISOLATION_OVERRIDES`);
  assert.deepEqual([...used].toSorted(), Object.keys(ISOLATION_OVERRIDES).toSorted());
});

// @spec MOD-MAN-013
test("no unit lists tts-pocket, stt-nemotron or stt-kyutai among its uses or requires, so a profile that is not enabled never annotates voice or ears", () => {
  for (const id of ["tts-pocket", "stt-nemotron", "stt-kyutai"]) {
    assert.ok(findService(id), `${id} is in the manifest`);
    for (const s of SERVICE_MANIFEST) {
      assert.ok(!s.uses.includes(id), `${s.id} uses ${id}`);
      assert.ok(!(s.requires ?? []).includes(id), `${s.id} requires ${id}`);
    }
  }
  assert.deepEqual(findService("voice")!.uses, []);
  assert.deepEqual(findService("ears")!.uses, []);
});

const OPENAI_LLM = ["llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"];
const TOOLS_SECRETS = ["tools.servers.*.token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.youtube.api_key"];

// @spec MOD-MAN-015
test("every unit carries a secrets list of SECRET_PATHS entries, each inside a section its config names, with no path twice", () => {
  const known = new Set(SECRET_PATHS); // the wildcard tools.servers.*.token counts as one entry
  const inside = (path: string, sections: readonly string[]) => sections.some((sec) => path === sec || path.startsWith(`${sec}.`));
  for (const s of SERVICE_MANIFEST) {
    assert.ok(Array.isArray(s.secrets), `${s.id} secrets`);
    for (const p of s.secrets) {
      assert.ok(known.has(p), `${s.id}: ${p} is not a path of SECRET_PATHS`);
      assert.ok(inside(p, s.config), `${s.id}: ${p} lies outside every section its config names`);
    }
    assert.equal(new Set(s.secrets).size, s.secrets.length, `${s.id} lists a path twice`);
  }
  for (const s of SERVICE_MANIFEST.filter((x) => !x.pnpmFilter)) assert.deepEqual(s.secrets, [], `${s.id}: a compose-only service reads none`);
});

// @spec MOD-MAN-015
test("the initial declarations: each unit lists the credentials its code reads and no more (the list is explicit, not every secret under its sections)", () => {
  const want: Record<string, string[]> = {
    chat: ["chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token", "chat.youtube.api_key"],
    eyes: ["vision.obs.password", ...OPENAI_LLM],
    ears: ["ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key"],
    salience: OPENAI_LLM, affect: OPENAI_LLM, memory: OPENAI_LLM, cortex: OPENAI_LLM,
    tools: TOOLS_SECRETS,
    voice: ["voice.openai.api_key"],
    "connector-discord": ["connections.discord.token"],
    mouth: [], avatar: [],
  };
  for (const [id, secrets] of Object.entries(want)) assert.deepEqual([...findService(id)!.secrets].toSorted(), [...secrets].toSorted(), id);
  const declared = new Set(SERVICE_MANIFEST.flatMap((s) => s.secrets));
  assert.ok(!declared.has("voice.pocket.hf_token"), "the Pocket token reaches only the tts-pocket engine container, through its own file");
  assert.ok(!SERVICE_MANIFEST.find((s) => s.id === "salience")!.secrets.includes("tools.servers.*.token"), "salience and cortex read the tools section and use no MCP token");
});

// @spec TOOL-SVC-010
test("the tools unit declares secrets as exactly tools.servers.*.token, chat.twitch.client_id, chat.twitch.client_secret and chat.youtube.api_key", () => {
  assert.deepEqual([...findService("tools")!.secrets].toSorted(), [...TOOLS_SECRETS].toSorted());
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Every source file under a unit's `src/`, tests excluded. */
function unitSources(id: string, dir = join(repo, "services", id, "src"), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) unitSources(id, p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// @spec MOD-MAN-016
test("documents: cortex and memory read personality, avatar reads expressions, every other unit none", () => {
  const want: Record<string, string[]> = { cortex: ["personality"], memory: ["personality"], avatar: ["expressions"] };
  for (const s of SERVICE_MANIFEST) assert.deepEqual([...s.documents], want[s.id] ?? [], s.id);
});

// @spec MOD-MAN-016
test("a unit whose source loads a document its documents list lacks fails", () => {
  const LOADERS: Record<string, RegExp> = {
    personality: /\b(?:loadPersonality|loadProjectionPersonality)\b/,
    expressions: /\b(?:loadExpressions|loadProjectionExpressions)\b/,
  };
  const offenders: string[] = [];
  for (const s of units) {
    const text = unitSources(s.id).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const [doc, re] of Object.entries(LOADERS)) {
      if (re.test(text) && !s.documents.includes(doc as never)) offenders.push(`${s.id} loads ${doc}`);
    }
  }
  assert.deepEqual(offenders, []);
  // The check sees the loads it guards against: cortex, memory and avatar each load their document.
  for (const [id, doc] of [["cortex", "personality"], ["memory", "personality"], ["avatar", "expressions"]] as const) {
    assert.match(unitSources(id).map((f) => readFileSync(f, "utf8")).join("\n"), LOADERS[doc]!, `${id} loads ${doc}`);
  }
});

// @spec MOD-MAN-017
test("stateKey is true for chat and avatar and false for every other unit", () => {
  for (const s of SERVICE_MANIFEST) assert.equal(s.stateKey, s.id === "chat" || s.id === "avatar", s.id);
});

// @spec MOD-MAN-016, MOD-MAN-017, STORE-TASK-002
test("the manifest takes every unit's settings declarations from UNIT_SETTINGS in @cohost/config, the one copy, in the same order", () => {
  assert.deepEqual(SERVICE_MANIFEST.map((s) => s.id), UNIT_SETTINGS.map((u) => u.id));
  for (const u of UNIT_SETTINGS) {
    const s = findService(u.id)!;
    assert.deepEqual(
      { composeName: s.composeName, config: s.config, secrets: s.secrets, documents: s.documents, stateKey: s.stateKey },
      { composeName: u.composeName, config: u.config, secrets: u.secrets, documents: u.documents, stateKey: u.stateKey }, u.id,
    );
  }
  assert.deepEqual(unitsReadingSection("brain.memory"), ["memory", "cortex"]);
  assert.deepEqual(unitsReadingSection("dashboard"), []);
});
