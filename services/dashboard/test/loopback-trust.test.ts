import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { createRecoveryHandler, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { guardFullSurface } from "../src/host.js";
import { fullSurfaceBind } from "../src/control.js";
import { tokenRefusal } from "../src/access.js";
import type { StackService, StackSnapshot } from "../src/stack.js";
import { EXAMPLE } from "./config-fixture.js";

const TOKEN = "tok-366";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const listen = async (h: http.RequestListener): Promise<string> => {
  const s = http.createServer(h);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  after(() => { s.close(); s.closeAllConnections(); });
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/**
 * The normal dashboard with control on and a token configured, as `DASHBOARD_HOST` decides: `tokenRequired` false is the
 * loopback bind, true a non-loopback one. The listener's guard is the loopback one either way (the test talks to 127.0.0.1).
 */
async function normal(tokenRequired: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-trust-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, EXAMPLE);
  const bus = new FakeBus();
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] };
  const handler = createDashboardHandler({
    bus, log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => configFile, secretsFile: () => secretsFile, uiDir: join(dir, "no-ui"), docsDir: join(dir, "no-docs"),
    controlToken: TOKEN, tokenRequired,
    control: { token: TOKEN, runtime: "compose", advanced: false, controller: {} as never },
  });
  const url = await listen(guardFullSurface(handler, { loopback: true, controlEnabled: true }));
  const send = (method: string, path: string, body: unknown, token?: string) =>
    fetch(url + path, { method, headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { url, bus, configFile, secretsFile, send, config: () => readFileSync(configFile, "utf8"), secrets: () => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } } };
}

// @spec DASH-CTRL-011, DASH-CTRL-004, DASH-CTRL-009, DASH-SECRET-003, DASH-TOOL-002
test("on a loopback bind with control on, a sensitive settings save, a secret write and a mutation need no token, and a stray header is ignored", async () => {
  const t = await normal(false);
  const etag = sha(t.config());
  const save = await t.send("PUT", "/config/llm", { etag, values: { provider: "openai" } });
  assert.equal(save.status, 200, await save.clone().text());
  assert.match(t.config(), /^ {2}provider: "?openai"?/m);
  const secret = await t.send("PUT", "/secrets/llm.openai.api_key", { value: "sk-local" }, "not-the-token");
  assert.equal(secret.status, 200, await secret.clone().text());
  assert.match(t.secrets(), /sk-local/);
  assert.equal((await t.send("POST", "/control", { cmd: "mute" })).status, 204);
  assert.equal((await t.send("POST", "/tools/answer", { id: "c1", allow: false })).status, 202);
  assert.equal((await t.send("PUT", "/secrets/access-check", { value: null })).status, 404, "the token check accepts any value on loopback");
  const info = await (await fetch(`${t.url}/services/control`)).json() as { enabled: boolean; tokenRequired: boolean };
  assert.deepEqual(info, { enabled: true, runtime: "compose", advanced: false, tokenRequired: false });
});

// @spec DASH-CTRL-011, DASH-CTRL-004, DASH-CTRL-009, DASH-SECRET-003, DASH-TOOL-002, DASH-CTRL-007
test("on a non-loopback bind every gated route needs the token, a sensitive save names its keys, and the right token passes", async () => {
  const t = await normal(true);
  const before = t.config();
  const etag = sha(before);
  for (const token of [undefined, "wrong"]) {
    const save = await t.send("PUT", "/config/llm", { etag, values: { provider: "openai" } }, token);
    assert.equal(save.status, 401);
    assert.equal(save.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(((await save.json()) as { sensitive: string[] }).sensitive, ["llm.provider"]);
    assert.equal((await t.send("PUT", "/config/llm", { etag, values: { temperature: 0.4 } }, token)).status, 401);
    assert.equal((await t.send("PUT", "/secrets/llm.openai.api_key", { value: "sk-x" }, token)).status, 401);
    assert.equal((await t.send("POST", "/control", { cmd: "mute" }, token)).status, 401);
    assert.equal((await t.send("POST", "/tools/answer", { id: "c1", allow: false }, token)).status, 401);
    assert.equal((await t.send("POST", "/stack/launch", {}, token)).status, 401);
    assert.equal((await t.send("PUT", "/secrets/access-check", { value: null }, token)).status, 401);
  }
  assert.equal(t.config(), before);
  assert.equal(t.secrets(), "");
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.send("PUT", "/config/llm", { etag, values: { provider: "openai" } }, TOKEN)).status, 200);
  assert.equal((await t.send("PUT", "/secrets/access-check", { value: null }, TOKEN)).status, 404);
  const info = await (await fetch(`${t.url}/services/control`)).json() as { tokenRequired: boolean };
  assert.equal(info.tokenRequired, true);
});

// @spec DASH-CTRL-011, DASH-CTRL-010
test("the gate: open when not required, 'none' without a configured token, 'wrong' for a missing or wrong header", () => {
  assert.equal(tokenRefusal({ required: false, token: TOKEN }, undefined), undefined);
  assert.equal(tokenRefusal({ required: false, token: undefined }, "Bearer x"), undefined);
  assert.equal(tokenRefusal({ required: true, token: undefined }, `Bearer ${TOKEN}`), "none");
  assert.equal(tokenRefusal({ required: true, token: TOKEN }, undefined), "wrong");
  assert.equal(tokenRefusal({ required: true, token: TOKEN }, "Bearer nope"), "wrong");
  assert.equal(tokenRefusal({ required: true, token: TOKEN }, `Bearer ${TOKEN}`), undefined);
});

// @spec DASH-CTRL-011, DASH-HOST-007, DASH-CTRL-003
test("the token is required exactly when the full surface is bound beyond loopback", () => {
  assert.equal(fullSurfaceBind({ CONTROL_ENABLED: "1", CONTROL_TOKEN: TOKEN }).tokenRequired, false);
  assert.equal(fullSurfaceBind({ DASHBOARD_HOST: "::1" }).tokenRequired, false);
  assert.equal(fullSurfaceBind({ DASHBOARD_HOST: "0.0.0.0", CONTROL_ENABLED: "1", CONTROL_TOKEN: TOKEN }).tokenRequired, true);
  assert.throws(() => fullSurfaceBind({ DASHBOARD_HOST: "0.0.0.0" }), /DASHBOARD_HOST/);
});

/** A config.yaml from the `${VAR}` era: a placeholder with a fallback at a sensitive key, one without, and a stray credential. */
const STALE = EXAMPLE
  .replace(/^ {2}name: "Coco"/m, '  name: "${COHOST_NAME:-Mika}"')
  .replace(/^ {2}provider: "ollama"/m, '  provider: "${LLM_PROVIDER:-openai}"')
  .replace(/^ {2}model: "qwen2\.5:7b-instruct-q4_K_M"/m, '  model: "${LLM_MODEL}"');
const BAD_SECRETS = "llm:\n  openai:\n    api_key: 0123\n";

async function recovery(o: Partial<RecoveryHandlerDeps> & { text?: string; secrets?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-trust-rcv-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, o.text ?? STALE);
  writeFileSync(secretsFile, o.secrets ?? BAD_SECRETS, { mode: 0o600 });
  const logs: string[] = [];
  const log = { info: (m: unknown) => { logs.push(String(m)); }, error: (m: unknown) => { logs.push(String(m)); } } as never;
  const handler = createRecoveryHandler({ log, files: { configFile, secretsFile }, controlEnabled: true, controlToken: TOKEN, tokenRequired: false, uiDir: join(dir, "no-ui"), onValid: () => {}, ...o });
  const url = await listen(guardFullSurface(handler, { loopback: true, controlEnabled: true }));
  const state = async () => (await (await fetch(`${url}/recovery`)).json()) as { etag: string; problems: RecoveryProblem[] };
  const send = (method: string, path: string, body: unknown, token?: string) =>
    fetch(url + path, { method, headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { url, logs, configFile, secretsFile, state, send, config: () => readFileSync(configFile, "utf8"), secrets: () => readFileSync(secretsFile, "utf8") };
}

// @spec DASH-RCV-003, DASH-RCV-005, DASH-RCV-006, DASH-RCV-018, DASH-RCV-023, DASH-CTRL-011
test("recovery on a loopback bind with control on: a sensitive set, a secrets reset, the fallback and a raw read need no token", async () => {
  const r = await recovery();
  let s = await r.state();
  const provider = s.problems.find((p) => p.path === "llm.provider")!;
  assert.equal(provider.sensitive, true);
  assert.equal(provider.fallback, "openai");
  const fb = await r.send("POST", "/recovery/fallback", { etag: s.etag, path: "llm.provider" });
  assert.equal(fb.status, 200, await fb.clone().text());
  assert.match(r.config(), /^ {2}provider: "?openai"?/m);
  assert.ok(r.logs.includes("config recovery: fallback llm.provider"), r.logs.join("\n"));
  s = await r.state();
  const set = await r.send("POST", "/recovery/set", { etag: s.etag, path: "llm.model", value: "qwen3:8b" });
  assert.equal(set.status, 200, await set.clone().text());
  s = await r.state();
  const reset = await r.send("POST", "/recovery/reset", { etag: s.etag, path: "llm.openai.api_key" }, "stale-token");
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.match(r.secrets(), /api_key: "0123"/);
  const raw = await fetch(`${r.url}/recovery/raw?file=secrets`);
  assert.equal(raw.status, 409, "secrets.yaml parses: the raw editor answers 409, not a token refusal");
  const info = await (await fetch(`${r.url}/services/control`)).json() as { tokenRequired: boolean; enabled: boolean };
  assert.deepEqual(info, { enabled: true, runtime: "compose", advanced: false, tokenRequired: false });
});

// @spec DASH-RCV-007, DASH-RCV-009, DASH-CTRL-011
test("recovery on a loopback bind: reset all repairs config.yaml and secrets.yaml without a token, and the answer has no tokenNeeded", async () => {
  const r = await recovery({ text: STALE.replace('"${LLM_MODEL}"', '"qwen3:8b"') });
  const s = await r.state();
  const res = await r.send("POST", "/recovery/reset-all", { etag: s.etag });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { valid: boolean; tokenNeeded?: unknown; problems: unknown[] };
  assert.equal(body.valid, true, JSON.stringify(body.problems));
  assert.equal("tokenNeeded" in body, false);
  assert.match(r.secrets(), /api_key: "0123"/);
});

// @spec DASH-RCV-017, DASH-RCV-018, DASH-CTRL-011
test("recovery on a loopback bind: the raw editor of either file reads and saves with no token", async () => {
  const r = await recovery({ text: "cohost: [x\n", secrets: "llm: [x\n" });
  for (const file of ["config", "secrets"] as const) {
    const read = await fetch(`${r.url}/recovery/raw?file=${file}`);
    assert.equal(read.status, 200, file);
    const { etag } = (await read.json()) as { etag: string };
    const text = file === "config" ? EXAMPLE : "";
    const save = await r.send("POST", "/recovery/raw", { file, etag, text });
    assert.equal(save.status, 200, `${file}: ${await save.clone().text()}`);
  }
  assert.equal(r.config(), EXAMPLE);
});

// @spec DASH-RCV-003, DASH-RCV-018, DASH-RCV-019, DASH-CTRL-011
test("recovery on a non-loopback bind: every write, the raw read and Stop need the token, checked before the body, and nothing is written", async () => {
  const r = await recovery({ tokenRequired: true });
  const before = { c: r.config(), s: r.secrets() };
  const s = await r.state();
  for (const token of [undefined, "wrong"]) {
    for (const [op, body] of [["set", { etag: s.etag, path: "llm.model", value: "x" }], ["reset", { etag: s.etag, path: "cohost.name" }], ["reset-all", { etag: s.etag }], ["fallback", { etag: s.etag, path: "cohost.name" }], ["raw", { file: "config", etag: s.etag, text: "" }]] as const) {
      const res = await r.send("POST", `/recovery/${op}`, body, token);
      assert.equal(res.status, 401, `${op} ${String(token)}`);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal(((await res.json()) as { ok: boolean }).ok, false);
    }
    const raw = await fetch(`${r.url}/recovery/raw?file=secrets`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(raw.status, 401);
    assert.doesNotMatch(await raw.text(), /0123/);
    assert.equal((await r.send("POST", "/stack/stop", {}, token)).status, 401);
  }
  assert.deepEqual({ c: r.config(), s: r.secrets() }, before);
  const ok = await r.send("POST", "/recovery/fallback", { etag: s.etag, path: "cohost.name" }, TOKEN);
  assert.equal(ok.status, 200);
  const none = await recovery({ tokenRequired: true, controlToken: undefined });
  const refused = await none.send("POST", "/recovery/reset-all", { etag: (await none.state()).etag }, TOKEN);
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { detail: string }).detail, /CONTROL_TOKEN.*CONTROL_ENABLED|CONTROL_ENABLED.*CONTROL_TOKEN/);
});

// @spec DASH-RCV-022, DASH-RCV-012, DASH-ACC-004
test("recovery answers the Access dialog's token check: 403 with none configured, 401 for a missing or wrong token, 404 otherwise, writing nothing", async () => {
  const cases: [Partial<RecoveryHandlerDeps>, string | undefined, number][] = [
    [{ tokenRequired: true, controlToken: undefined }, TOKEN, 403],
    [{ tokenRequired: true }, undefined, 401],
    [{ tokenRequired: true }, "wrong", 401],
    [{ tokenRequired: true }, TOKEN, 404],
    [{ tokenRequired: false }, undefined, 404],
    [{ tokenRequired: false }, "anything", 404],
  ];
  for (const [deps, token, status] of cases) {
    const r = await recovery(deps);
    const mtimes = [statSync(r.configFile).mtimeMs, statSync(r.secretsFile).mtimeMs];
    const before = { c: r.config(), s: r.secrets() };
    for (const path of ["/secrets/access-check", "/secrets/llm.openai.api_key"]) {
      const res = await r.send("PUT", path, { value: "sk-new" }, token);
      assert.equal(res.status, status, `${JSON.stringify(deps)} ${String(token)} ${path}`);
      const text = await res.text();
      const body = JSON.parse(text) as { ok: boolean; detail: string };
      assert.equal(body.ok, false);
      assert.doesNotMatch(text, /0123|sk-new/, "no secret in any answer");
      if (status === 403) { assert.match(body.detail, /CONTROL_TOKEN/); assert.match(body.detail, /CONTROL_ENABLED/); }
      if (status === 401) assert.equal(res.headers.get("www-authenticate"), "Bearer");
      if (status === 404) assert.equal(body.detail, "unknown secret");
    }
    assert.deepEqual({ c: r.config(), s: r.secrets() }, before);
    assert.deepEqual([statSync(r.configFile).mtimeMs, statSync(r.secretsFile).mtimeMs], mtimes);
  }
});

// @spec DASH-RCV-023
test("the fallback route writes the problem's own fallback, never a value from the request; another path is 400 and a stale etag 409", async () => {
  const r = await recovery();
  const s = await r.state();
  const before = r.config();
  const stale = await r.send("POST", "/recovery/fallback", { etag: "0".repeat(64), path: "cohost.name" });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { etag: string }).etag, s.etag);
  for (const path of ["llm.model", "cohost.timezone", "nope"]) {
    const res = await r.send("POST", "/recovery/fallback", { etag: s.etag, path });
    assert.equal(res.status, 400, path);
    assert.equal(((await res.json()) as { ok: boolean; issues: unknown[] }).issues.length > 0, true);
  }
  assert.equal(r.config(), before);
  const res = await r.send("POST", "/recovery/fallback", { etag: s.etag, path: "cohost.name", value: "Evil" });
  assert.equal(res.status, 200);
  assert.match(r.config(), /^ {2}name: "?Mika"?/m);
  assert.doesNotMatch(r.config(), /Evil/);
});
