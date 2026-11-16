import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBus, recordingLog } from "@cohost/testing";
import { PRESENTATION } from "@cohost/config";
import { changedSensitiveKeys, sameEffective } from "../src/sensitive.js";
import { createDashboardHandler } from "../src/routes.js";
import { guardFullSurface } from "../src/host.js";
import type { StackService, StackSnapshot } from "../src/stack.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const TOKEN = "tok-123";

type Mode = "control" | "token-only" | "no-token";

async function boot(mode: Mode) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-sensitive-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, EXAMPLE);
  const bus = new FakeBus();
  const rec = recordingLog();
  const writes: string[] = [];
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => file,
    configWrite: (f, text) => { writes.push(f); writeFileSync(f, text); },
    ...(mode !== "no-token" ? { controlToken: TOKEN } : {}),
    ...(mode === "control" ? { control: { token: TOKEN, runtime: "compose", advanced: false, controller: {} as never } } : {}),
  });
  const server = http.createServer(guardFullSurface(handler, { loopback: true, controlEnabled: mode === "control" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const put = (path: string, body: unknown, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const raw = (path: string, headers: Record<string, string>, body: string) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "PUT", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(body);
  });
  return { file, put, raw, writes, bus, text: () => readFileSync(file, "utf8"), etag: () => sha(readFileSync(file, "utf8")) };
}

const BASE = "llm.openai.base_url";
type Refusal = { ok: boolean; detail: string; sensitive: string[] };

// @spec DASH-CTRL-009
test("the presentation table marks the keys these tests rely on sensitive", () => {
  for (const k of [BASE, "vision.obs.host", "vision.obs.port"]) assert.equal(PRESENTATION.keys[k]?.sensitive, true, k);
  assert.equal(PRESENTATION.keys["llm.temperature"]?.sensitive, undefined);
});

// @spec DASH-CTRL-009, MOD-CFG-007
test("a save that changes a sensitive key needs the control token in both control modes: 401 with www-authenticate and {ok:false, detail, sensitive}, nothing written", async () => {
  for (const mode of ["control", "token-only"] as const) {
    const t = await boot(mode);
    const before = t.text();
    for (const token of [undefined, "wrong"]) {
      const r = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://evil.example/v1" } }, token);
      assert.equal(r.status, 401, `${mode} ${String(token)}`);
      assert.equal(r.headers.get("www-authenticate"), "Bearer");
      const j = (await r.json()) as Refusal;
      assert.equal(j.ok, false);
      assert.equal(typeof j.detail, "string");
      assert.deepEqual(j.sensitive, [BASE]);
    }
    assert.equal(t.text(), before);
    assert.deepEqual(t.writes, []);
    const ok = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://evil.example/v1" } }, TOKEN);
    assert.equal(ok.status, 200, mode);
    assert.match(t.text(), /base_url: "https:\/\/evil\.example\/v1"/);
  }
});

// @spec DASH-CTRL-010
test("with no control token configured a sensitive change is 403 {ok:false, detail, sensitive} naming CONTROL_TOKEN and CONTROL_ENABLED, nothing written", async () => {
  const t = await boot("no-token");
  const before = t.text();
  for (const token of [undefined, TOKEN]) {
    const r = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://evil.example/v1" } }, token);
    assert.equal(r.status, 403);
    const j = (await r.json()) as Refusal;
    assert.equal(j.ok, false);
    assert.match(j.detail, /CONTROL_TOKEN/);
    assert.match(j.detail, /CONTROL_ENABLED/);
    assert.deepEqual(j.sensitive, [BASE]);
  }
  assert.equal(t.text(), before);
  assert.deepEqual(t.writes, []);
});

// @spec DASH-CTRL-009
test("only keys whose value differs are named: an unchanged sensitive key resubmitted with the rest of the section does not demand the token", async () => {
  const t = await boot("no-token");
  // the file's value, as a string; the file's number, as a number and as text; a key left to its default
  const r = await t.put("/config/vision", { etag: t.etag(), values: { "obs.host": "host.docker.internal", "obs.port": 4455, temperature: 0.3 } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(t.text(), /temperature: 0\.3/);
  // a port sent as text is not the number the file holds and the editor does not coerce it (it would answer 400), so it is a
  // change by type: the token is asked for, and nothing is written
  const before = t.text();
  const again = await t.put("/config/vision", { etag: t.etag(), values: { "obs.port": "4455", "obs.host": "host.docker.internal", width: 640 } });
  assert.equal(again.status, 403, "no token is configured in this mode");
  assert.equal(t.text(), before);
  const noPort = await t.put("/config/vision", { etag: t.etag(), values: { "obs.host": "host.docker.internal", width: 640 } });
  assert.ok(noPort.status !== 401 && noPort.status !== 403, `unchanged sensitive keys alone do not ask for the token: ${noPort.status}`);
  const dflt = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://api.openai.com/v1", temperature: 0.5 } });
  assert.equal(dflt.status, 200);
});

// @spec DASH-CTRL-009
test("a sensitive key left at its schema default, resubmitted at that default, is unchanged; a different value is changed", async () => {
  const t = await boot("token-only");
  // remove the key from the file so it is only a default
  writeFileSync(t.file, t.text().replace(/^\s*base_url: .*$/m, ""));
  const same = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://api.openai.com/v1", temperature: 0.4 } });
  assert.equal(same.status, 200, await same.clone().text());
  const diff = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "http://other/v1" } });
  assert.equal(diff.status, 401);
});

// @spec DASH-CTRL-009
test("the list names exactly the changed sensitive keys, among unchanged ones and non-sensitive edits", async () => {
  const t = await boot("token-only");
  const r = await t.put("/config/vision", { etag: t.etag(), values: { "obs.host": "10.0.0.9", "obs.port": 4455, "obs.source": "Other", width: 640 } });
  assert.equal(r.status, 401);
  assert.deepEqual(((await r.json()) as Refusal).sensitive, ["vision.obs.host"]);
  const two = await t.put("/config/vision", { etag: t.etag(), values: { "obs.host": "10.0.0.9", "obs.port": 4456 } });
  assert.deepEqual(((await two.json()) as Refusal).sensitive.sort(), ["vision.obs.host", "vision.obs.port"]);
  assert.equal(t.text(), EXAMPLE);
});

// @spec DASH-CTRL-009, DASH-CTRL-004
test("a save that touches no sensitive key keeps today's gating: open with control off, token-gated with it on", async () => {
  const open = await boot("no-token");
  assert.equal((await open.put("/config/llm", { etag: open.etag(), values: { temperature: 0.5 } })).status, 200);
  const tokenOnly = await boot("token-only");
  assert.equal((await tokenOnly.put("/config/llm", { etag: tokenOnly.etag(), values: { temperature: 0.5 } })).status, 200, "a configured token does not gate a non-sensitive save while control is off");
  const ctl = await boot("control");
  assert.equal((await ctl.put("/config/llm", { etag: ctl.etag(), values: { temperature: 0.5 } })).status, 401);
  assert.equal((await ctl.put("/config/llm", { etag: ctl.etag(), values: { temperature: 0.5 } }, TOKEN)).status, 200);
});

// @spec DASH-CTRL-009, MOD-CFG-013
test("a dry run writes nothing and is never gated by the sensitive rule; in control mode it keeps its ordinary gating", async () => {
  for (const mode of ["no-token", "token-only"] as const) {
    const t = await boot(mode);
    const r = await t.put("/config/llm?dryRun=1", { etag: t.etag(), values: { "openai.base_url": "https://evil.example/v1" } });
    assert.equal(r.status, 200, mode);
    assert.equal(((await r.json()) as { dryRun: boolean }).dryRun, true);
    assert.equal(t.text(), EXAMPLE);
    assert.deepEqual(t.writes, []);
  }
  const ctl = await boot("control");
  assert.equal((await ctl.put("/config/llm?dryRun=1", { etag: ctl.etag(), values: { "openai.base_url": "http://x/v1" } })).status, 401);
  assert.equal((await ctl.put("/config/llm?dryRun=1", { etag: ctl.etag(), values: { "openai.base_url": "http://x/v1" } }, TOKEN)).status, 200);
  assert.deepEqual(ctl.writes, []);
});

// @spec DASH-CTRL-009
test("the check runs after the body's size and shape and before the etag and any validation", async () => {
  const t = await boot("token-only");
  assert.equal((await t.put("/config/llm", "not json")).status, 400);
  assert.equal((await t.put("/config/llm", { values: { "openai.base_url": "http://x/v1" } })).status, 400, "no etag: shape first");
  assert.equal((await t.put("/config/llm", { etag: "x", values: [] })).status, 400);
  assert.equal((await t.put("/config/llm", JSON.stringify({ etag: "x", values: { "openai.base_url": "y".repeat(70 * 1024) } }))).status, 413, "size first");
  const stale = await t.put("/config/llm", { etag: "stale", values: { "openai.base_url": "http://x/v1" } });
  assert.equal(stale.status, 401, "a stale etag does not outrank the token check");
  const invalid = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": 12, temperature: "hot" } });
  assert.equal(invalid.status, 401, "validation does not outrank the token check");
  // with the token, the ordinary answers return
  assert.equal((await t.put("/config/llm", { etag: "stale", values: { "openai.base_url": "http://x/v1" } }, TOKEN)).status, 409);
  assert.equal((await t.put("/config/llm", { etag: t.etag(), values: { temperature: "hot" } }, TOKEN)).status, 400);
});

// @spec DASH-CTRL-009, DASH-HOST-005
test("the Host and Origin checks answer first: a foreign Origin is 403 even with the token", async () => {
  const t = await boot("token-only");
  const body = JSON.stringify({ etag: t.etag(), values: { "openai.base_url": "http://x/v1" } });
  assert.equal(await t.raw("/config/llm", { host: "127.0.0.1", origin: "http://evil.example", authorization: `Bearer ${TOKEN}` }, body), 403);
  assert.equal(t.text(), EXAMPLE);
});

// @spec DASH-CTRL-009
test("a key unknown to the section is not a sensitive change and gets the ordinary refusal", async () => {
  const t = await boot("no-token");
  const r = await t.put("/config/llm", { etag: t.etag(), values: { "no.such.key": "x" } });
  assert.equal(r.status, 400);
});

// @spec DASH-CTRL-009
test("the token is compared as a bearer and the refusal never echoes the submitted value", async () => {
  const t = await boot("token-only");
  const r = await t.put("/config/llm", { etag: t.etag(), values: { "openai.base_url": "https://SUBMITTED-VALUE.example/v1" } }, "wrong");
  assert.ok(!(await r.text()).includes("SUBMITTED-VALUE"));
});

// @spec DASH-CTRL-009
test("sameEffective compares by type and value: the strings \"undefined\" and \"null\" are not undefined and null, a numeric string is not its number, and structures compare deeply", () => {
  assert.equal(sameEffective(undefined, "undefined"), false);
  assert.equal(sameEffective(null, "null"), false);
  assert.equal(sameEffective(undefined, undefined), true);
  assert.equal(sameEffective(4455, "4455"), false);
  assert.equal(sameEffective(4455, 4455), true);
  assert.equal(sameEffective("", 0), false);
  assert.equal(sameEffective(false, "false"), false);
  assert.equal(sameEffective(["a", "b"], ["a", "b"]), true);
  assert.equal(sameEffective(["a", "b"], ["b", "a"]), false);
  assert.equal(sameEffective({ a: 1, b: [1] }, { b: [1], a: 1 }), true);
  assert.equal(sameEffective({ a: 1 }, { a: "1" }), false);
});

// @spec DASH-CTRL-009, MOD-CFG-007
test("changedSensitiveKeys decides unchanged from what the write would store: the same number or string is unchanged, a numeric string for a numeric key and any other differing value are changes", () => {
  const key = "vision.obs.port";
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.port": 4455 }), [], "the number already in the file");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.port": 4456 }), [key]);
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.port": "4455" }), [key], "a string is not the number the file holds, and the editor does not coerce it");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.port": "undefined" }), [key]);
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.port": "null" }), [key]);
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.host": "host.docker.internal" }), []);
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.host": "" }), [], "an empty host reads back as the default the file already holds, so the write changes nothing");
  for (const odd of ["undefined", "null", "NaN", "false", "0"]) assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.host": odd }), ["vision.obs.host"], `host ${JSON.stringify(odd)}`);
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.host": ["host.docker.internal"] }), ["vision.obs.host"], "an array is not the string");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "vision", { "obs.host": { a: 1 } }), ["vision.obs.host"], "an object is not the string");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "mouth", { "outputs.http.url": "" }), [], "the empty string the file holds");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "mouth", { "outputs.http.url": null }), ["mouth.outputs.http.url"], "null is a change against a key that holds a value, the empty string included");
  assert.deepEqual(changedSensitiveKeys(EXAMPLE, "mouth", { "outputs.http.url": 0 }), ["mouth.outputs.http.url"]);
});
