import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ISOLATION_ENV, ISOLATION_OVERRIDES } from "@cohost/config";
import { ComposeRuntime, SERVICE_MANIFEST, type ExecFile } from "../src/index.js";

const hasDocker = (name: string) => name === "docker";

// ---- compose ----

function fakeExec(fail?: string) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: ExecFile = async (file, args, opts) => {
    calls.push({ file, args, env: opts.env });
    if (fail) throw Object.assign(new Error("exit 1"), { stderr: fail });
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

// @spec CTRL-RUNTIME-001
test("compose: exact argv for start / stop / restart, via execFile (no shell string)", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {} });
  assert.deepEqual(await rt.start("cortex"), { ok: true });
  await rt.stop("cortex");
  await rt.restart("cortex");
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
    ["docker", "compose", "up", "-d", "cortex"],
    ["docker", "compose", "stop", "cortex"],
    ["docker", "compose", "restart", "cortex"],
  ]);
});

// @spec CTRL-RUNTIME-004
test("compose: crafted ids are rejected without exec", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec });
  for (const id of ["nope", "cortex; rm -rf /", "$(id)", "--help"]) {
    const r = await rt.start(id);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0);
});

// @spec CTRL-RUNTIME-002
test("compose: an isolation preset goes in the child env and restart recreates", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: { A: "1" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls[0]!.args, ["compose", "up", "-d", "--force-recreate", "cortex"]);
  assert.equal(calls[0]!.env[ISOLATION_ENV], '{"LLM_PROVIDER":"mock"}');
  assert.equal(calls[0]!.env.A, "1");
});

// @spec CTRL-RUNTIME-009
test("compose: a preset reaches the container as the one COHOST_ISOLATION variable, JSON of override names to values, and no per-name variable is set", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {} });
  await rt.start("avatar", { env: { AVATAR_DRIVER: "null" } });
  await rt.restart("eyes", { env: { VISION_ENABLED: "false", VISION_ENGINE: "stub" } });
  await rt.start("ears", { env: { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" } });
  assert.deepEqual(calls.map((c) => JSON.parse(c.env[ISOLATION_ENV]!)), [
    { AVATAR_DRIVER: "null" }, { VISION_ENABLED: "false", VISION_ENGINE: "stub" }, { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" },
  ]);
  for (const c of calls) for (const name of Object.keys(ISOLATION_OVERRIDES)) assert.equal(c.env[name], undefined, `${name} is set on no process`);
});

// @spec CTRL-RUNTIME-009
test("compose: every manifest preset is accepted, and a name that is no isolation override fails the action without running docker", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {} });
  for (const def of SERVICE_MANIFEST) assert.deepEqual(await rt.start(def.id, { env: def.isolatedEnv }), { ok: true }, def.id);
  const before = calls.length;
  const bad = await rt.start("cortex", { env: { LLM_PROVIDER_TYPO: "mock" } });
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /LLM_PROVIDER_TYPO/);
  assert.equal(calls.length, before);
});

// @spec CTRL-RUNTIME-009
test("compose: the x-ts-service environment passes through exactly COHOST_ISOLATION and no per-override variable", () => {
  const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
  const block = compose.slice(compose.indexOf("x-ts-service:"), compose.indexOf("\nservices:"));
  assert.match(block, /^\s+COHOST_ISOLATION: \$\{COHOST_ISOLATION:-\}/m);
  for (const name of Object.keys(ISOLATION_OVERRIDES)) assert.doesNotMatch(block, new RegExp(`^\\s+${name}:`, "m"), name);
});

// @spec CTRL-RUNTIME-003
test("compose: a failing command is ok:false with stderr as detail", async () => {
  const rt = new ComposeRuntime({ onPath: hasDocker, exec: fakeExec("no such service").exec });
  assert.deepEqual(await rt.start("cortex"), { ok: false, detail: "no such service" });
});

// @spec CTRL-RUNTIME-010
test("compose: consolidate runs the fixed one-shot argv with a long timeout and reports the last stdout line", async () => {
  const seen: { args: string[]; timeoutMs?: number; cwd?: string }[] = [];
  const exec: ExecFile = async (_file, args, opts) => {
    seen.push({ args, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
    return { stdout: "starting\nconsolidate completed\n\n", stderr: "warn" };
  };
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {}, cwd: "/stack" });
  assert.deepEqual(await rt.consolidate(), { ok: true, detail: "consolidate completed" });
  assert.deepEqual(seen, [{ args: ["compose", "run", "--rm", "-T", "consolidate"], timeoutMs: 30 * 60_000, cwd: "/stack" }]);
  const quiet = new ComposeRuntime({ onPath: hasDocker, exec: async () => ({ stdout: "", stderr: "" }) });
  assert.deepEqual(await quiet.consolidate(), { ok: true });
});

// @spec CTRL-RUNTIME-010
// @spec CTRL-RUNTIME-011
test("compose: reembed runs the fixed one-shot argv with a long timeout and reports the last stdout line or the failure", async () => {
  const seen: { args: string[]; timeoutMs?: number; cwd?: string }[] = [];
  const exec: ExecFile = async (_file, args, opts) => {
    seen.push({ args, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
    return { stdout: "x\nreembed completed\n", stderr: "" };
  };
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {}, cwd: "/stack" });
  assert.deepEqual(await rt.reembed(), { ok: true, detail: "reembed completed" });
  assert.deepEqual(seen, [{ args: ["compose", "run", "--rm", "-T", "reembed"], timeoutMs: 30 * 60_000, cwd: "/stack" }]);
  const boom: ExecFile = async () => { throw Object.assign(new Error("exit 1"), { stdout: "", stderr: " boom \n" }); };
  assert.deepEqual(await new ComposeRuntime({ onPath: hasDocker, exec: boom }).reembed(), { ok: false, detail: "boom" });
});

test("compose: a failing consolidate is ok:false with stderr, else stdout tail, else the error message, cut to 500", async () => {
  const fail = (stdout: string, stderr: string, message = "exit 1"): ExecFile => async () => { throw Object.assign(new Error(message), { stdout, stderr }); };
  assert.deepEqual(await new ComposeRuntime({ onPath: hasDocker, exec: fail("", " no such service \n") }).consolidate(), { ok: false, detail: "no such service" });
  assert.deepEqual(await new ComposeRuntime({ onPath: hasDocker, exec: fail("a\nconsolidate failed\n", "") }).consolidate(), { ok: false, detail: "consolidate failed" });
  assert.deepEqual(await new ComposeRuntime({ onPath: hasDocker, exec: fail("", "") }).consolidate(), { ok: false, detail: "exit 1" });
  const long = await new ComposeRuntime({ onPath: hasDocker, exec: fail("", "x".repeat(900)) }).consolidate();
  assert.equal(long.detail?.length, 500);
});

// @spec CTRL-STACK-012
test("compose: the docker binary is COHOST_DOCKER_BIN, else docker, else docker.exe, with the same argv", async () => {
  const run = async (env: NodeJS.ProcessEnv, onPath: (n: string) => boolean) => {
    const { exec, calls } = fakeExec();
    const r = await new ComposeRuntime({ exec, env, onPath }).start("cortex");
    return { r, calls };
  };
  const a = await run({ COHOST_DOCKER_BIN: "/opt/d" }, () => true);
  assert.deepEqual([a.calls[0]!.file, ...a.calls[0]!.args], ["/opt/d", "compose", "up", "-d", "cortex"]);
  const b = await run({ COHOST_DOCKER_BIN: "" }, (n) => n === "docker" || n === "docker.exe");
  assert.equal(b.calls[0]!.file, "docker");
  const c = await run({}, (n) => n === "docker.exe");
  assert.deepEqual([c.calls[0]!.file, ...c.calls[0]!.args], ["docker.exe", "compose", "up", "-d", "cortex"]);
});

// @spec CTRL-STACK-012
test("compose: with no docker found every action resolves ok:false naming COHOST_DOCKER_BIN, without exec or throwing", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ exec, env: {}, onPath: () => false });
  for (const r of [await rt.start("cortex"), await rt.stop("cortex"), await rt.restart("cortex"), await rt.consolidate()]) {
    assert.equal(r.ok, false);
    assert.match(r.detail!, /COHOST_DOCKER_BIN/);
  }
  assert.equal(calls.length, 0);
});

// @spec CTRL-RUNTIME-012
test("compose: a Windows docker.exe gets COHOST_ISOLATION named once in WSLENV for a preset; another binary gets the env unchanged", async () => {
  const run = async (bin: string, env: NodeJS.ProcessEnv, preset: Record<string, string> = { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" }) => {
    const { exec, calls } = fakeExec();
    await new ComposeRuntime({ exec, env: { COHOST_DOCKER_BIN: bin, ...env } }).start("mouth", { env: preset });
    return calls[0]!.env;
  };
  const exe = await run("docker.exe", {});
  assert.equal(exe.WSLENV, ISOLATION_ENV);
  assert.equal(exe[ISOLATION_ENV], '{"MOUTH_DISCORD_ENABLED":"false","MOUTH_DRYRUN_ENABLED":"true"}');
  assert.equal((await run("docker.exe", { WSLENV: "PATH/l" })).WSLENV, `PATH/l:${ISOLATION_ENV}`);
  assert.equal((await run("docker.exe", { WSLENV: `PATH/l:${ISOLATION_ENV}/u` })).WSLENV, `PATH/l:${ISOLATION_ENV}/u`, "named once");
  const empty = await run("docker.exe", {}, {});
  assert.equal(empty[ISOLATION_ENV], "", "an empty preset encodes as the empty string");
  assert.equal(empty.WSLENV, ISOLATION_ENV);
  const none = await new Promise<NodeJS.ProcessEnv>((resolve) => {
    const { exec, calls } = fakeExec();
    void new ComposeRuntime({ exec, env: { COHOST_DOCKER_BIN: "docker.exe", [ISOLATION_ENV]: "ambient" } }).stop("mouth").then(() => resolve(calls[0]!.env));
  });
  assert.equal(none[ISOLATION_ENV], "", "no preset: empty, replacing the ambient value");
  assert.equal(none.WSLENV, ISOLATION_ENV, "the empty value is forwarded too, so Windows Compose does not read .env");
  assert.equal((await run("docker", {})).WSLENV, undefined);
  assert.equal((await run("docker", { WSLENV: "PATH/l" })).WSLENV, "PATH/l");
});

// @spec CTRL-RUNTIME-013
test("compose: every action without a preset sets COHOST_ISOLATION to the empty string over an ambient value", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: { [ISOLATION_ENV]: '{"CHAT_SOURCE":"fake"}' } });
  await rt.start("chat");
  await rt.start("chat", { env: {} });
  await rt.stop("chat");
  await rt.restart("chat");
  await rt.consolidate();
  await rt.reembed();
  assert.equal(calls.length, 6);
  for (const c of calls) assert.equal(c.env[ISOLATION_ENV], "", c.args.join(" "));
  await rt.start("chat", { env: { CHAT_SOURCE: "fake" } });
  assert.equal(calls[6]!.env[ISOLATION_ENV], '{"CHAT_SOURCE":"fake"}', "a preset replaces the ambient value too");
});
