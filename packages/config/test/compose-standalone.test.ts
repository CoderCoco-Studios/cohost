import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Structural checks of the deployment half of the standalone dashboard: Compose has no dashboard
// service, voice is published on loopback, containers reach the host dashboard through the host
// gateway, and .env.example and the smoke script match. Docker is not run.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
interface Svc {
  ports?: string[];
  env_file?: string;
  environment?: Record<string, string>;
  extra_hosts?: string[];
  profiles?: string[];
  build?: { args: { SERVICE: string } };
}
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as { services: Record<string, Svc> };
const names = Object.keys(compose.services).sort();

// @spec DEPLOY-COMPOSE-001
test("compose defines infra, one-shots and one app service per services/ directory except dashboard, and no dashboard", () => {
  assert.deepEqual(
    names,
    ["affect", "avatar", "chat", "consolidate", "cortex", "ears", "eyes", "memory", "models", "mouth", "ollama", "postgres", "redis", "reembed", "salience", "stt", "tts", "voice"],
  );
  assert.equal(compose.services.dashboard, undefined);
});

// @spec DEPLOY-COMPOSE-002, DEPLOY-COMPOSE-003
test("app services get no DASHBOARD_URL (uploads reach eyes and ears over Redis) and keep the host-gateway extra host", () => {
  for (const s of ["chat", "voice", "eyes", "ears"]) {
    const svc = compose.services[s]!;
    assert.equal(svc.environment?.DASHBOARD_URL, undefined, s);
    assert.ok(svc.extra_hosts?.includes("host.docker.internal:host-gateway"), `${s} has the host-gateway extra host`);
  }
});

// @spec DEPLOY-COMPOSE-003
test("no service pins CONTROL_ENABLED (the containerised dashboard it guarded is gone)", () => {
  for (const [n, s] of Object.entries(compose.services)) assert.equal(s.environment?.CONTROL_ENABLED, undefined, n);
});

// @spec DEPLOY-COMPOSE-006, DEPLOY-COMPOSE-007
test("every published port is loopback-only, and voice publishes 8700", () => {
  const all = Object.entries(compose.services).flatMap(([n, s]) => (s.ports ?? []).map((p) => [n, p] as const));
  for (const [n, p] of all) assert.match(p, /^127\.0\.0\.1:/, `${n} publishes ${p}`);
  assert.deepEqual(compose.services.voice!.ports, ["127.0.0.1:8700:8700"]);
  assert.deepEqual(all.map(([n]) => n).sort(), ["ollama", "postgres", "redis", "stt", "tts", "voice"]);
});

// @spec DEPLOY-HOST-002
test(".env.example turns control on, carries the empty token, the ports, the host and the docker bin hint", () => {
  const env = readFileSync(root(".env.example"), "utf8");
  const line = (k: string) => env.split("\n").find((l) => l.startsWith(`${k}=`));
  assert.equal(line("CONTROL_ENABLED"), "CONTROL_ENABLED=1");
  assert.match(line("CONTROL_TOKEN") ?? "", /^CONTROL_TOKEN=\s*(#.*)?$/);
  assert.equal(line("DASHBOARD_PORT"), "DASHBOARD_PORT=3000");
  assert.equal(line("DASHBOARD_LAN_PORT"), "DASHBOARD_LAN_PORT=3001");
  assert.equal(line("DASHBOARD_HOST"), "DASHBOARD_HOST=127.0.0.1");
  assert.match(env, /^# COHOST_DOCKER_BIN=/m);
  assert.match(env, /openssl rand -hex 24/);
  assert.match(env, /docker\.exe/);
  assert.match(env, /0\.0\.0\.0/);
});

// @spec DEPLOY-CI-002
test("compose-smoke.sh no longer expects a compose dashboard", () => {
  const sh = readFileSync(root("scripts/compose-smoke.sh"), "utf8");
  assert.match(sh, /SERVICES=\(salience affect avatar\)/);
  const code = sh.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /dashboard/);
});
