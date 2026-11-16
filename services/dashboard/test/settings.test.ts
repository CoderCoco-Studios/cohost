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
import { SECRET_PATHS, GROUPS } from "@cohost/config";
import { createDashboardHandler } from "../src/routes.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface Opts { control?: boolean; stack?: Partial<StackSnapshot>; write?: (f: string, t: string) => void; secrets?: string }

async function boot(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-settings-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, EXAMPLE);
  if (o.secrets !== undefined) writeFileSync(join(dir, "secrets.yaml"), o.secrets, { mode: 0o600 });
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: string[] = [];
  const controller = new Proxy({}, { get: (_t, name) => () => { calls.push(String(name)); throw new Error("the settings routes must never drive a unit"); } }) as unknown as ServiceController;
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...o.stack };
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => file, ...(o.write ? { configWrite: o.write } : {}),
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
  assert.deepEqual(llm.secrets.sort(), ["bedrock.access_key_id", "bedrock.secret_access_key", "claude.api_key", "openai.api_key"]);
  assert.equal(llm.schema.properties.provider.enum.includes("mock"), true);
  assert.deepEqual(sections.find((s) => s.path === "dashboard")!.services, []);
  assert.deepEqual(sections.find((s) => s.path === "voice")!.secrets, []);
  assert.deepEqual(sections.find((s) => s.path === "ears")!.secrets, ["http.token"]);
  assert.ok(SECRET_PATHS.length >= 2);
});

// @spec MOD-CFG-001, MOD-CFG-019, MOD-CFG-020, MOD-CFG-021
test("GET /config/schema carries the groups and each section's title, group, about, page and per-key presentation, with the help as the schema description", async () => {
  const t = await boot({ control: true });
  const body = (await (await t.get("/config/schema")).json()) as { groups: string[]; sections: any[] };
  assert.deepEqual(body.groups, [...GROUPS]);
  for (const s of body.sections) {
    assert.ok(typeof s.title === "string" && s.title && typeof s.about === "string" && s.about, `${s.path}: title and about`);
    assert.ok(body.groups.includes(s.group), `${s.path}: group`);
    for (const [k, p] of Object.entries<any>(s.keys)) assert.ok(typeof p.help === "string" && p.help, `${s.path}.${k}: help`);
  }
  const by = (path: string) => body.sections.find((s) => s.path === path)!;
  assert.equal(by("brain.working_memory_events").page, "brain.memory");
  assert.equal(by("llm").page, undefined);
  const llm = by("llm");
  assert.deepEqual(llm.keys["model"].widget, { type: "model", kind: "chat" });
  assert.equal(llm.keys["openai.base_url"].sensitive, true);
  assert.equal(llm.schema.properties.model.description, llm.keys["model"].help);
  assert.equal(llm.schema.properties.openai.properties.base_url["x-sensitive"], true);
  assert.equal(by("voice").keys["lang_code"].widget.type, "options");
  assert.deepEqual(by("ears").keys["sources"].widget, { type: "sources" });
  const reflexes = by("brain.salience").keys["reflexes"];
  assert.deepEqual(Object.keys(reflexes.items).sort(), ["cooldown_ms", "emotion", "gesture", "match", "on", "say"]);
  assert.equal(by("brain.salience").schema.properties.reflexes.items.properties.match.description, reflexes.items.match.help);
});

// @spec MOD-CFG-003
test("GET /config/:section answers etag, keys and unknown for a declared section, 404 otherwise, ungated", async () => {
  const t = await boot({ control: true });
  const r = await t.get("/config/voice");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { section: string; etag: string; keys: Record<string, any>; unknown: string[] };
  assert.equal(j.section, "voice");
  assert.equal(j.etag, sha(t.text()));
  assert.equal(j.keys["engine"].source, "literal");
  assert.deepEqual(j.unknown, []);
  assert.equal((await t.get("/config/brain.salience")).status, 200);
  assert.equal((await t.get("/config/dashboard")).status, 200);
  assert.equal((await t.get("/config/brain")).status, 404); // a schema path, but declared by no unit
  assert.equal((await t.get("/config/nope")).status, 404);
  assert.equal((await t.get("/config/")).status, 404);
});

// @spec MOD-CFG-005
test("a secret key never appears in a section's answer", async () => {
  const t = await boot({ secrets: "llm:\n  openai:\n    api_key: sk-live-secret\n" });
  const body = await (await t.get("/config/llm")).text();
  assert.doesNotMatch(body, /sk-live-secret/);
  const keys = JSON.parse(body).keys;
  assert.equal(keys["openai.api_key"].set, true);
  assert.equal(keys["claude.api_key"].set, false);
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

// @spec MOD-CFG-003, MOD-CFG-008, DASH-SET-031
test("the etag belongs to the file: every section read answers the same one, a write to any section replaces it for all, and the old one is then a 409", async () => {
  const t = await boot();
  const etagOf = async (section: string) => ((await (await t.get(`/config/${section}`)).json()) as { etag: string }).etag;
  const first = await etagOf("voice");
  assert.equal(await etagOf("dashboard"), first, "two sections, one file, one etag");
  const w = await t.put("/config/voice", { etag: first, values: { speed: 1.2 } });
  assert.equal(w.status, 200);
  const next = ((await w.json()) as { etag: string }).etag;
  assert.notEqual(next, first);
  assert.equal(await etagOf("dashboard"), next, "a read of another section answers the etag the write answered");
  assert.equal((await t.put("/config/dashboard", { etag: first, values: { port: 3010 } })).status, 409, "the etag from before the write is stale for every section");
  const second = await t.put("/config/dashboard", { etag: next, values: { port: 3010 } });
  assert.equal(second.status, 200, "the etag the first write answered is the one the second needs");
  const reread = await (await t.get("/config/voice")).json() as { etag: string; keys: Record<string, { value: unknown }> };
  assert.equal(reread.etag, ((await second.json()) as { etag: string }).etag);
  assert.equal(reread.keys["speed"]!.value, 1.2, "Reload after a 409 reads the current file");
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
  const t = await boot();
  const etag = sha(t.text());
  const ok = await t.put("/config/dashboard?dryRun=1", { etag, values: { port: 3010 } });
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as { ok: boolean; dryRun: boolean; warnings: string[] };
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.equal(j.warnings.length, 2, "the next-start notice and the new page address");
  assert.match(j.warnings[0]!, /next start/);
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
test("a dashboard save says it applies at the dashboard's next start, and a save of another section warns of nothing", async () => {
  const t = await boot();
  const r = await t.put("/config/voice", { etag: sha(t.text()), values: { engine: "stub" } });
  const j = (await r.json()) as { warnings: string[] };
  assert.deepEqual(j.warnings, []);
  const d = await t.put("/config/dashboard", { etag: sha(t.text()), values: { port: 3010 } });
  const dj = (await d.json()) as { warnings: string[]; restart: string[] };
  assert.deepEqual(dj.restart, []);
  assert.ok(dj.warnings.some((w) => /dashboard.*next start/i.test(w)));
});

const svc = (service: string, overrides?: Record<string, string>, status = "running") => ({ service, status, ...(overrides ? { overrides } : {}) });

// @spec MOD-CFG-018
test("a running unit that declares the section and was started with an override is listed in isolation.overriddenBy of the key the override name selects", async () => {
  const t = await boot({ stack: { services: [svc("avatar", { AVATAR_DRIVER: "null" }), svc("cortex", { LLM_PROVIDER: "mock" }), svc("voice", {}), svc("salience")] } });
  const avatar = (await (await t.get("/config/avatar")).json()) as { keys: Record<string, { isolation?: { name: string; overriddenBy: string[] } }> };
  assert.deepEqual(avatar.keys.driver!.isolation, { name: "AVATAR_DRIVER", overriddenBy: ["avatar"] });
  const llm = (await (await t.get("/config/llm")).json()) as { keys: Record<string, { isolation?: { name: string; overriddenBy: string[] } }> };
  assert.deepEqual(llm.keys.provider!.isolation, { name: "LLM_PROVIDER", overriddenBy: ["cortex"] });
  const voice = (await (await t.get("/config/voice")).json()) as { keys: Record<string, { isolation?: unknown }> };
  assert.equal(voice.keys.engine!.isolation === undefined || (voice.keys.engine!.isolation as { overriddenBy: string[] }).overriddenBy.length === 0, true, "an empty overrides object overrides nothing");
});

// @spec MOD-CFG-018
test("a unit that does not declare the section, is not running, or runs while Docker is unavailable is never listed", async () => {
  const listed = async (o: Opts, path: string, key: string): Promise<string[]> => {
    const j = (await (await (await boot(o)).get(path)).json()) as { keys: Record<string, { isolation?: { overriddenBy: string[] } }> };
    return j.keys[key]!.isolation?.overriddenBy ?? [];
  };
  assert.deepEqual(await listed({ stack: { services: [svc("cortex", { AVATAR_DRIVER: "null" })] } }, "/config/avatar", "driver"), [], "cortex does not declare avatar");
  assert.deepEqual(await listed({ stack: { services: [svc("avatar", { AVATAR_DRIVER: "null" }, "exited")] } }, "/config/avatar", "driver"), [], "not running");
  assert.deepEqual(await listed({ stack: { docker: { ok: false, detail: "no docker" }, services: [svc("avatar", { AVATAR_DRIVER: "null" })] } }, "/config/avatar", "driver"), [], "Docker unavailable");
  assert.deepEqual(await listed({ stack: { services: [svc("avatar")] } }, "/config/avatar", "driver"), [], "overrides unread");
});

// @spec MOD-CFG-015
test("a save of a key an isolated running unit overrides warns naming the key, the unit and that it applies after a start without isolation", async () => {
  const t = await boot({ stack: { services: [svc("avatar", { AVATAR_DRIVER: "null" })] } });
  const dry = await t.put("/config/avatar?dryRun=1", { etag: sha(t.text()), values: { driver: "vmc" } });
  const warnings = ((await dry.json()) as { warnings: string[] }).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /avatar\.driver/);
  assert.match(warnings[0]!, /avatar is running isolated with AVATAR_DRIVER/);
  const real = await t.put("/config/avatar", { etag: sha(t.text()), values: { driver: "vmc" } });
  assert.equal(real.status, 200);
  assert.deepEqual(((await real.json()) as { warnings: string[] }).warnings, warnings);
});

// @spec MOD-CFG-017
test("no /config response, an error or an issue message included, holds a secret value or a hash of secrets.yaml or of a secret value", async () => {
  const secretText = 'llm:\n  openai:\n    api_key: "sk-live-secret"\n';
  const t = await boot({ secrets: secretText });
  const seen: string[] = [];
  const keep = async (r: Response): Promise<number> => { seen.push(await r.text()); return r.status; };
  await keep(await t.get("/config/schema"));
  await keep(await t.get("/config/llm"));
  await keep(await t.get("/config/nope"));
  await keep(await t.put("/config/llm", { etag: sha(t.text()), values: { "openai.api_key": "sk-live-secret" } }));
  await keep(await t.put("/config/llm", { etag: "stale", values: { temperature: 0.5 } }));
  await keep(await t.put("/config/llm", { etag: sha(t.text()), values: { temperature: -1 } }));
  await keep(await t.put("/config/llm?dryRun=1", { etag: sha(t.text()), values: { temperature: 0.5 } }));
  const all = seen.join("\n");
  for (const forbidden of ["sk-live-secret", sha(secretText), sha("sk-live-secret"), sha(readFileSync(join(t.dir, "secrets.yaml"), "utf8"))]) assert.ok(!all.includes(forbidden), forbidden);
});

// @spec MOD-CFG-016
test("the settings routes read and write config.yaml only: no .env, no secrets.yaml, no unit started, stopped or restarted", async () => {
  const t = await boot({ secrets: 'llm:\n  openai:\n    api_key: "sk-secret"\n', stack: { services: [svc("voice")] } });
  const before = readFileSync(join(t.dir, "secrets.yaml"), "utf8");
  assert.equal((await t.put("/config/llm", { etag: sha(t.text()), values: { "openai.api_key": "pasted" } })).status, 400, "a secret key in a PUT is refused");
  assert.equal((await t.put("/config/voice", { etag: sha(t.text()), values: { speed: 1.1 } })).status, 200);
  assert.equal(readFileSync(join(t.dir, "secrets.yaml"), "utf8"), before);
  assert.deepEqual(readdirSync(t.dir).sort(), ["config.yaml", "secrets.yaml"]);
  assert.deepEqual(t.calls, []);
  const src = readFileSync(join(repo, "services", "dashboard", "src", "settings.ts"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
  assert.doesNotMatch(src, /\.env\b|process\.env|\benv\b/, "settings.ts takes no environment");
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
