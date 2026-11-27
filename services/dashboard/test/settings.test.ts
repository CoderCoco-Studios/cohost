import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST, type ServiceController } from "@cohost/control";
import { SECRET_PATHS, GROUPS } from "@cohost/config";
import type { Store } from "@cohost/store";
import { createDashboardHandler } from "../src/routes.js";
import type { StackService, StackSnapshot } from "../src/stack.js";
import { TOKEN, testControl } from "./control-fixture.js";
import { rawSection, repo, storedSection, testStore } from "./store-fixture.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface Opts { stack?: Partial<StackSnapshot>; secrets?: Record<string, string>; failWrite?: string }

async function boot(o: Opts = {}) {
  const st = await testStore({ token: false });
  after(() => st.close());
  if (o.secrets) assert.equal(st.store.write({ secrets: o.secrets }).ok, true);
  const real = st.store;
  // A store whose one write fails (a full disk), every other call the real store's.
  const store = o.failWrite === undefined ? real : new Proxy(real, {
    get: (target, key) => {
      if (key === "writeWithRetry") return async () => { throw new Error(o.failWrite); };
      const v = Reflect.get(target, key) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: string[] = [];
  const controller = new Proxy({}, { get: (_t, name) => () => { calls.push(String(name)); throw new Error("the settings routes must never drive a unit"); } }) as unknown as ServiceController;
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...o.stack };
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store, root: st.root, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    control: testControl({ controller }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string) => fetch(base + path);
  /** A PUT with the control token unless `token` names another, or is null for none. */
  const put = (path: string, body: unknown, token: string | null = TOKEN) =>
    fetch(base + path, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  /** The store's revision as the etag, and the stored sections and credentials as text: unchanged text means nothing was written. */
  const etag = () => String(real.revision());
  const snapshot = () => JSON.stringify({ revision: real.revision(), sections: real.sections(), secrets: real.secretPaths() });
  return { ...st, bus, calls, get, put, etag, snapshot, section: (p: string) => storedSection(real, p) };
}

// @spec MOD-CFG-001
test("GET /config/schema lists every declared section and dashboard with its readers, JSON Schema and secrets, ungated", async () => {
  const t = await boot();
  const r = await t.get("/config/schema");
  assert.equal(r.status, 200);
  const { sections } = (await r.json()) as { sections: { path: string; services: string[]; schema: any; secrets: string[] }[] };
  const declared = [...new Set(SERVICE_MANIFEST.flatMap((s) => s.config))];
  assert.deepEqual(sections.map((s) => s.path), [...declared, "dashboard", "renderer"]);
  assert.deepEqual(sections.find((s) => s.path === "renderer")!.services, []);
  assert.deepEqual(sections.find((s) => s.path === "renderer")!.secrets, []);
  const llm = sections.find((s) => s.path === "llm")!;
  assert.deepEqual(llm.services, SERVICE_MANIFEST.filter((s) => s.config.includes("llm")).map((s) => s.id));
  assert.deepEqual(llm.secrets.toSorted(), ["bedrock.access_key_id", "bedrock.secret_access_key", "claude.api_key", "openai.api_key"]);
  assert.equal(llm.schema.properties.provider.enum.includes("mock"), true);
  assert.deepEqual(sections.find((s) => s.path === "dashboard")!.services, []);
  assert.deepEqual(sections.find((s) => s.path === "voice")!.secrets.slice().toSorted(), ["openai.api_key", "pocket.hf_token"]); // CFG-SCH-059, CFG-SCH-061
  assert.deepEqual(sections.find((s) => s.path === "ears")!.secrets.slice().toSorted(), ["kyutai.api_key", "nemotron.api_key", "openai.api_key"]); // CFG-SCH-065..067
  assert.ok(SECRET_PATHS.length >= 2);
});

// @spec MOD-CFG-001, MOD-CFG-019, MOD-CFG-020, MOD-CFG-021
test("GET /config/schema carries the groups and each section's title, group, about, page and per-key presentation, with the help as the schema description", async () => {
  const t = await boot();
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
  assert.deepEqual(Object.keys(reflexes.items).toSorted(), ["cooldown_ms", "emotion", "gesture", "match", "on", "say"]);
  assert.equal(by("brain.salience").schema.properties.reflexes.items.properties.match.description, reflexes.items.match.help);
});

// @spec MOD-CFG-003, MOD-CFG-004
test("GET /config/:section answers the store's revision as etag, keys and unknown for a declared section, 404 otherwise, ungated", async () => {
  const t = await boot();
  const r = await t.get("/config/voice");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { section: string; etag: string; keys: Record<string, any>; unknown: string[] };
  assert.equal(j.section, "voice");
  assert.equal(j.etag, t.etag());
  assert.equal(j.keys["engine"].source, "literal", "the seeded example holds voice.engine");
  assert.equal(j.keys["engine"].value, t.section("voice")["engine"]);
  assert.deepEqual(j.unknown, []);
  assert.equal((await t.get("/config/brain.salience")).status, 200);
  assert.equal((await t.get("/config/dashboard")).status, 200);
  assert.equal((await t.get("/config/brain")).status, 404); // a schema path, but declared by no unit
  assert.equal((await t.get("/config/nope")).status, 404);
  assert.equal((await t.get("/config/")).status, 404);
});

// @spec MOD-CFG-004
test("a key the stored section does not hold is a default with the schema's value; one it holds is literal with its raw text", async () => {
  const t = await boot();
  const voice: Record<string, unknown> = { ...t.section("voice"), speed: 1.3 };
  delete voice["sample_rate"];
  rawSection(t.opts.dataDir!, "voice", voice);
  const keys = ((await (await t.get("/config/voice")).json()) as { keys: Record<string, { source: string; value?: unknown; raw?: string; editable: boolean }> }).keys;
  assert.equal(keys["speed"]!.source, "literal");
  assert.equal(keys["speed"]!.value, 1.3);
  assert.equal(keys["speed"]!.raw?.trim(), "1.3");
  assert.equal(keys["sample_rate"]!.source, "default");
  assert.equal(typeof keys["sample_rate"]!.value, "number");
  assert.equal(keys["sample_rate"]!.editable, true);
});

// @spec MOD-CFG-005
test("a secret key never appears in a section's answer: only secret and set, from the credentials the store holds", async () => {
  const t = await boot({ secrets: { "llm.openai.api_key": "sk-live-secret" } });
  const body = await (await t.get("/config/llm")).text();
  assert.doesNotMatch(body, /sk-live-secret/);
  const keys = JSON.parse(body).keys;
  assert.equal(keys["openai.api_key"].set, true);
  assert.equal(keys["openai.api_key"].secret, true);
  assert.equal(keys["claude.api_key"].set, false);
  assert.equal(keys["openai.api_key"].editable, false);
  assert.equal("value" in keys["openai.api_key"], false);
});

// @spec MOD-CFG-005
test("a server token is reported once per server the stored tools section holds, with its own set; a name it does not hold has no key", async () => {
  const t = await boot();
  assert.equal(t.store.setKey("tools.servers", { home: { url: "https://h.example/mcp" }, work: { url: "https://w.example/mcp" } }).ok, true);
  assert.equal(t.store.write({ secrets: { "tools.servers.home.token": "tok-home-SECRET" } }).ok, true);
  const body = await (await t.get("/config/tools")).text();
  assert.doesNotMatch(body, /tok-home-SECRET/);
  const keys = JSON.parse(body).keys as Record<string, { secret?: boolean; set?: boolean }>;
  assert.deepEqual(keys["servers.home.token"], { secret: true, editable: false, set: true });
  assert.deepEqual(keys["servers.work.token"], { secret: true, editable: false, set: false });
  assert.equal(keys["servers.ghost.token"], undefined);
});

// @spec MOD-CFG-006
test("unknown lists the dotted paths the stored section holds that the schema does not define", async () => {
  const t = await boot();
  rawSection(t.opts.dataDir!, "voice", { ...t.section("voice"), legacy_key: 1, openai: { ...(t.section("voice")["openai"] as object), retired: true } });
  const j = (await (await t.get("/config/voice")).json()) as { unknown: string[] };
  assert.deepEqual(j.unknown.toSorted(), ["voice.legacy_key", "voice.openai.retired"]);
});

// @spec MOD-CFG-007
test("PUT is gated by the control token and capped at 64 KiB, writing nothing otherwise", async () => {
  const t = await boot();
  const before = t.snapshot();
  const etag = t.etag();
  const body = { etag, values: { speed: 1.2 } };
  assert.equal((await t.put("/config/voice", body, null)).status, 401);
  assert.equal((await t.put("/config/voice", body, "wrong")).status, 401);
  assert.equal(t.snapshot(), before);
  const big = await t.put("/config/voice", JSON.stringify({ etag, values: { "fallback.lines": ["x".repeat(70 * 1024)] } }), TOKEN);
  assert.equal(big.status, 413);
  assert.equal(t.snapshot(), before);
  assert.equal((await t.put("/config/voice", body, TOKEN)).status, 200);
  assert.equal(t.section("voice")["speed"], 1.2);
});

// @spec MOD-CFG-007, DASH-CTRL-004
test("a save that changes a sensitive key is gated exactly like any other: 401 without the token, 200 with it, and a dry run is never gated", async () => {
  const t = await boot();
  const before = t.snapshot();
  const values = { "openai.base_url": "https://example.invalid/v1" }; // CFG-PRES-011 marks it sensitive
  const refused = await t.put("/config/llm", { etag: t.etag(), values }, null);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("www-authenticate"), "Bearer");
  assert.equal(t.snapshot(), before);
  const dry = await t.put("/config/llm?dryRun=1", { etag: t.etag(), values }, null);
  assert.equal(dry.status, 200);
  assert.equal(t.snapshot(), before, "a dry run writes nothing");
  const saved = await t.put("/config/llm", { etag: t.etag(), values });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((t.section("llm")["openai"] as { base_url: string }).base_url, "https://example.invalid/v1");
});

// @spec MOD-CFG-007
test("PUT answers 404 for an undeclared section and 400 for a malformed body", async () => {
  const t = await boot();
  const before = t.snapshot();
  assert.equal((await t.put("/config/nope", { etag: "x", values: {} })).status, 404);
  assert.equal((await t.put("/config/voice", "not json")).status, 400);
  assert.equal((await t.put("/config/voice", { etag: "x" })).status, 400);
  assert.equal((await t.put("/config/voice", { etag: t.etag(), values: [] })).status, 400);
  assert.equal((await t.put("/config/voice", { etag: t.etag(), values: {}, remove: "speed" })).status, 400, "remove must be a list");
  assert.equal((await t.put("/config/voice", { etag: t.etag(), values: {}, remove: [1] })).status, 400, "of paths");
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-008
test("a stale etag is a 409 carrying the store's current revision, and nothing is written", async () => {
  const t = await boot();
  const stale = t.etag();
  assert.equal(t.store.setKey("cohost.timezone", "Asia/Tokyo").ok, true); // another writer (a task on the host)
  const before = t.snapshot();
  const r = await t.put("/config/voice", { etag: stale, values: { speed: 1.2 } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, etag: t.etag() });
  assert.equal(t.snapshot(), before);
  assert.equal((await t.put("/config/voice", { etag: "not-a-revision", values: { speed: 1.2 } })).status, 409);
});

// @spec MOD-CFG-003, MOD-CFG-008, DASH-SET-031
test("the etag belongs to the store: every section read answers the same one, a write to any section replaces it for all, and the old one is then a 409", async () => {
  const t = await boot();
  const etagOf = async (section: string) => ((await (await t.get(`/config/${section}`)).json()) as { etag: string }).etag;
  const first = await etagOf("voice");
  assert.equal(await etagOf("dashboard"), first, "two sections, one store, one etag");
  const w = await t.put("/config/voice", { etag: first, values: { speed: 1.2 } });
  assert.equal(w.status, 200);
  const next = ((await w.json()) as { etag: string }).etag;
  assert.notEqual(next, first);
  assert.equal(next, t.etag());
  assert.equal(await etagOf("dashboard"), next, "a read of another section answers the etag the write answered");
  assert.equal((await t.put("/config/dashboard", { etag: first, values: { port: 3010 } })).status, 409, "the etag from before the write is stale for every section");
  const second = await t.put("/config/dashboard", { etag: next, values: { port: 3010 } });
  assert.equal(second.status, 200, "the etag the first write answered is the one the second needs");
  const reread = await (await t.get("/config/voice")).json() as { etag: string; keys: Record<string, { value: unknown }> };
  assert.equal(reread.etag, ((await second.json()) as { etag: string }).etag);
  assert.equal(reread.keys["speed"]!.value, 1.2, "Reload after a 409 reads the current store");
});

// @spec MOD-CFG-009
test("a key outside the schema or not editable is a 400 naming each, and nothing is written", async () => {
  const t = await boot();
  const before = t.snapshot();
  const r = await t.put("/config/llm", { etag: t.etag(), values: { nope: 1, "openai.api_key": "x" } });
  assert.equal(r.status, 400);
  const j = (await r.json()) as { ok: boolean; issues: { path: string }[] };
  assert.equal(j.ok, false);
  assert.deepEqual(j.issues.map((i) => i.path).toSorted(), ["nope", "openai.api_key"]);
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-009, DASH-SET-033
test("remove deletes each named stored key under the section, an unknown key included, so the default applies or the key goes", async () => {
  const t = await boot();
  rawSection(t.opts.dataDir!, "voice", { ...t.section("voice"), speed: 1.4, legacy_key: 1 });
  const before = (await (await t.get("/config/voice")).json()) as { unknown: string[]; keys: Record<string, { source: string }> };
  assert.deepEqual(before.unknown, ["voice.legacy_key"]);
  assert.equal(before.keys["speed"]!.source, "literal");
  const r = await t.put("/config/voice", { etag: t.etag(), values: {}, remove: ["voice.legacy_key", "voice.speed"] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal("legacy_key" in t.section("voice"), false);
  assert.equal("speed" in t.section("voice"), false);
  const after = (await (await t.get("/config/voice")).json()) as { unknown: string[]; keys: Record<string, { source: string }> };
  assert.deepEqual(after.unknown, []);
  assert.equal(after.keys["speed"]!.source, "default");
  assert.ok("engine" in t.section("voice"), "every other stored key is kept");
});

// @spec MOD-CFG-012
test("an edit that makes the settings invalid is a 400 with the store's issues, and nothing is written", async () => {
  const t = await boot();
  const before = t.snapshot();
  const r = await t.put("/config/voice", { etag: t.etag(), values: { speed: -1 } });
  assert.equal(r.status, 400);
  assert.deepEqual(((await r.json()) as any).issues.map((i: any) => i.path), ["voice.speed"]);
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-012
test("a value holding a ${NAME} placeholder is refused, never substituted", async () => {
  const t = await boot();
  const before = t.snapshot();
  const r = await t.put("/config/voice", { etag: t.etag(), values: { voice: "${VOICE_NAME}" } });
  assert.equal(r.status, 400);
  assert.ok(((await r.json()) as { issues: { path: string }[] }).issues.some((i) => i.path.startsWith("voice")));
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-013
test("?dryRun=1 runs every check, writes nothing and answers 200 with warnings", async () => {
  const t = await boot();
  const before = t.snapshot();
  const etag = t.etag();
  const ok = await t.put("/config/dashboard?dryRun=1", { etag, values: { port: 3010 } });
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as { ok: boolean; dryRun: boolean; warnings: string[] };
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.equal(j.warnings.length, 2, "the next-start notice and the new page address");
  assert.match(j.warnings[0]!, /next start/);
  assert.equal(t.snapshot(), before);
  assert.equal((await t.put("/config/voice?dryRun=1", { etag, values: { speed: -1 } })).status, 400);
  assert.equal((await t.put("/config/voice?dryRun=1", { etag: "stale", values: { speed: 1 } })).status, 409);
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-010, MOD-CFG-014, MOD-CFG-015, MOD-CFG-016
test("a valid save commits through the store's one write and answers the new etag, the running readers and the warnings", async () => {
  const t = await boot({ stack: { services: [{ service: "voice", status: "running" }, { service: "mouth", status: "exited" }, { service: "salience", status: "running" }] } });
  const others = JSON.stringify(Object.entries(t.store.sections()).filter(([p]) => p !== "voice"));
  const voiceBefore = t.section("voice");
  const rev = t.store.revision();
  const r = await t.put("/config/voice", { etag: t.etag(), values: { speed: 1.25, voice: "bf_emma" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; etag: string; restart: string[]; warnings: string[] };
  assert.equal(j.ok, true);
  assert.equal(j.etag, String(rev + 1), "one write, one revision");
  assert.deepEqual(j.restart, ["voice"]);
  assert.deepEqual(j.warnings, []);
  assert.deepEqual(t.section("voice"), { ...voiceBefore, speed: 1.25, voice: "bf_emma" }, "every other key of the section kept");
  assert.equal(JSON.stringify(Object.entries(t.store.sections()).filter(([p]) => p !== "voice")), others, "every other section kept");
  assert.deepEqual(t.bus.published, []);
  assert.deepEqual(t.calls, []);
});

// @spec MOD-CFG-010
test("a save of a section the store does not hold adds it", async () => {
  const t = await boot();
  rawSection(t.opts.dataDir!, "logging", null);
  assert.equal("logging" in t.store.sections(), false);
  const r = await t.put("/config/logging", { etag: t.etag(), values: { level: "debug" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(t.section("logging"), { level: "debug" });
});

// @spec MOD-CFG-015
test("restart lists units in manifest order that read the section and are running; none when Docker is unavailable", async () => {
  const running = ["cortex", "salience", "memory", "affect", "voice"].map((service) => ({ service, status: "running" }));
  const t = await boot({ stack: { services: running } });
  const r = await t.put("/config/llm", { etag: t.etag(), values: { temperature: 0.5 } });
  assert.deepEqual(((await r.json()) as any).restart, ["salience", "affect", "memory", "cortex"]);
  const off = await boot({ stack: { docker: { ok: false, detail: "no docker" }, services: running } });
  const r2 = await off.put("/config/llm", { etag: off.etag(), values: { temperature: 0.5 } });
  assert.deepEqual(((await r2.json()) as any).restart, []);
});

// @spec MOD-CFG-015, MOD-MAN-002
test("a saved tools section restarts exactly the running units that read it (salience, cortex and tools), in manifest order", async () => {
  const running = ["tools", "cortex", "salience", "memory", "affect", "voice"].map((service) => ({ service, status: "running" }));
  const t = await boot({ stack: { services: running } });
  const r = await t.put("/config/tools", { etag: t.etag(), values: { timeout_ms: 20000 } });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).restart, ["salience", "cortex", "tools"]);
});

// @spec MOD-CFG-015, MOD-MAN-002
test("a saved cohost section restarts the running units that read it, chat among them, in manifest order", async () => {
  const running = ["chat", "cortex", "tools", "voice", "avatar"].map((service) => ({ service, status: "running" }));
  const t = await boot({ stack: { services: running } });
  const r = await t.put("/config/cohost", { etag: t.etag(), values: { timezone: "America/New_York" } });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).restart, ["chat", "cortex", "tools"]);
});

// @spec MOD-CFG-015, MOD-MAN-002
test("a saved logging section restarts every running application unit, in manifest order", async () => {
  const units = ["chat", "salience", "affect", "memory", "cortex", "tools", "voice", "avatar", "eyes", "ears", "mouth", "connector-discord"];
  const running = [...units, "redis", "ollama"].map((service) => ({ service, status: "running" }));
  const t = await boot({ stack: { services: running } });
  const r = await t.put("/config/logging", { etag: t.etag(), values: { level: "debug" } });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).restart, units);
});

// @spec MOD-CFG-015
test("a dashboard save says it applies at the dashboard's next start, and a save of another section warns of nothing", async () => {
  const t = await boot();
  // voice.sample_rate: any save is gated alike (DASH-CTRL-004), a sensitive key needing nothing more
  const r = await t.put("/config/voice", { etag: t.etag(), values: { sample_rate: 24000 } });
  const j = (await r.json()) as { warnings: string[] };
  assert.deepEqual(j.warnings, []);
  const d = await t.put("/config/dashboard", { etag: t.etag(), values: { port: 3010 } });
  const dj = (await d.json()) as { warnings: string[]; restart: string[] };
  assert.deepEqual(dj.restart, []);
  assert.ok(dj.warnings.some((w) => /dashboard.*next start/i.test(w)));
});

const svc = (service: string, overrides?: Record<string, string>, status = "running") => ({ service, status, ...(overrides ? { overrides } : {}) });

// @spec MOD-CFG-015
test("a logging save offers the running units that declare it and warns that the dashboard picks it up at its next start", async () => {
  const t = await boot({ stack: { services: [svc("cortex"), svc("voice", undefined, "exited")] } });
  const r = await t.put("/config/logging", { etag: t.etag(), values: { level: "debug" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { warnings: string[]; restart: string[] };
  assert.deepEqual(j.restart, ["cortex"]);
  assert.equal(j.warnings.length, 1);
  assert.match(j.warnings[0]!, /dashboard.*next start/i);
});

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
  const dry = await t.put("/config/avatar?dryRun=1", { etag: t.etag(), values: { driver: "vmc" } });
  const warnings = ((await dry.json()) as { warnings: string[] }).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /avatar\.driver/);
  assert.match(warnings[0]!, /avatar is running isolated with AVATAR_DRIVER/);
  const real = await t.put("/config/avatar", { etag: t.etag(), values: { driver: "vmc" } });
  assert.equal(real.status, 200);
  assert.deepEqual(((await real.json()) as { warnings: string[] }).warnings, warnings);
});

// @spec MOD-CFG-017
test("no /config response, an error or an issue message included, holds a secret value or a hash of one", async () => {
  const t = await boot({ secrets: { "llm.openai.api_key": "sk-live-secret" } });
  const seen: string[] = [];
  const keep = async (r: Response): Promise<number> => { seen.push(await r.text()); return r.status; };
  await keep(await t.get("/config/schema"));
  await keep(await t.get("/config/llm"));
  await keep(await t.get("/config/nope"));
  await keep(await t.put("/config/llm", { etag: t.etag(), values: { "openai.api_key": "sk-live-secret" } }));
  await keep(await t.put("/config/llm", { etag: "stale", values: { temperature: 0.5 } }));
  await keep(await t.put("/config/llm", { etag: t.etag(), values: { temperature: -1 } }));
  await keep(await t.put("/config/llm?dryRun=1", { etag: t.etag(), values: { temperature: 0.5 } }));
  const all = seen.join("\n");
  for (const forbidden of ["sk-live-secret", sha("sk-live-secret"), sha("sk-live-secret\n")]) assert.ok(!all.includes(forbidden), forbidden);
});

// @spec MOD-CFG-016
test("the settings routes never write a credential, never touch .env and never start, stop or restart a unit", async () => {
  const t = await boot({ secrets: { "llm.openai.api_key": "sk-secret" }, stack: { services: [svc("voice")] } });
  assert.equal((await t.put("/config/llm", { etag: t.etag(), values: { "openai.api_key": "pasted" } })).status, 400, "a secret key in a PUT is refused");
  assert.equal((await t.put("/config/voice", { etag: t.etag(), values: { speed: 1.1 } })).status, 200);
  assert.equal(t.store.secret("llm.openai.api_key"), "sk-secret", "the stored credential is unchanged");
  assert.deepEqual(t.store.secretPaths(), ["llm.openai.api_key"]);
  assert.equal(existsSync(join(t.root, ".env")), false);
  assert.deepEqual(t.calls, []);
  const src = readFileSync(join(repo, "services", "dashboard", "src", "settings.ts"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
  assert.doesNotMatch(src, /\.env\b|process\.env|\benv\b/, "settings.ts takes no environment");
});

// @spec MOD-CFG-014
test("a failed write is a 500 with the error text and the store unchanged", async () => {
  const t = await boot({ failWrite: "disk full" });
  const before = t.snapshot();
  const r = await t.put("/config/voice", { etag: t.etag(), values: { speed: 1.5 } });
  assert.equal(r.status, 500);
  assert.match(await r.text(), /disk full/);
  assert.equal(t.snapshot(), before);
});

// @spec MOD-CFG-009, MOD-CFG-010, MOD-CFG-012
test("while the stored section holds an unknown key a save that does not remove it is refused naming it; one that removes it is written", async () => {
  const t = await boot();
  rawSection(t.opts.dataDir!, "voice", { ...t.section("voice"), legacy_key: 1 });
  const before = t.snapshot();
  const dashboard = JSON.stringify(t.section("dashboard"));
  const refused = await t.put("/config/voice", { etag: t.etag(), values: { speed: 1.1 } });
  assert.equal(refused.status, 400);
  assert.deepEqual(((await refused.json()) as { issues: { path: string }[] }).issues.map((i) => i.path), ["voice.legacy_key"]);
  assert.equal(t.snapshot(), before);
  const r = await t.put("/config/voice", { etag: t.etag(), values: { speed: 1.1 }, remove: ["voice.legacy_key"] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal("legacy_key" in t.section("voice"), false);
  assert.equal(t.section("voice")["speed"], 1.1);
  assert.equal(JSON.stringify(t.section("dashboard")), dashboard, "another section is kept");
});

// @spec MOD-CFG-021, MOD-CFG-022
test("GET /config/schema serves the avatar-model and slider widgets and live: true on the renderer section alone", async () => {
  const t = await boot();
  const { sections } = (await (await t.get("/config/schema")).json()) as { sections: { path: string; live?: unknown; keys: Record<string, { widget?: unknown }> }[] };
  const renderer = sections.find((s) => s.path === "renderer")!;
  assert.equal(renderer.live, true);
  assert.deepEqual(renderer.keys["model"]!.widget, { type: "avatar-model" });
  assert.deepEqual(renderer.keys["turn"]!.widget, { type: "slider", step: 1 });
  for (const s of sections.filter((x) => x.path !== "renderer")) assert.equal("live" in s, false, `${s.path} has no live field`);
});
