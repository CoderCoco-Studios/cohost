import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { SERVICE_MANIFEST } from "../src/index.js";

// Structural checks of the Compose files against the control plane: the healthcheck wiring, the isolation
// pass-through, and image pinning. Docker is not run.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
interface Svc {
  image?: string;
  environment?: Record<string, string>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number; start_period: string };
  build?: { args: { SERVICE: string } };
}
const load = (f: string) => parse(readFileSync(root(f), "utf8"), { merge: true }) as { services: Record<string, Svc>; "x-ts-service"?: Svc };
const base = load("docker-compose.yml");
const gpu = load("docker-compose.gpu.yml");
const appServices = Object.entries(base.services).filter(([, s]) => s.build);

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

// @spec CTRL-RUNTIME-009, DEPLOY-COMPOSE-017
test("the isolation preset variables of the manifest all pass through as ${VAR:-}", () => {
  const preset = [...new Set(SERVICE_MANIFEST.flatMap((s) => Object.keys(s.isolatedEnv)))].sort();
  assert.deepEqual(preset, [
    "AVATAR_DRIVER", "CHAT_SOURCE", "CONNECTIONS_DISCORD_ENABLED", "EARS_SOURCES", "EARS_STT_ENGINE", "LLM_PROVIDER", "MEMORY_EMBEDDER", "MEMORY_STORE",
    "MOUTH_DISCORD_ENABLED", "MOUTH_DRYRUN_ENABLED", "VISION_ENABLED", "VISION_ENGINE", "VOICE_ENGINE",
  ]);
  const env = base["x-ts-service"]!.environment!;
  for (const v of preset) assert.equal(env[v], `\${${v}:-}`, v);
  for (const [name, s] of appServices) {
    for (const v of preset) assert.ok(s.environment === undefined || s.environment[v] === undefined || s.environment[v] === `\${${v}:-}`, `${name} ${v}`);
  }
});

const images = (file: ReturnType<typeof load>) => Object.entries(file.services).flatMap(([n, s]) => (s.image ? [[n, s.image] as const] : []));
/** Strips the `${VAR:-default}` wrapper so the default value is what is judged. */
const effective = (image: string) => /^\$\{[A-Z_]+:-(.+)\}$/.exec(image)?.[1] ?? image;

// @spec DEPLOY-COMPOSE-014
test("every image in both Compose files carries an exact version tag", () => {
  const all = [...images(base), ...images(gpu)];
  assert.ok(all.length >= 8);
  for (const [name, raw] of all) {
    const image = effective(raw);
    const tag = image.split("/").at(-1)!.split(":")[1];
    assert.ok(tag, `${name} (${image}) has a tag`);
    assert.doesNotMatch(tag, /^latest/, `${name} (${image}) is not latest`);
    assert.match(tag, /\d+\.\d+/, `${name} (${image}) names a full or minor version, not a floating major`);
  }
  assert.equal(effective(base.services.redis!.image!), "redis:7.4.12-alpine");
  assert.equal(effective(base.services.postgres!.image!), "pgvector/pgvector:0.8.7-pg16");
});
