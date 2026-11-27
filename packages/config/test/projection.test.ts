import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError, loadProjection, loadProjectionExpressions, loadProjectionPersonality, outboxPath, readPersonalityOutbox, sha256Hex,
  writePersonalityOutbox, earsListenerVerifier, UNIT_SETTINGS, parseYaml,
} from "../src/index.js";
import { captureWarnings, isolateEnv, repo } from "./helpers/config-sandbox.js";

isolateEnv();

/** A projection directory holding `settings.json` for `unit` with these sections and documents. */
function projection(unit: string, sections: Record<string, unknown>, documents: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ format: 1, unit, revision: 7, sections, documents, ...extra }));
  return dir;
}

/** The shipped example's value of each section path, as the seed stores it. */
const example = parseYaml(readFileSync(join(repo, "config", "config.example.yaml"), "utf8")) as Record<string, unknown>;
const exampleSection = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], example);
/** The projection of `unit` the seed would give: exactly its declared sections, from the shipped example. */
const seedSections = (unit: string): Record<string, unknown> =>
  Object.fromEntries(UNIT_SETTINGS.find((u) => u.id === unit)!.config.map((s) => [s, exampleSection(s) ?? {}]));

// @spec CFG-LOAD-001
test("loadProjection returns each held section validated with its defaults filled in, cached until force", () => {
  const dir = projection("voice", { voice: { speed: 1.1 }, network: { lan: [] }, logging: {} });
  const cfg = loadProjection({ dir, force: true });
  assert.equal(cfg.voice.speed, 1.1);
  assert.equal(typeof cfg.voice.engine, "string", "a key the section does not hold takes its schema default");
  assert.deepEqual(cfg.network?.lan, []);
  assert.equal(loadProjection({ dir }), cfg, "cached");
  assert.notEqual(loadProjection({ dir, force: true }), cfg);
});

// @spec CFG-LOAD-001
test("reading a section the projection does not hold throws, naming the section and the unit; brain parts likewise", () => {
  const dir = projection("affect", { "brain.affect": {}, "brain.input_limits": {}, viewer_text: {}, cohost: { name: "Coco", streamer: "Chris" }, llm: { model: "m", embed_model: "e" }, logging: {} });
  const cfg = loadProjection({ dir, force: true });
  assert.equal(cfg.cohost.name, "Coco");
  assert.ok(cfg.brain.affect, "a held brain part reads");
  assert.throws(() => cfg.chat, /affect read the settings section chat, which its projection does not hold/);
  assert.throws(() => cfg.brain.memory, /affect read the settings section brain\.memory/);
  assert.throws(() => cfg.brain.working_memory_events, /brain\.working_memory_events/);
  assert.deepEqual(Object.keys(cfg).toSorted(), ["brain", "cohost", "llm", "logging", "viewer_text"], "only the held sections are keys");
});

// @spec CFG-LOAD-001, CFG-LOAD-003
test("every unit's projection of the shipped example's declared sections loads, and every other section throws", () => {
  for (const u of UNIT_SETTINGS.filter((x) => x.config.length > 0)) {
    const cfg = loadProjection({ dir: projection(u.id, seedSections(u.id)), force: true }) as unknown as Record<string, Record<string, unknown>>;
    for (const s of u.config) {
      const [top, sub] = s.split(".");
      assert.doesNotThrow(() => (sub ? cfg[top!]![sub] : cfg[top!]), `${u.id} reads ${s}`);
    }
    const other = ["chat", "voice", "brain.memory", "dashboard"].find((s) => !u.config.includes(s))!;
    const [top, sub] = other.split(".");
    assert.throws(() => (sub ? cfg[top!]![sub] : cfg[top!]), new RegExp(`${u.id} read the settings section ${other.replace(".", "\\.")}`), u.id);
  }
});

// @spec CFG-LOAD-003
test("a held section that fails validation throws Invalid <file>: listing every failing key; a refinement across brain parts counts only when both are held", () => {
  const dir = projection("voice", { voice: { speed: "fast" }, network: { lan: ["not a host!"] }, logging: {} });
  assert.throws(() => loadProjection({ dir, force: true }), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, new RegExp(`^Invalid ${join(dir, "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
    assert.match(e.message, /voice\.speed: /);
    assert.match(e.message, /network\.lan\[0\]|network\.lan\.0/);
    return true;
  });
  // own_lines 30 against the default 24 events: not checked while the unit does not hold brain.working_memory_events.
  assert.doesNotThrow(() => loadProjection({ dir: projection("x", { "brain.working_memory_own_lines": 30 }), force: true }));
  assert.throws(
    () => loadProjection({ dir: projection("x", { "brain.working_memory_own_lines": 30, "brain.working_memory_events": 24 }), force: true }),
    /brain\.working_memory_own_lines: must be less than/,
  );
  // A refinement inside one brain part is checked with that part.
  assert.throws(() => loadProjection({ dir: projection("x", { "brain.cortex": { clause_min_chars: 50, clause_max_chars: 40 } }), force: true }), /brain\.cortex\.clause_max_chars/);
});

// @spec CFG-LOAD-002, CFG-LOAD-005
test("nulls are dropped so defaults apply; unknown keys and unknown sections load with exactly one warning naming them", () => {
  const dir = projection("voice", { voice: { speed: null, tpyo: 1 }, network: {}, logging: {}, nonsense: {} });
  let cfg!: ReturnType<typeof loadProjection>;
  const warnings = captureWarnings(() => { cfg = loadProjection({ dir, force: true }); });
  assert.equal(typeof cfg.voice.speed, "number");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /voice\.tpyo/);
  assert.match(warnings[0]!, /nonsense/);
});

// @spec CFG-LOAD-007
test("a missing settings.json, one that is not JSON or not a format-1 projection fails naming the file and who writes it", () => {
  const empty = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  assert.throws(() => loadProjection({ dir: empty, force: true }), /settings\.json does not exist: .*written by the dashboard, cohostctl or the unit runner/);
  writeFileSync(join(empty, "settings.json"), "{not json");
  assert.throws(() => loadProjection({ dir: empty, force: true }), /settings\.json is not JSON/);
  writeFileSync(join(empty, "settings.json"), JSON.stringify({ format: 2, unit: "voice", revision: 1, sections: {} }));
  assert.throws(() => loadProjection({ dir: empty, force: true }), /not a projection of format 1/);
});

// @spec CFG-ISO-007
test("an isolation override applies to a held section and is validated like a stored value; one for a section not held is skipped", () => {
  const dir = projection("voice", { voice: {}, network: {}, logging: {} });
  const cfg = loadProjection({ dir, force: true, isolation: JSON.stringify({ VOICE_ENGINE: "stub", CHAT_SOURCES: "[fake]" }) });
  assert.equal(cfg.voice.engine, "stub");
  assert.throws(() => cfg.chat, /voice read the settings section chat/, "the chat override created no chat section");
  assert.throws(() => loadProjection({ dir, force: true, isolation: JSON.stringify({ VOICE_ENGINE: "nope" }) }), /voice\.engine: [\s\S]*COHOST_ISOLATION overrides applied: VOICE_ENGINE/);
});

// @spec CFG-SEC-002, CFG-SEC-016, CFG-SEC-017, CFG-SEC-020
test("delivered credentials are set at their secret paths after validation; a token for an absent server, a bad verifier or a path outside the held sections is dropped with a warning naming the path, never the value", () => {
  const dir = projection("ears", { ears: {}, network: {}, logging: {} });
  const hex = "a".repeat(64);
  let cfg!: ReturnType<typeof loadProjection>;
  let warnings = captureWarnings(() => {
    cfg = loadProjection({ dir, force: true, credentials: { "ears.openai.api_key": "sk-ears", "ears.http.verifier": hex, "llm.openai.api_key": "sk-secret-value" } });
  });
  assert.equal(cfg.ears.openai.api_key, "sk-ears");
  assert.equal(earsListenerVerifier(cfg), hex);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /llm\.openai\.api_key/);
  assert.doesNotMatch(warnings.join("\n"), /sk-secret-value|sk-ears/);
  warnings = captureWarnings(() => { cfg = loadProjection({ dir, force: true, credentials: { "ears.http.verifier": "XYZ-not-hex" } }); });
  assert.equal(earsListenerVerifier(cfg), undefined);
  assert.match(warnings.join("\n"), /ears\.http\.verifier/);
  assert.doesNotMatch(warnings.join("\n"), /XYZ-not-hex/);

  const tools = projection("tools", { tools: { servers: { docs: { url: "https://example.com/mcp" } } }, cohost: { name: "a", streamer: "b" }, chat: {}, viewer_text: {}, network: {}, logging: {} });
  warnings = captureWarnings(() => {
    cfg = loadProjection({ dir: tools, force: true, credentials: { "tools.servers.docs.token": "t-docs", "tools.servers.gone.token": "t-gone" } });
  });
  assert.equal(cfg.tools.servers.docs!.token, "t-docs");
  assert.equal(cfg.tools.servers.gone, undefined, "a credential creates no entry the settings lack");
  assert.match(warnings.join("\n"), /tools\.servers\.gone\.token/);
  assert.doesNotMatch(warnings.join("\n"), /t-gone/);
});

// @spec CFG-USR-001, CFG-USR-002
test("the documents are read from the projection on every call; an absent personality throws naming the unit, absent expressions are empty, invalid ones throw Invalid <file>:", () => {
  const dir = projection("cortex", {}, { personality: "# Coco\n", expressions: { vtube_studio: { happy: "Smile" } } });
  assert.equal(loadProjectionPersonality(dir), "# Coco\n");
  assert.equal(loadProjectionExpressions(dir).vtube_studio!.happy, "Smile");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ format: 1, unit: "cortex", revision: 8, sections: {}, documents: { personality: "# Changed\n" } }));
  assert.equal(loadProjectionPersonality(dir), "# Changed\n", "not cached");
  assert.deepEqual(loadProjectionExpressions(dir), {});
  const none = projection("chat", {});
  assert.throws(() => loadProjectionPersonality(none), /projection of chat holds no personality document/);
  const bad = projection("avatar", {}, { expressions: { browser: { happy: "x".repeat(65) } } });
  assert.throws(() => loadProjectionExpressions(bad), /^Error: Invalid .*settings\.json:\n {2}expressions\.browser\.happy: /);
});

// @spec STORE-OUT-001
test("the reflection outbox holds {base, text}, base the SHA-256 of the text read, written 0600 through a rename under <data>/memory", () => {
  const data = mkdtempSync(join(tmpdir(), "cohost-data-"));
  assert.equal(readPersonalityOutbox(data), undefined);
  const file = writePersonalityOutbox("# Coco\n", "# Coco\n\n## Learned\n- likes frogs\n", data);
  assert.equal(file, outboxPath(data));
  assert.equal(file, join(data, "memory", "personality-outbox.json"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(data, "memory")), ["personality-outbox.json"], "no temporary file left");
  const o = readPersonalityOutbox(data)!;
  assert.equal(o.base, sha256Hex("# Coco\n"));
  assert.match(o.base, /^[0-9a-f]{64}$/);
  assert.equal(o.text, "# Coco\n\n## Learned\n- likes frogs\n");
  writeFileSync(file, "{\"base\":\"x\"}");
  assert.throws(() => readPersonalityOutbox(data), /is not a personality outbox/);
  assert.ok(existsSync(file));
});
