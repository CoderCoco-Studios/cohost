import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// The log files' place in the Compose stack (deployment "Log files"): every application service but `tools` mounts ./data/logs,
// writable, nothing else mounts any part of ./data for it, and the Docker daemon keeps a bounded copy of each service's output.

type Mount = string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
interface Svc { volumes?: Mount[]; logging?: unknown; build?: unknown; environment?: Record<string, string> }
const text = readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8");
const compose = parse(text, { merge: true }) as { services: Record<string, Svc>; "x-ts-service-base": Svc; "x-ts-service": Svc };

const LOGS = "./data/logs:/app/data/logs";
const WITH_LOGS = ["affect", "avatar", "chat", "connector-discord", "consolidate", "cortex", "ears", "eyes", "memory", "mouth", "reembed", "salience", "voice"];
const sourceOf = (m: Mount): string => (typeof m === "string" ? m.split(":")[0]! : (m.source ?? ""));

// @spec DEPLOY-COMPOSE-029
test("every application service but tools, the one-shots included, mounts ./data/logs writable, and no other service has it", () => {
  for (const [name, svc] of Object.entries(compose.services)) {
    const logs = (svc.volumes ?? []).filter((m) => sourceOf(m) === "./data/logs");
    if (WITH_LOGS.includes(name)) assert.deepEqual(logs, [LOGS], `${name} mounts ./data/logs at /app/data/logs, writable`);
    else assert.deepEqual(logs, [], `${name} has no ./data/logs mount`);
  }
  assert.ok((compose["x-ts-service"].volumes ?? []).includes(LOGS), "the x-ts-service anchor carries the mount");
  for (const name of ["tools", "models", "redis", "postgres", "ollama", "tts", "stt", "tts-pocket", "stt-nemotron", "stt-kyutai"]) {
    assert.ok(!(compose.services[name]!.volumes ?? []).some((m) => sourceOf(m).startsWith("./data/logs")), `${name} does not mount ./data/logs`);
  }
  assert.ok(!(compose.services.tools!.volumes ?? []).some((m) => sourceOf(m).startsWith("./data")), "tools mounts no part of ./data");
});

// @spec DEPLOY-COMPOSE-030
test("the ./data/logs mount is the short form, which Compose creates on the host when it is missing", () => {
  for (const name of WITH_LOGS) {
    const long = (compose.services[name]!.volumes ?? []).filter((m) => typeof m !== "string" && m.source === "./data/logs");
    assert.deepEqual(long, [], `${name}: no long-form mount that could set create_host_path: false`);
  }
});

// @spec DEPLOY-COMPOSE-031
test("x-ts-service-base sets a bounded local log driver, so every application service, tools and the one-shots included, inherits it", () => {
  const driver = { driver: "local", options: { "max-size": "10m", "max-file": "3" } };
  assert.deepEqual(compose["x-ts-service-base"].logging, driver);
  for (const name of [...WITH_LOGS, "tools"]) assert.deepEqual(compose.services[name]!.logging, driver, name);
});
