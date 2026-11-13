import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Structural check of chat's data mount. Docker is not run: the file is parsed as YAML with merge keys resolved.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as {
  services: Record<string, { volumes?: string[]; build?: unknown; environment?: Record<string, string>; env_file?: string | string[]; ports?: string[]; depends_on?: Record<string, unknown>; profiles?: string[] }>;
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

// @spec DEPLOY-COMPOSE-023
test("connector-discord waits for redis alone, publishes no port, mounts only the shared config and takes .env (DISCORD_TOKEN); ears and mouth get the token blanked", () => {
  const c = compose.services["connector-discord"]!;
  assert.deepEqual(Object.keys(c.depends_on ?? {}), ["redis"]);
  assert.deepEqual(c.depends_on!.redis, { condition: "service_healthy" });
  assert.equal(c.ports, undefined);
  assert.deepEqual(c.volumes, ["./config:/app/config"]);
  assert.deepEqual(c.profiles, ["discord"]);
  assert.equal(c.env_file, ".env", "DISCORD_TOKEN reaches it from .env");
  assert.equal(c.environment!.DISCORD_TOKEN, undefined, "nothing overrides it");
  for (const name of ["ears", "mouth"]) {
    const svc = compose.services[name]!;
    assert.equal(svc.environment!.DISCORD_TOKEN, "", `${name} must not receive DISCORD_TOKEN from .env`);
    assert.equal(svc.environment!.REDIS_URL, "redis://redis:6379", `${name} keeps the shared environment`);
  }
});

// @spec DEPLOY-README-004
test(".env.example carries DISCORD_TOKEN as the one bot, with its guild and channel", () => {
  const env = readFileSync(root(".env.example"), "utf8");
  assert.match(env, /^DISCORD_TOKEN=/m);
  assert.match(env, /^DISCORD_GUILD_ID=/m);
  assert.match(env, /^DISCORD_VOICE_CHANNEL_ID=/m);
  const head = env.slice(env.search(/^# --- Discord/m));
  assert.match(head.split("\nDISCORD_TOKEN=")[0]!, /one Discord bot|one bot/i);
  assert.match(head.split("\nDISCORD_TOKEN=")[0]!, /Discord connector/);
  assert.match(head.split("\nDISCORD_TOKEN=")[0]!, /Connect/);
  assert.match(head.split("\nDISCORD_TOKEN=")[0]!, /Speak/);
  assert.match(head.split("\nDISCORD_TOKEN=")[0]!, /Server Members/);
});

// @spec DEPLOY-README-005
test("the README describes ears, mouth and the Discord connector as separate optional profiles, the one bot, the routing table and the guild and channel keys", () => {
  const md = readFileSync(root("README.md"), "utf8");
  assert.match(md, /`ears`[^\n]*`mouth`[^\n]*`discord`|`discord`[^\n]*`ears`[^\n]*`mouth`/);
  assert.match(md, /mouth\.outputs/);
  assert.match(md, /add\s+`discord` to `COMPOSE_PROFILES`/);
  assert.match(md, /connections\.discord\.guild_id/);
  assert.match(md, /connections\.discord\.voice_channel_id/);
  assert.match(md, /Connect/);
  assert.match(md, /Server Members/);
});
