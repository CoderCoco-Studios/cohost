import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substituteEnv, ensureFromExample } from "../src/index.js";

test("substituteEnv: ${VAR}, ${VAR:-default}, unset and empty", () => {
  process.env.T_SET = "set";
  process.env.T_EMPTY = "";
  delete process.env.T_UNSET;
  assert.equal(substituteEnv("${T_SET}|${T_EMPTY}|${T_UNSET}"), "set||");
  assert.equal(substituteEnv("${T_SET:-d}|${T_EMPTY:-d}|${T_UNSET:-d}"), "set|d|d");
  assert.equal(substituteEnv("${T_UNSET:-http://x:8000/v1}"), "http://x:8000/v1");
  assert.equal(substituteEnv("no vars here"), "no vars here");
});

test("ensureFromExample seeds the real file once and then leaves it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-cfg-"));
  process.env.CONFIG_DIR = dir;
  writeFileSync(join(dir, "thing.example.yaml"), "a: 1\n");
  const file = ensureFromExample("thing.yaml", "thing.example.yaml");
  assert.equal(file, join(dir, "thing.yaml"));
  assert.ok(existsSync(file));
  writeFileSync(file, "a: 2\n"); // user edits it
  ensureFromExample("thing.yaml", "thing.example.yaml");
  assert.equal(readFileSync(file, "utf8"), "a: 2\n");
  assert.throws(() => ensureFromExample("missing.yaml", "missing.example.yaml"), /no .*missing\.example\.yaml/);
});

import { ConfigSchema, ModuleSchema, unknownKeys } from "../src/index.js";

test("reflex match must be a valid regex (a bad one would crash-loop salience)", () => {
  const reflexes = ConfigSchema.shape.brain.shape.salience.removeDefault().shape.reflexes;
  assert.equal(reflexes.safeParse([{ match: "(you died", say: ["x"] }]).success, false);
  assert.equal(reflexes.safeParse([{ match: "\\b(you died)\\b", say: ["x"] }]).success, true);
});

test("a hook's llm.provider override requires a model; a model alone is fine", () => {
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama" } }).success, false);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "ollama", model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { model: "qwen" } }).success, true);
  assert.equal(ModuleSchema.safeParse({ kind: "llm", llm: { provider: "", model: "" } }).success, true); // empty = inherit
});

test("unknownKeys names settings the schema dropped (pre-split brain.* keys)", () => {
  const raw = { brain: { tick_ms: 900, cooldown_ms: 1, salience: { tick_ms: 1500, typo_key: 1 }, memory: { recall_k: 3 } } };
  const parsed = { brain: { salience: { tick_ms: 1500 }, memory: { recall_k: 3 } } };
  assert.deepEqual(unknownKeys(raw, parsed).sort(), ["brain.cooldown_ms", "brain.salience.typo_key", "brain.tick_ms"]);
  assert.deepEqual(unknownKeys({ a: 1 }, { a: 1 }), []);
});
