import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
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
  volumes?: unknown[];
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

const IN_NETWORK = ["COHOST_DATA_DIR", "CONFIG_DIR", "DATABASE_URL", "OLLAMA_URL", "REDIS_URL", "STT_URL", "TTS_URL", "VOICE_URL"];

// @spec CTRL-RUNTIME-009, DEPLOY-COMPOSE-003, DEPLOY-COMPOSE-017
test("the shared environment is the in-network addresses plus the one pass-through COHOST_ISOLATION: ${COHOST_ISOLATION:-}", () => {
  const env = base["x-ts-service"]!.environment!;
  assert.equal(env.COHOST_ISOLATION, "${COHOST_ISOLATION:-}");
  assert.equal(env.COHOST_DATA_DIR, "/app/data", "pinned so each program's log file lands in the ./data/logs mount (DEPLOY-COMPOSE-003)");
  assert.equal(env.CONTROL_TOKEN, undefined, "no control token entry");
  assert.deepEqual(Object.keys(env).toSorted(), ["COHOST_ISOLATION", ...IN_NETWORK].toSorted());
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

// @spec DEPLOY-COMPOSE-025
test("no service passes EARS_HTTP_TOKEN or any other credential variable through its environment", () => {
  for (const file of [base, gpu]) {
    for (const [name, s] of [...Object.entries(file.services), ["x-ts-service", file["x-ts-service"] ?? {}] as const]) {
      for (const k of Object.keys(s.environment ?? {})) assert.doesNotMatch(k, /TOKEN|SECRET|API_KEY|ACCESS_KEY/, `${name} passes ${k}`);
    }
  }
  assert.doesNotMatch(readFileSync(root("docker-compose.yml"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n"), /EARS_HTTP_TOKEN|DISCORD_TOKEN/);
});

// @spec DEPLOY-COMPOSE-003, DEPLOY-COMPOSE-025
test("no service's environment block, nor the x-ts-service one, names CONTROL_TOKEN at all", () => {
  for (const file of [base, gpu]) {
    for (const [name, s] of [...Object.entries(file.services), ["x-ts-service", file["x-ts-service"] ?? {}] as const]) {
      assert.ok(!Object.hasOwn(s.environment ?? {}, "CONTROL_TOKEN"), `${name} names CONTROL_TOKEN`);
    }
  }
  for (const f of ["docker-compose.yml", "docker-compose.gpu.yml"]) {
    const code = readFileSync(root(f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /CONTROL_TOKEN/, f);
  }
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

type LongMount = { type?: string; source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
/** Every mount of a service as a host source, a container target and the raw entry, whichever syntax it is written in. */
const mountsOf = (s: Svc): { source: string; target: string; raw: string | LongMount }[] =>
  ((s.volumes ?? []) as (string | LongMount)[]).map((raw) =>
    typeof raw === "string" ? { raw, source: raw.split(":")[0]!, target: raw.split(":")[1] ?? "" } : { raw, source: raw.source ?? "", target: raw.target ?? "" });
/** The unit whose projection a service mounts: the one-shots built as `memory` mount `memory`'s, `models` the `models` one (DEPLOY-COMPOSE-025). */
const unitOf = (name: string): string => (name === "consolidate" || name === "reembed" ? "memory" : name);
const projectionMount = (unit: string): LongMount => ({ type: "bind", source: `./data/projections/${unit}`, target: "/app/config", read_only: true, bind: { create_host_path: false } });
const isProjection = (source: string): boolean => /^(\.\/)?data\/projections(\/|$)/.test(source);

// @spec DEPLOY-COMPOSE-025
test("every application service mounts exactly its own unit's ./data/projections/<composeName> read-only at /app/config in the long syntax with create_host_path false, and no Compose entry carries an operator credential", () => {
  for (const [name, s] of [...appServices, ["models", base.services.models!] as const]) {
    const atConfig = mountsOf(s).filter((m) => m.target === "/app/config" || m.target.startsWith("/app/config/"));
    assert.deepEqual(atConfig.map((m) => m.raw), [projectionMount(unitOf(name))], `${name} mounts its own projection, and nothing else, at /app/config`);
    assert.deepEqual(mountsOf(s).filter((m) => isProjection(m.source)).map((m) => m.source), [`./data/projections/${unitOf(name)}`], `${name} mounts no other projection`);
  }
  for (const name of ["consolidate", "reembed"]) assert.equal(mountsOf(base.services[name]!).find((m) => isProjection(m.source))?.source, "./data/projections/memory", name);
  assert.deepEqual(mountsOf(base.services.models!).map((m) => m.raw), [projectionMount("models")]);

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
        assert.doesNotMatch(v, /\/\/[^/@\s]+:[^/@\s]+@/, `${name} ${k} embeds a credential in a URL`);
      }
    }
  }
  const ports = base.services.postgres as unknown as { ports?: string[] };
  assert.deepEqual(ports.ports, ["127.0.0.1:5432:5432"], "the fixed credential is reachable from the host loopback only");
});

// ---- projections, the settings store and the credentials tmpfs (DEPLOY-SECRET-013; DEPLOY-COMPOSE-033, -034)

// @spec DEPLOY-SECRET-013
test("no service mounts another unit's projection, ./data/store, ./secrets, the master key's directory or any host path at /run/cohost, nor passes a secret path in environment or a build argument", () => {
  const store = resolve(root("data/store"));
  const keyDir = resolve(homedir(), ".config/cohost");
  for (const file of [base, gpu]) {
    for (const [name, s] of Object.entries(file.services)) {
      for (const m of mountsOf(s)) {
        assert.ok(m.target !== "/run/cohost" && !m.target.startsWith("/run/cohost/"), `${name} mounts ${m.source} at /run/cohost`);
        if (isProjection(m.source)) {
          assert.ok(name === "models" || appServices.some(([n]) => n === name), `${name} is not an application service but mounts a projection`);
          assert.equal(m.source, `./data/projections/${unitOf(name)}`, `${name} mounts another unit's projection`);
        }
        if (!m.source.startsWith(".") && !m.source.startsWith("/") && !m.source.startsWith("~")) continue; // a named volume holds no host path
        assert.ok(!m.source.startsWith("~"), `${name} mounts ${m.source} from the home directory`);
        const host = resolve(root(""), m.source);
        const within = (dir: string): boolean => host === dir || host.startsWith(dir + sep) || dir.startsWith(host + sep);
        assert.ok(!within(store), `${name} mounts ${m.source}, which is or holds ./data/store`);
        assert.ok(!within(keyDir), `${name} mounts ${m.source}, which is or holds the master key's directory`);
        assert.doesNotMatch(m.source, /^(\.\/)?secrets(\/|$)/, `${name} mounts ${m.source}`);
        assert.notEqual(host, resolve(root("")), `${name} mounts the workspace root`);
      }
      const entries = [...Object.entries(s.environment ?? {}), ...Object.entries(s.build?.args ?? {})];
      for (const [k, v] of entries) for (const p of SECRET_PATHS) assert.ok(!k.includes(p) && !v.includes(p), `${name} ${k} passes the secret path ${p}`);
    }
  }
});

type Hardened = Svc & { tmpfs?: string | string[]; ulimits?: { core?: number | { soft?: number; hard?: number } } };
const hardenedBase = base as unknown as { services: Record<string, Hardened>; "x-ts-service-base"?: Hardened; "x-ts-service"?: Hardened };
/** Bytes of a tmpfs `size=` option (a plain byte count or one suffixed k, m or g). */
const sizeBytes = (size: string): number => {
  const m = /^(\d+)([kmg]?)$/i.exec(size);
  assert.ok(m, `size=${size} is a byte count`);
  return Number(m[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[m[2]!.toLowerCase()]!;
};
/** The service's /run/cohost tmpfs options, or undefined when it has none. */
const runCohostTmpfs = (s: Hardened): Record<string, string> | undefined => {
  const entries = s.tmpfs === undefined ? [] : Array.isArray(s.tmpfs) ? s.tmpfs : [s.tmpfs];
  const entry = entries.find((t) => t === "/run/cohost" || t.startsWith("/run/cohost:"));
  if (entry === undefined) return undefined;
  const opts = entry.split(":")[1] ?? "";
  return Object.fromEntries(opts.split(",").filter(Boolean).map((o) => [o.split("=")[0]!, o.split("=")[1] ?? ""]));
};

// @spec DEPLOY-COMPOSE-033, DEPLOY-COMPOSE-034
test("every application service (tools and the one-shots included, through the anchors) and tts-pocket mount /run/cohost as a tmpfs with mode 0700 and at most 1 MiB, and set ulimits core 0", () => {
  const hardened = [...appServices.map(([n]) => n), "tts-pocket"];
  for (const n of ["tools", "consolidate", "reembed", "chat", "memory", "voice", "mouth", "connector-discord"]) assert.ok(hardened.includes(n), `${n} is covered`);
  for (const name of hardened) {
    const s = hardenedBase.services[name]!;
    const opts = runCohostTmpfs(s);
    assert.ok(opts, `${name} mounts /run/cohost as tmpfs`);
    assert.equal(opts.mode, "0700", `${name}: mode 0700`);
    assert.ok(opts.size !== undefined && sizeBytes(opts.size) <= 1024 ** 2, `${name}: a size of at most 1 MiB`);
    const core = s.ulimits?.core;
    assert.ok(core === 0 || (typeof core === "object" && core.soft === 0 && core.hard === 0), `${name}: ulimits core 0`);
  }
  assert.ok(runCohostTmpfs(hardenedBase["x-ts-service-base"]!), "the x-ts-service-base anchor carries the tmpfs");
  assert.equal(hardenedBase["x-ts-service"]!.ulimits?.core, 0, "the x-ts-service anchor sets core 0");
});

// ---- the tools network (DEPLOY-NET-001, -002, -003; DEPLOY-COMPOSE-026)

interface Net { driver?: string; internal?: boolean }
type WithNets = Svc & { networks?: unknown; extra_hosts?: string[] };
const compose = base as unknown as { networks?: Record<string, Net | null>; services: Record<string, WithNets> };
/** The networks a service joins: its `networks:` list or map keys, else only the project's `default` network. */
const joined = (s: WithNets): string[] => {
  if (s.networks === undefined) return ["default"];
  return Array.isArray(s.networks) ? (s.networks as string[]) : Object.keys(s.networks as object);
};

// @spec DEPLOY-NET-001
test("the base Compose file declares a bridge network tools-redis that is not internal", () => {
  const net = compose.networks?.["tools-redis"];
  assert.ok(net !== undefined, "tools-redis is declared");
  assert.ok(net === null || net.driver === undefined || net.driver === "bridge", "a bridge network");
  assert.ok(net === null || net.internal !== true, "not internal: the outbound route carries the egress to MCP servers (DEPLOY-NET-003)");
  for (const name of Object.keys(compose.networks ?? {})) assert.ok(name === "tools-redis" || name === "default", `no other network is declared: ${name}`);
});

// @spec DEPLOY-NET-002, DEPLOY-COMPOSE-026
test("redis joins default and tools-redis, tools joins tools-redis alone, and no other service declares a network, so tools-redis holds exactly redis and tools", () => {
  assert.deepEqual([...joined(compose.services.redis!)].toSorted(), ["default", "tools-redis"]);
  assert.deepEqual(joined(compose.services.tools!), ["tools-redis"]);
  for (const file of [base, gpu]) {
    for (const [name, s] of Object.entries(file.services as Record<string, WithNets>)) {
      if (name === "redis" || name === "tools") continue;
      assert.equal(s.networks, undefined, `${name} declares no networks: key`);
    }
  }
  const onToolsRedis = Object.entries(compose.services).filter(([, s]) => joined(s).includes("tools-redis")).map(([n]) => n).toSorted();
  assert.deepEqual(onToolsRedis, ["redis", "tools"]);
  assert.ok(!joined(compose.services.tools!).includes("default"), "tools is not on the default network");
  // the only service tools can name besides itself is redis: every other service shares no network with it
  const reach = Object.entries(compose.services).filter(([n, s]) => n !== "tools" && joined(s).some((net) => joined(compose.services.tools!).includes(net))).map(([n]) => n);
  assert.deepEqual(reach, ["redis"]);
  assert.deepEqual(Object.keys((compose.services.tools as { depends_on?: object }).depends_on ?? {}), ["redis"]);
});

// @spec DEPLOY-NET-003
test("tools keeps the host gateway for host-side MCP servers, and the Compose file adds no proxy or firewall service for the egress", () => {
  assert.ok(compose.services.tools!.extra_hosts?.includes("host.docker.internal:host-gateway"));
  const names = Object.keys(compose.services);
  assert.deepEqual(names.filter((n) => /proxy|squid|firewall|egress|gateway|nginx|traefik|envoy/i.test(n)), []);
  assert.ok((compose.networks?.["tools-redis"] as Net | null)?.internal !== true, "the network keeps its outbound route");
});
