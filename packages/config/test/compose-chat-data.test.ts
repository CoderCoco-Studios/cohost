import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Mount = string | { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
/** The long-syntax mount of a unit's projection, read-only at /app/config and never created by Compose (DEPLOY-COMPOSE-025). */
const projectionMount = (unit: string) => ({ type: "bind", source: `./data/projections/${unit}`, target: "/app/config", read_only: true, bind: { create_host_path: false } });
/** The host path a mount binds, whichever syntax it is written in. */
const sourceOf = (m: Mount): string => (typeof m === "string" ? m.split(":")[0]! : (m.source ?? ""));
/** The unit whose projection a service mounts: the memory image's one-shots mount `memory`'s (DEPLOY-COMPOSE-025). */
const unitOf = (name: string): string => (name === "consolidate" || name === "reembed" ? "memory" : name);
const TMPFS = ["/run/cohost:mode=0700,size=1m"];

// Structural check of chat's data mount. Docker is not run: the file is parsed as YAML with merge keys resolved.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as {
  services: Record<string, { volumes?: Mount[]; build?: unknown; environment?: Record<string, string>; env_file?: string | string[]; ports?: string[]; depends_on?: Record<string, unknown>; profiles?: string[]; tmpfs?: string[] }>;
};

// @spec DEPLOY-COMPOSE-022
test("chat mounts ./data/chat beside its projection and ./data/logs, and no other built service mounts ./data beyond ./data/logs, its own projection and avatar's ./data/avatar", () => {
  assert.deepEqual(compose.services.chat!.volumes, ["./data/logs:/app/data/logs", "./data/chat:/app/data/chat", projectionMount("chat")]);
  for (const [name, svc] of Object.entries(compose.services)) {
    if (name === "chat" || !svc.build) continue;
    const allowed = new Set(["./data/logs", `./data/projections/${unitOf(name)}`, ...(name === "avatar" ? ["./data/avatar"] : [])]);
    const extra = (svc.volumes ?? []).map(sourceOf).filter((s) => /^(\.\/)?data(\/|$)/.test(s) && !allowed.has(s));
    assert.deepEqual(extra, [], `${name} mounts no other part of ./data`);
  }
});

// @spec DEPLOY-COMPOSE-020, DEPLOY-COMPOSE-033
test("mouth mounts only its projection and ./data/logs beside its /run/cohost tmpfs, publishes no port and waits for redis alone", () => {
  const mouth = compose.services.mouth!;
  assert.deepEqual(mouth.volumes, ["./data/logs:/app/data/logs", projectionMount("mouth")]);
  assert.deepEqual(mouth.tmpfs, TMPFS);
  assert.equal(mouth.ports, undefined);
  assert.deepEqual(Object.keys(mouth.depends_on ?? {}), ["redis"]);
  assert.deepEqual(mouth.profiles, ["mouth"]);
});

// @spec DEPLOY-COMPOSE-023, DEPLOY-COMPOSE-033
test("connector-discord waits for redis alone, publishes no port, mounts only its projection and ./data/logs beside its /run/cohost tmpfs, and no service has a Discord token entry (ears and mouth inherit the shared environment)", () => {
  const c = compose.services["connector-discord"]!;
  assert.deepEqual(Object.keys(c.depends_on ?? {}), ["redis"]);
  assert.deepEqual(c.depends_on!.redis, { condition: "service_healthy" });
  assert.equal(c.ports, undefined);
  assert.deepEqual(c.volumes, ["./data/logs:/app/data/logs", projectionMount("connector-discord")]);
  assert.deepEqual(c.tmpfs, TMPFS);
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
