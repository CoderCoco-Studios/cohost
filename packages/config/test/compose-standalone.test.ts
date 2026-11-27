import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  volumes?: unknown[];
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: string[]; interval?: string };
}
const compose = parse(readFileSync(root("docker-compose.yml"), "utf8"), { merge: true }) as { services: Record<string, Svc> };
const names = Object.keys(compose.services).toSorted();

// @spec DEPLOY-COMPOSE-001
test("compose defines infra, one-shots and one app service per services/ directory except dashboard, and no dashboard", () => {
  assert.deepEqual(
    names,
    ["affect", "avatar", "chat", "connector-discord", "consolidate", "cortex", "ears", "eyes", "memory", "models", "mouth", "ollama", "postgres", "redis", "reembed", "salience", "stt", "stt-kyutai", "stt-nemotron", "tools", "tts", "tts-pocket", "voice"],
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
  .toSorted();
/** The in-network literals of every application service except `tools`, which gets only the bus and config ones (DEPLOY-COMPOSE-026). */
const IN_NETWORK = {
  REDIS_URL: "redis://redis:6379",
  DATABASE_URL: "postgres://cohost:cohost@postgres:5432/cohost",
  OLLAMA_URL: "http://ollama:11434",
  TTS_URL: "http://tts:8880",
  STT_URL: "http://stt:8000",
  VOICE_URL: "http://voice:8700",
  CONFIG_DIR: "/app/config",
  COHOST_SECRETS_FILE: "", // pinned empty so a value in .env cannot point the loader away from the unit's projection (DEPLOY-COMPOSE-003)
  COHOST_DATA_DIR: "/app/data", // pinned so each program's log file lands in the ./data/logs mount (DEPLOY-COMPOSE-003, DEPLOY-COMPOSE-029)
};
const TOOLS_ENVIRONMENT = ["COHOST_ISOLATION", "CONFIG_DIR", "REDIS_URL"];

// @spec DEPLOY-COMPOSE-002
test("every application service builds the root Dockerfile with SERVICE set to its directory name and inherits the shared x-ts-service settings", () => {
  assert.ok(appServices.includes("tools") && appServices.length >= 12, `found the services/ directories: ${appServices.join(",")}`);
  for (const name of appServices) {
    const svc = compose.services[name];
    assert.ok(svc, `${name} is a compose service`);
    assert.equal(svc.build?.context, ".", `${name}: the repository root is the build context`);
    assert.equal(svc.build?.dockerfile, undefined, `${name}: the single root Dockerfile`);
    assert.equal(svc.build?.args.SERVICE, name, `${name}: SERVICE is its directory name`);
    assert.equal(svc.restart, "unless-stopped", `${name}: restart`);
    if (name !== "tools") {
      assert.equal(svc.env_file, ".env", `${name}: env_file`);
      for (const [k, v] of Object.entries(IN_NETWORK)) assert.equal(svc.environment?.[k], v, `${name}: ${k}`);
    }
    assert.ok(svc.volumes?.includes(name === "tools" ? "./config:/app/config:ro" : "./config:/app/config"), `${name}: the config bind mount`);
    assert.equal(svc.volumes?.includes("./data/logs:/app/data/logs"), name !== "tools", `${name}: the logs bind mount`);
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
  for (const name of appServices.filter((n) => n !== "tools")) {
    const env = compose.services[name]!.environment ?? {};
    assert.equal(compose.services[name]!.env_file, ".env", `${name}: .env is still loaded`);
    for (const [k, v] of Object.entries(IN_NETWORK)) {
      assert.equal(env[k], v, `${name}: ${k} is set in environment`);
      assert.ok(!env[k].includes("${"), `${name}: ${k} is not read from .env through substitution`);
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
  assert.deepEqual(all.map(([n]) => n).toSorted(), ["ollama", "postgres", "redis", "stt", "stt-kyutai", "stt-nemotron", "tts", "tts-pocket", "voice"]); // the engine servers publish on loopback too (DEPLOY-ENG-008)
});

// @spec DEPLOY-HOST-002
test(".env.example carries the empty token as the one lock, no CONTROL_ENABLED, the host and the docker bin hint, and no port", () => {
  const env = readFileSync(root(".env.example"), "utf8");
  const line = (k: string) => env.split("\n").find((l) => l.startsWith(`${k}=`));
  assert.doesNotMatch(env, /CONTROL_ENABLED/, "no CONTROL_ENABLED line or mention");
  assert.match(line("CONTROL_TOKEN") ?? "", /^CONTROL_TOKEN=\s*(#.*)?$/);
  // the comment above the token line: the one lock, the dashboard refuses to start without it, a bearer for programs, the
  // unlock link in a browser, and the installer fills it
  const lines = env.split("\n");
  const at = lines.findIndex((l) => l.startsWith("CONTROL_TOKEN="));
  let first = at;
  while (first > 0 && lines[first - 1]!.startsWith("#")) first--;
  const comment = lines.slice(first, at).join("\n");
  assert.match(comment, /one lock/);
  assert.match(comment, /does not start without it/);
  assert.match(comment, /bearer/);
  assert.match(comment, /unlock link/);
  assert.match(comment, /install\.sh fills it/);
  assert.match(comment, /openssl rand -hex 24/);
  assert.match(env, /0\.0\.0\.0 opens the full dashboard to other machines,\n# and the control token and the unlock cookie then cross the network in cleartext/);
  assert.equal(line("DASHBOARD_PORT"), undefined, "the ports are dashboard.port and dashboard.lan_port in config.yaml");
  assert.equal(line("DASHBOARD_LAN_PORT"), undefined);
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

// @spec DEPLOY-IMG-004, DEPLOY-IMG-005
test(".dockerignore keeps the VTube Studio token, the secrets directory and the user-owned config files out of the build context; the examples stay in", () => {
  const lines = readFileSync(root(".dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const f of ["config/.vts-token", "secrets", "config/config.yaml", "config/personality.md", "config/expressions.yaml", ".env"]) assert.ok(lines.includes(f), `${f} is excluded`);
  assert.ok(!lines.includes("config/secrets.yaml"), "the credentials file no longer lives in ./config");
  assert.ok(!lines.some((l) => /example/.test(l) || l === "config" || l === "config/*"), "the config/*.example.* files stay in the context");
});

// @spec DEPLOY-CI-002
test("compose-smoke.sh starts the services from .env.example alone: it sets no operator setting and needs no credential (its secrets directories hold empty mappings only)", () => {
  const sh = readFileSync(root("scripts/compose-smoke.sh"), "utf8");
  const code = sh.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(code, /\[ -f \.env \] \|\| cp \.env\.example \.env/);
  assert.doesNotMatch(code, /COHOST_ISOLATION|LLM_PROVIDER|CHAT_SOURCE|AVATAR_DRIVER|DISCORD_TOKEN/);
  // the services it starts need no model, credential or optional profile
  for (const s of ["salience", "affect", "avatar"]) assert.equal(compose.services[s]!.profiles, undefined, s);
});

// @spec DEPLOY-COMPOSE-026
test("tools builds the root Dockerfile with SERVICE tools, belongs to no profile, publishes no port, mounts only ./config read-only and its own secrets projection, and depends on redis healthy alone", () => {
  const tools = compose.services.tools!;
  assert.ok(tools, "tools is a compose service");
  assert.equal(tools.build?.context, ".");
  assert.equal(tools.build?.dockerfile, undefined, "the single root Dockerfile");
  assert.equal(tools.build?.args.SERVICE, "tools");
  assert.equal(tools.env_file, undefined, "least privilege: no env_file");
  assert.deepEqual(Object.keys(tools.environment ?? {}).toSorted(), TOOLS_ENVIRONMENT, "least privilege: the bus URL, the config directory and the isolation pass-through only");
  assert.ok(tools.extra_hosts?.includes("host.docker.internal:host-gateway"), "host-side MCP servers are reached through the host gateway");
  assert.equal(tools.profiles, undefined, "no profile: a tool the owner enabled must never silently not run");
  assert.equal(tools.ports, undefined);
  assert.deepEqual(tools.volumes?.filter((m) => typeof m === "string"), ["./config:/app/config:ro"], "the config mount is read-only");
  assert.deepEqual(tools.volumes?.filter((m) => typeof m !== "string"), [{ type: "bind", source: "./secrets/units/tools", target: "/app/secrets", read_only: true, bind: { create_host_path: false } }], "its projection, long syntax, the source never created (DEPLOY-SECRET-002)");
  assert.equal(tools.volumes?.length, 2, "no volume beyond those two");
  assert.equal(tools.environment?.REDIS_URL, "redis://redis:6379");
  assert.equal(tools.environment?.CONFIG_DIR, "/app/config");
  assert.equal(tools.environment?.COHOST_ISOLATION, "${COHOST_ISOLATION:-}");
  assert.deepEqual(Object.keys(tools.depends_on ?? {}), ["redis"]);
  assert.equal(tools.depends_on?.redis?.condition, "service_healthy");
});

// @spec DEPLOY-COMPOSE-026
test("tools gets no more host access than the other application services: no privileged mode, added capability, host network or pid namespace, device or docker socket, and no data volume", () => {
  const tools = compose.services.tools as Svc & Record<string, unknown>;
  assert.ok(tools, "tools is a compose service");
  for (const k of ["privileged", "cap_add", "network_mode", "pid", "ipc", "devices", "security_opt"]) assert.equal(tools[k], undefined, `tools sets no ${k}`);
  assert.ok(!(tools.volumes ?? []).some((v) => /docker\.sock|\.\/data|^\//.test(String(typeof v === "string" ? v : (v as { source?: string }).source))), "no docker socket, no ./data and no absolute host path");
});

// @spec DEPLOY-COMPOSE-027
test("the Compose file names no profile `tools`, so the service named tools and a profile of that name never both exist", () => {
  assert.ok(compose.services.tools, "the tools service exists");
  const profiles = new Set(Object.values(compose.services).flatMap((s) => s.profiles ?? []));
  assert.ok(!profiles.has("tools"), `profiles in use: ${[...profiles].toSorted().join(", ")}`);
});

// @spec DEPLOY-REPO-001
test("the root tsconfig.json is a solution file referencing the 9 packages, the 13 services, the two test projects and nothing else", () => {
  const ts = JSON.parse(readFileSync(root("tsconfig.json"), "utf8")) as { files: string[]; references: { path: string }[] };
  assert.deepEqual(ts.files, []);
  const paths = ts.references.map((r) => r.path);
  const dir = (d: string) => readdirSync(root(d), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => `${d}/${e.name}`);
  const packages = dir("packages"), services = dir("services");
  assert.equal(packages.length, 9, packages.join(","));
  assert.equal(services.length, 13, services.join(","));
  assert.ok(services.includes("services/tools"));
  assert.deepEqual([...paths].toSorted(), [...packages, ...services, "services/voice/tsconfig.test.json", "services/avatar/test"].toSorted());
});

/**
 * Runs compose-smoke.sh against a copy of the repository's scripts, Compose file and .env.example with a stand-in `docker`.
 * The stand-in logs every command to `cmds.txt`, records what ./secrets/units held when the first `compose up` ran, answers
 * every health probe healthy (the container of service `tools` as `TOOLS_STATE`), and answers `compose exec ... <name>`:
 * a name containing `salience` exits SALIENCE_EXIT (default 1: it does not resolve), one containing `redis` exits REDIS_EXIT
 * (default 0: it resolves). The workspace is not built when the script runs, so it must learn the mounted secrets directories
 * from docker-compose.yml itself: `compose config` fails here.
 */
function smoke(env: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "cohost-smoke-"));
  mkdirSync(join(work, "scripts"));
  copyFileSync(root("scripts/compose-smoke.sh"), join(work, "scripts", "compose-smoke.sh"));
  copyFileSync(root("docker-compose.yml"), join(work, "docker-compose.yml"));
  copyFileSync(root(".env.example"), join(work, ".env.example"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  const seen = join(work, "seen.txt");
  const cmds = join(work, "cmds.txt");
  writeFileSync(join(bin, "docker"), [
    "#!/bin/bash",
    `echo "$*" >> "${cmds}"`,
    'case "$1 $2" in',
    `  "compose up") if [ ! -f "${seen}" ]; then (cd "${work}" && for d in secrets/units/*; do printf '%s %s %s\\n' "$d" "$(stat -c %a "$d")" "$(cat "$d/secrets.yaml" 2>&1 | tr '\\n' '~')"; done) > "${seen}" 2>&1; fi; exit 0;;`,
    '  "compose ps") echo "cid-$4"; exit 0;;',
    '  "compose config") exit 1;;',
    '  "compose exec") case "$*" in *salience*) exit "${SALIENCE_EXIT:-1}";; *redis*) exit "${REDIS_EXIT:-0}";; esac; exit 0;;',
    "esac",
    'case "$1" in inspect) if [ "$4" = "cid-tools" ]; then echo "${TOOLS_STATE:-running healthy restarts=0}"; else echo "running healthy restarts=0"; fi; exit 0;; esac',
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "docker"), 0o755);
  // an existing projection must survive: memory's file holds a marker
  const keep = join(work, "secrets", "units", "memory");
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  writeFileSync(join(keep, "secrets.yaml"), "llm: {openai: {api_key: keep-me}}\n", { mode: 0o600 });
  const r = spawnSync("bash", [join(work, "scripts", "compose-smoke.sh")], { cwd: work, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "/", SMOKE_WAIT: "3", ...env } });
  const log = existsSync(cmds) ? readFileSync(cmds, "utf8").trim().split("\n") : [];
  return { work, r, seen, log };
}

// @spec DEPLOY-SECRET-011
test("compose-smoke.sh creates, before its first docker compose up, an empty-mapping secrets.yaml (mode 0700 directory) for every ./secrets/units/<name> the Compose file mounts, and leaves an existing file untouched", () => {
  const { work, r, seen } = smoke();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(seen), "docker compose up ran");

  const mounted = new Set([...readFileSync(root("docker-compose.yml"), "utf8").matchAll(/\.\/secrets\/units\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
  assert.ok(mounted.size >= 10, `the Compose file mounts a directory per unit that declares a secret: ${[...mounted].join(",")}`);
  const atUp = new Map(readFileSync(seen, "utf8").trim().split("\n").map((l) => { const [dir, perm, ...rest] = l.split(" "); return [dir!.replace("secrets/units/", ""), { perm, text: rest.join(" ") }] as const; }));
  for (const name of mounted) {
    const at = atUp.get(name);
    assert.ok(at, `${name}: the directory exists before the first up`);
    assert.equal(at.perm, "700", `${name}: directory mode`);
    if (name === "memory") assert.match(at.text, /keep-me/, "an existing file is left untouched");
    else assert.match(at.text, /^(\{\}~?|\{\s*\}~?)$/, `${name}: secrets.yaml holds an empty YAML mapping`);
  }
  assert.equal(statSync(join(work, "secrets", "units", "chat")).mode & 0o777, 0o700);
});

// @spec DEPLOY-NET-004
test("compose-smoke.sh starts tools after the named services are healthy, waits for it to be healthy, then resolves redis (must succeed) and salience (must fail) with dns.lookup through docker compose exec", () => {
  const { r, log } = smoke();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const at = (needle: RegExp) => log.findIndex((l) => needle.test(l));
  const upDefault = at(/^compose up -d --build redis salience affect avatar/);
  const upTools = at(/^compose up -d\b.*\btools\b/);
  const psTools = at(/^compose ps -aq tools/);
  const inspectTools = at(/^inspect .*cid-tools/);
  const execRedis = at(/^compose exec -T tools node -e .*dns\.lookup.*\bredis\b|^compose exec -T tools node -e .*\bredis\b.*dns\.lookup/);
  const execSalience = at(/^compose exec -T tools node -e .*\bsalience\b/);
  const inspectLast = log.map((l, i) => (/^inspect .*cid-(salience|affect|avatar)/.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  for (const [name, i] of Object.entries({ upDefault, upTools, psTools, inspectTools, execRedis, execSalience })) assert.ok(i >= 0, `${name} ran: ${log.join(" | ")}`);
  assert.ok(upDefault < inspectLast && inspectLast < upTools, "tools starts after the named services are healthy");
  assert.ok(upTools < inspectTools && inspectTools < execRedis, "and the lookups wait for tools to be healthy");
  assert.ok(log.some((l) => /dns\.lookup/.test(l)), "the script calls dns.lookup");
  assert.match(r.stdout, /ok\s+tools/);
});

// @spec DEPLOY-NET-004
test("compose-smoke.sh fails the run when salience resolves from tools, when redis does not, and when tools is not healthy", () => {
  const leaky = smoke({ SALIENCE_EXIT: "0" });
  assert.notEqual(leaky.r.status, 0, "a salience that resolves means tools shares a network with it");
  assert.match(leaky.r.stdout + leaky.r.stderr, /salience/);
  const cut = smoke({ REDIS_EXIT: "1" });
  assert.notEqual(cut.r.status, 0, "a redis that does not resolve means tools cannot reach the bus");
  const sick = smoke({ TOOLS_STATE: "running unhealthy restarts=0" });
  assert.notEqual(sick.r.status, 0);
  assert.ok(!sick.log.some((l) => l.startsWith("compose exec")), "no lookup runs against an unhealthy tools");
  const restarted = smoke({ TOOLS_STATE: "running healthy restarts=2" });
  assert.notEqual(restarted.r.status, 0, "a restart of tools fails the run");
});
