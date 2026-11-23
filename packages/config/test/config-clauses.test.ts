import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, PRESENTATION, SECTION_PATHS, sectionKeyPaths } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {},
});
const cortex = (c: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), brain: { cortex: c } });
type Result = { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
/** A failure whose issue path or message names the key (rejection "with a message naming the key"). */
const namesKey = (r: Result, key: string) =>
  !r.success && r.error!.issues.some((i) => i.path.join(".") === key || i.message.includes(key.split(".").pop()!));
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const example = () => readFileSync(join(repoRoot, "config", "config.example.yaml"), "utf8");
type Cortex = { clause_min_chars: number; clause_max_chars: number; max_clauses: number };
const val = (c: Record<string, unknown>) => {
  const r = cortex(c);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  return r.data.brain.cortex as unknown as Cortex;
};

// @spec CFG-SCH-072
test("brain.cortex.clause_min_chars defaults to 24, is an integer of at least 1, and a bad value names the key", () => {
  assert.equal(val({}).clause_min_chars, 24);
  assert.equal(val({ clause_min_chars: 1 }).clause_min_chars, 1);
  assert.equal(val({ clause_min_chars: 40 }).clause_min_chars, 40);
  for (const bad of [0, -3, 1.5, "24", null]) {
    assert.ok(namesKey(cortex({ clause_min_chars: bad }), "brain.cortex.clause_min_chars"), `clause_min_chars=${String(bad)} names the key`);
  }
});

// @spec CFG-SCH-073
test("brain.cortex.clause_max_chars defaults to 160 and is an integer not below clause_min_chars; a bad value names the key", () => {
  assert.equal(val({}).clause_max_chars, 160);
  assert.equal(val({ clause_max_chars: 300 }).clause_max_chars, 300);
  assert.equal(val({ clause_min_chars: 50, clause_max_chars: 50 }).clause_max_chars, 50, "equal to the minimum is allowed");
  for (const bad of [10, 1.5, "160", null]) {
    assert.ok(namesKey(cortex({ clause_max_chars: bad }), "brain.cortex.clause_max_chars"), `clause_max_chars=${String(bad)} (min 24) names the key`);
  }
  assert.ok(namesKey(cortex({ clause_min_chars: 80, clause_max_chars: 79 }), "brain.cortex.clause_max_chars"), "below an explicit minimum names the key");
});

// @spec CFG-SCH-074
test("brain.cortex.max_clauses defaults to 8 and is an integer from 1 to 16; a bad value names the key", () => {
  assert.equal(val({}).max_clauses, 8);
  for (const v of [1, 16]) assert.equal(val({ max_clauses: v }).max_clauses, v);
  for (const bad of [0, 17, -1, 2.5, "8", null]) {
    assert.ok(namesKey(cortex({ max_clauses: bad }), "brain.cortex.max_clauses"), `max_clauses=${String(bad)} names the key`);
  }
});

// @spec CFG-PRES-015
test("the presentation table gives the three clause keys a label and a help text in the brain.cortex section", () => {
  assert.ok(SECTION_PATHS.includes("brain.cortex" as never), "brain.cortex is a section");
  const keys = sectionKeyPaths("brain.cortex");
  for (const k of ["brain.cortex.clause_min_chars", "brain.cortex.clause_max_chars", "brain.cortex.max_clauses"]) {
    assert.ok(keys.includes(k), `${k} is a key of brain.cortex`);
    const e = PRESENTATION.keys[k];
    assert.ok(e, `${k} has a presentation entry`);
    assert.ok(typeof e.label === "string" && e.label.trim().length > 0 && !/[\r\n]/.test(e.label), `${k}: label`);
    assert.ok(e.help.length >= 40 && /[.!?)]$/.test(e.help) && !/[\r\n]/.test(e.help), `${k}: help`);
  }
});

// @spec CFG-USR-017
test("config.example.yaml sets the input-limit, repetition, clause and affect keys, each with a comment", () => {
  const text = example();
  const want: Array<[string, string]> = [
    ["max_chars", "500"], ["max_name_chars", "40"], ["speech_max_chars", "1000"], ["vision_max_chars", "500"],
    ["working_memory_own_lines", "4"], ["repeat_similarity", "0.8"], ["clause_min_chars", "24"], ["clause_max_chars", "160"],
    ["max_clauses", "8"], ["count_window_ms", "30000"],
  ];
  for (const [key, v] of want) assert.match(text, new RegExp(`^\\s+${key}: ${v}\\s+#\\s*\\S`, "m"), `${key}: ${v} with a comment`);
});
