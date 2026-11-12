import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
test("compose: isolated env goes in the child env and restart recreates", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: { A: "1" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls[0]!.args, ["compose", "up", "-d", "--force-recreate", "cortex"]);
  assert.equal(calls[0]!.env.LLM_PROVIDER, "mock");
  assert.equal(calls[0]!.env.A, "1");
});

// @spec CTRL-RUNTIME-009
test("compose: every isolation preset variable reaches the container through x-ts-service pass-through", async () => {
  // The preset is set on the docker compose CLI env; it only reaches the container if the
  // compose file names each variable as `VAR: ${VAR:-}` (docker is not run here).
  const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
  const block = compose.slice(compose.indexOf("x-ts-service:"), compose.indexOf("\nservices:"));
  const presetVars = new Set(SERVICE_MANIFEST.flatMap((d) => Object.keys(d.isolatedEnv)));
  for (const v of ["CHAT_SOURCE", "MEMORY_STORE", "MEMORY_EMBEDDER", "LLM_PROVIDER", "VOICE_ENGINE", "AVATAR_DRIVER", "VISION_ENABLED", "EARS_SOURCE", "MOUTH_DISCORD_ENABLED"]) {
    assert.ok(presetVars.has(v), `${v} is a manifest preset variable`);
  }
  for (const v of presetVars) {
    assert.match(block, new RegExp(`^\\s+${v}: \\$\\{${v}:-\\}`, "m"), `${v} passed through as \${${v}:-}`);
  }
  // And the runtime does hand the preset to the compose process for start and recreate.
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {} });
  await rt.start("cortex", { env: { LLM_PROVIDER: "mock" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls.map((c) => c.env.LLM_PROVIDER), ["mock", "mock"]);
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
test("compose: a Windows docker.exe gets the preset variables named in WSLENV; another binary gets the env unchanged", async () => {
  const run = async (bin: string, env: NodeJS.ProcessEnv) => {
    const { exec, calls } = fakeExec();
    await new ComposeRuntime({ exec, env: { COHOST_DOCKER_BIN: bin, ...env } }).start("mouth", { env: { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" } });
    return calls[0]!.env;
  };
  const exe = await run("docker.exe", {});
  assert.equal(exe.WSLENV, "MOUTH_DISCORD_ENABLED:MOUTH_DRYRUN_ENABLED");
  assert.equal(exe.MOUTH_DRYRUN_ENABLED, "true");
  const merged = await run("docker.exe", { WSLENV: "PATH/l:MOUTH_DRYRUN_ENABLED/u" });
  assert.equal(merged.WSLENV, "PATH/l:MOUTH_DRYRUN_ENABLED/u:MOUTH_DISCORD_ENABLED");
  assert.equal((await run("docker", {})).WSLENV, undefined);
});
