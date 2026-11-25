import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ComposeRuntime, StackController, SERVICE_MANIFEST, type ExecFile } from "../src/index.js";

// The control plane runs the secrets projection before it issues a `docker compose` command that creates, starts or restarts an
// application container (control-plane CTRL-RUNTIME-014, deployment DEPLOY-SECRET-004), and exposes it as an entry the installer
// runs (CTRL-RUNTIME-015, DEPLOY-SECRET-006). The operator's file is `secrets/secrets.yaml` under the workspace root, which the
// tests point the loader at with COHOST_SECRETS_FILE (the real repository is the workspace root of the test process).

const initial = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in initial)) delete process.env[k];
  Object.assign(process.env, initial);
});

const MARKER = "sk-CONTROL-MARKER";
const GOOD = `llm:
  openai:
    api_key: sk-openai
chat:
  twitch:
    client_id: cid
connections:
  discord:
    token: disc
tools:
  servers:
    weather:
      token: w-token
`;
/** The units the projection covers: a Compose service and a non-empty `secrets` list. */
const projected = SERVICE_MANIFEST.filter((s) => s.composeName && (s.secrets ?? []).length > 0);

function workspace(operator?: string): { root: string; operator: string; units: string } {
  const root = mkdtempSync(join(tmpdir(), "cohost-ctl-proj-"));
  mkdirSync(join(root, "secrets"), { mode: 0o700 });
  const file = join(root, "secrets", "secrets.yaml");
  if (operator !== undefined) writeFileSync(file, operator, { mode: 0o600 });
  process.env.COHOST_SECRETS_FILE = file;
  return { root, operator: file, units: join(root, "secrets", "units") };
}

/** An exec that records each command with the unit directories that existed when it ran. */
function recorder(units: string) {
  const calls: { args: string[]; units: string[]; contents: Record<string, unknown> }[] = [];
  const exec: ExecFile = async (_file, args) => {
    const dirs = existsSync(units) ? readdirSync(units).sort() : [];
    const contents: Record<string, unknown> = {};
    for (const d of dirs) { try { contents[d] = parse(readFileSync(join(units, d, "secrets.yaml"), "utf8")); } catch { /* not there */ } }
    calls.push({ args, units: dirs, contents });
    return { stdout: args[1] === "ps" ? "[]" : "", stderr: "" };
  };
  return { exec, calls };
}
const onPath = (n: string): boolean => n === "docker";

// @spec MOD-MAN-015
test("the manifest declares a secrets list for tools, chat, eyes, ears, the model units, voice and the Discord connector, and none for mouth, avatar and the compose-only services", () => {
  assert.deepEqual(projected.map((s) => s.composeName).sort(), ["affect", "chat", "connector-discord", "cortex", "ears", "eyes", "memory", "salience", "tools", "voice"]);
  for (const s of SERVICE_MANIFEST.filter((x) => !projected.includes(x))) assert.deepEqual(s.secrets, [], s.id);
});

// @spec CTRL-RUNTIME-014, DEPLOY-SECRET-004, DEPLOY-SECRET-002
test("start, both forms of restart, consolidate and reembed project every unit's secrets before the docker compose command", async () => {
  const w = workspace(GOOD);
  const { exec, calls } = recorder(w.units);
  const rt = new ComposeRuntime({ exec, onPath, cwd: w.root, env: {} });
  assert.equal((await rt.start("cortex")).ok, true);
  assert.equal((await rt.restart("cortex")).ok, true);
  assert.equal((await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } })).ok, true);
  assert.equal((await rt.consolidate()).ok, true);
  assert.equal((await rt.reembed()).ok, true);
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.deepEqual(c.units, projected.map((s) => s.composeName).sort(), `before \`${c.args.join(" ")}\`: every unit directory exists`);
    assert.deepEqual(c.contents.tools, { chat: { twitch: { client_id: "cid" } }, tools: { servers: { weather: { token: "w-token" } } } }, "tools holds only its declared paths that are set");
    assert.deepEqual(c.contents["connector-discord"], { connections: { discord: { token: "disc" } } });
    assert.deepEqual(c.contents.voice, {});
  }
});

// @spec CTRL-RUNTIME-014, DEPLOY-SECRET-004
test("when the projection fails, none of those runtime commands runs docker and each returns ok: false with a message naming the file and no value", async () => {
  const w = workspace(`llm:\n  openai:\n    api_key: ${MARKER}\nbroken: [unclosed\n`);
  const { exec, calls } = recorder(w.units);
  const rt = new ComposeRuntime({ exec, onPath, cwd: w.root, env: {} });
  const results = [await rt.start("cortex"), await rt.restart("cortex"), await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } }), await rt.consolidate(), await rt.reembed()];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.ok(r.detail!.includes(w.operator), r.detail);
    assert.ok(!r.detail!.includes(MARKER), "no value in the message");
  }
  assert.equal(calls.length, 0, "no docker compose command ran");
});

// @spec CTRL-RUNTIME-014
test("stop does not project: it runs with a malformed operator file and writes no unit file", async () => {
  const w = workspace("broken: [unclosed\n");
  const { exec, calls } = recorder(w.units);
  const rt = new ComposeRuntime({ exec, onPath, cwd: w.root, env: {} });
  assert.equal((await rt.stop("cortex")).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(w.units), false);
});

// @spec CTRL-RUNTIME-014, DEPLOY-SECRET-004
test("StackController.launch and rebuild project before docker compose up, and a failed projection runs no docker compose command", async () => {
  for (const kind of ["launch", "rebuild"] as const) {
    const w = workspace(GOOD);
    const { exec, calls } = recorder(w.units);
    const stack = new StackController({ exec, onPath, cwd: w.root, env: {}, now: () => 0, sleep: async () => {}, readPocketConfig: () => ({ token: "", engine: "kokoro" }) });
    await stack[kind]();
    const up = calls.find((c) => c.args[1] === "up");
    assert.ok(up, `${kind} ran docker compose up`);
    assert.deepEqual(up.units, projected.map((s) => s.composeName).sort(), `${kind}: projected before up`);
    assert.deepEqual(up.contents.chat, { chat: { twitch: { client_id: "cid" } } });

    const bad = workspace(`llm:\n  openai:\n    api_key: ${MARKER}\nbroken: [unclosed\n`);
    const failing = recorder(bad.units);
    const r = await new StackController({ exec: failing.exec, onPath, cwd: bad.root, env: {}, now: () => 0, sleep: async () => {}, readPocketConfig: () => ({ token: "", engine: "kokoro" }) })[kind]();
    assert.equal(r.ok, false);
    assert.ok(r.detail!.includes(bad.operator) && !r.detail!.includes(MARKER), r.detail);
    assert.equal(failing.calls.length, 0, `${kind}: no docker compose command ran`);
  }
});

const entry = fileURLToPath(new URL("../dist/project-secrets.js", import.meta.url));
const runEntry = (cwd: string, secretsFile: string) =>
  spawnSync(process.execPath, [entry], { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, COHOST_SECRETS_FILE: secretsFile } });

// @spec CTRL-RUNTIME-015, DEPLOY-SECRET-006
test("node packages/control/dist/project-secrets.js projects for the workspace root and exits 0, or prints the message to stderr and exits 1", () => {
  assert.ok(existsSync(entry), "run `pnpm build` first");
  // the entry takes the workspace root from where it runs: a directory holding pnpm-workspace.yaml
  const w = workspace(GOOD);
  writeFileSync(join(w.root, "pnpm-workspace.yaml"), "packages: []\n");
  const ok = runEntry(w.root, w.operator);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readdirSync(w.units).sort(), projected.map((s) => s.composeName).sort());
  assert.deepEqual(parse(readFileSync(join(w.units, "tools", "secrets.yaml"), "utf8")), { chat: { twitch: { client_id: "cid" } }, tools: { servers: { weather: { token: "w-token" } } } });

  const bad = workspace(`llm:\n  openai:\n    api_key: ${MARKER}\nbroken: [unclosed\n`);
  writeFileSync(join(bad.root, "pnpm-workspace.yaml"), "packages: []\n");
  const fail = runEntry(bad.root, bad.operator);
  assert.equal(fail.status, 1);
  assert.ok(fail.stderr.includes(bad.operator), fail.stderr);
  assert.ok(!fail.stderr.includes(MARKER) && !fail.stdout.includes(MARKER));
});
