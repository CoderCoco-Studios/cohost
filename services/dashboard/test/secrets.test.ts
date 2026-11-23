import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST } from "@cohost/control";
import { SECRET_PATHS } from "@cohost/config";
import { createDashboardHandler } from "../src/routes.js";
import { guardFullSurface, lanHandler } from "../src/host.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");

const TOKEN = "tok-123";
const OPENAI = "llm.openai.api_key";
const BR_ID = "llm.bedrock.access_key_id";
const BR_SECRET = "llm.bedrock.secret_access_key";

interface Opts {
  /** CONTROL_ENABLED=1 (the handler gets `control`). */
  control?: boolean;
  /** CONTROL_TOKEN configured; default is the token when `control`, none otherwise. */
  token?: string | null;
  secrets?: string;
  stack?: Partial<StackSnapshot>;
  /** Let the settings reads locate config.yaml (the secret route itself never does). */
  readConfig?: boolean;
  /** The secrets file path to use instead of `<dir>/secrets.yaml`. */
  secretsFile?: string;
}

async function boot(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-secrets-"));
  const configFile = join(dir, "config.yaml");
  writeFileSync(configFile, EXAMPLE);
  const secretsFile = o.secretsFile ?? join(dir, "secrets.yaml");
  if (o.secrets !== undefined) writeFileSync(secretsFile, o.secrets, { mode: 0o600 });
  const bus = new FakeBus();
  const rec = recordingLog();
  const token = o.token === undefined ? (o.control ? TOKEN : undefined) : o.token ?? undefined;
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...o.stack };
  let configReads = 0;
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => { configReads++; if (o.readConfig) return configFile; throw new Error("the secret route must not touch config.yaml"); },
    secretsFile: () => secretsFile,
    ...(token ? { controlToken: token } : {}),
    ...(o.control ? { control: { token: token!, runtime: "compose", advanced: false, controller: {} as never } } : {}),
  });
  const mk = (h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });
  const server = await mk(guardFullSurface(handler, { loopback: true, controlEnabled: !!o.control }));
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
  return {
    dir, configFile, get, secretsFile, bus, put, raw, logs, lanPort, snap, configReads: () => configReads,
    secretsText: () => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } },
    values: () => nonEmptyValues(secretsFile),
    configText: () => readFileSync(configFile, "utf8"),
  };
}

/** The non-empty values of a secrets file written as nested block mappings: dotted path to value. */
function nonEmptyValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: { indent: number; key: string }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^(\s*)([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (!m || m[3]!.startsWith("#") && !m[3]) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, key: m[2]! });
    const v = m[3]!.replace(/^(["'])(.*)\1$/, "$2");
    if (v !== "") out[stack.map((x) => x.key).join(".")] = v;
  }
  return out;
}

const mode = (f: string) => statSync(f).mode & 0o777;

// @spec DASH-SECRET-001, DASH-SECRET-008, DASH-SECRET-010
test("a set stores the value trimmed at its config path, mode 0600, answers {ok, set: true, restart}, and touches no other file", async () => {
  for (const control of [true, false]) {
    const t = await boot({ control, token: TOKEN });
    const r = await t.put(`/secrets/${OPENAI}`, { value: "  sk-abc123\n" }, TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, set: true, restart: [] });
    assert.deepEqual(t.values(), { [OPENAI]: "sk-abc123" });
    assert.equal(mode(t.secretsFile), 0o600);
    assert.equal(t.configText(), EXAMPLE, "config.yaml is untouched");
    assert.equal(t.configReads(), 0, "config.yaml is never even located");
    assert.deepEqual(t.bus.published, []);
  }
});

// @spec DASH-SECRET-001
test("each of the seventeen wildcard-free secret paths can be set and cleared", async () => {
  const t = await boot({ control: true });
  const wildcardFree = SECRET_PATHS.filter((p) => !p.includes("*"));
  assert.equal(wildcardFree.length, 17); // CFG-SEC-003, wildcard-free paths only
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

// @spec DASH-SECRET-002, DASH-SECRET-007
test("a clear empties the value, keeps the key and every other secret, and every read reports it not set", async () => {
  const t = await boot({ control: true, secrets: `# mine\nllm:\n  openai:\n    api_key: sk-old\n  claude:\n    api_key: sk-claude\n` });
  const r = await t.put(`/secrets/${OPENAI}`, { value: null }, TOKEN);
  assert.deepEqual(await r.json(), { ok: true, set: false, restart: [] });
  assert.match(t.secretsText(), /# mine/);
  assert.match(t.secretsText(), /api_key: ""|api_key: ''|api_key:\s*$/m);
  assert.deepEqual(t.values(), { "llm.claude.api_key": "sk-claude" });
  assert.doesNotMatch(t.secretsText(), /sk-old/);
});

// @spec DASH-SECRET-003, DASH-SECRET-004
test("the control token is always required, in both modes: missing or wrong is 401 with www-authenticate and nothing is written", async () => {
  for (const control of [true, false]) {
    const t = await boot({ control, token: TOKEN });
    for (const tok of [undefined, "wrong", ""]) {
      const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-never" }, tok);
      assert.equal(r.status, 401, `control=${control} token=${String(tok)}`);
      assert.equal(r.headers.get("www-authenticate"), "Bearer");
      assert.equal(t.secretsText(), "");
    }
  }
});

// @spec DASH-SECRET-004
test("with no control token configured the route is 403 naming CONTROL_TOKEN and CONTROL_ENABLED, whatever the request carries", async () => {
  const t = await boot({ control: false, token: null });
  for (const tok of [undefined, "anything"]) {
    const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-never" }, tok);
    assert.equal(r.status, 403);
    const j = (await r.json()) as { ok: boolean; detail: string };
    assert.equal(j.ok, false);
    assert.match(j.detail, /CONTROL_TOKEN/);
    assert.match(j.detail, /CONTROL_ENABLED/);
  }
  assert.equal((await t.put("/secrets", { values: { [OPENAI]: "x" } }, TOKEN)).status, 403);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-003, DASH-SECRET-005, DASH-ACC-004
test("the token is checked before the path: an unknown path is 401 for a wrong token and 404 for the right one, writing nothing", async () => {
  for (const control of [true, false]) {
    const t = await boot({ control, token: TOKEN });
    assert.equal((await t.put("/secrets/access-check", { value: null }, "wrong")).status, 401);
    assert.equal((await t.put("/secrets/access-check", { value: null })).status, 401);
    const ok = await t.put("/secrets/access-check", { value: null }, TOKEN);
    assert.equal(ok.status, 404);
    assert.deepEqual(await ok.json(), { ok: false, detail: "unknown secret" });
    assert.equal(t.secretsText(), "");
  }
});

// @spec DASH-SECRET-003, DASH-SECRET-006
test("refusal order after the token: 413 body size, then 404 path, then 400 body", async () => {
  const t = await boot({ control: false, token: TOKEN });
  const huge = JSON.stringify({ value: "x".repeat(70 * 1024) });
  assert.equal((await t.put(`/secrets/${OPENAI}`, huge, "wrong")).status, 401, "token before size");
  assert.equal((await t.put(`/secrets/${OPENAI}`, huge, TOKEN)).status, 413);
  assert.equal((await t.put("/secrets/nope", huge, TOKEN)).status, 413, "size before path");
  assert.equal((await t.put("/secrets/nope", "not json", TOKEN)).status, 404, "path before body");
  assert.equal((await t.put(`/secrets/${OPENAI}`, "not json", TOKEN)).status, 400);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-005
test("a path that is not one of the secret paths is 404 unknown secret: traversal, prototype keys, non-secret config paths, bad escapes", async () => {
  const t = await boot({ control: true });
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
  assert.equal(t.secretsText(), "");
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(t.configText(), EXAMPLE);
});

// @spec DASH-SECRET-006
test("a body that is not a JSON object, lacks value, or holds an unusable value is 400 {ok:false, detail}; nothing is written", async () => {
  const t = await boot({ control: true });
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
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-006
test("a body over 64 KiB is 413 and writes nothing", async () => {
  const t = await boot({ control: true });
  const r = await t.put(`/secrets/${OPENAI}`, JSON.stringify({ value: "x".repeat(64 * 1024) }), TOKEN);
  assert.equal(r.status, 413);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-007
test("the value appears in no response body, no log line and no error text, on success or failure", async () => {
  const LEAK = "sk-LEAK-0123456789-unique";
  const t = await boot({ control: true });
  const bodies: string[] = [];
  const grab = async (r: Response) => { bodies.push(await r.text()); return r.status; };
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: LEAK }, TOKEN)), 200);
  assert.equal(await grab(await t.put("/secrets", { values: { [OPENAI]: LEAK, [BR_ID]: LEAK } }, TOKEN)), 400, "half Bedrock pair");
  assert.equal(await grab(await t.put("/secrets", { values: { "nope.path": LEAK } }, TOKEN)), 404);
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: `${LEAK}\n${LEAK}` }, TOKEN)), 400);
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, `{"value": "${LEAK}"`, TOKEN)), 400, "truncated JSON");
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: LEAK }, "wrong")), 401);
  assert.equal(await grab(await t.put("/secrets/unknown", { value: LEAK }, TOKEN)), 404);
  // failed writes: an unparsable secrets file, and a secrets path that is a directory
  writeFileSync(t.secretsFile, `llm: [${LEAK}\n`);
  assert.equal(await grab(await t.put(`/secrets/${OPENAI}`, { value: LEAK }, TOKEN)), 500);
  const asDir = await boot({ control: true, secretsFile: join(mkdtempSync(join(tmpdir(), "cohost-secrets-dir-")), "secrets.yaml") });
  mkdirSync(asDir.secretsFile);
  assert.equal(await grab(await asDir.put(`/secrets/${OPENAI}`, { value: LEAK }, TOKEN)), 500);
  for (const b of bodies) assert.ok(!b.includes(LEAK), `response leaked: ${b}`);
  assert.ok(!t.logs().includes(LEAK), "dashboard log leaked the value");
  assert.ok(!asDir.logs().includes(LEAK), "dashboard log leaked the value");
  assert.deepEqual(t.bus.published, []);
});

// @spec DASH-SECRET-007
test("GET /config/:section reports a stored secret only as set or not set", async () => {
  const t = await boot({ control: true, readConfig: true });
  const before = (await (await t.get("/config/llm")).json()) as { keys: Record<string, { set?: boolean; value?: unknown }> };
  assert.equal(before.keys["openai.api_key"]!.set, false);
  await t.put(`/secrets/${OPENAI}`, { value: "sk-SHOWN-NOWHERE" }, TOKEN);
  const text = await (await t.get("/config/llm")).text();
  assert.ok(!text.includes("sk-SHOWN-NOWHERE"));
  assert.equal((JSON.parse(text) as typeof before).keys["openai.api_key"]!.set, true);
});

// @spec DASH-SECRET-008
test("a failed write is 500 {ok:false, detail} carrying the error text and leaves the file as it was", async () => {
  const bad = "llm: [unclosed\n";
  const t = await boot({ control: true, secrets: bad });
  const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-never" }, TOKEN);
  assert.equal(r.status, 500);
  const j = (await r.json()) as { ok: boolean; detail: string };
  assert.equal(j.ok, false);
  assert.match(j.detail, /secrets\.yaml/);
  assert.equal(t.secretsText(), bad);
});

// @spec DASH-SECRET-008
test("the file ends at mode 0600 even when it existed with a looser mode", async () => {
  const t = await boot({ control: true, secrets: "llm:\n  claude:\n    api_key: sk-c\n" });
  chmodSync(t.secretsFile, 0o644);
  assert.equal((await t.put(`/secrets/${OPENAI}`, { value: "sk-x" }, TOKEN)).status, 200);
  assert.equal(mode(t.secretsFile), 0o600);
  assert.deepEqual(t.values(), { [OPENAI]: "sk-x", "llm.claude.api_key": "sk-c" });
});

// @spec DASH-SECRET-009
test("two requests in flight are applied one after the other and leave the file well-formed with both applied", async () => {
  const t = await boot({ control: true });
  const paths = SECRET_PATHS.filter((p) => p !== BR_ID && p !== BR_SECRET && !p.includes("*"));
  const rs = await Promise.all(paths.map((p) => t.put(`/secrets/${p}`, { value: `v-${p}` }, TOKEN)));
  assert.deepEqual(rs.map((r) => r.status), paths.map(() => 200));
  assert.deepEqual(t.values(), Object.fromEntries(paths.map((p) => [p, `v-${p}`])));
});

// @spec DASH-SECRET-001, MOD-CFG-015
test("restart lists, in manifest order, the running units that declare the secret's section; none while Docker is unavailable", async () => {
  const readers = SERVICE_MANIFEST.filter((s) => s.config.includes("llm")).map((s) => s.id);
  assert.ok(readers.length >= 2);
  const svc = (service: string, status: string) => ({ service, status });
  const running = [...readers].reverse().map((id) => svc(id, "running")).concat([svc("voice", "running")]);
  const t = await boot({ control: true, stack: { services: running as never } });
  const r = await t.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN);
  assert.deepEqual(((await r.json()) as { restart: string[] }).restart, readers);
  const stopped = await boot({ control: true, stack: { services: [svc(readers[0]!, "exited")] as never } });
  assert.deepEqual(((await (await stopped.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN)).json()) as { restart: string[] }).restart, []);
  const noDocker = await boot({ control: true, stack: { docker: { ok: false } as never, services: running as never } });
  assert.deepEqual(((await (await noDocker.put(`/secrets/${OPENAI}`, { value: "sk-1" }, TOKEN)).json()) as { restart: string[] }).restart, []);
});

// @spec DASH-SECRET-003, DASH-HOST-004, DASH-HOST-005
test("Host and Origin checks apply before the token: a foreign Origin or Host is 403 and writes nothing, even with the right token", async () => {
  const t = await boot({ control: true });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const body = JSON.stringify({ value: "sk-never" });
  const viaRaw = (headers: Record<string, string>) => t.raw(`/secrets/${OPENAI}`, { ...headers, "content-length": String(body.length) }, body);
  assert.equal((await viaRaw({ ...auth, host: "127.0.0.1", origin: "http://evil.example" })).status, 403);
  assert.equal((await viaRaw({ ...auth, host: "rebind.example" })).status, 403);
  assert.equal(t.secretsText(), "");
  assert.equal((await viaRaw({ ...auth, host: "127.0.0.1" })).status, 200);
});

// @spec DASH-SECRET-010, DASH-HOST-002
test("the secret route is not served on the LAN listener", async () => {
  const t = await boot({ control: true });
  const body = JSON.stringify({ value: "sk-never" });
  const headers = { authorization: `Bearer ${TOKEN}`, "content-length": String(body.length) };
  assert.equal((await t.raw(`/secrets/${OPENAI}`, headers, body, t.lanPort)).status, 404);
  assert.equal((await t.raw("/secrets", headers, JSON.stringify({ values: { [OPENAI]: "x" } }), t.lanPort)).status, 404);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-011
test("PUT /secrets sets and clears several paths in one atomic write and answers {ok, set: {path: boolean}, restart}", async () => {
  const t = await boot({ control: true, secrets: "llm:\n  claude:\n    api_key: sk-c\n" });
  const r = await t.put("/secrets", { values: { [OPENAI]: " sk-o ", "llm.claude.api_key": null, "vision.obs.password": "pw" } }, TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, set: { [OPENAI]: true, "llm.claude.api_key": false, "vision.obs.password": true }, restart: [] });
  assert.deepEqual(t.values(), { [OPENAI]: "sk-o", "vision.obs.password": "pw" });
  assert.equal(mode(t.secretsFile), 0o600);
});

// @spec DASH-SECRET-011, DASH-SECRET-003
test("PUT /secrets is gated like the single form: 403 with no token configured, 401 for a wrong token, before the body is judged", async () => {
  const none = await boot({ control: false, token: null });
  assert.equal((await none.put("/secrets", { values: { [OPENAI]: "x" } }, TOKEN)).status, 403);
  const t = await boot({ control: false, token: TOKEN });
  assert.equal((await t.put("/secrets", "not json", "wrong")).status, 401);
  assert.equal((await t.put("/secrets", { values: { [OPENAI]: "x" } })).status, 401);
  assert.equal((await t.put("/secrets", "not json", TOKEN)).status, 400);
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-011
test("PUT /secrets refuses a bad body, an unknown path or an unusable value with nothing written for any path", async () => {
  const t = await boot({ control: true });
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
  assert.equal(t.secretsText(), "");
  assert.equal((await t.put("/secrets", "x".repeat(70 * 1024), TOKEN)).status, 413);
});

// @spec DASH-SECRET-012
test("a request that would leave exactly one of the two Bedrock credentials set is 400 naming both paths and writes nothing", async () => {
  const both = { paths: [BR_ID, BR_SECRET] };
  const t = await boot({ control: true });
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
  assert.equal(t.secretsText(), "");
});

// @spec DASH-SECRET-012
test("the Bedrock pair is judged on the state the request would leave: with its partner set it can change alone; clearing one of a set pair is refused, clearing both is not", async () => {
  const t = await boot({ control: true });
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
test("a request that does not name a Bedrock credential is not refused for a half-set pair already in the file", async () => {
  const t = await boot({ control: true, secrets: `llm:\n  bedrock:\n    access_key_id: id\n` });
  assert.equal((await t.put(`/secrets/${OPENAI}`, { value: "sk" }, TOKEN)).status, 200);
});
