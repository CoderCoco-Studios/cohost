import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST, type ServiceController } from "@cohost/control";
import { SECRET_PATHS } from "@cohost/config";
import { createDashboardHandler } from "../src/routes.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface Opts { control?: boolean; stack?: Partial<StackSnapshot>; write?: (f: string, t: string) => void; env?: NodeJS.ProcessEnv }

async function boot(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-settings-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, EXAMPLE);
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: string[] = [];
  const controller = new Proxy({}, { get: (_t, name) => () => { calls.push(String(name)); throw new Error("the settings routes must never drive a unit"); } }) as unknown as ServiceController;
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...o.stack };
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => file, configEnv: o.env ?? {}, ...(o.write ? { configWrite: o.write } : {}),
    ...(o.control ? { control: { token: "tok", runtime: "compose", advanced: false, controller } } : {}),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string) => fetch(base + path);
  const put = (path: string, body: unknown, token?: string) =>
    fetch(base + path, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { dir, file, bus, calls, get, put, text: () => readFileSync(file, "utf8") };
}

// @spec MOD-CFG-001
test("GET /config/schema lists every declared section and dashboard with its readers, JSON Schema and secrets, ungated", async () => {
  const t = await boot({ control: true });
  const r = await t.get("/config/schema");
  assert.equal(r.status, 200);
  const { sections } = (await r.json()) as { sections: { path: string; services: string[]; schema: any; secrets: string[] }[] };
  const declared = [...new Set(SERVICE_MANIFEST.flatMap((s) => s.config))];
  assert.deepEqual(sections.map((s) => s.path), [...declared, "dashboard"]);
  const llm = sections.find((s) => s.path === "llm")!;
  assert.deepEqual(llm.services, SERVICE_MANIFEST.filter((s) => s.config.includes("llm")).map((s) => s.id));
  assert.deepEqual(llm.secrets.sort(), ["claude.api_key", "openai.api_key"]);
  assert.equal(llm.schema.properties.provider.enum.includes("mock"), true);
  assert.deepEqual(sections.find((s) => s.path === "dashboard")!.services, []);
  assert.deepEqual(sections.find((s) => s.path === "voice")!.secrets, []);
  assert.ok(SECRET_PATHS.length >= 2);
});

// @spec MOD-CFG-003
test("GET /config/:section answers etag, keys and unknown for a declared section, 404 otherwise, ungated", async () => {
  const t = await boot({ control: true });
  const r = await t.get("/config/voice");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { section: string; etag: string; keys: Record<string, any>; unknown: string[] };
  assert.equal(j.section, "voice");
  assert.equal(j.etag, sha(t.text()));
  assert.equal(j.keys["engine"].source, "env-default");
  assert.deepEqual(j.unknown, []);
  assert.equal((await t.get("/config/brain.salience")).status, 200);
  assert.equal((await t.get("/config/dashboard")).status, 200);
  assert.equal((await t.get("/config/brain")).status, 404); // a schema path, but declared by no unit
  assert.equal((await t.get("/config/nope")).status, 404);
  assert.equal((await t.get("/config/")).status, 404);
});

// @spec MOD-CFG-005
test("a secret key never appears in a section's answer", async () => {
  const t = await boot({ env: { LLM_API_KEY: "sk-live-secret", ANTHROPIC_API_KEY: "sk-ant-secret" } });
  const body = await (await t.get("/config/llm")).text();
  assert.doesNotMatch(body, /sk-live-secret|sk-ant-secret/);
  const keys = JSON.parse(body).keys;
  assert.equal(keys["openai.api_key"].set, true);
  assert.equal(keys["openai.api_key"].editable, false);
  assert.equal("value" in keys["openai.api_key"], false);
});

// @spec MOD-CFG-007
test("PUT is gated by the control token and capped at 64 KiB, writing nothing otherwise", async () => {
  const t = await boot({ control: true });
  const etag = sha(t.text());
  const body = { etag, values: { speed: 1.2 } };
  assert.equal((await t.put("/config/voice", body)).status, 401);
  assert.equal((await t.put("/config/voice", body, "wrong")).status, 401);
  assert.equal(t.text(), EXAMPLE);
  const big = await t.put("/config/voice", JSON.stringify({ etag, values: { "fallback.lines": ["x".repeat(70 * 1024)] } }), "tok");
  assert.equal(big.status, 413);
  assert.equal(t.text(), EXAMPLE);
  assert.equal((await t.put("/config/voice", body, "tok")).status, 200);
  assert.match(t.text(), /speed: 1\.2/);
});

// @spec MOD-CFG-007
test("PUT answers 404 for an undeclared section and 400 for a malformed body", async () => {
  const t = await boot();
  assert.equal((await t.put("/config/nope", { etag: "x", values: {} })).status, 404);
  assert.equal((await t.put("/config/voice", "not json")).status, 400);
  assert.equal((await t.put("/config/voice", { etag: "x" })).status, 400);
  assert.equal((await t.put("/config/voice", { etag: sha(EXAMPLE), values: [] })).status, 400);
  assert.equal(t.text(), EXAMPLE);
});

// @spec MOD-CFG-008
test("a stale etag is a 409 carrying the current one, and nothing is written", async () => {
  const t = await boot();
  const stale = sha(t.text());
  writeFileSync(t.file, EXAMPLE + "\n# hand edit\n");
  const r = await t.put("/config/voice", { etag: stale, values: { speed: 1.2 } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, etag: sha(EXAMPLE + "\n# hand edit\n") });
  assert.equal(t.text(), EXAMPLE + "\n# hand edit\n");
});

// @spec MOD-CFG-009
test("a key outside the schema or not editable is a 400 naming each, and nothing is written", async () => {
  const t = await boot();
  const r = await t.put("/config/llm", { etag: sha(t.text()), values: { nope: 1, "openai.api_key": "x" } });
  assert.equal(r.status, 400);
  const j = (await r.json()) as { ok: boolean; issues: { path: string }[] };
  assert.equal(j.ok, false);
  assert.deepEqual(j.issues.map((i) => i.path).sort(), ["nope", "openai.api_key"]);
  assert.equal(t.text(), EXAMPLE);
});

// @spec MOD-CFG-012
test("an edit that makes the file invalid is a 400 with the loader's issues, and nothing is written", async () => {
  const t = await boot();
  const r = await t.put("/config/voice", { etag: sha(t.text()), values: { speed: -1 } });
  assert.equal(r.status, 400);
  assert.deepEqual(((await r.json()) as any).issues.map((i: any) => i.path), ["voice.speed"]);
  assert.equal(t.text(), EXAMPLE);
});

// @spec MOD-CFG-013
test("?dryRun=1 runs every check, writes nothing and answers 200 with warnings", async () => {
  const t = await boot({ env: { LLM_PROVIDER: "ollama" } });
  const etag = sha(t.text());
  const ok = await t.put("/config/llm?dryRun=1", { etag, values: { provider: "anthropic" } });
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as { ok: boolean; dryRun: boolean; warnings: string[] };
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.equal(j.warnings.length, 1);
  assert.match(j.warnings[0]!, /LLM_PROVIDER/);
  assert.equal(t.text(), EXAMPLE);
  assert.equal((await t.put("/config/voice?dryRun=1", { etag, values: { speed: -1 } })).status, 400);
  assert.equal((await t.put("/config/voice?dryRun=1", { etag: "stale", values: { speed: 1 } })).status, 409);
  assert.equal(t.text(), EXAMPLE);
});

// @spec MOD-CFG-014, MOD-CFG-015, MOD-CFG-016
test("a valid save rewrites the file atomically and answers the new etag, the running readers and the warnings", async () => {
  const t = await boot({ stack: { services: [{ service: "voice", status: "running" }, { service: "mouth", status: "exited" }, { service: "salience", status: "running" }] } });
  const before = t.text();
  const r = await t.put("/config/voice", { etag: sha(before), values: { speed: 1.25, voice: "bf_emma" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; etag: string; restart: string[]; warnings: string[] };
  assert.equal(j.ok, true);
  assert.equal(j.etag, sha(t.text()));
  assert.deepEqual(j.restart, ["voice"]);
  assert.deepEqual(j.warnings, []);
  assert.match(t.text(), /speed: 1\.25/);
  assert.match(t.text(), /bf_emma/);
  assert.equal(t.text().split("\n").length, before.split("\n").length); // comments and every other line kept
  assert.deepEqual(readdirSync(t.dir), ["config.yaml"]); // no temp file left behind
  assert.deepEqual(t.bus.published, []);
  assert.deepEqual(t.calls, []);
  assert.equal(readdirSync(t.dir).includes(".env"), false);
});

// @spec MOD-CFG-015
test("restart lists units in manifest order that read the section and are running; none when Docker is unavailable", async () => {
  const running = ["cortex", "salience", "memory", "affect", "voice"].map((service) => ({ service, status: "running" }));
  const t = await boot({ stack: { services: running } });
  const r = await t.put("/config/llm", { etag: sha(t.text()), values: { temperature: 0.5 } });
  assert.deepEqual(((await r.json()) as any).restart, ["salience", "affect", "memory", "cortex"]);
  const off = await boot({ stack: { docker: { ok: false, detail: "no docker" }, services: running } });
  const r2 = await off.put("/config/llm", { etag: sha(off.text()), values: { temperature: 0.5 } });
  assert.deepEqual(((await r2.json()) as any).restart, []);
});

// @spec MOD-CFG-015
test("warnings name a shadowed env default, and a dashboard save says it applies at the dashboard's next start", async () => {
  const t = await boot({ env: { VOICE_ENGINE: "stub" } });
  const r = await t.put("/config/voice", { etag: sha(t.text()), values: { engine: "kokoro" } });
  const j = (await r.json()) as { warnings: string[] };
  assert.equal(j.warnings.length, 1);
  assert.match(j.warnings[0]!, /voice\.engine.*VOICE_ENGINE/);
  const d = await t.put("/config/dashboard", { etag: sha(t.text()), values: { port: 3010 } });
  const dj = (await d.json()) as { warnings: string[]; restart: string[] };
  assert.deepEqual(dj.restart, []);
  assert.ok(dj.warnings.some((w) => /dashboard.*next start/i.test(w)));
});

// @spec MOD-CFG-014
test("a failed write is a 500 with the error text and the file unchanged", async () => {
  const t = await boot({ write: () => { throw new Error("disk full"); } });
  const r = await t.put("/config/voice", { etag: sha(t.text()), values: { speed: 1.5 } });
  assert.equal(r.status, 500);
  assert.match(await r.text(), /disk full/);
  assert.equal(t.text(), EXAMPLE);
});

// @spec MOD-CFG-010
test("a save leaves comments, unknown keys and other sections exactly as they were", async () => {
  const t = await boot();
  const withUnknown = EXAMPLE.replace("dashboard:", "legacy_key: 1   # old\ndashboard:");
  writeFileSync(t.file, withUnknown);
  const r = await t.put("/config/voice", { etag: sha(withUnknown), values: { speed: 1.1 } });
  assert.equal(r.status, 200);
  const changed = t.text().split("\n").filter((l, i) => l !== withUnknown.split("\n")[i]);
  assert.equal(changed.length, 1);
  assert.match(changed[0]!, /speed: 1\.1/);
  assert.match(t.text(), /legacy_key: 1 {3}# old/);
});
