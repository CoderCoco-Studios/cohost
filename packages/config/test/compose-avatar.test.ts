import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Svc { ports?: unknown; volumes?: string[]; build?: { args?: { SERVICE?: string } } }
const compose = parse(readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8"), { merge: true }) as { services: Record<string, Svc>; volumes?: Record<string, unknown> };

// @spec DEPLOY-COMPOSE-028
test("the avatar service publishes no port and mounts only the shared ./config and ./data/logs binds", () => {
  const avatar = compose.services.avatar!;
  assert.equal(avatar.build?.args?.SERVICE, "avatar");
  assert.equal(avatar.ports, undefined, "no published port");
  assert.deepEqual(avatar.volumes, ["./config:/app/config", "./data/logs:/app/data/logs"], "no data volume, no model directory");
  assert.equal(Object.keys(compose.volumes ?? {}).some((v) => /avatar|model/i.test(v)), false, "no named avatar or model volume");
});
