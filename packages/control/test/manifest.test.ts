import { test } from "node:test";
import assert from "node:assert/strict";
import * as control from "../src/index.js";
import { SERVICE_MANIFEST, findService, appServiceIds, HealthTracker } from "../src/index.js";

// @spec CTRL-MANIFEST-001
test("every manifest entry carries the runtime fields", () => {
  const ids = new Set<string>();
  for (const s of SERVICE_MANIFEST) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.equal(typeof s.composeName, "string");
    assert.ok(s.composeName.length > 0);
    assert.ok(s.pnpmFilter === undefined || s.pnpmFilter === `@cohost/${s.composeName}`); // discord: connector-discord
    assert.ok(Array.isArray(s.groups));
    assert.ok(s.defaultMode === "resume" || s.defaultMode === "fresh");
    assert.equal(typeof s.infra, "boolean");
    assert.equal("self" in s, false, `${s.id} carries no self flag`);
    assert.equal(typeof s.isolatedEnv, "object");
  }
});

// @spec CTRL-MANIFEST-005, MOD-MAN-006
test("the tracker's known list and the CLI's list are the manifest's application units; no separate list exists", () => {
  const apps = SERVICE_MANIFEST.filter((s) => s.pnpmFilter).map((s) => s.id);
  assert.deepEqual(appServiceIds(), apps);
  assert.equal("KNOWN_SERVICES" in control, false);
  const snap = new HealthTracker().snapshot();
  assert.deepEqual(snap.map((s) => s.service), apps);
  const custom = [{ ...SERVICE_MANIFEST[0]!, id: "only", composeName: "only", pnpmFilter: "@cohost/only" }];
  assert.deepEqual(appServiceIds(custom), ["only"]);
});

// @spec CTRL-MANIFEST-002, CTRL-MANIFEST-003
test("flags and defaults match the spec", () => {
  assert.equal(findService("dashboard"), undefined);
  assert.equal(SERVICE_MANIFEST.length, 16);
  assert.deepEqual(SERVICE_MANIFEST.map((s) => s.id), ["chat", "salience", "affect", "memory", "cortex", "voice", "avatar", "eyes", "ears", "mouth", "discord", "redis", "postgres", "ollama", "tts", "stt"]);
  assert.equal(findService("cortex")!.pnpmFilter, "@cohost/cortex");
  assert.equal(findService("redis")!.pnpmFilter, undefined);
  assert.equal(findService("redis")!.infra, true);
  assert.equal(findService("postgres")!.infra, true);
  for (const id of ["salience", "affect", "cortex", "voice", "avatar", "chat", "eyes", "ears", "mouth"]) {
    assert.equal(findService(id)!.defaultMode, "fresh", id);
    assert.deepEqual(findService(id)!.groups, [id], id);
  }
  for (const id of ["memory", "discord", "redis", "postgres", "ollama", "tts", "stt"]) assert.equal(findService(id)!.defaultMode, "resume", id);
  for (const id of ["redis", "postgres", "ollama", "tts", "stt"]) assert.deepEqual(findService(id)!.groups, [], id);
  assert.deepEqual(findService("memory")!.groups, ["memory", "memory-recall", "memory-notes"]);
  assert.deepEqual(findService("cortex")!.groups, ["cortex"]);
  assert.equal(findService("mouth")!.pnpmFilter, "@cohost/mouth");
  assert.equal(findService("mouth")!.composeName, "mouth");
  assert.equal(findService("discord")!.composeName, "connector-discord");
  assert.equal(findService("discord")!.pnpmFilter, "@cohost/connector-discord");
  assert.deepEqual(findService("discord")!.groups, [], "the connector subscribes to no stream");
  assert.equal(findService("discord")!.defaultMode, "resume");
  assert.equal(findService("discord")!.infra, false);
  assert.deepEqual(findService("discord")!.isolatedEnv, { CONNECTIONS_DISCORD_ENABLED: "false" });
  assert.deepEqual(findService("mouth")!.isolatedEnv, { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" });
  assert.deepEqual(findService("ears")!.isolatedEnv, { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" });
  assert.deepEqual(findService("eyes")!.isolatedEnv, { VISION_ENABLED: "false", VISION_ENGINE: "stub" });
});

// @spec CTRL-MANIFEST-004
test("unknown ids are not found", () => {
  assert.equal(findService("nope"), undefined);
  assert.equal(findService("cortex; rm -rf /"), undefined);
});

// @spec CTRL-HEALTH-005
test("the known list is the eleven app services, mouth and discord among them, without dashboard", () => {
  const ids = appServiceIds();
  assert.equal(ids.length, 11);
  assert.ok(ids.includes("mouth"));
  assert.ok(ids.includes("discord"));
  assert.equal(ids.includes("dashboard"), false);
});

// @spec CTRL-MANIFEST-003
test("the isolation presets are exactly the specified ones; every other unit has none", () => {
  const expected: Record<string, Record<string, string>> = {
    chat: { CHAT_SOURCE: "fake" },
    memory: { MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash" },
    cortex: { LLM_PROVIDER: "mock" },
    voice: { VOICE_ENGINE: "stub" },
    avatar: { AVATAR_DRIVER: "null" },
    eyes: { VISION_ENABLED: "false", VISION_ENGINE: "stub" },
    ears: { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" },
    mouth: { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" },
    discord: { CONNECTIONS_DISCORD_ENABLED: "false" },
  };
  for (const s of SERVICE_MANIFEST) assert.deepEqual(s.isolatedEnv, expected[s.id] ?? {}, s.id);
});
