import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ISOLATION_OVERRIDES, SECRET_PATHS } from "@cohost/config";

// Structural checks of the Compose files against the control plane: the healthcheck wiring, the isolation
// pass-through, and image pinning. Docker is not run.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
interface Svc {
  image?: string;
  environment?: Record<string, string>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number; start_period: string };
  build?: { args: Record<string, string> };
  volumes?: string[];
}
const load = (f: string) => parse(readFileSync(root(f), "utf8"), { merge: true }) as { services: Record<string, Svc>; "x-ts-service"?: Svc };
const base = load("docker-compose.yml");
const gpu = load("docker-compose.gpu.yml");
// `models` builds the memory image too but is a one-shot on its own settings (DEPLOY-COMPOSE-008), not an x-ts-service unit.
// The optional engine servers are third-party images built from their own sources, not application services (DEPLOY-ENG-001..003).
const ENGINE_SERVERS = ["tts-pocket", "stt-nemotron", "stt-kyutai"];
const appServices = Object.entries(base.services).filter(([name, s]) => s.build && name !== "models" && !ENGINE_SERVERS.includes(name));

// @spec CTRL-CHECK-003
test("every x-ts-service application service runs the heartbeat healthcheck on the specified cadence", () => {
  const anchor = base["x-ts-service"]!;
  assert.deepEqual(anchor.healthcheck, {
    test: ["CMD-SHELL", "node packages/control/dist/healthcheck.js $$SERVICE"],
    interval: "10s", timeout: "5s", retries: 3, start_period: "30s",
  });
  for (const [name, s] of appServices) {
    // consolidate and reembed are one-shots that never join the bus; they disable the inherited check
    if (name === "consolidate" || name === "reembed") continue;
    assert.deepEqual(s.healthcheck, anchor.healthcheck, `${name} inherits the healthcheck`);
  }
  assert.ok(appServices.length >= 10);
});

const IN_NETWORK = ["CONFIG_DIR", "DATABASE_URL", "OLLAMA_URL", "REDIS_URL", "STT_URL", "TTS_URL", "VOICE_URL"];

// @spec CTRL-RUNTIME-009, DEPLOY-COMPOSE-017
test("the shared environment is the in-network addresses plus the one pass-through COHOST_ISOLATION: ${COHOST_ISOLATION:-}", () => {
  const env = base["x-ts-service"]!.environment!;
  assert.equal(env.COHOST_ISOLATION, "${COHOST_ISOLATION:-}");
  assert.deepEqual(Object.keys(env).sort(), ["COHOST_ISOLATION", ...IN_NETWORK]);
  for (const name of Object.keys(ISOLATION_OVERRIDES)) assert.equal(env[name], undefined, `${name} has no entry`);
  for (const [name, s] of appServices) {
    for (const v of Object.keys(ISOLATION_OVERRIDES)) assert.equal(s.environment?.[v], undefined, `${name} ${v}`);
    assert.ok(s.environment === undefined || s.environment.COHOST_ISOLATION === "${COHOST_ISOLATION:-}", `${name} passes COHOST_ISOLATION through unchanged`);
  }
});

// @spec DEPLOY-COMPOSE-017
test("no operator setting is interpolated into the Compose files: the only ${VAR} are COHOST_ISOLATION and the image overrides", () => {
  const allowed = new Set(["COHOST_ISOLATION", "KOKORO_IMAGE", "SPEACHES_IMAGE"]);
  for (const file of ["docker-compose.yml", "docker-compose.gpu.yml"]) {
    const code = readFileSync(root(file), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    for (const m of code.matchAll(/\$\{([A-Z0-9_]+)/g)) assert.ok(allowed.has(m[1]!), `${file} interpolates ${m[1]}`);
  }
});

// @spec DEPLOY-COMPOSE-024
test("no service passes EARS_HTTP_TOKEN or any other credential variable through its environment", () => {
  for (const [name, s] of [...Object.entries(base.services), ["x-ts-service", base["x-ts-service"]!] as const]) {
    for (const k of Object.keys(s.environment ?? {})) assert.doesNotMatch(k, /TOKEN|SECRET|API_KEY|ACCESS_KEY/, `${name} passes ${k}`);
  }
  assert.doesNotMatch(readFileSync(root("docker-compose.yml"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n"), /EARS_HTTP_TOKEN|DISCORD_TOKEN/);
});

const images = (file: ReturnType<typeof load>) => Object.entries(file.services).flatMap(([n, s]) => (s.image ? [[n, s.image] as const] : []));
/** Strips the `${VAR:-default}` wrapper so the default value is what is judged. */
const effective = (image: string) => /^\$\{[A-Z_]+:-(.+)\}$/.exec(image)?.[1] ?? image;

// @spec DEPLOY-COMPOSE-014
test("every image in both Compose files carries an exact version tag", () => {
  const all = [...images(base), ...images(gpu)];
  assert.ok(all.length >= 7);
  for (const [name, raw] of all) {
    const image = effective(raw);
    const tag = image.split("/").at(-1)!.split(":")[1];
    assert.ok(tag, `${name} (${image}) has a tag`);
    assert.doesNotMatch(tag, /^latest/, `${name} (${image}) is not latest`);
    assert.match(tag, /\d+\.\d+/, `${name} (${image}) names a full or minor version, not a floating major`);
  }
  assert.equal(effective(base.services.redis!.image!), "redis:8.10.3-alpine");
  assert.equal(effective(base.services.postgres!.image!), "pgvector/pgvector:0.8.7-pg18");
});

// @spec DEPLOY-COMPOSE-025
test("every application service mounts ./config:/app/config, and no Compose entry carries an operator credential", () => {
  for (const [name, s] of appServices) assert.ok(s.volumes?.includes("./config:/app/config"), `${name} mounts ./config:/app/config`);
  assert.ok(base.services.models!.volumes?.includes("./config:/app/config"), "models mounts ./config");

  // The environment names an operator credential (a SECRET_PATHS key) never get: each key's leaf, as an environment name.
  const leaves = [...new Set(SECRET_PATHS.map((p) => p.split(".").at(-1)!.toUpperCase()))];
  assert.ok(leaves.includes("API_KEY") && leaves.includes("TOKEN") && leaves.includes("PASSWORD"));
  const LOCAL_POSTGRES = "postgres://cohost:cohost@postgres:5432/cohost";
  for (const file of [base, gpu]) {
    for (const [name, s] of [...Object.entries(file.services), ["x-ts-service", file["x-ts-service"] ?? {}] as const]) {
      const entries = [...Object.entries(s.environment ?? {}), ...Object.entries(s.build?.args ?? {})];
      for (const [k, v] of entries) {
        // The local-only Postgres service's fixed `cohost` credential is inside the trust boundary, not an operator credential.
        if (name === "postgres" && k === "POSTGRES_PASSWORD") { assert.equal(v, "cohost"); continue; }
        if (k === "DATABASE_URL") { assert.equal(v, LOCAL_POSTGRES, `${name} DATABASE_URL is the fixed local credential`); continue; }
        for (const leaf of leaves) assert.ok(!k.toUpperCase().includes(leaf), `${name} passes ${k}, an operator credential`);
        assert.doesNotMatch(String(v), /\/\/[^/@\s]+:[^/@\s]+@/, `${name} ${k} embeds a credential in a URL`);
      }
    }
  }
  const ports = base.services.postgres as unknown as { ports?: string[] };
  assert.deepEqual(ports.ports, ["127.0.0.1:5432:5432"], "the fixed credential is reachable from the host loopback only");
});
