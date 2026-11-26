import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { shippedSandbox, repo } from "./helpers/config-sandbox.js";

// Structural checks of the compose `models` one-shot, and a run of its command (the config package's pull-models entry)
// against a fake Ollama. Docker is not run: the file is parsed as YAML with merge keys resolved.

const composePath = fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url));
const source = readFileSync(composePath, "utf8");
interface Svc {
  build?: { context?: string; args?: { SERVICE?: string } };
  image?: string;
  command?: string[];
  entrypoint?: unknown;
  restart?: string;
  env_file?: unknown;
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: Record<string, { condition?: string }> | string[];
  profiles?: string[];
}
const compose = parse(source, { merge: true }) as { services: Record<string, Svc> };
const models = compose.services.models!;

// @spec DEPLOY-COMPOSE-008
test("models builds the shared Dockerfile with SERVICE memory, mounts ./config, waits for ollama started and not redis, and runs pull-models", () => {
  assert.equal(models.build?.context, ".");
  assert.equal(models.build?.args?.SERVICE, "memory");
  assert.equal(models.image, undefined, "no separate image");
  assert.deepEqual(models.command, ["node", "packages/config/dist/pull-models.js"]);
  assert.equal(models.entrypoint, undefined);
  assert.deepEqual(models.volumes, ["./config:/app/config"]);
  assert.deepEqual(models.depends_on, { ollama: { condition: "service_started" } });
  assert.equal(models.profiles, undefined, "no profile: a plain `docker compose up -d` pulls the models");
});

// @spec DEPLOY-COMPOSE-008
test("models takes its model names from config.yaml alone: no model-name variable in .env or its environment, no STT model", () => {
  const code = source.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /LLM_MODEL|VISION_MODEL|EMBED_MODEL|NOTES_MODEL|STT_MODEL/);
  assert.equal(models.env_file, undefined, "nothing in .env reaches it");
  assert.deepEqual(Object.keys(models.environment ?? {}).toSorted(), ["CONFIG_DIR", "OLLAMA_URL"]);
  assert.equal(models.environment!.OLLAMA_URL, "http://ollama:11434");
  assert.equal(models.environment!.CONFIG_DIR, "/app/config");
});

// @spec DEPLOY-COMPOSE-011
test("the models service carries no restart policy", () => {
  assert.equal(models.restart, undefined);
});

interface Fake { url: string; pulls: string[]; close(): Promise<void> }
async function fakeOllama(behave: (model: string) => "ok" | "http" | "line"): Promise<Fake> {
  const fake = { url: "", pulls: [] as string[] };
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") { res.end("{}"); return; }
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      const model = (JSON.parse(body) as { name: string }).name;
      fake.pulls.push(model);
      const how = behave(model);
      if (how === "http") { res.statusCode = 500; res.end("boom"); return; }
      res.end(how === "line" ? `{"error":"no such model ${model}"}\n` : `{"status":"success"}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, { close: () => new Promise<void>((r) => { server.close(() => r()); }) });
}

/** Runs the compose command (`node <script>`) from the repository root with the service's environment pointed at the sandbox and the fake. */
function runCommand(ollama: string): Promise<{ code: number | null; stderr: string }> {
  const [exe, script] = models.command!;
  const env = { ...process.env, ...models.environment, CONFIG_DIR: shippedSandbox(), OLLAMA_URL: ollama };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script!], { cwd: repo, env });
    assert.equal(exe, "node");
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// @spec DEPLOY-COMPOSE-011
test("the models command exits non-zero after attempting every model when a required pull fails (error line or HTTP error)", async () => {
  for (const how of ["line", "http"] as const) {
    const fake = await fakeOllama((m) => (m === "nomic-embed-text" ? how : "ok"));
    try {
      const r = await runCommand(fake.url);
      assert.notEqual(r.code, 0, how);
      assert.equal(fake.pulls.length, 4, `${how}: every model attempted`);
      assert.match(r.stderr, /nomic-embed-text/);
    } finally { await fake.close(); }
  }
});

// @spec DEPLOY-COMPOSE-011
test("the models command logs a failed optional pull as a warning on stderr and exits 0", async () => {
  const fake = await fakeOllama((m) => (m === "gemma3:4b" ? "line" : "ok"));
  try {
    const r = await runCommand(fake.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /WARNING.*gemma3:4b/);
  } finally { await fake.close(); }
});

// @spec DEPLOY-README-001
test("config.example.yaml says the models service pulls what llm.model, llm.embed_model and vision.model name, and not ears.stt_model", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8").split("\n").filter((l) => l.trimStart().startsWith("#")).join("\n");
  assert.match(text, /`models` service[^]*llm\.model, llm\.embed_model and vision\.model/);
  assert.match(text, /hook models/);
  assert.match(text, /ears\.stt_model is not pulled/);
});
