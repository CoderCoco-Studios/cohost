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
