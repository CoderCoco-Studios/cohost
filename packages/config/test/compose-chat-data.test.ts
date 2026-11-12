import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Structural check of chat's data mount. Docker is not run: the file is parsed as YAML with merge keys resolved.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as {
  services: Record<string, { volumes?: string[]; build?: unknown }>;
};

// @spec DEPLOY-COMPOSE-022
test("chat mounts ./data/chat beside ./config, and no other application service mounts ./data", () => {
  assert.deepEqual(compose.services.chat!.volumes, ["./config:/app/config", "./data/chat:/app/data/chat"]);
  for (const [name, svc] of Object.entries(compose.services)) {
    if (name === "chat" || !svc.build) continue;
    assert.ok(!(svc.volumes ?? []).some((v) => v.includes("./data")), `${name} has no ./data mount`);
  }
});

// @spec DEPLOY-COMPOSE-020
test("mouth mounts only the shared config directory, publishes no port and waits for redis alone", () => {
  const mouth = compose.services.mouth as { volumes?: string[]; ports?: string[]; depends_on?: Record<string, unknown>; profiles?: string[] };
  assert.deepEqual(mouth.volumes, ["./config:/app/config"]);
  assert.equal(mouth.ports, undefined);
  assert.deepEqual(Object.keys(mouth.depends_on ?? {}), ["redis"]);
  assert.deepEqual(mouth.profiles, ["mouth"]);
});
