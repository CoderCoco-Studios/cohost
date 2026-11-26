import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etagOf } from "@cohost/config";
import { LifecycleLock, StackController, type ExecFile } from "@cohost/control";
import { createRecoveryHandler, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { EXAMPLE } from "./config-fixture.js";

/** The example with an unclosed flow sequence on its `cohost.name` line: not YAML. */
const BROKEN = EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: [Coco');
/** A secrets file that does not parse, holding a credential that must never leave without the token. */
const BROKEN_SECRETS = "llm:\n  openai:\n    api_key: \"sk-live-123\n  other: [\n";
const SECRET = "sk-live-123";

interface Rig { url: string; dir: string; configFile: string; secretsFile: string; logs: string[]; valid: () => number; close: () => Promise<void> }

async function rig(text: string, o: Partial<RecoveryHandlerDeps> & { secrets?: string } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "cohost-rcv-raw-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, text);
  if (o.secrets !== undefined) writeFileSync(secretsFile, o.secrets, { mode: 0o600 });
  const logs: string[] = [];
  let valid = 0;
  const line = (level: string) => (...a: unknown[]) => { logs.push(`${level} ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`); };
  const log = { info: line("info"), error: line("error") } as never;
  const handler = createRecoveryHandler({ log, files: { configFile, secretsFile }, controlEnabled: false, uiDir: join(dir, "no-ui"), onValid: () => { valid++; }, ...o });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, dir, configFile, secretsFile, logs, valid: () => valid, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

type Raw = { ok: boolean; file: string; path: string; text: string; etag: string; message: string; line?: number; col?: number; detail?: string };
type Written = { ok: boolean; etag: string; problems: RecoveryProblem[]; valid: boolean; detail?: string };
const problems = async (r: Rig): Promise<RecoveryProblem[]> => ((await (await fetch(`${r.url}/recovery`)).json()) as { problems: RecoveryProblem[] }).problems;
const getRaw = (r: Rig, file: string, headers: Record<string, string> = {}) => fetch(`${r.url}/recovery/raw?file=${file}`, { headers });
const putRaw = (r: Rig, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.url}/recovery/raw`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const auth = { authorization: "Bearer tok" };

// @spec DASH-RCV-004
test("raw is offered only on a YAML syntax error of config.yaml or secrets.yaml", async () => {
  const cfg = await rig(BROKEN);
  try {
    const p = await problems(cfg);
    assert.deepEqual(p.map((x) => [x.file, x.kind, x.path, x.raw]), [["config", "syntax", "", true]]);
  } finally { await cfg.close(); }
  const sec = await rig(EXAMPLE, { secrets: BROKEN_SECRETS });
  try {
    const p = await problems(sec);
    assert.deepEqual(p.map((x) => [x.file, x.path, x.raw]), [["secrets", "", true]]);
    assert.ok(!JSON.stringify(p).includes(SECRET), "no secrets text in the list");
  } finally { await sec.close(); }
  const other = await rig(EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: "${NAME}"'), { secrets: "- a list\n" });
  try {
    const p = await problems(other);
    assert.ok(p.length >= 2, JSON.stringify(p));
    assert.ok(p.every((x) => x.raw === undefined), "a placeholder and a secrets root that is no mapping offer no raw editor");
  } finally { await other.close(); }
});

// @spec DASH-RCV-016, DASH-RCV-018
test("GET /recovery/raw gives config.yaml's text, etag and the parser's position, and refuses a file without a syntax error", async () => {
  const r = await rig(BROKEN);
  try {
    const res = await getRaw(r, "config");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json() as Raw;
    assert.equal(body.text, BROKEN);
    assert.equal(body.etag, etagOf(BROKEN));
    assert.equal(body.path, r.configFile);
    assert.match(body.message, /^not valid YAML at line \d+, column \d+/);
    assert.ok(typeof body.line === "number" && typeof body.col === "number");
    assert.match(body.message, new RegExp(`line ${body.line}, column ${body.col}`));
    assert.equal((await getRaw(r, "other")).status, 400);
    const noSyntax = await getRaw(r, "secrets", auth);
    assert.equal(noSyntax.status, 403, "no token configured: the secrets text is refused before anything else");
  } finally { await r.close(); }
  const ok = await rig(EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: "${NAME}"'));
  try {
    const res = await getRaw(ok, "config");
    assert.equal(res.status, 409);
    const body = await res.json() as Raw;
    assert.equal(body.text, undefined, "no text for a file the rows fix");
  } finally { await ok.close(); }
});

// @spec DASH-RCV-018
test("secrets.yaml text is read only with the control token, in both control modes, and never appears in a refusal", async () => {
  for (const controlEnabled of [false, true]) {
    const none = await rig(EXAMPLE, { secrets: BROKEN_SECRETS, controlEnabled: false });
    try {
      const res = await getRaw(none, "secrets", auth);
      assert.equal(res.status, 403);
      const text = await res.text();
      assert.match(text, /CONTROL_TOKEN/);
      assert.ok(!text.includes(SECRET));
    } finally { await none.close(); }
    const r = await rig(EXAMPLE, { secrets: BROKEN_SECRETS, controlEnabled, controlToken: "tok" });
    try {
      for (const headers of [{}, { authorization: "Bearer nope" }]) {
        const res = await getRaw(r, "secrets", headers);
        assert.equal(res.status, 401, `control ${controlEnabled}`);
        assert.equal(res.headers.get("www-authenticate"), "Bearer");
        assert.ok(!(await res.text()).includes(SECRET));
      }
      const res = await getRaw(r, "secrets", auth);
      assert.equal(res.status, 200);
      const body = await res.json() as Raw;
      assert.equal(body.text, BROKEN_SECRETS);
      assert.equal(body.etag, etagOf(BROKEN_SECRETS));
    } finally { await r.close(); }
  }
});

// @spec DASH-RCV-018
test("config.yaml raw access: the token with control on; with control off an open read, and a write gated whenever a token is configured", async () => {
  const on = await rig(BROKEN, { controlEnabled: true, controlToken: "tok" });
  try {
    assert.equal((await getRaw(on, "config")).status, 401);
    assert.equal((await putRaw(on, { file: "config", etag: etagOf(BROKEN), text: EXAMPLE })).status, 401);
    assert.equal(readFileSync(on.configFile, "utf8"), BROKEN);
    assert.equal((await getRaw(on, "config", auth)).status, 200);
  } finally { await on.close(); }
  const tokenOff = await rig(BROKEN, { controlToken: "tok" });
  try {
    assert.equal((await getRaw(tokenOff, "config")).status, 200, "a read is open with control off");
    const res = await putRaw(tokenOff, { file: "config", etag: etagOf(BROKEN), text: EXAMPLE });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.equal(readFileSync(tokenOff.configFile, "utf8"), BROKEN, "a refused write changes nothing");
    assert.equal((await putRaw(tokenOff, { file: "config", etag: etagOf(BROKEN), text: EXAMPLE }, auth)).status, 200);
  } finally { await tokenOff.close(); }
});

// @spec DASH-RCV-017, DASH-RCV-009, DASH-RCV-011, DASH-RCV-012, DASH-RCV-015
test("a raw write replaces config.yaml atomically keeping its mode, and fixing the syntax error leads back to normal mode", async () => {
  const r = await rig(BROKEN);
  try {
    chmodSync(r.configFile, 0o640);
    const ino = statSync(r.configFile).ino;
    const stale = await putRaw(r, { file: "config", etag: "old", text: EXAMPLE });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { etag: string }).etag, etagOf(BROKEN));
    assert.equal(readFileSync(r.configFile, "utf8"), BROKEN, "an etag conflict writes nothing");

    const still = BROKEN.replace("[Coco", "[Coco, {");
    let res = await putRaw(r, { file: "config", etag: etagOf(BROKEN), text: still });
    assert.equal(res.status, 200);
    let body = await res.json() as Written;
    assert.equal(readFileSync(r.configFile, "utf8"), still, "the text is written as sent, still broken");
    assert.equal(body.valid, false);
    assert.equal(body.etag, etagOf(still));
    assert.deepEqual(body.problems.map((p) => [p.kind, p.raw]), [["syntax", true]]);
    assert.equal(r.valid(), 0);

    const fixed = EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: "Mika"   # fixed by hand');
    res = await putRaw(r, { file: "config", etag: body.etag, text: fixed });
    assert.equal(res.status, 200);
    body = await res.json() as Written;
    assert.equal(body.valid, true);
    assert.deepEqual(body.problems, []);
    assert.equal(readFileSync(r.configFile, "utf8"), fixed);
    assert.equal(statSync(r.configFile).mode & 0o777, 0o640, "the file keeps its permission bits");
    assert.notEqual(statSync(r.configFile).ino, ino, "replaced by a rename, not rewritten in place");
    assert.deepEqual(readdirSync(r.dir).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(r.valid(), 1, "a valid file leaves recovery mode");
    assert.ok(r.logs.includes("info config recovery: raw edit config.yaml"), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("Mika") || l.includes("fixed by hand")), "no text is logged");
  } finally { await r.close(); }
});

// @spec DASH-RCV-017, DASH-RCV-012
test("a raw write is refused for a file without a syntax error, for a malformed body and over 1 MiB, writing nothing", async () => {
  const text = EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: "${NAME}"');
  const r = await rig(text);
  try {
    const res = await putRaw(r, { file: "config", etag: etagOf(text), text: EXAMPLE });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { detail: string }).detail, /syntax/);
    assert.equal((await putRaw(r, { file: "config", etag: etagOf(text) })).status, 400);
    assert.equal((await putRaw(r, { file: "nope", etag: etagOf(text), text: "" })).status, 400);
    assert.equal((await fetch(`${r.url}/recovery/raw`, { method: "POST", body: "not json" })).status, 400);
    assert.equal(readFileSync(r.configFile, "utf8"), text);
  } finally { await r.close(); }
  const big = await rig(BROKEN);
  try {
    const res = await putRaw(big, { file: "config", etag: etagOf(BROKEN), text: `${EXAMPLE}#${"x".repeat(1024 * 1024)}\n` });
    assert.equal(res.status, 413);
    assert.equal(readFileSync(big.configFile, "utf8"), BROKEN);
    const near = `${EXAMPLE}#${"x".repeat(200 * 1024)}\n`;
    assert.equal((await putRaw(big, { file: "config", etag: etagOf(BROKEN), text: near })).status, 200, "a file over the 64 KiB JSON cap fits");
  } finally { await big.close(); }
});

// @spec DASH-RCV-017, DASH-RCV-018, DASH-RCV-015
test("a raw write of secrets.yaml needs the token, goes through a symbolic link with mode 0600, and never logs the text", async () => {
  const none = await rig(EXAMPLE, { secrets: BROKEN_SECRETS });
  try {
    const res = await putRaw(none, { file: "secrets", etag: etagOf(BROKEN_SECRETS), text: "" });
    assert.equal(res.status, 403);
    assert.equal(readFileSync(none.secretsFile, "utf8"), BROKEN_SECRETS);
  } finally { await none.close(); }
  const r = await rig(EXAMPLE, { controlToken: "tok" });
  try {
    const target = join(r.dir, "real-secrets.yaml");
    writeFileSync(target, BROKEN_SECRETS, { mode: 0o644 });
    symlinkSync(target, r.secretsFile);
    const refused = await putRaw(r, { file: "secrets", etag: etagOf(BROKEN_SECRETS), text: "" });
    assert.equal(refused.status, 401);
    const stale = await putRaw(r, { file: "secrets", etag: "old", text: "" }, auth);
    assert.equal(stale.status, 409);
    const fixed = "llm:\n  openai:\n    api_key: \"sk-live-123\"\n";
    const res = await putRaw(r, { file: "secrets", etag: etagOf(BROKEN_SECRETS), text: fixed }, auth);
    assert.equal(res.status, 200);
    const body = await res.json() as Written;
    assert.equal(body.valid, true, JSON.stringify(body.problems));
    assert.ok(lstatSync(r.secretsFile).isSymbolicLink(), "the link stays a link");
    assert.equal(readFileSync(target, "utf8"), fixed);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.ok(r.logs.includes("info config recovery: raw edit secrets.yaml"), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes(SECRET)), "the secrets text is never logged");
    assert.ok(!JSON.stringify(body).includes(SECRET));
  } finally { await r.close(); }
});

/** A recovery rig whose Stop runs a real `StackController` over a fake docker. */
async function stopRig(o: { controlEnabled: boolean; fail?: boolean; lockDir?: string }) {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const exec: ExecFile = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    if (o.fail) throw Object.assign(new Error("exit 1"), { stderr: "Cannot connect to the Docker daemon\n" });
    return { stdout: "", stderr: "" };
  };
  const lockDir = o.lockDir ?? mkdtempSync(join(tmpdir(), "cohost-rcv-lock-"));
  const r = await rig(BROKEN, {
    controlEnabled: o.controlEnabled, controlToken: "tok",
    stack: new StackController({ exec, cwd: "/ws", env: { COHOST_DOCKER_BIN: "/opt/docker" } }),
    lock: new LifecycleLock({ by: "dashboard", dir: lockDir }),
  });
  return { r, calls, lockDir };
}

// @spec DASH-RCV-019, DASH-RCV-010
test("Stop runs docker compose stop without a valid config, behind the token and the lifecycle lock", async () => {
  const off = await stopRig({ controlEnabled: false });
  try {
    assert.equal((await fetch(`${off.r.url}/stack/stop`, { method: "POST", headers: auth })).status, 404);
    assert.deepEqual(off.calls, []);
  } finally { await off.r.close(); }

  const on = await stopRig({ controlEnabled: true });
  try {
    const no = await fetch(`${on.r.url}/stack/stop`, { method: "POST" });
    assert.equal(no.status, 401);
    assert.equal(no.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(on.calls, []);

    const res = await fetch(`${on.r.url}/stack/stop`, { method: "POST", headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, action: "stop" });
    assert.deepEqual(on.calls, [{ file: "/opt/docker", args: ["compose", "stop"], cwd: "/ws" }]);
    assert.equal(existsSync(join(on.lockDir, "control.lock")), false, "the lock is released");
    assert.ok(on.r.logs.includes("info config recovery: stop"), on.r.logs.join("\n"));

    const held = new LifecycleLock({ by: "cohostctl", dir: on.lockDir, pid: process.ppid }).tryAcquire("launch");
    assert.ok(held.ok);
    const busy = await fetch(`${on.r.url}/stack/stop`, { method: "POST", headers: auth });
    assert.equal(busy.status, 409);
    assert.match(((await busy.json()) as { detail: string }).detail, /^busy: launch held by cohostctl/);
    assert.equal(on.calls.length, 1, "nothing runs while the lock is held");
    held.release();
  } finally { await on.r.close(); }

  const failing = await stopRig({ controlEnabled: true, fail: true });
  try {
    const res = await fetch(`${failing.r.url}/stack/stop`, { method: "POST", headers: auth });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, detail: "Cannot connect to the Docker daemon" });
    assert.equal(existsSync(join(failing.lockDir, "control.lock")), false, "the lock is released after a failure");
    assert.ok(failing.r.logs.some((l) => l.startsWith("error") && l.includes("Cannot connect to the Docker daemon")), failing.r.logs.join("\n"));
  } finally { await failing.r.close(); }
});
