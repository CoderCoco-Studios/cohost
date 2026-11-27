import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ollamaModels, ConfigSchema, OLLAMA_MODEL_SECTIONS, parseYaml, type Config } from "../src/index.js";
import { isolateEnv, repo } from "./helpers/config-sandbox.js";

isolateEnv();

const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({
  cohost: { name: "a", streamer: "b" }, llm: { model: "chat:1", embed_model: "embed:1" }, vision: { model: "" , obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {}, ...over,
});

// @spec CFG-MODEL-001
test("ollamaModels requires llm.model, llm.embed_model and vision.model only while their provider or engine is ollama", () => {
  assert.deepEqual(ollamaModels(cfg()), { required: ["chat:1", "embed:1"], optional: [] });
  assert.deepEqual(ollamaModels(cfg({ llm: { provider: "anthropic", model: "claude-x", embed_model: "embed:1" } })).required, ["embed:1"]);
  assert.deepEqual(ollamaModels(cfg({ brain: { memory: { embedder: "hash" } } })).required, ["chat:1"]);
  assert.deepEqual(ollamaModels(cfg({ llm: { provider: "mock", model: "m", embed_model: "e" }, brain: { memory: { embedder: "hash" } } })).required, []);
  assert.deepEqual(ollamaModels(cfg({ vision: { model: "vlm:1", obs: {} } })).required, ["chat:1", "embed:1", "vlm:1"]);
  assert.deepEqual(ollamaModels(cfg({ vision: { enabled: true, provider: "stub", model: "vlm:1", obs: {} } })).required, ["chat:1", "embed:1"], "the stub describer needs no model");
  for (const provider of ["openai", "anthropic", "bedrock"]) {
    assert.deepEqual(ollamaModels(cfg({ vision: { provider, model: "vlm:1", obs: {} } })).required, ["chat:1", "embed:1"], `a hosted ${provider} describer pulls no model`);
  }
  assert.deepEqual(ollamaModels(cfg({ vision: { enabled: true, provider: "ollama", model: "", obs: {} } })).required, ["chat:1", "embed:1"], "a blank vision.model is no requirement");
  assert.deepEqual(ollamaModels(cfg({ vision: { model: "chat:1", obs: {} } })).required, ["chat:1", "embed:1"], "no duplicate");
});

// @spec CFG-MODEL-001
test("ollamaModels lists as optional the model of each llm hook on ollama, an unset hook model meaning llm.model, with no duplicate and nothing already required", () => {
  const hook = (llm: Record<string, unknown> = {}, kind = "llm") => ({ kind, llm });
  const c = cfg({
    brain: {
      salience: { module: hook({ provider: "ollama", model: "small:1" }) },
      affect: { module: hook({ model: "small:1" }) },
      cortex: { critic: hook({ provider: "openai", model: "gpt-x" }) },
      memory: { notes: { capture: hook({ provider: "ollama", model: "gemma:4b" }), consolidator: hook({ provider: "ollama", model: "chat:1" }) } },
    },
  });
  assert.deepEqual(ollamaModels(c), { required: ["chat:1", "embed:1"], optional: ["small:1", "gemma:4b"] });
  const inherit = cfg({ brain: { salience: { module: hook() }, affect: { module: hook({}, "rules") }, cortex: { critic: hook({}, "http") } } });
  assert.deepEqual(ollamaModels(inherit).optional, [], "an inherited chat:1 is already required");
  const cloud = cfg({ llm: { provider: "anthropic", model: "claude-x", embed_model: "embed:1" }, brain: { salience: { module: hook() }, affect: { module: hook({ provider: "ollama", model: "tiny:1" }) } } });
  assert.deepEqual(ollamaModels(cloud).optional, ["tiny:1"], "a hook that inherits a non-ollama provider pulls nothing");
});

const script = join(repo, "packages", "config", "dist", "pull-models.js");

interface Fake { url: string; tags: number; pulls: string[]; close(): Promise<void> }
/** An Ollama stand-in: /api/tags answers 200, /api/pull answers per `behave(model)`: "ok", "http" (a 500) or "line" (a 200 holding an error line). */
async function fakeOllama(behave: (model: string) => "ok" | "http" | "line"): Promise<Fake> {
  const fake = { url: "", tags: 0, pulls: [] as string[] };
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") { fake.tags++; res.end("{}"); return; }
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      const model = (JSON.parse(body) as { name: string }).name;
      fake.pulls.push(model);
      const how = behave(model);
      if (how === "http") { res.statusCode = 500; res.end("boom"); return; }
      res.end(how === "line" ? `{"status":"pulling"}\n{"error":"no such model ${model}"}\n` : `{"status":"pulling"}\n{"status":"success"}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, { close: () => new Promise<void>((r) => { server.close(() => r()); }) });
}

/**
 * The `models` projection the control plane writes (settings-store STORE-PROJ-005): the sections `ollamaModels` reads, from the
 * shipped example, with `over` replacing whole sections.
 */
function modelsDir(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cohost-models-"));
  const example = parseYaml(readFileSync(join(repo, "config", "config.example.yaml"), "utf8")) as Record<string, unknown>;
  const at = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), example);
  const sections = Object.fromEntries(OLLAMA_MODEL_SECTIONS.map((p) => [p, over[p] ?? at(p) ?? {}]));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ format: 1, unit: "models", revision: 1, sections, documents: {} }));
  return dir;
}

function run(dir: string, ollama: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, CONFIG_DIR: dir, COHOST_ENV_FILE: join(dir, "..", ".env"), OLLAMA_URL: ollama } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// @spec CFG-MODEL-002
test("pull-models waits for ollama, pulls the required models then the optional ones, one after another, and exits 0", async () => {
  assert.ok(existsSync(script), "run `mise run build` first");
  const fake = await fakeOllama(() => "ok");
  try {
    const r = await run(modelsDir(), fake.url);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fake.tags >= 1);
    assert.deepEqual(fake.pulls, ["qwen2.5:7b-instruct-q4_K_M", "nomic-embed-text", "qwen2.5vl:3b", "gemma3:4b"]);
    assert.match(r.stdout, /success/);
  } finally { await fake.close(); }
});

// @spec CFG-MODEL-002
test("pull-models tries every model after a failed required pull (request error or error line) and then exits non-zero; a failed optional pull is only a warning", async () => {
  const failing = await fakeOllama((m) => (m === "nomic-embed-text" ? "line" : m === "qwen2.5vl:3b" ? "http" : "ok"));
  try {
    const r = await run(modelsDir(), failing.url);
    assert.notEqual(r.code, 0);
    assert.equal(failing.pulls.length, 4, "the remaining models are still tried");
    assert.match(r.stderr, /nomic-embed-text/);
    assert.match(r.stderr, /qwen2\.5vl:3b/);
  } finally { await failing.close(); }
  const optional = await fakeOllama((m) => (m === "gemma3:4b" ? "line" : "ok"));
  try {
    const r = await run(modelsDir(), optional.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /WARNING.*gemma3:4b/);
  } finally { await optional.close(); }
});

// @spec CFG-MODEL-002
test("pull-models exits non-zero with the loader's error naming the failing keys and pulls nothing when the config is invalid", async () => {
  const fake = await fakeOllama(() => "ok");
  try {
    const bad = await run(modelsDir({ llm: { model: "", embed_model: "e" } }), fake.url);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /llm\.model/);
    const provider = await run(modelsDir({ vision: { provider: "nope" } }), fake.url);
    assert.notEqual(provider.code, 0);
    assert.match(provider.stderr, /vision\.provider/);
    assert.deepEqual(fake.pulls, []);
    assert.equal(fake.tags, 0, "it does not even wait for ollama");
  } finally { await fake.close(); }
});
