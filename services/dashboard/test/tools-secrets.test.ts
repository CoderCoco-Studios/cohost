import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { guardFullSurface } from "../src/host.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

// `tools.servers.<name>.token`: the one secret path that names a map entry (CFG-SEC-016). The dashboard sets it only for a
// server the saved config.yaml holds, and always lets it be cleared, so a token whose server was removed does not stay
// behind (DASH-SECRET-013, DASH-SECRET-014, CFG-SEC-018).

const TOKEN = "tok-123";
const WEATHER = "tools.servers.weather.token";
const OTHER = "tools.servers.ghost.token";
const WITH_WEATHER = "tools:\n  servers:\n    weather:\n      url: https://api.example.com/mcp\n";
const NO_SERVERS = "tools:\n  mode: live\n";

async function boot(config: string | undefined = WITH_WEATHER, secrets?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-tools-secrets-"));
  const configFile = join(dir, "config.yaml");
  if (config !== undefined) writeFileSync(configFile, config);
  const secretsFile = join(dir, "secrets.yaml");
  if (secrets !== undefined) writeFileSync(secretsFile, secrets, { mode: 0o600 });
  const bus = new FakeBus();
  const rec = recordingLog();
  const readers = SERVICE_MANIFEST.filter((s) => s.config.includes("tools")).map((s) => s.id);
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [...readers].reverse().concat(["voice"]).map((service) => ({ service, status: "running" })) as never };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => configFile, secretsFile: () => secretsFile, controlToken: TOKEN,
  });
  const server = await new Promise<http.Server>((r) => { const s = http.createServer(guardFullSurface(handler, { loopback: true, controlEnabled: false })); s.listen(0, "127.0.0.1", () => r(s)); });
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const put = (path: string, body: unknown, tok: string | undefined = TOKEN) =>
    fetch(base + path, { method: "PUT", body: JSON.stringify(body), headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const get = (path: string) => fetch(base + path);
  const secretsText = () => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } };
  return {
    put, get, readers, bus, rec, secretsText, configFile, secretsFile,
    logs: () => JSON.stringify(rec.lines, (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)),
  };
}

// @spec DASH-SECRET-013
test("a token for a server the saved config.yaml holds is set trimmed and cleared like any secret, and restart lists the running units that declare the tools section in manifest order", async () => {
  const t = await boot();
  assert.ok(t.readers.length >= 3 && t.readers.includes("tools") && t.readers.includes("cortex") && t.readers.includes("salience"));
  const set = await t.put(`/secrets/${WEATHER}`, { value: "  mcp-token-1 " });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { ok: true, set: true, restart: t.readers });
  assert.match(t.secretsText(), /mcp-token-1/);
  assert.doesNotMatch(t.secretsText(), / mcp-token-1 /);
  const clear = await t.put(`/secrets/${WEATHER}`, { value: null });
  assert.equal(clear.status, 200);
  assert.deepEqual(await clear.json(), { ok: true, set: false, restart: t.readers });
  assert.doesNotMatch(t.secretsText(), /mcp-token-1/);
});

// @spec DASH-SECRET-013
test("PUT /secrets sets a configured server's token with other secrets in one write, and restart includes the tools units", async () => {
  const t = await boot();
  const r = await t.put("/secrets", { values: { [WEATHER]: "mcp-2", "llm.openai.api_key": "sk-1" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; set: Record<string, boolean>; restart: string[] };
  assert.deepEqual(j.set, { [WEATHER]: true, "llm.openai.api_key": true });
  for (const id of t.readers) assert.ok(j.restart.includes(id), id);
  assert.match(t.secretsText(), /mcp-2/);
});

// @spec DASH-SECRET-014
test("a set for a server the saved config.yaml does not hold is 404 unknown secret and writes nothing", async () => {
  const t = await boot();
  const r = await t.put(`/secrets/${OTHER}`, { value: "mcp-3" });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { ok: false, detail: "unknown secret" });
  assert.equal(t.secretsText(), "", "nothing written");
  assert.equal(t.logs().includes("mcp-3"), false);
});

// @spec DASH-SECRET-014, CFG-SEC-018
test("a clear for a server config.yaml does not hold works: the removed server's token is emptied and every other secret stays", async () => {
  const t = await boot(NO_SERVERS, 'llm:\n  openai:\n    api_key: sk-keep\ntools:\n  servers:\n    ghost:\n      token: "left-behind"\n');
  const r = await t.put(`/secrets/${OTHER}`, { value: null });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; set: boolean };
  assert.deepEqual([j.ok, j.set], [true, false]);
  assert.doesNotMatch(t.secretsText(), /left-behind/);
  assert.match(t.secretsText(), /sk-keep/);
});

// @spec DASH-SECRET-014
test("a clear for a name never configured, and a clear with no config.yaml section at all, answer 200 set false", async () => {
  const none = await boot(NO_SERVERS);
  assert.equal((await none.put(`/secrets/${OTHER}`, { value: null })).status, 200);
  const noFile = await boot(undefined);
  assert.equal((await noFile.put(`/secrets/${OTHER}`, { value: null })).status, 200);
});

// @spec DASH-SECRET-014
test("PUT /secrets: a clear for an unknown server goes through, but a set for one is 404 naming the path and applies none of the request", async () => {
  const t = await boot();
  const cleared = await t.put("/secrets", { values: { [OTHER]: null, [WEATHER]: "mcp-4" } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(((await cleared.json()) as { set: unknown }).set, { [OTHER]: false, [WEATHER]: true });
  const refused = await t.put("/secrets", { values: { [OTHER]: "mcp-5", [WEATHER]: "mcp-6" } });
  assert.equal(refused.status, 404);
  const j = (await refused.json()) as { ok: boolean; detail: string; paths?: string[] };
  assert.equal(j.detail, "unknown secret");
  assert.deepEqual(j.paths, [OTHER]);
  assert.doesNotMatch(t.secretsText(), /mcp-5|mcp-6/);
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the config is read at the request, not cached: a server saved to config.yaml a moment ago takes its token, and one removed refuses a set but still clears", async () => {
  const t = await boot(NO_SERVERS);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "early" })).status, 404, "not saved yet: the page saves the map first");
  writeFileSync(t.configFile, WITH_WEATHER);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "now" })).status, 200);
  writeFileSync(t.configFile, NO_SERVERS);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "again" })).status, 404);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: null })).status, 200);
  assert.doesNotMatch(t.secretsText(), /now|early|again/);
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("a name that is not a server name of config (case, separators, extra segments, prototype keys) is never a set; a clear writes no key outside the file's own mapping", async () => {
  const t = await boot();
  for (const name of ["Weather", "we_ather", "wea.ther", "constructor", "__proto__", "a".repeat(40), ""]) {
    const path = `tools.servers.${name}.token`;
    const r = await t.put(`/secrets/${encodeURIComponent(path)}`, { value: "x-secret" });
    assert.ok(r.status === 404, `${path} set: ${r.status}`);
  }
  assert.equal(t.secretsText(), "");
  for (const name of ["constructor", "__proto__", "toString"]) {
    const r = await t.put(`/secrets/${encodeURIComponent(`tools.servers.${name}.token`)}`, { value: null });
    assert.ok(r.status === 200 || r.status === 404, `${name} clear: ${r.status}`);
  }
  assert.equal(({} as Record<string, unknown>).token, undefined, "no prototype was polluted");
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the token is gated as every secret write is, before the config is looked at: 401 for none or a wrong token, writing nothing", async () => {
  const t = await boot();
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "x" }, "")).status, 401);
  assert.equal((await t.put(`/secrets/${OTHER}`, { value: null }, "wrong")).status, 401);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the token value appears in no response, log line or error text, whether the set is accepted, refused as unknown or fails to write", async () => {
  const t = await boot();
  const secret = "mcp-SECRET-VALUE-777";
  const bodies: string[] = [];
  bodies.push(await (await t.put(`/secrets/${WEATHER}`, { value: secret })).text());
  bodies.push(await (await t.put(`/secrets/${OTHER}`, { value: secret })).text());
  bodies.push(await (await t.put("/secrets", { values: { [OTHER]: secret } })).text());
  for (const b of bodies) assert.equal(b.includes(secret), false);
  assert.equal(t.logs().includes(secret), false);
  assert.equal(t.bus.published.length, 0, "the secret never reaches the bus, hence never the feed");
});

// @spec DASH-SECRET-013
test("GET /config/tools reports the token only as set or not set, never its value", async () => {
  const t = await boot();
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "mcp-hidden-9" })).status, 200);
  const r = await t.get("/config/tools");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes("mcp-hidden-9"), false);
  assert.equal((JSON.parse(text) as { keys: Record<string, { set?: boolean }> }).keys["servers.*.token"]!.set, true);
});
