import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Mount = string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
interface Svc { ports?: unknown; volumes?: Mount[]; build?: { args?: { SERVICE?: string } } }
const compose = parse(readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8"), { merge: true }) as { services: Record<string, Svc>; volumes?: Record<string, unknown> };

// @spec DEPLOY-COMPOSE-028
test("the avatar service publishes no port and mounts only its projection, ./data/logs and ./data/avatar", () => {
  const avatar = compose.services.avatar!;
  assert.equal(avatar.build?.args?.SERVICE, "avatar");
  assert.equal(avatar.ports, undefined, "no published port");
  assert.deepEqual(avatar.volumes, [
    "./data/logs:/app/data/logs",
    "./data/avatar:/app/data/avatar",
    { type: "bind", source: "./data/projections/avatar", target: "/app/config", read_only: true, bind: { create_host_path: false } },
  ], "no model directory");
  assert.equal(Object.keys(compose.volumes ?? {}).some((v) => /avatar|model/i.test(v)), false, "no named avatar or model volume");
});
