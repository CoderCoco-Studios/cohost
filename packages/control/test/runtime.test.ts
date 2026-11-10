import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ComposeRuntime, SERVICE_MANIFEST, type ExecFile } from "../src/index.js";

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
  const rt = new ComposeRuntime({ exec, env: {} });
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
  const rt = new ComposeRuntime({ exec });
  for (const id of ["nope", "cortex; rm -rf /", "$(id)", "--help"]) {
    const r = await rt.start(id);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0);
});

// @spec CTRL-RUNTIME-002
test("compose: isolated env goes in the child env and restart recreates", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ exec, env: { A: "1" } });
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
  for (const v of ["CHAT_SOURCE", "MEMORY_STORE", "MEMORY_EMBEDDER", "LLM_PROVIDER", "VOICE_ENGINE", "AVATAR_DRIVER", "VISION_ENABLED", "EARS_SOURCE"]) {
    assert.ok(presetVars.has(v), `${v} is a manifest preset variable`);
  }
  for (const v of presetVars) {
    assert.match(block, new RegExp(`^\\s+${v}: \\$\\{${v}:-\\}`, "m"), `${v} passed through as \${${v}:-}`);
  }
  // And the runtime does hand the preset to the compose process for start and recreate.
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ exec, env: {} });
  await rt.start("cortex", { env: { LLM_PROVIDER: "mock" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls.map((c) => c.env.LLM_PROVIDER), ["mock", "mock"]);
});

// @spec CTRL-RUNTIME-003
test("compose: a failing command is ok:false with stderr as detail", async () => {
  const rt = new ComposeRuntime({ exec: fakeExec("no such service").exec });
  assert.deepEqual(await rt.start("cortex"), { ok: false, detail: "no such service" });
});

// @spec CTRL-RUNTIME-010
test("compose: consolidate runs the fixed one-shot argv with a long timeout and reports the last stdout line", async () => {
  const seen: { args: string[]; timeoutMs?: number; cwd?: string }[] = [];
  const exec: ExecFile = async (_file, args, opts) => {
    seen.push({ args, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
    return { stdout: "starting\nconsolidate completed\n\n", stderr: "warn" };
  };
  const rt = new ComposeRuntime({ exec, env: {}, cwd: "/stack" });
  assert.deepEqual(await rt.consolidate(), { ok: true, detail: "consolidate completed" });
  assert.deepEqual(seen, [{ args: ["compose", "run", "--rm", "-T", "consolidate"], timeoutMs: 30 * 60_000, cwd: "/stack" }]);
  const quiet = new ComposeRuntime({ exec: async () => ({ stdout: "", stderr: "" }) });
  assert.deepEqual(await quiet.consolidate(), { ok: true });
});

// @spec CTRL-RUNTIME-010
test("compose: a failing consolidate is ok:false with stderr, else stdout tail, else the error message, cut to 500", async () => {
  const fail = (stdout: string, stderr: string, message = "exit 1"): ExecFile => async () => { throw Object.assign(new Error(message), { stdout, stderr }); };
  assert.deepEqual(await new ComposeRuntime({ exec: fail("", " no such service \n") }).consolidate(), { ok: false, detail: "no such service" });
  assert.deepEqual(await new ComposeRuntime({ exec: fail("a\nconsolidate failed\n", "") }).consolidate(), { ok: false, detail: "consolidate failed" });
  assert.deepEqual(await new ComposeRuntime({ exec: fail("", "") }).consolidate(), { ok: false, detail: "exit 1" });
  const long = await new ComposeRuntime({ exec: fail("", "x".repeat(900)) }).consolidate();
  assert.equal(long.detail?.length, 500);
});
