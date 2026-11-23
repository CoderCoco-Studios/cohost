import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, PRESENTATION } from "../src/index.js";

// Early reply keys (config design, Early reply keys): defaults, ranges, the after_ms < silence_ms rule and the presentation entries.

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {},
});
type Sections = { ears?: Record<string, unknown>; salience?: Record<string, unknown>; cortex?: Record<string, unknown> };
const parse = ({ ears = {}, salience = {}, cortex = {} }: Sections) =>
  ConfigSchema.safeParse({ ...baseCfg(), ears, brain: { salience, cortex } });
const ok = (s: Sections) => {
  const r = parse(s);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  return r.data as unknown as { ears: { early: Record<string, unknown> }; brain: { salience: Record<string, unknown>; cortex: Record<string, unknown> } };
};
const rejects = (s: Sections, key: string) => {
  const r = parse(s);
  assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".").startsWith(key)), `${JSON.stringify(s)} fails naming ${key}`);
};
const early = (e: Record<string, unknown>): Sections => ({ ears: { early: e } });

// @spec CFG-SCH-102, CFG-SCH-103, CFG-SCH-104
test("ears.early defaults to disabled, 250 ms and 2 per utterance", () => {
  const e = ok({}).ears.early;
  assert.equal(e.enabled, false);
  assert.equal(e.after_ms, 250);
  assert.equal(e.max_per_utterance, 2);
});

// @spec CFG-SCH-102
test("ears.early.enabled is a boolean and anything else fails the load naming the key", () => {
  for (const v of [true, false]) assert.equal(ok(early({ enabled: v })).ears.early.enabled, v);
  for (const bad of ["yes", 1, null]) rejects(early({ enabled: bad }), "ears.early.enabled");
});

// @spec CFG-SCH-103
test("ears.early.after_ms is an integer of at least 100", () => {
  for (const good of [100, 250, 699]) assert.equal(ok({ ears: { silence_ms: 700, early: { after_ms: good } } }).ears.early.after_ms, good);
  for (const bad of [99, 0, -1, 150.5, "250", null]) rejects(early({ after_ms: bad }), "ears.early.after_ms");
});

// @spec CFG-SCH-104
test("ears.early.max_per_utterance is an integer from 1 to 5", () => {
  for (const good of [1, 2, 5]) assert.equal(ok(early({ max_per_utterance: good })).ears.early.max_per_utterance, good);
  for (const bad of [0, 6, -1, 1.5, "2", null]) rejects(early({ max_per_utterance: bad }), "ears.early.max_per_utterance");
});

// @spec CFG-SCH-105
test("ears.early.after_ms equal to or above ears.silence_ms fails the load naming ears.early.after_ms", () => {
  rejects({ ears: { silence_ms: 700, early: { after_ms: 700 } } }, "ears.early.after_ms");
  rejects({ ears: { silence_ms: 700, early: { after_ms: 900 } } }, "ears.early.after_ms");
  rejects({ ears: { silence_ms: 200 } }, "ears.early.after_ms"); // default after_ms 250 is not below 200
  rejects({ ears: { silence_ms: 700, early: { enabled: false, after_ms: 700 } } }, "ears.early.after_ms"); // enforced even while disabled
  assert.equal(ok({ ears: { silence_ms: 700, early: { after_ms: 699 } } }).ears.early.after_ms, 699);
  assert.equal(ok({ ears: { silence_ms: 251 } }).ears.early.after_ms, 250);
});

// @spec CFG-SCH-106
test("ears.early.enabled true loads with every ears.stt_engine value", () => {
  // The engines come from the schema itself, so a new engine is covered without editing this list.
  const engines = (ConfigSchema.shape.ears.shape.stt_engine as unknown as { _zod: { def: { out: { options: string[] } } } })._zod.def.out.options;
  assert.ok(engines.length >= 5, "the schema names the stt engines");
  for (const engine of [...engines, ""]) {
    const r = ok({ ears: { stt_engine: engine, early: { enabled: true } } });
    assert.equal(r.ears.early.enabled, true, `stt_engine=${engine}`);
  }
});

// @spec CFG-SCH-107
test("brain.salience interject, interject_chance and interject_yield default to false, 0.15 and true", () => {
  const s = ok({}).brain.salience;
  assert.equal(s.interject, false);
  assert.equal(s.interject_chance, 0.15);
  assert.equal(s.interject_yield, true);
});

// @spec CFG-SCH-107
test("interject and interject_yield are booleans; interject_chance is a number from 0 to 1", () => {
  for (const k of ["interject", "interject_yield"]) {
    for (const v of [true, false]) assert.equal(ok({ salience: { [k]: v } }).brain.salience[k], v);
    for (const bad of ["yes", 1, null]) rejects({ salience: { [k]: bad } }, `brain.salience.${k}`);
  }
  for (const good of [0, 0.5, 1]) assert.equal(ok({ salience: { interject_chance: good } }).brain.salience.interject_chance, good);
  for (const bad of [-0.1, 1.1, "0.5", Number.NaN, null]) rejects({ salience: { interject_chance: bad } }, "brain.salience.interject_chance");
});

// @spec CFG-SCH-108
test("interject_min_gap_ms, interject_min_words and interject_followup_min_words default to 120000, 4 and 3", () => {
  const s = ok({}).brain.salience;
  assert.equal(s.interject_min_gap_ms, 120000);
  assert.equal(s.interject_min_words, 4);
  assert.equal(s.interject_followup_min_words, 3);
});

// @spec CFG-SCH-108
test("interject_min_gap_ms is a positive integer; the two word counts are integers of at least 1", () => {
  for (const k of ["interject_min_gap_ms", "interject_min_words", "interject_followup_min_words"]) {
    assert.equal(ok({ salience: { [k]: 1 } }).brain.salience[k], 1);
    for (const bad of [0, -1, 1.5, "3", null]) rejects({ salience: { [k]: bad } }, `brain.salience.${k}`);
  }
});

// @spec CFG-SCH-109
test("brain.salience.unresolved_limit_ms defaults to 4000 and is a positive integer", () => {
  assert.equal(ok({}).brain.salience.unresolved_limit_ms, 4000);
  assert.equal(ok({ salience: { unresolved_limit_ms: 1 } }).brain.salience.unresolved_limit_ms, 1);
  for (const bad of [0, -1, 1.5, "4000", null]) rejects({ salience: { unresolved_limit_ms: bad } }, "brain.salience.unresolved_limit_ms");
});

// @spec CFG-SCH-110
test("brain.cortex.hold_limit_ms defaults to 5000 and is a positive integer", () => {
  assert.equal(ok({}).brain.cortex.hold_limit_ms, 5000);
  assert.equal(ok({ cortex: { hold_limit_ms: 1 } }).brain.cortex.hold_limit_ms, 1);
  for (const bad of [0, -1, 1.5, "5000", null]) rejects({ cortex: { hold_limit_ms: bad } }, "brain.cortex.hold_limit_ms");
});

const UNITS: Record<string, string | undefined> = {
  "ears.early.enabled": undefined,
  "ears.early.after_ms": "ms",
  "ears.early.max_per_utterance": undefined,
  "brain.salience.interject": undefined,
  "brain.salience.interject_chance": undefined,
  "brain.salience.interject_yield": undefined,
  "brain.salience.interject_min_gap_ms": "ms",
  "brain.salience.interject_min_words": "words",
  "brain.salience.interject_followup_min_words": "words",
  "brain.salience.unresolved_limit_ms": "ms",
  "brain.cortex.hold_limit_ms": "ms",
};

// @spec CFG-SCH-111
test("every early reply key has a presentation entry with a help sentence and a ms or words unit where it is one", () => {
  for (const [key, unit] of Object.entries(UNITS)) {
    const entry = (PRESENTATION.keys as Record<string, { help?: string; unit?: string } | undefined>)[key];
    assert.ok(entry, `${key} has a presentation entry`);
    assert.ok(typeof entry.help === "string" && entry.help.trim().length > 0 && !/[\r\n]/.test(entry.help), `${key} has a one-line help`);
    assert.equal(entry.unit, unit, `${key} unit`);
  }
});

// @spec CFG-SCH-112
test("config.example.yaml lists ears.early, the salience interject keys, unresolved_limit_ms and cortex hold_limit_ms at their defaults", () => {
  const raw = parseYaml(readFileSync(join(repo, "config", "config.example.yaml"), "utf8")) as Record<string, unknown>;
  const at = (p: string) => p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], raw);
  const expected: Array<[string, unknown]> = [
    ["ears.early.enabled", false], ["ears.early.after_ms", 250], ["ears.early.max_per_utterance", 2],
    ["brain.salience.interject", false], ["brain.salience.interject_chance", 0.15], ["brain.salience.interject_yield", true],
    ["brain.salience.interject_min_gap_ms", 120000], ["brain.salience.interject_min_words", 4],
    ["brain.salience.interject_followup_min_words", 3], ["brain.salience.unresolved_limit_ms", 4000],
    ["brain.cortex.hold_limit_ms", 5000],
  ];
  for (const [path, value] of expected) assert.deepEqual(at(path), value, path);
});
