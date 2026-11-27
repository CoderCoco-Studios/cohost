import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
  deploy?: { resources?: { reservations?: { devices?: Array<{ driver?: string; count?: number | string; capabilities?: string[] }> } } };
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
  return readdirSync(root(dir)).toSorted().flatMap((n) => {
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
  assert.deepEqual(edges.toSorted(), ["ears>stt-kyutai", "ears>stt-nemotron", "voice>tts-pocket"]);
});

// @spec DEPLOY-ENG-014
test("tts-pocket's entrypoint is docker/tts-pocket/entrypoint.sh, mounted read-only and named by entrypoint:", () => {
  const mount = POCKET.volumes!.find((v) => v.startsWith("./docker/tts-pocket/entrypoint.sh:"))!;
  assert.ok(mount, "the script is bind-mounted");
  const [, target, mode] = mount.split(":");
  assert.equal(mode, "ro");
  assert.deepEqual(POCKET.entrypoint, ["/bin/sh", target], "entrypoint: the shell runs the mounted script, so no exec bit or line ending is needed");
  assert.ok(existsSync(root("docker/tts-pocket/entrypoint.sh")));
});

const TOKEN = "/run/cohost/hf_token";

// @spec DEPLOY-ENG-014
test("the entrypoint waits with no timeout for /run/cohost/hf_token, reads it, deletes it, exports a non-empty value as HF_TOKEN and execs the command", () => {
  const script = code(read("docker/tts-pocket/entrypoint.sh"));
  assert.match(script, /^TOKEN_FILE=\/run\/cohost\/hf_token$/m, "the token file is /run/cohost/hf_token");
  assert.match(script, /while \[ ! -f "\$TOKEN_FILE" \]; do sleep \d+; done/, "it waits for the file");
  assert.doesNotMatch(script, /\btimeout\b|\s-(gt|ge|lt|le)\s|\$\(\(/, "no timeout, counter or deadline bounds the wait");
  const readAt = script.indexOf('HF_TOKEN="$(cat "$TOKEN_FILE")"');
  const rmAt = script.indexOf('rm -f "$TOKEN_FILE"');
  const exportAt = script.indexOf('if [ -n "$HF_TOKEN" ]; then export HF_TOKEN; else unset HF_TOKEN; fi');
  assert.ok(readAt >= 0, "it reads the file's content");
  assert.ok(rmAt > readAt, "it deletes the file after reading it");
  assert.ok(exportAt >= 0, "HF_TOKEN is exported only when not empty, and unset otherwise");
  assert.equal(script.trimEnd().split("\n").at(-1), 'exec "$@"', "it ends by replacing the shell with the command, unchanged");
  const trapAt = script.indexOf("trap 'exit 143' TERM INT");
  assert.ok(trapAt >= 0 && trapAt < script.indexOf("while"), "a stop while it waits ends it with 143, before the wait starts");
});

// @spec DEPLOY-ENG-014
test("a SIGTERM while the entrypoint waits for the token ends it with status 143", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-entry-"));
  try {
    const script = join(dir, "entrypoint.sh");
    writeFileSync(script, read("docker/tts-pocket/entrypoint.sh").replaceAll(TOKEN, join(dir, "hf_token")));
    const child = spawn("sh", [script, "true"], { env: { PATH: process.env.PATH ?? "" }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    const status = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    assert.equal(status, 143);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the entrypoint with the token path redirected into `dir` (the file already written, so the wait ends at once). */
function runEntry(dir: string, ...cmd: string[]) {
  const text = read("docker/tts-pocket/entrypoint.sh").replaceAll(TOKEN, join(dir, "hf_token"));
  const script = join(dir, "entrypoint.sh");
  writeFileSync(script, text);
  return spawnSync("sh", [script, ...cmd], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 10_000 });
}

// @spec DEPLOY-ENG-014
test("with the token file present, the entrypoint passes a non-empty token as HF_TOKEN, leaves it unset for an empty file, deletes the file and execs the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-entry-"));
  try {
    const probe = ["sh", "-c", 'printf "%s|%s" "${HF_TOKEN-unset}" "$1"', "sh", "arg-kept"];
    writeFileSync(join(dir, "hf_token"), "hf_secret_value\n");
    const present = runEntry(dir, ...probe);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(present.stdout, "hf_secret_value|arg-kept", "the file's content, without its trailing newline");
    assert.ok(!existsSync(join(dir, "hf_token")), "the file is deleted");
    writeFileSync(join(dir, "hf_token"), "");
    const empty = runEntry(dir, ...probe);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, "unset|arg-kept", "an empty file: HF_TOKEN stays unset and the command runs with its arguments");
    writeFileSync(join(dir, "hf_token"), "");
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
    assert.doesNotMatch(code(read(f)), /hf_token|HF_TOKEN/, `${f} names the token nowhere`);
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

// @spec DEPLOY-COMPOSE-010
test("the GPU overlay reserves every NVIDIA device for ollama, tts and stt and switches tts and stt to the GPU images", () => {
  for (const name of ["ollama", "tts", "stt"]) {
    const devices = gpu.services[name]?.deploy?.resources?.reservations?.devices;
    assert.ok(devices?.some((d) => d.driver === "nvidia" && d.count === "all" && d.capabilities?.includes("gpu")), `${name} reserves every NVIDIA device`);
  }
  assert.equal(gpu.services.tts!.image, "${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu128}");
  assert.equal(gpu.services.stt!.image, "${SPEACHES_IMAGE:-ghcr.io/speaches-ai/speaches:0.8.3-cuda}");
});

// @spec DEPLOY-ENG-017
test("the GPU overlay's tts defaults to Kokoro-FastAPI v0.10.0-cu128 with a dated reason; latest-cu128 is named nowhere; .env.example offers v0.10.0-cu126", () => {
  assert.equal(gpu.services.tts!.image, "${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu128}");
  const lines = read("docker-compose.gpu.yml").split("\n");
  const at = lines.findIndex((l) => /^\s*image:.*kokoro-fastapi-gpu:v0\.10\.0-cu128/.test(l));
  assert.ok(at >= 0, "the overlay's tts image line");
  // The comment block directly above the image line gives the reason and the date the tag was looked up.
  let from = at;
  while (from > 0 && lines[from - 1]!.trimStart().startsWith("#")) from--;
  const comment = lines.slice(from, at).join("\n");
  assert.match(comment, /RTX 50/, "the reason names RTX 50-series cards");
  assert.match(comment, /\b\d{4}-\d{2}-\d{2}\b/, "the comment dates the lookup");
  for (const f of ["docker-compose.yml", "docker-compose.gpu.yml", ".env.example"]) assert.doesNotMatch(read(f), /latest-cu128/, f);
  assert.ok(read(".env.example").split("\n").some((l) => /^#\s*KOKORO_IMAGE=ghcr\.io\/remsky\/kokoro-fastapi-gpu:v0\.10\.0-cu126$/.test(l)), "a commented KOKORO_IMAGE line naming v0.10.0-cu126");
});

// @spec DEPLOY-ENG-019, DEPLOY-COMPOSE-033, DEPLOY-COMPOSE-034
test("tts-pocket mounts no projection and nothing under ./data (only its cache and the read-only entrypoint), and has the /run/cohost tmpfs and no core file", () => {
  const vols = POCKET.volumes!;
  for (const v of vols) assert.equal(typeof v, "string", "no long-syntax mount: no projection bind");
  for (const v of vols) assert.doesNotMatch(v, /(^|:)\.\/config\b|\/app\/config|projections|^\.\/data\b|\/run\/cohost/, `mount ${v}`);
  assert.deepEqual(vols.toSorted(), ["./docker/tts-pocket/entrypoint.sh:/cohost/entrypoint.sh:ro", "tts-pocket-cache:/root/.cache"]);
  const pocket = POCKET as Svc & { tmpfs?: string[]; ulimits?: { core?: unknown } };
  assert.deepEqual(pocket.tmpfs, ["/run/cohost:mode=0700,size=1m"], "the token arrives in RAM");
  assert.equal(pocket.ulimits?.core, 0);
});
