import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ConfigSchema } from "../src/index.js";

// Structural checks of the optional engine servers (tts-pocket, stt-nemotron, stt-kyutai): the Compose files and the
// Dockerfiles and script under docker/. Docker is not run: the files are parsed as YAML with merge keys resolved. No test
// names a commit SHA or a version beyond the ones the specs fix: the pins are looked up and written by the implementation.

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), "utf8");

interface Svc {
  image?: string;
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> | string[] } | string;
  ports?: string[];
  volumes?: string[];
  restart?: string;
  profiles?: string[];
  entrypoint?: string | string[];
  command?: string | string[];
  environment?: Record<string, string> | string[];
  env_file?: string | string[];
  healthcheck?: { test: string[] | string; interval?: string; timeout?: string; retries?: number; start_period?: string };
  depends_on?: Record<string, { condition?: string; required?: boolean }>;
  deploy?: { resources?: { reservations?: { devices?: Array<{ driver?: string; capabilities?: string[] }> } } };
}
interface File { services: Record<string, Svc>; volumes?: Record<string, unknown> }
const load = (f: string) => parse(read(f), { merge: true }) as File;
const base = load("docker-compose.yml");
const gpu = load("docker-compose.gpu.yml");

const POCKET = base.services["tts-pocket"]!;
const NEMOTRON = base.services["stt-nemotron"]!;
const KYUTAI = base.services["stt-kyutai"]!;
const ENGINES = { "tts-pocket": POCKET, "stt-nemotron": NEMOTRON, "stt-kyutai": KYUTAI } as const;

const FULL_SHA = /[0-9a-f]{40}/;
const contextOf = (s: Svc): string => (typeof s.build === "string" ? s.build : s.build?.context ?? "");
const joined = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(" ") : v ?? "");
/** The non-comment text of a file. */
const code = (text: string) => text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

/** Every Dockerfile under docker/, as repo-relative paths. */
function dockerfiles(dir = "docker"): string[] {
  if (!existsSync(root(dir))) return [];
  return readdirSync(root(dir)).sort().flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(root(rel)).isDirectory()) return dockerfiles(rel);
    return n === "Dockerfile" ? [rel] : [];
  });
}
const lines = (rel: string) => read(rel).split("\n");

// @spec DEPLOY-ENG-001, DEPLOY-ENG-002, DEPLOY-ENG-003
test("each engine server is built, not pulled, and its image is cohost-<service>:<upstream version>", () => {
  assert.equal(POCKET.image, "cohost-tts-pocket:4.0.1");
  assert.equal(NEMOTRON.image, "cohost-stt-nemotron:0.3.0");
  assert.equal(KYUTAI.image, "cohost-stt-kyutai:0.6.4");
  for (const [name, s] of Object.entries(ENGINES)) assert.ok(contextOf(s), `${name} has a build context`);
});

// @spec DEPLOY-ENG-004
test("the tts-pocket build context is the Pocket TTS repository at a full commit SHA, with tag v4.0.1 named in a comment beside it", () => {
  const ctx = contextOf(POCKET);
  assert.match(ctx, /^https:\/\/github\.com\/[^/]+\/[^/#]*pocket-tts[^#]*#[0-9a-f]{40}$/i, "a Git URL whose ref is a full SHA");
  const line = lines("docker-compose.yml").find((l) => l.includes(ctx) && !l.trimStart().startsWith("#"))!;
  assert.match(line, /#\s*.*v4\.0\.1/, "the tag is named in a comment on that line");
});

// @spec DEPLOY-ENG-005
test("the stt-nemotron build fetches NeMo-Speech.cpp at a full commit SHA, with tag v0.3.0 named in a comment beside it", () => {
  assert.equal(contextOf(NEMOTRON).replace(/\/$/, "").replace(/^\.\//, ""), "docker/stt-nemotron", "built from cohost's own Dockerfile");
  const docker = lines("docker/stt-nemotron/Dockerfile");
  const at = docker.findIndex((l) => /nemo-speech\.cpp/i.test(l) && FULL_SHA.test(l) && !l.trimStart().startsWith("#"));
  assert.ok(at >= 0, "a line names the NeMo-Speech.cpp repository and a full SHA");
  assert.match([docker[at - 1] ?? "", docker[at]!].join("\n"), /v0\.3\.0/, "tag v0.3.0 is named in a comment beside the SHA");
});

// @spec DEPLOY-ENG-006
test("the stt-kyutai image is built from docker/stt-kyutai/Dockerfile: cargo install moshi-server =0.6.4 --locked on an exact CUDA 12.8 devel base, with its server config beside it", () => {
  assert.equal(contextOf(KYUTAI).replace(/\/$/, "").replace(/^\.\//, ""), "docker/stt-kyutai");
  const dockerfile = code(read("docker/stt-kyutai/Dockerfile"));
  const install = dockerfile.split("\n").find((l) => /cargo install/.test(l))!;
  assert.ok(install, "a cargo install line");
  assert.match(install, /moshi-server/);
  assert.match(install, /=0\.6\.4\b/, "exactly 0.6.4");
  assert.match(install, /--locked/);
  const from = dockerfile.split("\n").filter((l) => /^\s*FROM\s/i.test(l));
  assert.ok(from.some((l) => /nvidia\/cuda:12\.8\.\d+-devel/.test(l)), `a CUDA 12.8 devel base at an exact tag: ${from.join(" | ")}`);
  const beside = readdirSync(root("docker/stt-kyutai")).filter((n) => n !== "Dockerfile");
  assert.ok(beside.some((n) => /\.(toml|ya?ml|json)$/.test(n)), `a server configuration file is committed beside the Dockerfile: ${beside.join(",")}`);
});

// @spec DEPLOY-ENG-007
test("every base image named by a Dockerfile under docker/ carries an exact version tag", () => {
  const files = dockerfiles();
  assert.ok(files.length >= 2, `found ${files.join(",")}`);
  for (const f of files) {
    const stages = new Set<string>();
    for (const l of lines(f)) {
      const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
      if (!m) continue;
      const image = m[1]!;
      if (!stages.has(image.toLowerCase()) && image !== "scratch") {
        const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
        assert.ok(tag, `${f}: ${image} has a tag`);
        assert.doesNotMatch(tag, /^latest/, `${f}: ${image} is not latest`);
        assert.match(tag, /\d+\.\d+\.\d+/, `${f}: ${image} names an exact version`);
      }
      if (m[2]) stages.add(m[2].toLowerCase());
    }
  }
});

// @spec DEPLOY-ENG-008
test("the engine servers publish on loopback only: 8881 to 8000, 8081 to 8080 and 8082 to 8080", () => {
  assert.deepEqual(POCKET.ports, ["127.0.0.1:8881:8000"]);
  assert.deepEqual(NEMOTRON.ports, ["127.0.0.1:8081:8080"]);
  assert.deepEqual(KYUTAI.ports, ["127.0.0.1:8082:8080"]);
});

// @spec DEPLOY-ENG-001, DEPLOY-ENG-002, DEPLOY-ENG-003
test("each engine server is behind its own profile: pocket, nemotron, kyutai", () => {
  assert.deepEqual(POCKET.profiles, ["pocket"]);
  assert.deepEqual(NEMOTRON.profiles, ["nemotron"]);
  assert.deepEqual(KYUTAI.profiles, ["kyutai"]);
});

// @spec DEPLOY-ENG-009, DEPLOY-COMPOSE-009
test("each engine server mounts a named volume of its own at an absolute cache path, and the volumes are declared top-level", () => {
  const want = { "tts-pocket": "tts-pocket-cache", "stt-nemotron": "stt-nemotron-cache", "stt-kyutai": "stt-kyutai-cache" } as const;
  for (const [name, volume] of Object.entries(want)) {
    const mounts = ENGINES[name as keyof typeof ENGINES].volumes!.filter((v) => v.startsWith(`${volume}:`));
    assert.equal(mounts.length, 1, `${name} mounts ${volume} once`);
    assert.match(mounts[0]!, /^[a-z-]+:\/[^:]+$/, `${name}: ${mounts[0]} mounts at an absolute path`);
    assert.ok(base.volumes && volume in base.volumes, `${volume} is a declared volume`);
  }
  for (const v of ["redis-data", "pg18-data", "ollama-data", "stt-cache"]) assert.ok(v in base.volumes!, `${v} stays declared`);
});

// @spec DEPLOY-ENG-010
test("the GPU overlay reserves the NVIDIA device for stt-nemotron and stt-kyutai and not for tts-pocket", () => {
  for (const name of ["stt-nemotron", "stt-kyutai"]) {
    const devices = gpu.services[name]?.deploy?.resources?.reservations?.devices;
    assert.ok(devices?.some((d) => d.driver === "nvidia" && d.capabilities?.includes("gpu")), `${name} reserves the GPU`);
  }
  assert.equal(gpu.services["tts-pocket"], undefined, "tts-pocket is absent from the overlay");
  assert.equal(base.services["tts-pocket"]!.deploy, undefined);
});

// @spec DEPLOY-ENG-011
test("the engine servers restart unless stopped", () => {
  for (const [name, s] of Object.entries(ENGINES)) assert.equal(s.restart, "unless-stopped", name);
});

// @spec DEPLOY-ENG-012
test("healthchecks: tts-pocket GET /health, stt-nemotron GET /ready, stt-kyutai a TCP connection, each with a 10 minute start period", () => {
  assert.match(joined(POCKET.healthcheck?.test), /\/health\b/);
  assert.match(joined(NEMOTRON.healthcheck?.test), /\/ready\b/);
  const tcp = joined(KYUTAI.healthcheck?.test);
  assert.match(tcp, /8080/, "probes the server's port");
  assert.doesNotMatch(tcp, /https?:\/\/|\/health|\/ready/, "no HTTP request: a TCP connection only");
  for (const [name, s] of Object.entries(ENGINES)) {
    assert.equal(s.healthcheck?.start_period, "10m", `${name} start period`);
    assert.ok(s.healthcheck?.interval && s.healthcheck?.timeout && s.healthcheck?.retries, `${name} has an interval, timeout and retries`);
  }
});

// @spec DEPLOY-ENG-013, DEPLOY-COMPOSE-005
test("voice and ears list the engine servers as service_started, required: false, and keep their other dependencies", () => {
  const optional = { condition: "service_started", required: false };
  assert.deepEqual(base.services.voice!.depends_on!["tts-pocket"], optional);
  assert.deepEqual(base.services.ears!.depends_on!["stt-nemotron"], optional);
  assert.deepEqual(base.services.ears!.depends_on!["stt-kyutai"], optional);
  assert.equal(base.services.voice!.depends_on!["stt-nemotron"], undefined, "voice waits for no STT server");
  assert.equal(base.services.ears!.depends_on!["tts-pocket"], undefined, "ears waits for no TTS server");
  assert.deepEqual(base.services.voice!.depends_on!.redis, { condition: "service_healthy" });
  assert.deepEqual(base.services.voice!.depends_on!.tts, { condition: "service_started" });
  assert.deepEqual(base.services.ears!.depends_on!.redis, { condition: "service_healthy" });
  assert.deepEqual(base.services.ears!.depends_on!.stt, { condition: "service_started" });
});

// @spec DEPLOY-COMPOSE-005
test("no service outside voice and ears depends on an engine server", () => {
  const edges = Object.entries(base.services).flatMap(([n, s]) => Object.keys(s.depends_on ?? {}).filter((d) => d in ENGINES).map((d) => `${n}>${d}`));
  assert.deepEqual(edges.sort(), ["ears>stt-kyutai", "ears>stt-nemotron", "voice>tts-pocket"]);
});

// @spec DEPLOY-ENG-014
test("tts-pocket's entrypoint is docker/tts-pocket/entrypoint.sh, mounted read-only and named by entrypoint:", () => {
  const mount = POCKET.volumes!.find((v) => v.startsWith("./docker/tts-pocket/entrypoint.sh:"))!;
  assert.ok(mount, "the script is bind-mounted");
  const [, target, mode] = mount.split(":");
  assert.equal(mode, "ro");
  assert.equal(joined(POCKET.entrypoint).trim(), target, "entrypoint: names the mounted path");
  assert.ok(existsSync(root("docker/tts-pocket/entrypoint.sh")));
});

const SECRET = "/run/cohost-secret/hf_token";
/** Runs the entrypoint with the secret path redirected to `dir`, handing off to the command given. */
function runEntry(secretDir: string, ...cmd: string[]) {
  const text = read("docker/tts-pocket/entrypoint.sh").replaceAll(SECRET, join(secretDir, "hf_token"));
  const script = join(secretDir, "entrypoint.sh");
  writeFileSync(script, text);
  return spawnSync("sh", [script, ...cmd], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
}

// @spec DEPLOY-ENG-014
test("the entrypoint exports the token file's content as HF_TOKEN for the command it runs, and runs it unchanged when the file is absent", () => {
  assert.ok(read("docker/tts-pocket/entrypoint.sh").includes(SECRET), "it reads /run/cohost-secret/hf_token");
  const dir = mkdtempSync(join(tmpdir(), "cohost-entry-"));
  try {
    const probe = ["sh", "-c", 'printf "%s|%s" "${HF_TOKEN-unset}" "$1"', "sh", "arg-kept"];
    const absent = runEntry(dir, ...probe);
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.stdout, "unset|arg-kept", "no file: HF_TOKEN stays unset and the command runs with its arguments");
    writeFileSync(join(dir, "hf_token"), "hf_secret_value\n");
    const present = runEntry(dir, ...probe);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(present.stdout, "hf_secret_value|arg-kept", "the file's content, without its trailing newline");
    assert.equal(runEntry(dir, "sh", "-c", "exit 7").status, 7, "the command is exec'd, so its exit status is the container's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec DEPLOY-ENG-015
test("no Compose file or Dockerfile carries the Pocket token as an environment entry, a build argument or an image layer", () => {
  for (const f of ["docker-compose.yml", "docker-compose.gpu.yml"]) {
    for (const [name, s] of Object.entries(load(f).services)) {
      const env = Array.isArray(s.environment) ? s.environment.map((e) => e.split("=")[0]!) : Object.keys(s.environment ?? {});
      for (const k of env) assert.doesNotMatch(k, /^HF_|HUGGING/i, `${f} ${name} sets ${k}`);
      const b = typeof s.build === "object" ? s.build.args : undefined;
      const args = Array.isArray(b) ? b.map((a) => a.split("=")[0]!) : Object.keys(b ?? {});
      for (const k of args) assert.doesNotMatch(k, /^HF_|HUGGING|TOKEN/i, `${f} ${name} passes build arg ${k}`);
    }
    assert.doesNotMatch(code(read(f)).replace(/\/run\/cohost-secret\/hf_token/g, ""), /hf_token|HF_TOKEN/, `${f} names the token nowhere but a mount`);
  }
  for (const f of dockerfiles()) assert.doesNotMatch(code(read(f)), /HF_TOKEN|hf_token|HUGGING_?FACE_HUB_TOKEN/i, f);
});

// @spec DEPLOY-ENG-016
test("the Compose service names are the hosts of the default engine URLs", () => {
  // The schema requires the sections that have no defaults (cohost, llm, vision, chat, avatar); the engine URLs default.
  const cfg = ConfigSchema.parse({
    cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
    voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
  });
  const hosts = [new URL(cfg.voice.pocket.url), new URL(cfg.ears.nemotron.url), new URL(cfg.ears.kyutai.url)];
  assert.deepEqual(hosts.map((u) => u.hostname), ["tts-pocket", "stt-nemotron", "stt-kyutai"]);
  for (const u of hosts) assert.ok(base.services[u.hostname], `${u.hostname} is a Compose service`);
  assert.deepEqual(hosts.map((u) => u.port), ["8000", "8080", "8080"], "the container ports");
});

// @spec DEPLOY-ENG-017
test("neither Compose file names latest-cu128; .env.example comments KOKORO_IMAGE with it for an RTX 50-series card and says it is unconfirmed", () => {
  for (const f of ["docker-compose.yml", "docker-compose.gpu.yml"]) assert.doesNotMatch(read(f), /latest-cu128/, f);
  const env = read(".env.example").split("\n");
  const at = env.findIndex((l) => /^#\s*KOKORO_IMAGE=.*latest-cu128/.test(l));
  assert.ok(at >= 0, "a commented KOKORO_IMAGE line naming latest-cu128");
  const block = env.slice(Math.max(0, at - 6), at + 3).join("\n");
  assert.match(block, /RTX 50/);
  assert.match(block, /not (?:been )?confirmed|unconfirmed/i);
});

// @spec DEPLOY-ENG-019
test("tts-pocket mounts no ./config; its only secret-bearing mount is data/tts-pocket-secret, read-only at /run/cohost-secret", () => {
  const vols = POCKET.volumes!;
  for (const v of vols) assert.doesNotMatch(v, /(^|:)\.\/config\b|\/app\/config|secrets\.yaml/, `mount ${v}`);
  assert.deepEqual(vols.filter((v) => /^\.\/data\b|secret/.test(v)), ["./data/tts-pocket-secret:/run/cohost-secret:ro"]);
  for (const v of vols) assert.match(v, /^(tts-pocket-cache:|\.\/docker\/tts-pocket\/entrypoint\.sh:|\.\/data\/tts-pocket-secret:)/, `unexpected mount ${v}`);
});
