import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  build?: { context?: string; dockerfile?: string; args: { SERVICE: string } };
  restart?: string;
  volumes?: string[];
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: string[]; interval?: string };
}
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as { services: Record<string, Svc> };
const names = Object.keys(compose.services).sort();

// @spec DEPLOY-COMPOSE-001
test("compose defines infra, one-shots and one app service per services/ directory except dashboard, and no dashboard", () => {
  assert.deepEqual(
    names,
    ["affect", "avatar", "chat", "connector-discord", "consolidate", "cortex", "ears", "eyes", "memory", "models", "mouth", "ollama", "postgres", "redis", "reembed", "salience", "stt", "tts", "voice"],
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

/** The application services: one per `services/` directory except the host-run dashboard. */
const appServices = readdirSync(root("services"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "dashboard")
  .map((d) => d.name)
  .sort();
const IN_NETWORK = {
  REDIS_URL: "redis://redis:6379",
  DATABASE_URL: "postgres://cohost:cohost@postgres:5432/cohost",
  OLLAMA_URL: "http://ollama:11434",
  TTS_URL: "http://tts:8880",
  STT_URL: "http://stt:8000",
  VOICE_URL: "http://voice:8700",
  CONFIG_DIR: "/app/config",
};

// @spec DEPLOY-COMPOSE-002
test("every application service builds the root Dockerfile with SERVICE set to its directory name and inherits the shared x-ts-service settings", () => {
  assert.ok(appServices.length >= 10, `found the services/ directories: ${appServices.join(",")}`);
  for (const name of appServices) {
    const svc = compose.services[name];
    assert.ok(svc, `${name} is a compose service`);
    assert.equal(svc.build?.context, ".", `${name}: the repository root is the build context`);
    assert.equal(svc.build?.dockerfile, undefined, `${name}: the single root Dockerfile`);
    assert.equal(svc.build?.args.SERVICE, name, `${name}: SERVICE is its directory name`);
    assert.equal(svc.restart, "unless-stopped", `${name}: restart`);
    assert.equal(svc.env_file, ".env", `${name}: env_file`);
    for (const [k, v] of Object.entries(IN_NETWORK)) assert.equal(svc.environment?.[k], v, `${name}: ${k}`);
    assert.ok(svc.volumes?.includes("./config:/app/config"), `${name}: the config bind mount`);
    assert.ok(svc.extra_hosts?.includes("host.docker.internal:host-gateway"), `${name}: host-gateway`);
    assert.equal(svc.depends_on?.redis?.condition, "service_healthy", `${name}: redis healthy`);
    assert.ok(svc.healthcheck?.test?.join(" ").includes("healthcheck.js $$SERVICE"), `${name}: the container healthcheck`);
    assert.equal(svc.environment?.DASHBOARD_URL, undefined, `${name}: no dashboard address`);
  }
  // the memory image's one-shots build the memory directory's image too
  for (const name of ["consolidate", "reembed"]) assert.equal(compose.services[name]!.build?.args.SERVICE, "memory", name);
});

// @spec DEPLOY-COMPOSE-003
test("the in-network addresses are literals in each application service's environment block, so .env (env_file) cannot change them", () => {
  for (const name of appServices) {
    const env = compose.services[name]!.environment ?? {};
    assert.equal(compose.services[name]!.env_file, ".env", `${name}: .env is still loaded`);
    for (const [k, v] of Object.entries(IN_NETWORK)) {
      assert.equal(env[k], v, `${name}: ${k} is set in environment`);
      assert.ok(!String(env[k]).includes("${"), `${name}: ${k} is not read from .env through substitution`);
    }
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
