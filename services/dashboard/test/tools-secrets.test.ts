import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { guardFullSurface } from "../src/host.js";
import { gateFor, testControl } from "./control-fixture.js";
import { rawSection, storedSection, testStore } from "./store-fixture.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

// `tools.servers.<name>.token`: the one secret path that names a map entry (CFG-SEC-016). The dashboard sets it only for a
// server the stored `tools` section holds, and always lets it be cleared (DASH-SECRET-013, DASH-SECRET-014, CFG-SEC-018).

const TOKEN = "tok-123-control-token-for-tools-secrets";
const WEATHER = "tools.servers.weather.token";
const OTHER = "tools.servers.ghost.token";
type Servers = Record<string, { url: string }>;
const WITH_WEATHER: Servers = { weather: { url: "https://api.example.com/mcp" } };

/** `servers` is the stored `tools.servers` map; null stores a tools section without one. */
async function boot(servers: Servers | null = WITH_WEATHER, secrets: Record<string, string> = {}) {
  const st = await testStore({ token: false });
  after(() => st.close());
  const tools = { ...storedSection(st.store, "tools") };
  delete tools["servers"];
  rawSection(st.opts.dataDir!, "tools", servers === null ? tools : { ...tools, servers });
  if (Object.keys(secrets).length) assert.equal(st.store.write({ secrets }).ok, true);
  const bus = new FakeBus();
  const rec = recordingLog();
  // every unit that reads the tools section is running; only those that declare the MCP token path are restarted
  const sectionReaders = SERVICE_MANIFEST.filter((s) => s.config.includes("tools")).map((s) => s.id);
  const readers = SERVICE_MANIFEST.filter((s) => (s.secrets ?? []).includes("tools.servers.*.token")).map((s) => s.id);
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [...sectionReaders].toReversed().concat(["voice"]).map((service) => ({ service, status: "running" })) as never };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: st.store, root: st.root, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    control: testControl({ gate: gateFor(TOKEN) }),
  });
  const server = await new Promise<http.Server>((r) => { const s = http.createServer(guardFullSurface(handler, { loopback: true })); s.listen(0, "127.0.0.1", () => r(s)); });
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const put = (path: string, body: unknown, tok: string | undefined = TOKEN) =>
    fetch(base + path, { method: "PUT", body: JSON.stringify(body), headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const get = (path: string) => fetch(base + path);
  return {
    ...st, put, get, readers, bus, rec,
    values: () => st.store.secretValues(),
    setServers: (s: Servers) => assert.equal(st.store.setKey("tools.servers", s).ok, true),
    logs: () => JSON.stringify(rec.lines, (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)),
  };
}

// @spec DASH-SECRET-013
test("a token for a server the stored tools section holds is set trimmed and cleared like any secret, and restart lists the running units whose secrets list declares tools.servers.*.token", async () => {
  const t = await boot();
  assert.deepEqual(t.readers, ["tools"], "only the tools unit declares tools.servers.*.token; salience and cortex read the section and use no MCP token");
  const set = await t.put(`/secrets/${WEATHER}`, { value: "  mcp-token-1 " });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { ok: true, set: true, restart: t.readers });
  assert.deepEqual(t.values(), { [WEATHER]: "mcp-token-1" });
  const clear = await t.put(`/secrets/${WEATHER}`, { value: null });
  assert.equal(clear.status, 200);
  assert.deepEqual(await clear.json(), { ok: true, set: false, restart: t.readers });
  assert.deepEqual(t.values(), {});
});

// @spec DASH-SECRET-013
test("PUT /secrets sets a configured server's token with other secrets in one write, and restart includes the tools units", async () => {
  const t = await boot();
  const rev = t.store.revision();
  const r = await t.put("/secrets", { values: { [WEATHER]: "mcp-2", "llm.openai.api_key": "sk-1" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; set: Record<string, boolean>; restart: string[] };
  assert.deepEqual(j.set, { [WEATHER]: true, "llm.openai.api_key": true });
  for (const id of t.readers) assert.ok(j.restart.includes(id), id);
  assert.deepEqual(t.values(), { "llm.openai.api_key": "sk-1", [WEATHER]: "mcp-2" });
  assert.equal(t.store.revision(), rev + 1);
});

// @spec DASH-SECRET-014
test("a set for a server the stored tools section does not hold is 404 unknown secret and writes nothing", async () => {
  const t = await boot();
  const rev = t.store.revision();
  const r = await t.put(`/secrets/${OTHER}`, { value: "mcp-3" });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { ok: false, detail: "unknown secret" });
  assert.deepEqual(t.values(), {}, "nothing written");
  assert.equal(t.store.revision(), rev);
  assert.equal(t.logs().includes("mcp-3"), false);
});

// @spec DASH-SECRET-014, CFG-SEC-018
test("a clear for a server the tools section does not hold works and keeps every other secret", async () => {
  const t = await boot(null, { "llm.openai.api_key": "sk-keep" });
  const r = await t.put(`/secrets/${OTHER}`, { value: null });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; set: boolean };
  assert.deepEqual([j.ok, j.set], [true, false]);
  assert.deepEqual(t.values(), { "llm.openai.api_key": "sk-keep" });
});

// @spec DASH-SECRET-014
test("a clear for a name never configured, and a clear with no tools section stored at all, answer 200 set false", async () => {
  const none = await boot(null);
  assert.equal((await none.put(`/secrets/${OTHER}`, { value: null })).status, 200);
  const noSection = await boot(null);
  rawSection(noSection.opts.dataDir!, "tools", null);
  assert.equal((await noSection.put(`/secrets/${OTHER}`, { value: null })).status, 200);
});

// @spec DASH-SECRET-014, DASH-SECRET-015
test("PUT /secrets: a clear for an unknown server goes through, but a set for one is 404 naming the path and applies none of the request", async () => {
  const t = await boot();
  const cleared = await t.put("/secrets", { values: { [OTHER]: null, [WEATHER]: "mcp-4" } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(((await cleared.json()) as { set: unknown }).set, { [OTHER]: false, [WEATHER]: true });
  const before = JSON.stringify(t.values());
  const refused = await t.put("/secrets", { values: { [OTHER]: "mcp-5", [WEATHER]: "mcp-6", "llm.openai.api_key": null } });
  assert.equal(refused.status, 404);
  const j = (await refused.json()) as { ok: boolean; detail: string; paths?: string[] };
  assert.equal(j.detail, "unknown secret");
  assert.deepEqual(j.paths, [OTHER]);
  assert.equal(JSON.stringify(t.values()), before, "none of it applied, the clear included");
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the stored section is read at the request, not cached: a server saved a moment ago takes its token, and one removed refuses a set but still clears", async () => {
  const t = await boot(null);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "early" })).status, 404, "not saved yet: the page saves the map first");
  t.setServers(WITH_WEATHER);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "now" })).status, 200);
  t.setServers({});
  assert.deepEqual(t.values(), {}, "removing the server took its token with it (settings-store STORE-SET-006)");
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "again" })).status, 404);
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: null })).status, 200);
  assert.deepEqual(t.values(), {});
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("a name that is not a server name of the stored section (case, separators, extra segments, prototype keys) is never a set; a clear pollutes nothing", async () => {
  const t = await boot();
  for (const name of ["Weather", "we_ather", "wea.ther", "constructor", "__proto__", "a".repeat(40), ""]) {
    const path = `tools.servers.${name}.token`;
    const r = await t.put(`/secrets/${encodeURIComponent(path)}`, { value: "x-secret" });
    assert.ok(r.status === 404, `${path} set: ${r.status}`);
  }
  assert.deepEqual(t.values(), {});
  for (const name of ["constructor", "__proto__", "toString"]) {
    const r = await t.put(`/secrets/${encodeURIComponent(`tools.servers.${name}.token`)}`, { value: null });
    assert.ok(r.status === 200 || r.status === 404, `${name} clear: ${r.status}`);
  }
  assert.equal(({} as Record<string, unknown>).token, undefined, "no prototype was polluted");
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the token is gated as every secret write is, before the stored section is looked at: 401 for none or a wrong token, writing nothing", async () => {
  const t = await boot();
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "x" }, "")).status, 401);
  assert.equal((await t.put(`/secrets/${OTHER}`, { value: null }, "wrong")).status, 401);
  assert.deepEqual(t.values(), {});
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("the token value appears in no response, log line or error text, whether the set is accepted or refused as unknown", async () => {
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

// @spec DASH-SECRET-013, MOD-CFG-005
test("GET /config/tools reports the token only as set or not set, never its value", async () => {
  const t = await boot();
  assert.equal((await t.put(`/secrets/${WEATHER}`, { value: "mcp-hidden-9" })).status, 200);
  const r = await t.get("/config/tools");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes("mcp-hidden-9"), false);
  const keys = (JSON.parse(text) as { keys: Record<string, { set?: boolean; value?: unknown }> }).keys;
  assert.equal(keys["servers.weather.token"]!.set, true);
  assert.equal("value" in keys["servers.weather.token"]!, false);
  assert.equal("servers.*.token" in keys, false);
});

// @spec DASH-SECRET-006
test("a value holding a control character (tab, CR, bell, DEL) is 400 and nothing is written", async () => {
  const t = await boot();
  for (const v of ["mcp\tx", "mcp\rx", "mcp\x07x", "mcp\x7fx"]) {
    assert.equal((await t.put(`/secrets/${WEATHER}`, { value: v })).status, 400, JSON.stringify(v));
  }
  assert.deepEqual(t.values(), {});
});

// @spec DASH-SECRET-013, DASH-SECRET-014
test("a set is refused 404 while the store holds no tools section or one with no servers: no server is known, so no token is stored", async () => {
  const noServers = await boot(null);
  assert.equal((await noServers.put(`/secrets/${WEATHER}`, { value: "x-1" })).status, 404, "no servers");
  const noSection = await boot(null);
  rawSection(noSection.opts.dataDir!, "tools", null);
  assert.equal((await noSection.put(`/secrets/${WEATHER}`, { value: "x-2" })).status, 404, "no tools section");
  assert.deepEqual({ ...noServers.values(), ...noSection.values() }, {});
});

// @spec DASH-SECRET-015
test("a multi-path PUT /secrets with a token set is refused 404 with its paths while no server is stored, and applies none of it", async () => {
  const noServers = await boot(null);
  const noSection = await boot(null);
  rawSection(noSection.opts.dataDir!, "tools", null);
  for (const t of [noServers, noSection]) {
    const r = await t.put("/secrets", { values: { [WEATHER]: "x-4", "llm.openai.api_key": "sk-4" } });
    assert.equal(r.status, 404);
    assert.deepEqual(((await r.json()) as { paths?: string[] }).paths, [WEATHER]);
    assert.deepEqual(t.values(), {}, "nothing written");
  }
});
