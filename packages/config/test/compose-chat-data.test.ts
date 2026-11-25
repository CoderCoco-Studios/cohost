import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Mount = string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
/** The long-syntax mount of a unit's secrets projection (DEPLOY-SECRET-002). */
const secretsMount = (unit: string) => ({ type: "bind", source: `./secrets/units/${unit}`, target: "/app/secrets", read_only: true, bind: { create_host_path: false } });
/** The short-syntax mounts of a service, and its long-syntax ones: the secrets projection is the one long-syntax mount. */
const shortMounts = (v: Mount[] | undefined): string[] => (v ?? []).filter((m): m is string => typeof m === "string");
const longMounts = (v: Mount[] | undefined) => (v ?? []).filter((m) => typeof m !== "string");

// Structural check of chat's data mount. Docker is not run: the file is parsed as YAML with merge keys resolved.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as {
  services: Record<string, { volumes?: Mount[]; build?: unknown; environment?: Record<string, string>; env_file?: string | string[]; ports?: string[]; depends_on?: Record<string, unknown>; profiles?: string[] }>;
};

// @spec DEPLOY-COMPOSE-022, DEPLOY-SECRET-002
test("chat mounts ./data/chat beside ./config and its own secrets projection, and no other application service mounts ./data", () => {
  assert.deepEqual(shortMounts(compose.services.chat!.volumes), ["./config:/app/config", "./data/chat:/app/data/chat"]);
  assert.deepEqual(longMounts(compose.services.chat!.volumes), [secretsMount("chat")]);
  for (const [name, svc] of Object.entries(compose.services)) {
    if (name === "chat" || !svc.build || name === "tts-pocket") continue; // tts-pocket mounts its token directory under ./data (DEPLOY-ENG-019)
    assert.ok(!shortMounts(svc.volumes).some((v) => v.includes("./data")) && !longMounts(svc.volumes).some((v) => String((v as { source?: string }).source).includes("./data")), `${name} has no ./data mount`);
  }
});

// @spec DEPLOY-COMPOSE-020
test("mouth mounts only the shared config directory (it declares no secret, so no secrets mount), publishes no port and waits for redis alone", () => {
  const mouth = compose.services.mouth as { volumes?: Mount[]; ports?: string[]; depends_on?: Record<string, unknown>; profiles?: string[] };
  assert.deepEqual(mouth.volumes, ["./config:/app/config"]);
  assert.ok(!JSON.stringify(mouth.volumes).includes("secrets"), "no secrets mount for a unit that declares no secret path (DEPLOY-SECRET-002)");
  assert.equal(mouth.ports, undefined);
  assert.deepEqual(Object.keys(mouth.depends_on ?? {}), ["redis"]);
  assert.deepEqual(mouth.profiles, ["mouth"]);
});

// @spec DEPLOY-COMPOSE-023
test("connector-discord waits for redis alone, publishes no port, mounts only the shared config and its own secrets projection, and no service has a Discord token entry (ears and mouth inherit the shared environment)", () => {
  const c = compose.services["connector-discord"]!;
  assert.deepEqual(Object.keys(c.depends_on ?? {}), ["redis"]);
  assert.deepEqual(c.depends_on!.redis, { condition: "service_healthy" });
  assert.equal(c.ports, undefined);
  assert.deepEqual(shortMounts(c.volumes), ["./config:/app/config"]);
  assert.deepEqual(longMounts(c.volumes), [secretsMount("connector-discord")]);
  assert.deepEqual(c.profiles, ["discord"]);
  const shared = (parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as { "x-ts-service": { environment: Record<string, string> } })["x-ts-service"].environment;
  for (const name of ["ears", "mouth", "connector-discord"]) assert.deepEqual(compose.services[name]!.environment, shared, `${name} inherits the shared environment unchanged`);
  const code = readFileSync(root("docker-compose.yml"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /DISCORD_TOKEN/);
});

// @spec DEPLOY-README-004
test("secrets.example.yaml carries the Discord bot token as the one bot, and config.example.yaml its guild and channel", () => {
  const secrets = readFileSync(root("config/secrets.example.yaml"), "utf8");
  const tokenLine = secrets.split("\n").find((l) => /^\s+token: ""/.test(l) && /Discord|bot/i.test(l))!;
  assert.ok(tokenLine, "connections.discord.token has a comment");
  assert.match(secrets, /connections:\n {2}discord:\n {4}token: ""/);
  assert.match(tokenLine, /one Discord bot|one bot/i);
  assert.match(tokenLine, /Discord connector/);
  assert.match(tokenLine, /Connect/);
  assert.match(tokenLine, /Speak/);
  assert.match(tokenLine, /Server Members/);
  const config = readFileSync(root("config/config.example.yaml"), "utf8");
  assert.match(config, /^\s+guild_id: ""/m);
  assert.match(config, /^\s+voice_channel_id: ""/m);
  assert.doesNotMatch(readFileSync(root(".env.example"), "utf8"), /DISCORD_/);
});

// @spec DEPLOY-README-005
test("the Discord page describes ears, mouth and the Discord connector as separate optional profiles, the one bot, the routing table and the guild and channel keys", () => {
  const md = readFileSync(root("docs/guide/connect/discord.md"), "utf8");
  assert.match(md, /\| `discord` \|[\s\S]*\| `ears` \|[\s\S]*\| `mouth` \|/);
  assert.match(md, /mouth\.outputs/);
  assert.match(md, /COMPOSE_PROFILES=discord,ears,mouth/);
  assert.match(md, /`secrets\/secrets\.yaml`[\s\S]*?connections:\s+discord:\s+token:/);
  assert.doesNotMatch(md, /DISCORD_TOKEN/);
  assert.match(md, /connections:\s+discord:[\s\S]*?guild_id:[\s\S]*?voice_channel_id:/);
  assert.match(md, /\*\*Connect\*\*/);
  assert.match(md, /Server Members/);
});
