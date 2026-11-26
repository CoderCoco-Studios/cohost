import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, etagOf } from "@cohost/config";
import { createRecoveryHandler, recoveryAddress, startDashboard, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { createDashboardHandler } from "../src/routes.js";
import { StackService } from "../src/stack.js";
import { EXAMPLE } from "./config-fixture.js";

/** The example with `name` and the VTube Studio port as placeholders and a credential written as one. */
const STALE = EXAMPLE
  .replace(/^ {2}name: "Coco"/m, '  name: "${COHOST_NAME:-Mika}"')
  .replace(/^ {2}model: "qwen2\.5:7b-instruct-q4_K_M"/m, '  model: "${LLM_MODEL}"')
  .replace(/^ {2}claude: .*\n/m, (line) => `${line}    api_key: "\${LLM_API_KEY}"   # pasted from the old .env\n`);

interface Rig { url: string; dir: string; configFile: string; secretsFile: string; logs: string[]; valid: () => number; close: () => Promise<void> }

async function rig(text: string, o: Partial<RecoveryHandlerDeps> & { secrets?: string } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "cohost-rcv-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, text);
  if (o.secrets !== undefined) writeFileSync(secretsFile, o.secrets, { mode: 0o600 });
  const logs: string[] = [];
  let valid = 0;
  const log = { info: (...a: unknown[]) => { logs.push(`info ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`); }, error: (...a: unknown[]) => { logs.push(`error ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`); } } as never;
  const handler = createRecoveryHandler({ log, files: { configFile, secretsFile }, controlEnabled: false, uiDir: join(dir, "no-ui"), onValid: () => { valid++; }, ...o });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, dir, configFile, secretsFile, logs, valid: () => valid, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

type State = { active: boolean; etag: string; problems: RecoveryProblem[]; file: string };
const state = async (r: Rig): Promise<State> => (await (await fetch(`${r.url}/recovery`)).json()) as State;
const post = (r: Rig, op: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.url}/recovery/${op}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// @spec DASH-RCV-004, DASH-RCV-008
test("GET /recovery lists every failing key with its kind and the actions it allows, and writes nothing", async () => {
  const r = await rig(STALE);
  try {
    const before = statSync(r.configFile).mtimeMs;
    const s = await state(r);
    assert.equal(s.active, true);
    assert.equal(s.etag, etagOf(STALE));
    const by = (path: string) => s.problems.find((p) => p.path === path)!;
    assert.deepEqual(s.problems.map((p) => p.path).toSorted(), ["cohost.name", "llm.claude.api_key", "llm.model"]);
    assert.ok(s.problems.every((p) => p.kind === "placeholder" && p.file === "config"));
    assert.deepEqual(by("cohost.name").actions, { set: true, reset: true, fallback: true });
    assert.equal(by("cohost.name").fallback, "Mika");
    assert.deepEqual(by("llm.model").actions, { set: true, reset: true, fallback: false });
    const secret = by("llm.claude.api_key");
    assert.equal(secret.secret, true);
    assert.deepEqual(secret.actions, { set: false, reset: true, fallback: false });
    assert.ok(secret.section && secret.section.path.startsWith("llm") && secret.section.title.length > 0, JSON.stringify(secret.section));
    assert.equal(by("llm.model").sensitive, false);
    assert.equal(statSync(r.configFile).mtimeMs, before);
    assert.equal(readFileSync(r.configFile, "utf8"), STALE);
  } finally { await r.close(); }
});

// @spec DASH-RCV-004
test("a syntax error has no action, a secrets.yaml value is quoted or cleared, a list entry is set alone or resets the list", async () => {
  const r = await rig("cohost: [x\n");
  try {
    const s = await state(r);
    assert.deepEqual(s.problems.map((p) => [p.kind, p.path, p.actions]), [["syntax", "", { set: false, reset: false, fallback: false }]]);
  } finally { await r.close(); }
  const sec = await rig(EXAMPLE, { secrets: "llm:\n  openai:\n    api_key: 12345\n" });
  try {
    const s = await state(sec);
    assert.deepEqual(s.problems.map((p) => [p.file, p.kind, p.path, p.actions.reset, p.repair]), [["secrets", "secrets", "llm.openai.api_key", true, "quote"]]);
  } finally { await sec.close(); }
  const list = await rig(EXAMPLE.replace(/^ {2}ignore_users: .*$/m, '  ignore_users: [nightbot, "${BOT}", "${OTHER:-moobot}"]'));
  try {
    const s = await state(list);
    const p = s.problems.find((x) => x.path === "chat.ignore_users[1]")!;
    assert.ok(p, JSON.stringify(s.problems));
    assert.equal(p.resetPath, "chat.ignore_users");
    assert.deepEqual(p.actions, { set: true, reset: true, fallback: false });
    const q = s.problems.find((x) => x.path === "chat.ignore_users[2]")!;
    assert.deepEqual([q.actions, q.fallback], [{ set: true, reset: true, fallback: true }, "moobot"]);
  } finally { await list.close(); }
  const one = await rig(EXAMPLE.replace(/^ {2}ignore_users: .*$/m, '  ignore_users: [nightbot, "${OTHER:-moobot}"]   # bots'));
  try {
    const all = await post(one, "reset-all", { etag: (await state(one)).etag });
    assert.equal(((await all.json()) as { valid: boolean }).valid, true);
    assert.match(readFileSync(one.configFile, "utf8"), /^ {2}ignore_users: \[nightbot, "moobot"\] {3}# bots$/m, "the fallback goes into its entry; the list stays");
  } finally { await one.close(); }
});

// @spec DASH-RCV-005, DASH-RCV-009, DASH-RCV-012, DASH-RCV-015
test("set writes one key keeping the rest of the file, reads typed text as YAML when the key accepts it, and re-validates", async () => {
  const r = await rig(STALE);
  try {
    let s = await state(r);
    const res = await post(r, "set", { etag: s.etag, path: "llm.model", value: "qwen2.5:7b" });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; etag: string; problems: RecoveryProblem[]; valid: boolean };
    const text = readFileSync(r.configFile, "utf8");
    assert.equal(text, STALE.replace('"${LLM_MODEL}"', '"qwen2.5:7b"'));
    assert.equal(body.etag, etagOf(text));
    assert.equal(body.valid, false);
    assert.deepEqual(body.problems.map((p) => p.path).toSorted(), ["cohost.name", "llm.claude.api_key"]);
    assert.ok(r.logs.includes("info config recovery: set llm.model"), r.logs.join("\n"));
    assert.ok(r.logs.includes("info config recovery: 2 problems remain"), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("qwen2.5:7b")), "no value is logged");

    s = await state(r);
    const port = await post(r, "set", { etag: s.etag, path: "dashboard.port", value: "3100" });
    assert.equal(port.status, 200);
    assert.match(readFileSync(r.configFile, "utf8"), /^ {2}port: 3100 /m);

    s = await state(r);
    const before = readFileSync(r.configFile, "utf8");
    const bad = await post(r, "set", { etag: s.etag, path: "dashboard.port", value: "not a port" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { issues: unknown[] }).issues.length > 0, true);
    const stale = await post(r, "set", { etag: "old", path: "llm.model", value: "x" });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { etag: string }).etag, s.etag);
    const secret = await post(r, "set", { etag: s.etag, path: "llm.claude.api_key", value: "sk-1" });
    assert.equal(secret.status, 400);
    assert.match(JSON.stringify(await secret.json()), /secrets\.yaml/);
    assert.equal(readFileSync(r.configFile, "utf8"), before, "a refused write changes nothing");
  } finally { await r.close(); }
});

// @spec DASH-RCV-006, DASH-RCV-008, DASH-RCV-009, DASH-RCV-011, DASH-RCV-015
test("reset removes the key (a credential leaves config.yaml), clears a secrets path, and the last fix answers valid and leaves", async () => {
  const r = await rig(STALE.replace('"${LLM_MODEL}"', '"m"').replace('"${COHOST_NAME:-Mika}"', '"Coco"'));
  try {
    const s = await state(r);
    assert.deepEqual(s.problems.map((p) => p.path), ["llm.claude.api_key"]);
    const res = await post(r, "reset", { etag: s.etag, path: "llm.claude.api_key" });
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; problems: unknown[]; port?: number };
    assert.equal(body.valid, true);
    assert.deepEqual(body.problems, []);
    assert.equal((body as { moved?: boolean }).moved, undefined, "no bound port given: nothing moves");
    const text = readFileSync(r.configFile, "utf8");
    assert.doesNotMatch(text, /LLM_API_KEY|pasted from the old/);
    assert.match(text, /^ {2}claude: .*\n {4}effort: low/m, "the rest of the mapping stays");
    assert.deepEqual(checkConfig({ configFile: r.configFile, secretsFile: r.secretsFile }), []);
    await new Promise((d) => setTimeout(d, 20));
    assert.equal(r.valid(), 1, "recovery mode is left once the answer is sent");
    assert.ok(r.logs.includes("info config recovery: reset llm.claude.api_key"));
    assert.ok(r.logs.some((l) => /leaving config recovery mode/.test(l)));
  } finally { await r.close(); }

  const sec = await rig(EXAMPLE, { controlToken: "tok", secrets: "# mine\nllm:\n  openai:\n    api_key: [a]\nvoice:\n  openai:\n    api_key: \"keep\"\n" });
  try {
    const s = await state(sec);
    assert.equal(s.problems[0]!.repair, "clear");
    const locked = await post(sec, "reset", { etag: s.etag, path: "llm.openai.api_key" });
    assert.equal(locked.status, 401, "a secrets.yaml change needs the token with control off");
    assert.match(readFileSync(sec.secretsFile, "utf8"), /\[a\]/);
    const res = await post(sec, "reset", { etag: s.etag, path: "llm.openai.api_key" }, { authorization: "Bearer tok" });
    assert.equal(res.status, 200);
    const secrets = readFileSync(sec.secretsFile, "utf8");
    assert.match(secrets, /# mine/);
    assert.match(secrets, /api_key: "keep"/);
    assert.doesNotMatch(secrets, /\[a\]/);
    const nothing = await post(sec, "reset", { etag: etagOf(EXAMPLE), path: "cohost.name" });
    assert.ok(nothing.status === 400 || nothing.status === 200);
  } finally { await sec.close(); }
});

// @spec DASH-RCV-007, DASH-RCV-009, DASH-RCV-015
test("reset-all uses fallbacks, resets the rest in rounds, writes once, and reports what still needs a value", async () => {
  const r = await rig(STALE);
  try {
    const s = await state(r);
    const res = await post(r, "reset-all", { etag: s.etag });
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; problems: RecoveryProblem[] };
    const text = readFileSync(r.configFile, "utf8");
    assert.match(text, /^ {2}name: "Mika"/m, "the fallback is written");
    assert.doesNotMatch(text, /LLM_API_KEY/);
    assert.equal(body.valid, false, "llm.model has no fallback and no default");
    assert.deepEqual(body.problems.map((p) => p.path), ["llm.model"]);
    assert.deepEqual(body.problems[0]!.actions, { set: true, reset: false, fallback: false });
    assert.ok(r.logs.some((l) => /^info config recovery: reset all \(\d+ keys\)$/.test(l)), r.logs.join("\n"));
    const fixed = await post(r, "set", { etag: etagOf(text), path: "llm.model", value: "qwen2.5:7b" });
    assert.equal(((await fixed.json()) as { valid: boolean }).valid, true);
  } finally { await r.close(); }
});

// @spec DASH-RCV-003
test("with control enabled every recovery write needs the token; with it off a typed sensitive key needs it, a reset does not", async () => {
  const on = await rig(STALE, { controlEnabled: true, controlToken: "tok" });
  try {
    const s = await state(on);
    assert.equal((await post(on, "reset-all", { etag: s.etag })).status, 401);
    assert.equal(readFileSync(on.configFile, "utf8"), STALE);
    assert.equal((await post(on, "reset-all", { etag: s.etag }, { authorization: "Bearer tok" })).status, 200);
  } finally { await on.close(); }

  const text = STALE.replace(/^ {2}provider: "ollama"/m, '  provider: "${LLM_PROVIDER:-ollama}"');
  const off = await rig(text);
  try {
    const s = await state(off);
    const none = await post(off, "set", { etag: s.etag, path: "llm.provider", value: "anthropic" });
    assert.equal(none.status, 403);
    assert.deepEqual(((await none.json()) as { sensitive: string[] }).sensitive, ["llm.provider"]);
    const reset = await post(off, "reset", { etag: s.etag, path: "llm.provider" });
    assert.equal(reset.status, 200, "a reset is not a sensitive change");
  } finally { await off.close(); }

  const tokenOff = await rig(text, { controlToken: "tok" });
  try {
    const s = await state(tokenOff);
    assert.equal((await post(tokenOff, "set", { etag: s.etag, path: "llm.provider", value: "anthropic" })).status, 401);
    assert.equal((await post(tokenOff, "set", { etag: s.etag, path: "llm.provider", value: "anthropic" }, { authorization: "Bearer tok" })).status, 200);
  } finally { await tokenOff.close(); }
});

// @spec DASH-RCV-010
test("stack posts other than stop and every lifecycle post are refused with the config gate's text (404 with control off), other routes 503, health and the UI served", async () => {
  const on = await rig(STALE, { controlEnabled: true, controlToken: "tok" });
  try {
    for (const path of ["/stack/launch", "/stack/rebuild", "/stack/restart", "/services/voice/start", "/services/voice/stop", "/services/voice/restart"]) {
      const res = await fetch(`${on.url}${path}`, { method: "POST", headers: { authorization: "Bearer tok" } });
      assert.equal(res.status, 409, path);
      assert.match(((await res.json()) as { detail: string }).detail, /^the config is invalid \(3 problems; first: .*recovery screen/);
    }
    assert.equal((await fetch(`${on.url}/health`)).status, 200);
    assert.deepEqual(await (await fetch(`${on.url}/services/control`)).json(), { enabled: true, runtime: "compose", advanced: false });
    const other = await fetch(`${on.url}/stack`);
    assert.equal(other.status, 503);
    assert.match(((await other.json()) as { detail: string }).detail, /config recovery mode/);
    assert.equal((await fetch(`${on.url}/`)).status, 503, "the UI route answers (its not-built page here)");
  } finally { await on.close(); }
  const off = await rig(STALE);
  try {
    assert.equal((await fetch(`${off.url}/stack/launch`, { method: "POST" })).status, 404);
  } finally { await off.close(); }
});

// @spec DASH-RCV-011
test("GET /recovery on a file fixed by hand answers inactive and leaves recovery mode", async () => {
  const r = await rig(STALE);
  try {
    writeFileSync(r.configFile, EXAMPLE);
    assert.deepEqual(await (await fetch(`${r.url}/recovery`)).json(), { active: false });
    await new Promise((d) => setTimeout(d, 20));
    assert.equal(r.valid(), 1);
  } finally { await r.close(); }
});

// @spec DASH-RCV-002
test("the recovery port comes from the dashboard section when it validates alone, else the default", () => {
  assert.equal(recoveryAddress(EXAMPLE.replace(/^ {2}port: 3000/m, "  port: 3400")).port, 3400);
  assert.equal(recoveryAddress(STALE.replace(/^ {2}port: 3000/m, "  port: 3400")).port, 3400, "other sections failing do not matter");
  assert.equal(recoveryAddress(EXAMPLE.replace(/^ {2}port: 3000/m, "  port: ${DASHBOARD_PORT:-3400}")).port, 3000);
  assert.equal(recoveryAddress(EXAMPLE.replace(/^ {2}port: 3000/m, "  port: 3001")).port, 3000, "port equal to lan_port fails the section");
  assert.equal(recoveryAddress("dashboard: [x\n").port, 3000);
  assert.deepEqual(recoveryAddress(EXAMPLE.replace("allowed_hosts: []", "allowed_hosts: [cohost.lan]")).allowedHosts, ["cohost.lan"]);
});

// @spec DASH-RCV-004, DASH-RCV-010
test("in normal mode GET /recovery is inactive and a recovery write is a 409", async () => {
  const log = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} } as never;
  const handler = createDashboardHandler({
    bus: { publish: async () => "1", putUpload: async () => "u" } as never, log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "", savePersonality: () => {}, services: () => [], stack: new StackService({ log, bus: () => "connected" }), uiDir: "/nonexistent", docsDir: "/nonexistent",
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${url}/recovery`)).json(), { active: false });
    assert.equal((await fetch(`${url}/recovery/reset-all`, { method: "POST", body: "{}" })).status, 409);
    assert.equal((await fetch(`${url}/recovery/raw`, { method: "POST", body: "{}" })).status, 409);
    const raw = await fetch(`${url}/recovery/raw?file=secrets`);
    assert.equal(raw.status, 409);
    assert.match(((await raw.json()) as { detail: string }).detail, /not in config recovery mode/);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
});

// @spec DASH-HTTP-016
test("startDashboard hands a valid configuration to run, and leaves a load failure that is not about the files to the bootstrap", async () => {
  const log = { info() {}, error() {}, fatal() {} } as never;
  const seen: unknown[] = [];
  await startDashboard({ log, run: async (cfg) => { seen.push(cfg); } });
  assert.equal(typeof seen[0], "object");
  const prev = process.env.COHOST_ISOLATION;
  process.env.COHOST_ISOLATION = "not json";
  try { await startDashboard({ log, run: async (cfg) => { seen.push(cfg); } }); } finally {
    if (prev === undefined) delete process.env.COHOST_ISOLATION; else process.env.COHOST_ISOLATION = prev;
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[1], undefined);
});

// @spec DASH-RCV-003, DASH-RCV-006, DASH-RCV-007
test("a secrets.yaml repair needs the control token in both modes; reset-all fixes config.yaml without it and names the secrets left", async () => {
  const none = await rig(STALE, { secrets: "llm:\n  openai:\n    api_key: 0123\n" });
  try {
    const s = await state(none);
    const reset = await post(none, "reset", { etag: s.etag, path: "llm.openai.api_key" });
    assert.equal(reset.status, 403);
    assert.match(((await reset.json()) as { detail: string }).detail, /CONTROL_TOKEN/);
    const all = await post(none, "reset-all", { etag: s.etag });
    assert.equal(all.status, 200);
    const body = await all.json() as { valid: boolean; problems: RecoveryProblem[]; tokenNeeded?: string[] };
    assert.deepEqual(body.tokenNeeded, ["llm.openai.api_key"]);
    assert.ok(body.problems.every((p) => p.file === "secrets" || p.path === "llm.model"), JSON.stringify(body.problems.map((p) => p.path)));
    assert.match(readFileSync(none.secretsFile, "utf8"), /api_key: 0123/, "secrets.yaml untouched");
    assert.doesNotMatch(readFileSync(none.configFile, "utf8"), /COHOST_NAME/, "config.yaml repaired");
  } finally { await none.close(); }

  const tok = await rig(EXAMPLE, { controlToken: "tok", secrets: "llm:\n  openai:\n    api_key: 0123\n" });
  try {
    const s = await state(tok);
    const all = await post(tok, "reset-all", { etag: s.etag }, { authorization: "Bearer tok" });
    assert.equal(((await all.json()) as { valid: boolean }).valid, true);
    assert.match(readFileSync(tok.secretsFile, "utf8"), /api_key: "0123"/, "an all-digit token is quoted, never cleared");
  } finally { await tok.close(); }
});

// @spec DASH-RCV-004, DASH-RCV-005
test("paths that name an object's own properties are refused as unknown keys, never a 500", async () => {
  const r = await rig(STALE);
  try {
    const s = await state(r);
    for (const path of ["__proto__", "constructor", "llm.toString", "llm.__proto__"]) {
      const set = await post(r, "set", { etag: s.etag, path, value: "x" });
      assert.equal(set.status, 400, path);
      const reset = await post(r, "reset", { etag: s.etag, path });
      assert.equal(reset.status, 400, path);
    }
    assert.equal(readFileSync(r.configFile, "utf8"), STALE);
  } finally { await r.close(); }
});

// @spec DASH-RCV-011
test("recovery mode is left once when the client of the answer that found the files valid goes away before the answer finishes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-rcv-"));
  writeFileSync(join(dir, "config.yaml"), EXAMPLE);
  let valid = 0;
  const handler = createRecoveryHandler({ log: { info() {}, error() {} } as never, files: { configFile: join(dir, "config.yaml"), secretsFile: join(dir, "s.yaml") }, controlEnabled: false, uiDir: join(dir, "ui"), onValid: () => { valid++; } });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/recovery", headers: {} });
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead() { return this; }, end() { return this; } });
  handler(req as never, res as never);
  return new Promise<void>((done) => setImmediate(() => {
    assert.equal(valid, 0);
    res.emit("close");
    res.emit("finish");
    assert.equal(valid, 1);
    done();
  }));
});

// @spec DASH-RCV-003
test("an entry of a sensitive list is as sensitive as the list: setting it needs the control token in both modes", async () => {
  const text = EXAMPLE
    .replace("allowed_hosts: []", 'allowed_hosts: ["${HOST}"]')
    .replace(/^ {2}lan: \[\]/m, '  lan: ["${LAN}"]');
  for (const path of ["dashboard.allowed_hosts[0]", "network.lan[0]"]) {
    const key = path.replace("[0]", "");
    const none = await rig(text);
    try {
      const s = await state(none);
      assert.ok(s.problems.some((p) => p.path === path && p.sensitive), JSON.stringify(s.problems));
      const res = await post(none, "set", { etag: s.etag, path, value: "streampc" });
      assert.equal(res.status, 403, path);
      assert.deepEqual(((await res.json()) as { sensitive: string[] }).sensitive, [key]);
      assert.equal(readFileSync(none.configFile, "utf8"), text);
    } finally { await none.close(); }
    const tok = await rig(text, { controlToken: "tok" });
    try {
      const s = await state(tok);
      const res = await post(tok, "set", { etag: s.etag, path, value: "streampc" });
      assert.equal(res.status, 401, path);
      assert.equal(readFileSync(tok.configFile, "utf8"), text);
      assert.equal((await post(tok, "set", { etag: s.etag, path, value: "streampc" }, { authorization: "Bearer tok" })).status, 200, path);
    } finally { await tok.close(); }
  }
});

// @spec DASH-RCV-009, DASH-RCV-011
test("the valid answer says moved, with the port, only when dashboard.port is not the bound recovery port", async () => {
  const same = await rig(STALE.replace('"${LLM_MODEL}"', '"m"').replace('"${COHOST_NAME:-Mika}"', '"Coco"'), { boundPort: 3000 });
  try {
    const s = await state(same);
    const body = await (await post(same, "reset", { etag: s.etag, path: "llm.claude.api_key" })).json() as Record<string, unknown>;
    assert.equal(body.valid, true);
    assert.equal(body.moved, undefined);
    assert.equal(body.port, undefined);
  } finally { await same.close(); }
  const moved = await rig(STALE.replace('"${LLM_MODEL}"', '"m"').replace('"${COHOST_NAME:-Mika}"', '"Coco"'), { boundPort: 3000 });
  try {
    let s = await state(moved);
    await post(moved, "set", { etag: s.etag, path: "dashboard.port", value: "3100" });
    s = await state(moved);
    const body = await (await post(moved, "reset", { etag: s.etag, path: "llm.claude.api_key" })).json() as Record<string, unknown>;
    assert.equal(body.valid, true);
    assert.equal(body.moved, true);
    assert.equal(body.port, 3100);
  } finally { await moved.close(); }
});
