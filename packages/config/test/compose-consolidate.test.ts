import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Structural checks of the compose `consolidate` one-shot. Docker is not run: the file is parsed
// as YAML with merge keys resolved, so each service shows what Compose would merge from `x-ts-service`.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
interface Svc {
  build?: { context: string; args: { SERVICE: string } };
  command?: string[];
  restart?: string;
  profiles?: string[];
  volumes?: string[];
  env_file?: string;
  environment?: Record<string, string>;
  healthcheck?: { disable?: boolean; test?: string[] };
  depends_on?: Record<string, { condition: string }> | string[];
}
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as { services: Record<string, Svc> };
const svc = compose.services.consolidate!;

// @spec DEPLOY-COMPOSE-001
test("the consolidate service exists next to models", () => {
  assert.ok(svc, "consolidate is a service");
  assert.ok(compose.services.models);
});

// @spec DEPLOY-COMPOSE-018
test("consolidate builds the memory image and runs the consolidate entry point instead of the default command", () => {
  assert.equal(svc.build?.args.SERVICE, "memory");
  assert.equal(svc.build?.context, ".");
  assert.deepEqual(svc.command, ["node", "services/memory/dist/consolidate.js"]);
  assert.ok(existsSync(root("services/memory/src/consolidate.ts")), "the command's source exists");
  assert.equal(svc.restart, "no");
});

// @spec DEPLOY-COMPOSE-018
test("consolidate inherits the shared env, config volume and environment, and restates nothing that hides them", () => {
  const memory = compose.services.memory!;
  assert.equal(svc.env_file, ".env");
  assert.deepEqual(svc.volumes, ["./config:/app/config"]);
  assert.deepEqual(svc.volumes, memory.volumes);
  for (const k of ["DATABASE_URL", "OLLAMA_URL", "CONFIG_DIR", "MEMORY_STORE", "MEMORY_EMBEDDER", "LLM_PROVIDER"]) {
    assert.ok(svc.environment?.[k] !== undefined, `${k} is set`);
    assert.equal(svc.environment?.[k], memory.environment?.[k], k);
  }
});

// @spec DEPLOY-COMPOSE-018
test("consolidate waits for postgres healthy and ollama started, and not for redis (the entry point never opens the bus)", () => {
  assert.deepEqual(svc.depends_on, { postgres: { condition: "service_healthy" }, ollama: { condition: "service_started" } });
  for (const f of ["services/memory/src/consolidate.ts", "services/memory/src/consolidate-run.ts"]) {
    assert.doesNotMatch(readFileSync(root(f), "utf8"), /@cohost\/bus/, `${f} does not import the bus`);
  }
});

// @spec DEPLOY-COMPOSE-018
test("consolidate disables the heartbeat healthcheck it can never satisfy", () => {
  assert.deepEqual(svc.healthcheck, { disable: true });
  assert.ok(compose.services.memory!.healthcheck?.test, "the other app services keep the shared check");
});

// @spec DEPLOY-COMPOSE-004, DEPLOY-COMPOSE-019
test("only the consolidate and reembed one-shots are in the tools profile, and eyes, ears and mouth each keep a profile of their own name; no other service has a profile", () => {
  assert.deepEqual(svc.profiles, ["tools"]);
  const profiled = Object.entries(compose.services).filter(([, s]) => s.profiles).map(([n, s]) => [n, s.profiles]);
  assert.deepEqual(profiled.sort(), [["consolidate", ["tools"]], ["ears", ["ears"]], ["eyes", ["eyes"]], ["mouth", ["mouth"]], ["reembed", ["tools"]]]);
});

// @spec DEPLOY-COMPOSE-015
test("consolidate, models and reembed are the only services without an unless-stopped restart policy", () => {
  const other = Object.entries(compose.services).filter(([, s]) => s.restart !== "unless-stopped").map(([n]) => n).sort();
  assert.deepEqual(other, ["consolidate", "models", "reembed"]);
  assert.equal(compose.services.models!.restart, undefined);
});

// @spec DEPLOY-COMPOSE-021
test("reembed builds the memory image, runs the reembed entry point, needs postgres healthy and ollama started but no redis, and has no healthcheck", () => {
  const re = compose.services.reembed!;
  assert.ok(re, "reembed is a service");
  assert.equal(re.build?.args?.SERVICE, "memory");
  assert.deepEqual(re.command, ["node", "services/memory/dist/reembed.js"]);
  assert.ok(existsSync(root("services/memory/src/reembed.ts")), "the command's source exists");
  assert.equal(re.restart, "no");
  assert.deepEqual(re.profiles, ["tools"]);
  assert.deepEqual(re.healthcheck, { disable: true });
  assert.deepEqual(Object.keys(re.depends_on ?? {}).sort(), ["ollama", "postgres"]);
  assert.equal(re.depends_on?.postgres?.condition, "service_healthy");
  assert.equal(re.depends_on?.ollama?.condition, "service_started");
});
