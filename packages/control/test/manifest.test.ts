import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICE_MANIFEST, findService, KNOWN_SERVICES } from "../src/index.js";

// @spec CTRL-MANIFEST-001
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
    assert.equal("self" in s, false, `${s.id} carries no self flag`);
    assert.equal(typeof s.isolatedEnv, "object");
  }
});

// @spec CTRL-MANIFEST-005
test("every health-tracked service is in the manifest", () => {
  for (const id of KNOWN_SERVICES) assert.ok(findService(id), id);
});

// @spec CTRL-MANIFEST-002, CTRL-MANIFEST-003
test("flags and defaults match the spec", () => {
  assert.equal(findService("dashboard"), undefined);
  assert.equal(SERVICE_MANIFEST.length, 15);
  assert.deepEqual(SERVICE_MANIFEST.map((s) => s.id), ["chat", "salience", "affect", "memory", "cortex", "voice", "avatar", "eyes", "ears", "mouth", "redis", "postgres", "ollama", "tts", "stt"]);
  assert.equal(findService("cortex")!.pnpmFilter, "@cohost/cortex");
  assert.equal(findService("redis")!.pnpmFilter, undefined);
  assert.equal(findService("redis")!.infra, true);
  assert.equal(findService("postgres")!.infra, true);
  for (const id of ["salience", "affect", "cortex", "voice", "avatar", "chat", "eyes", "ears", "mouth"]) {
    assert.equal(findService(id)!.defaultMode, "fresh", id);
    assert.deepEqual(findService(id)!.groups, [id], id);
  }
  for (const id of ["memory", "redis", "postgres", "ollama", "tts", "stt"]) assert.equal(findService(id)!.defaultMode, "resume", id);
  for (const id of ["redis", "postgres", "ollama", "tts", "stt"]) assert.deepEqual(findService(id)!.groups, [], id);
  assert.deepEqual(findService("memory")!.groups, ["memory", "memory-recall", "memory-notes"]);
  assert.deepEqual(findService("cortex")!.groups, ["cortex"]);
  assert.equal(findService("mouth")!.pnpmFilter, "@cohost/mouth");
  assert.equal(findService("mouth")!.composeName, "mouth");
  assert.deepEqual(findService("mouth")!.isolatedEnv, { MOUTH_DISCORD_ENABLED: "false" });
  assert.deepEqual(findService("ears")!.isolatedEnv, { EARS_SOURCE: "off" });
});

// @spec CTRL-MANIFEST-004
test("unknown ids are not found", () => {
  assert.equal(findService("nope"), undefined);
  assert.equal(findService("cortex; rm -rf /"), undefined);
});

// @spec CTRL-HEALTH-005
test("the known list is the ten app services, mouth among them, without dashboard", () => {
  assert.equal(KNOWN_SERVICES.length, 10);
  assert.ok((KNOWN_SERVICES as readonly string[]).includes("mouth"));
  assert.equal((KNOWN_SERVICES as readonly string[]).includes("dashboard"), false);
});
