import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICE_MANIFEST, findService, KNOWN_SERVICES } from "../src/index.js";

test("every manifest entry carries the runtime fields", () => {
  const ids = new Set<string>();
  for (const s of SERVICE_MANIFEST) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.equal(typeof s.composeName, "string");
    assert.ok(s.composeName.length > 0);
    assert.ok(s.pnpmFilter === undefined || s.pnpmFilter === `@cohost/${s.id}`);
    assert.ok(Array.isArray(s.groups));
    assert.ok(s.defaultMode === "resume" || s.defaultMode === "fresh");
    assert.equal(typeof s.infra, "boolean");
    assert.equal(typeof s.self, "boolean");
    assert.equal(typeof s.isolatedEnv, "object");
  }
});

test("every health-tracked service is in the manifest", () => {
  for (const id of KNOWN_SERVICES) assert.ok(findService(id), id);
});

test("flags and defaults match the spec", () => {
  assert.equal(findService("dashboard")!.self, true);
  assert.equal(findService("redis")!.infra, true);
  assert.equal(findService("postgres")!.infra, true);
  for (const id of ["salience", "affect", "cortex", "voice", "avatar"]) assert.equal(findService(id)!.defaultMode, "fresh", id);
  assert.equal(findService("memory")!.defaultMode, "resume");
  assert.deepEqual(findService("memory")!.groups, ["memory", "memory-recall"]);
  assert.deepEqual(findService("cortex")!.groups, ["cortex"]);
});

test("unknown ids are not found", () => {
  assert.equal(findService("nope"), undefined);
  assert.equal(findService("cortex; rm -rf /"), undefined);
});
