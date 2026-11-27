import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST } from "@cohost/control";
import { SECRET_PATHS } from "@cohost/config";
import { storeFile, type Store } from "@cohost/store";
import { createDashboardHandler } from "../src/routes.js";
import { guardFullSurface, lanHandler } from "../src/host.js";
import { gateFor, testControl } from "./control-fixture.js";
import { testStore } from "./store-fixture.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

const TOKEN = "tok-123-control-token-for-secrets-0001";
const OPENAI = "llm.openai.api_key";
const BR_ID = "llm.bedrock.access_key_id";
const BR_SECRET = "llm.bedrock.secret_access_key";

interface Opts {
  /** Credentials stored before the test. */
  secrets?: Record<string, string>;
  stack?: Partial<StackSnapshot>;
  /** The store's one write throws this error text (a full disk, a locked store). */
  failWrite?: string;
}

async function boot(o: Opts = {}) {
  const st = await testStore({ token: false });
  after(() => st.close());
  const real = st.store;
  if (o.secrets) assert.equal(real.write({ secrets: o.secrets }).ok, true);
  const store = o.failWrite === undefined ? real : new Proxy(real, {
    get: (target, key) => {
      if (key === "writeWithRetry") return async () => { throw new Error(o.failWrite); };
      const v = Reflect.get(target, key) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
  const bus = new FakeBus();
  const rec = recordingLog();
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...o.stack };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store, root: st.root, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    control: testControl({ gate: gateFor(TOKEN) }),
  });
  const mk = (h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });
  const server = await mk(guardFullSurface(handler, { loopback: true }));
  const lan = await mk(lanHandler(handler));
  after(() => { server.close(); lan.close(); });
  const port = (server.address() as { port: number }).port;
  const lanPort = (lan.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const put = (path: string, body: unknown, tok?: string) =>
    fetch(base + path, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const raw = (path: string, headers: Record<string, string>, body = "{}", p = port) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p, path, method: "PUT", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const logs = () => JSON.stringify(rec.lines, (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  const get = (path: string) => fetch(base + path);
  const sections = JSON.stringify(real.sections());
  return {
    ...st, get, bus, put, raw, logs, lanPort, snap,
    /** The stored credentials by path. */
    values: () => real.secretValues(),
    /** The store's revision, its credentials and its sections: unchanged text means nothing was written. */
    snapshot: () => JSON.stringify({ revision: real.revision(), secrets: real.secretValues(), sections: real.sections() }),
    /** True while no setting has changed since the start. */
    settingsUnchanged: () => JSON.stringify(real.sections()) === sections,
  };
}

// @spec DASH-SECRET-001, DASH-SECRET-008, DASH-SECRET-010
test("a set stores the value trimmed at its path in the store, encrypted, answers {ok, set: true, restart}, and changes no setting", async () => {
  const t = await boot();
  const r = await t.put(`/secrets/${OPENAI}`, { value: "  sk-abc123\n" }, TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, set: true, restart: [] });
  assert.deepEqual(t.values(), { [OPENAI]: "sk-abc123" });
  assert.equal(readFileSync(storeFile(t.opts.dataDir!)).includes("sk-abc123"), false, "the value is stored encrypted (settings-store STORE-KEY-006)");
  assert.ok(t.settingsUnchanged(), "no setting changed");
  assert.deepEqual(t.bus.published, []);
});

// @spec DASH-SECRET-001
test("each of the sixteen wildcard-free secret paths can be set and cleared", async () => {
  const t = await boot();
  const wildcardFree = SECRET_PATHS.filter((p) => !p.includes("*"));
  assert.equal(wildcardFree.length, 16); // CFG-SEC-003, wildcard-free paths only
  for (const p of wildcardFree) {
    // the Bedrock pair is only ever changed together (DASH-SECRET-012)
    if (p === BR_ID || p === BR_SECRET) continue;
    assert.equal((await t.put(`/secrets/${p}`, { value: `v-${p}` }, TOKEN)).status, 200, p);
    assert.equal(t.values()[p], `v-${p}`);
    assert.equal((await t.put(`/secrets/${p}`, { value: null }, TOKEN)).status, 200, p);
    assert.equal(t.values()[p], undefined);
  }
  const both = await t.put("/secrets", { values: { [BR_ID]: "id", [BR_SECRET]: "sec" } }, TOKEN);
  assert.equal(both.status, 200);
  assert.deepEqual(t.values(), { [BR_ID]: "id", [BR_SECRET]: "sec" });
});

// @spec DASH-SECRET-001
test("the engine secrets (ears openai/nemotron/kyutai keys, voice openai key, pocket hf_token) are secret paths of GET /config/schema and PUT /secrets/:path stores each trimmed", async () => {
  const engine = ["ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key", "voice.openai.api_key", "voice.pocket.hf_token"];
  const t = await boot();
  const schema = (await (await t.get("/config/schema")).json()) as { sections: { path: string; secrets?: string[] }[] };
  const advertised = schema.sections.flatMap((s) => (s.secrets ?? []).map((n) => `${s.path}.${n}`));
  for (const p of engine) {
    assert.ok(advertised.includes(p), `${p} is declared by a schema section`);
    const r = await t.put(`/secrets/${p}`, { value: `  v-${p}\n` }, TOKEN);
    assert.equal(r.status, 200, p);
    assert.equal(((await r.json()) as { set: boolean }).set, true);
    assert.equal(t.values()[p], `v-${p}`);
  }
  assert.ok(t.settingsUnchanged());
});

// @spec DASH-SECRET-002, DASH-SECRET-007
test("a clear deletes the credential, keeps every other, and every read reports it not set", async () => {
  const t = await boot({ secrets: { [OPENAI]: "sk-old", "llm.claude.api_key": "sk-claude" } });
  const r = await t.put(`/secrets/${OPENAI}`, { value: null }, TOKEN);
  assert.deepEqual(await r.json(), { ok: true, set: false, restart: [] });
  assert.deepEqual(t.values(), { "llm.claude.api_key": "sk-claude" });
  assert.deepEqual(t.store.secretPaths(), ["llm.claude.api_key"]);
  const keys = ((await (await t.get("/config/llm")).json()) as { keys: Record<string, { set?: boolean }> }).keys;
  assert.equal(keys["openai.api_key"]!.set, false);
  assert.equal(keys["claude.api_key"]!.set, true);
});

// @spec DASH-SECRET-003
test("the write passes the one gate: missing or wrong is 401 {ok: false} with www-authenticate and nothing is written; never a 403", async () => {
  const t = await boot();
  const before = t.snapshot();
  for (const tok of [undefined, "wrong", ""]) {
    const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-never" }, tok);
    assert.equal(r.status, 401, `token=${String(tok)}`);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    assert.equal(((await r.json()) as { ok: boolean }).ok, false);
  }
  assert.equal((await t.put("/secrets", { values: { [OPENAI]: "x" } })).status, 401);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-003, DASH-SECRET-005, DASH-ACC-004
test("the token is checked before the path: an unknown path is 401 for a wrong token and 404 for the right one, writing nothing", async () => {
  const t = await boot();
  const before = t.snapshot();
  assert.equal((await t.put("/secrets/access-check", { value: null }, "wrong")).status, 401);
  assert.equal((await t.put("/secrets/access-check", { value: null })).status, 401);
  const ok = await t.put("/secrets/access-check", { value: null }, TOKEN);
  assert.equal(ok.status, 404);
  assert.deepEqual(await ok.json(), { ok: false, detail: "unknown secret" });
  assert.equal(t.snapshot(), before);
});

// @spec CFG-SEC-020, DASH-SECRET-005
test("the derived ears.http.verifier is no secret path: its write is 404 unknown secret, with the right token", async () => {
  const t = await boot();
  const before = t.snapshot();
  const r = await t.put("/secrets/ears.http.verifier", { value: "ab".repeat(32) }, TOKEN);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { ok: false, detail: "unknown secret" });
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-003, DASH-SECRET-006
test("refusal order after the token: 413 body size, then 404 path, then 400 body", async () => {
  const t = await boot();
  const before = t.snapshot();
  const huge = JSON.stringify({ value: "x".repeat(70 * 1024) });
  assert.equal((await t.put(`/secrets/${OPENAI}`, huge, "wrong")).status, 401, "token before size");
  assert.equal((await t.put(`/secrets/${OPENAI}`, huge, TOKEN)).status, 413);
  assert.equal((await t.put("/secrets/nope", huge, TOKEN)).status, 413, "size before path");
  assert.equal((await t.put("/secrets/nope", "not json", TOKEN)).status, 404, "path before body");
  assert.equal((await t.put(`/secrets/${OPENAI}`, "not json", TOKEN)).status, 400);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-005
test("a path that is not one of the secret paths is 404 unknown secret: traversal, prototype keys, non-secret config paths, bad escapes", async () => {
  const t = await boot();
  const before = t.snapshot();
  const bad = [
    "llm", "llm.openai", "llm.openai.base_url", "llm.model", "voice.speed", "dashboard.port", "llm.openai.api_key.x", "LLM.OPENAI.API_KEY",
    "%20llm.openai.api_key", "llm.openai.api_key%20", "llm.openai.api_key%0A", "", "__proto__", "constructor", "prototype", "toString", "__proto__.polluted",
    "..%2F..%2Fetc%2Fpasswd", "..%2Fsecrets.yaml", "llm%2Eopenai%2Eapi_key%00", "llm.openai.api_key%", "%E0%A4%A", "%", "llm.openai.api_key%2F..",
  ];
  for (const p of bad) {
    const r = await t.put(`/secrets/${p}`, { value: "sk-never" }, TOKEN);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { ok: false, detail: "unknown secret" }, p);
  }
  assert.equal(t.snapshot(), before);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

// @spec DASH-SECRET-006
test("a body that is not a JSON object, lacks value, or holds an unusable value is 400 {ok:false, detail}; nothing is written", async () => {
  const t = await boot();
  const before = t.snapshot();
  const bodies: unknown[] = [
    "not json", "", "null", "[]", '"x"', "42", "{}", { other: "x" }, { value: "" }, { value: "   \n\t " }, { value: 5 }, { value: true }, { value: ["a"] },
    { value: { a: 1 } }, { value: "line1\nline2" }, { value: "line1\r\nline2" }, { value: "a\u0000b" }, { value: "\u0000" }, { value: undefined },
  ];
  for (const b of bodies) {
    const r = await t.put(`/secrets/${OPENAI}`, typeof b === "string" ? b : JSON.stringify(b), TOKEN);
    assert.equal(r.status, 400, JSON.stringify(b));
    const j = (await r.json()) as { ok: boolean; detail: string };
    assert.equal(j.ok, false);
    assert.equal(typeof j.detail, "string");
    assert.ok(!JSON.stringify(j).includes("line1"), "the detail never carries the value");
  }
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-006
test("a body over 64 KiB is 413 and writes nothing", async () => {
  const t = await boot();
  const before = t.snapshot();
  const r = await t.put(`/secrets/${OPENAI}`, JSON.stringify({ value: "x".repeat(64 * 1024) }), TOKEN);
  assert.equal(r.status, 413);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-007
test("the value appears in no response body, no log line and no error text, on success or failure", async () => {
  const LEAK = "sk-LEAK-0123456789-unique";
  const t = await boot();
  const bodies: string[] = [];
  const grab = async (r: Response) => { bodies.push(await r.text()); return r.status; };
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: LEAK }, TOKEN)), 200);
  assert.equal(await grab(await t.put("/secrets", { values: { [OPENAI]: LEAK, [BR_ID]: LEAK } }, TOKEN)), 400, "half Bedrock pair");
  assert.equal(await grab(await t.put("/secrets", { values: { "nope.path": LEAK } }, TOKEN)), 404);
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: `${LEAK}\n${LEAK}` }, TOKEN)), 400);
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, `{"value": "${LEAK}"`, TOKEN)), 400, "truncated JSON");
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: LEAK }, "wrong")), 401);
  assert.equal(await grab(await t.put("/secrets/unknown", { value: LEAK }, TOKEN)), 404);
  // A failed write whose error text carries the value: the answer and the log carry neither.
  const failing = await boot({ failWrite: `the store refused ${LEAK} for no good reason` });
  assert.equal(await grab(await failing.put(`/secrets/${OPENAI}`, { value: LEAK }, TOKEN)), 500);
  for (const b of bodies) assert.ok(!b.includes(LEAK), `response leaked: ${b}`);
  assert.ok(!t.logs().includes(LEAK), "dashboard log leaked the value");
  assert.ok(!failing.logs().includes(LEAK), "dashboard log leaked the value");
  assert.deepEqual(t.bus.published, []);
});

// @spec DASH-SECRET-007
test("GET /config/:section reports a stored secret only as set or not set", async () => {
  const t = await boot();
  const before = (await (await t.get("/config/llm")).json()) as { keys: Record<string, { set?: boolean; value?: unknown }> };
  assert.equal(before.keys["openai.api_key"]!.set, false);
  await t.put(`/secrets/${OPENAI}`, { value: "sk-SHOWN-NOWHERE" }, TOKEN);
  const text = await (await t.get("/config/llm")).text();
  assert.ok(!text.includes("sk-SHOWN-NOWHERE"));
  assert.equal((JSON.parse(text) as typeof before).keys["openai.api_key"]!.set, true);
});

// @spec DASH-SECRET-008
test("a failed write is 500 {ok:false, detail} carrying the error text, never the value, and leaves the store as it was", async () => {
  const t = await boot({ secrets: { "llm.claude.api_key": "sk-c" }, failWrite: "the settings store is busy: SQLITE_BUSY" });
  const before = t.snapshot();
  const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-never" }, TOKEN);
  assert.equal(r.status, 500);
  const j = (await r.json()) as { ok: boolean; detail: string };
  assert.equal(j.ok, false);
  assert.match(j.detail, /SQLITE_BUSY/);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-009
test("requests in flight are applied one after the other in arrival order, each its own store write, so all are applied", async () => {
  const t = await boot();
  const rev = t.store.revision();
  const paths = SECRET_PATHS.filter((p) => p !== BR_ID && p !== BR_SECRET && !p.includes("*"));
  const rs = await Promise.all(paths.map((p) => t.put(`/secrets/${p}`, { value: `v-${p}` }, TOKEN)));
  assert.deepEqual(rs.map((r) => r.status), paths.map(() => 200));
  assert.deepEqual(t.values(), Object.fromEntries(paths.map((p) => [p, `v-${p}`]).toSorted(([a], [b]) => (a! < b! ? -1 : 1))));
  assert.equal(t.store.revision(), rev + paths.length, "one store transaction per request");
});

// @spec DASH-SECRET-009, DASH-SECRET-012
test("the pair check of a request reads the credentials the request before it left", async () => {
  const t = await boot();
  // Sent together: the second, judged alone against the empty store, would be half a pair; after the first it is a rotation.
  const [both, one] = await Promise.all([
    t.put("/secrets", { values: { [BR_ID]: "id", [BR_SECRET]: "sec" } }, TOKEN),
    t.put(`/secrets/${BR_ID}`, { value: "id2" }, TOKEN),
  ]);
  assert.equal(both.status, 200);
  assert.equal(one.status, 200);
  assert.deepEqual(t.values(), { [BR_ID]: "id2", [BR_SECRET]: "sec" });
});

// @spec DASH-SECRET-001, MOD-CFG-015, MOD-MAN-015
test("restart lists, in manifest order, the running units whose manifest secrets list declares the path; none while Docker is unavailable", async () => {
  const readers = SERVICE_MANIFEST.filter((s) => (s.secrets ?? []).includes(OPENAI)).map((s) => s.id);
  assert.deepEqual(readers, ["salience", "affect", "memory", "cortex", "eyes"]);
  assert.ok(SERVICE_MANIFEST.filter((s) => s.config.includes("llm")).length > readers.length - 1, "units read the llm section; only those declaring the path restart");
  const svc = (service: string, status: string) => ({ service, status });
  const running = [...readers].toReversed().map((id) => svc(id, "running")).concat([svc("voice", "running")]);
  const t = await boot({ stack: { services: running as never } });
  const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN);
  assert.deepEqual(((await r.json()) as { restart: string[] }).restart, readers);
  const stopped = await boot({ stack: { services: [svc(readers[0]!, "exited")] as never } });
  assert.deepEqual(((await (await stopped.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN)).json()) as { restart: string[] }).restart, []);
  const noDocker = await boot({ stack: { docker: { ok: false } as never, services: running as never } });
  assert.deepEqual(((await (await noDocker.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN)).json()) as { restart: string[] }).restart, []);
});

// @spec DASH-SECRET-001, MOD-MAN-015
test("a unit that reads a section but does not declare the path is not restarted, and a path no unit declares restarts nothing", async () => {
  const everyone = SERVICE_MANIFEST.map((s) => ({ service: s.composeName, status: "running" }));
  const t = await boot({ stack: { services: everyone as never } });
  const restartOf = async (body: unknown, path: string) => ((await (await t.put(`/secrets/${path}`, body, TOKEN)).json()) as { restart: string[] }).restart;
  assert.deepEqual(await restartOf({ value: "d" }, "connections.discord.token"), ["connector-discord"]);
  assert.deepEqual(await restartOf({ value: "y" }, "chat.youtube.api_key"), ["chat", "tools"], "tools declares the stream-info credentials; chat the user ones");
  assert.deepEqual(await restartOf({ value: "t" }, "chat.twitch.access_token"), ["chat"], "tools reads the chat section but declares no user token");
  assert.deepEqual(await restartOf({ value: "v" }, "voice.openai.api_key"), ["voice"], "mouth and avatar read other sections and declare none");
  assert.deepEqual(await restartOf({ value: "hf" }, "voice.pocket.hf_token"), [], "the Pocket token reaches only the engine container, through its own file");
  assert.deepEqual(await restartOf({ value: null }, "voice.pocket.hf_token"), [], "a clear lists the same units as a set");
  const multi = (await (await t.put("/secrets", { values: { "connections.discord.token": "d", "ears.openai.api_key": "e" } }, TOKEN)).json()) as { restart: string[] };
  assert.deepEqual(multi.restart, ["ears", "connector-discord"], "PUT /secrets: the union in manifest order");
});

// @spec DASH-SECRET-003, DASH-HOST-004, DASH-HOST-005
test("Host and Origin checks apply before the token: a foreign Origin or Host is 403 and writes nothing, even with the right token", async () => {
  const t = await boot();
  const before = t.snapshot();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const body = JSON.stringify({ value: "sk-never" });
  const viaRaw = (headers: Record<string, string>) => t.raw(`/secrets/${OPENAI}`, { ...headers, "content-length": String(body.length) }, body);
  assert.equal((await viaRaw({ ...auth, host: "127.0.0.1", origin: "http://evil.example" })).status, 403);
  assert.equal((await viaRaw({ ...auth, host: "rebind.example" })).status, 403);
  assert.equal(t.snapshot(), before);
  assert.equal((await viaRaw({ ...auth, host: "127.0.0.1" })).status, 200);
});

// @spec DASH-SECRET-010, DASH-HOST-002
test("the secret route is not served on the LAN listener", async () => {
  const t = await boot();
  const before = t.snapshot();
  const body = JSON.stringify({ value: "sk-never" });
  const headers = { authorization: `Bearer ${TOKEN}`, "content-length": String(body.length) };
  assert.equal((await t.raw(`/secrets/${OPENAI}`, headers, body, t.lanPort)).status, 404);
  assert.equal((await t.raw("/secrets", headers, JSON.stringify({ values: { [OPENAI]: "x" } }), t.lanPort)).status, 404);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-011
test("PUT /secrets sets and clears several paths in one store write and answers {ok, set: {path: boolean}, restart}", async () => {
  const t = await boot({ secrets: { "llm.claude.api_key": "sk-c" } });
  const rev = t.store.revision();
  const r = await t.put("/secrets", { values: { [OPENAI]: " sk-o ", "llm.claude.api_key": null, "vision.obs.password": "pw" } }, TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, set: { [OPENAI]: true, "llm.claude.api_key": false, "vision.obs.password": true }, restart: [] });
  assert.deepEqual(t.values(), { [OPENAI]: "sk-o", "vision.obs.password": "pw" });
  assert.equal(t.store.revision(), rev + 1, "one write");
});

// @spec DASH-SECRET-011, DASH-SECRET-003
test("PUT /secrets is gated like the single form: 401 for a missing or wrong token, before the body is judged", async () => {
  const t = await boot();
  const before = t.snapshot();
  assert.equal((await t.put("/secrets", "not json", "wrong")).status, 401);
  assert.equal((await t.put("/secrets", { values: { [OPENAI]: "x" } })).status, 401);
  assert.equal((await t.put("/secrets", "not json", TOKEN)).status, 400);
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-011
test("PUT /secrets refuses a bad body, an unknown path or an unusable value with nothing written for any path", async () => {
  const t = await boot();
  const before = t.snapshot();
  const bad: [unknown, number][] = [
    ["not json", 400], [{}, 400], [{ values: null }, 400], [{ values: [] }, 400], [{ values: {} }, 400], [{ values: "x" }, 400], [{ value: "x" }, 400],
    [{ values: { [OPENAI]: "" } }, 400], [{ values: { [OPENAI]: 5 } }, 400], [{ values: { [OPENAI]: "a\nb" } }, 400],
    [{ values: { [OPENAI]: "ok", "llm.openai.base_url": "x" } }, 404], [{ values: { [OPENAI]: "ok", nope: "x" } }, 404],
    [JSON.parse('{"values": {"__proto__": "x"}}'), 404], [{ values: { constructor: "x" } }, 404],
  ];
  for (const [b, status] of bad) {
    const r = await t.put("/secrets", typeof b === "string" ? b : JSON.stringify(b), TOKEN);
    assert.equal(r.status, status, JSON.stringify(b));
    assert.equal(((await r.json()) as { ok: boolean }).ok, false);
  }
  assert.equal(t.snapshot(), before);
  assert.equal((await t.put("/secrets", "x".repeat(70 * 1024), TOKEN)).status, 413);
});

// @spec DASH-SECRET-012
test("a request that would leave exactly one of the two Bedrock credentials set is 400 naming both paths and writes nothing", async () => {
  const both = { paths: [BR_ID, BR_SECRET] };
  const t = await boot();
  const before = t.snapshot();
  const cases: { name: string; call: () => Promise<Response> }[] = [
    { name: "single: set the key id alone", call: () => t.put(`/secrets/${BR_ID}`, { value: "id" }, TOKEN) },
    { name: "single: set the secret key alone", call: () => t.put(`/secrets/${BR_SECRET}`, { value: "sec" }, TOKEN) },
    { name: "multi: only one", call: () => t.put("/secrets", { values: { [BR_ID]: "id", [OPENAI]: "k" } }, TOKEN) },
    { name: "multi: one set, one cleared", call: () => t.put("/secrets", { values: { [BR_ID]: "id", [BR_SECRET]: null } }, TOKEN) },
  ];
  for (const c of cases) {
    const r = await c.call();
    assert.equal(r.status, 400, c.name);
    const j = (await r.json()) as { ok: boolean; detail: string; paths: string[] };
    assert.equal(j.ok, false);
    assert.deepEqual(j.paths, both.paths, c.name);
    assert.ok(j.detail.includes(BR_ID) && j.detail.includes(BR_SECRET), `${c.name}: detail names both`);
  }
  assert.equal(t.snapshot(), before);
});

// @spec DASH-SECRET-012
test("the Bedrock pair is judged on the state the request would leave: with its partner set it can change alone; clearing one of a set pair is refused, clearing both is not", async () => {
  const t = await boot();
  assert.equal((await t.put("/secrets", { values: { [BR_ID]: "id", [BR_SECRET]: "sec" } }, TOKEN)).status, 200);
  assert.equal((await t.put(`/secrets/${BR_ID}`, { value: "id2" }, TOKEN)).status, 200, "rotate one while the other is set");
  assert.deepEqual(t.values(), { [BR_ID]: "id2", [BR_SECRET]: "sec" });
  const half = await t.put(`/secrets/${BR_SECRET}`, { value: null }, TOKEN);
  assert.equal(half.status, 400);
  assert.deepEqual(t.values(), { [BR_ID]: "id2", [BR_SECRET]: "sec" });
  assert.equal((await t.put("/secrets", { values: { [BR_ID]: null, [BR_SECRET]: null } }, TOKEN)).status, 200);
  assert.deepEqual(t.values(), {});
  assert.equal((await t.put(`/secrets/${BR_ID}`, { value: null }, TOKEN)).status, 200, "clearing a credential whose partner is already empty leaves neither set");
});

// @spec DASH-SECRET-012
test("a request that does not name a Bedrock credential is not refused for a half-set pair already in the store", async () => {
  const t = await boot({ secrets: { [BR_ID]: "id" } });
  assert.equal((await t.put(`/secrets/${OPENAI}`, { value: "sk" }, TOKEN)).status, 200);
});
