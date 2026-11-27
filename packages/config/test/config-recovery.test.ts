import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, canSetKey, loadConfig, schemaAt, type ConfigProblem } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, projectionDir } from "./helpers/config-sandbox.js";

isolateEnv();

/** The error `loadConfig` throws for the projection in `dir`. */
const loadError = (dir: string): unknown => {
  try { loadConfig({ dir, force: true }); } catch (e) { return e; }
  return assert.fail("expected the load to fail");
};

const kinds = (problems: readonly ConfigProblem[]): string[] => problems.map((p) => `${p.kind} ${p.path}`);

// @spec CFG-RCV-001
test("a schema failure is a ConfigError of kind schema, list indexes written [i], each problem in the message", () => {
  const dir = projectionDir(MINIMAL_YAML.replace("cohost: { name: Coco, streamer: Chris }", "cohost: { name: \"\", streamer: Chris }").replace("brain: {}", "brain: { salience: { reflexes: [{ match: 3 }] } }"));
  const e = loadError(dir);
  assert.ok(e instanceof ConfigError);
  assert.ok(e instanceof Error);
  assert.ok(e.message.startsWith(`Invalid ${join(dir, "settings.json")}:\n  `), e.message);
  assert.ok(e.problems.length >= 2);
  assert.ok(e.problems.every((p) => p.kind === "schema"));
  assert.ok(e.problems.some((p) => p.path === "cohost.name"));
  assert.ok(e.problems.some((p) => p.path.startsWith("brain.salience.reflexes[0]")), kinds(e.problems).join(", "));
  assert.ok(!e.problems.some((p) => /\.\d+(\.|$)/.test(p.path)), "no list index is written as a dotted number");
  assert.ok(e.problems.every((p) => p.file === join(dir, "settings.json")));
  assert.ok(e.problems.every((p) => e.message.includes(`: ${p.message}`)), "each problem is in the message");
});

// @spec CFG-RCV-001, CFG-LOAD-007
test("a projection that is not JSON is a ConfigError of kind syntax at the empty path; an isolation failure stays a plain Error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  writeFileSync(join(dir, "settings.json"), "{ not json");
  const s = loadError(dir);
  assert.ok(s instanceof ConfigError);
  assert.deepEqual(s.problems.map((p) => [p.kind, p.path]), [["syntax", ""]]);

  process.env.COHOST_ISOLATION = "not json";
  const iso = loadError(projectionDir(MINIMAL_YAML));
  assert.ok(iso instanceof Error);
  assert.ok(!(iso instanceof ConfigError), "COHOST_ISOLATION is not a fault of the settings");
});

// @spec STORE-RCV-002
test("canSetKey accepts a key and a single-value list entry, and refuses a credential, a section and a key this build lacks", () => {
  assert.equal(canSetKey("llm.model"), true);
  assert.equal(canSetKey("chat.ignore_users[1]"), true);
  assert.equal(canSetKey("llm.openai.api_key"), false);
  assert.equal(canSetKey("llm"), false);
  assert.equal(canSetKey("llm.no_such_key"), false);
});

// @spec MOD-CFG-001
test("schemaAt names only the schema's own keys", () => {
  for (const path of ["__proto__", "constructor", "llm.toString", "llm.hasOwnProperty"]) assert.equal(schemaAt(path), undefined, path);
  assert.ok(schemaAt("llm.model"));
});
