import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ISOLATION_ENV, ISOLATION_OVERRIDES } from "@cohost/config";
import { WS } from "./workspace.js";
import { ComposeRuntime, SERVICE_MANIFEST, type ExecFile, type Provisioner, NO_PROVISION } from "../src/index.js";

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
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec, env: {} });
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
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec });
  for (const id of ["nope", "cortex; rm -rf /", "$(id)", "--help"]) {
    const r = await rt.start(id);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0);
});

// @spec CTRL-RUNTIME-002
test("compose: an isolation preset goes in the child env and restart recreates", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec, env: { A: "1" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls[0]!.args, ["compose", "up", "-d", "--force-recreate", "cortex"]);
  assert.equal(calls[0]!.env[ISOLATION_ENV], '{"LLM_PROVIDER":"mock"}');
  assert.equal(calls[0]!.env.A, "1");
});

// @spec CTRL-RUNTIME-009
test("compose: a preset reaches the container as the one COHOST_ISOLATION variable, JSON of override names to values, and no per-name variable is set", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec, env: {} });
  await rt.start("avatar", { env: { AVATAR_DRIVER: "null" } });
  await rt.restart("eyes", { env: { VISION_ENABLED: "false", VISION_PROVIDER: "stub" } });
  await rt.start("ears", { env: { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" } });
  assert.deepEqual(calls.map((c) => JSON.parse(c.env[ISOLATION_ENV]!)), [
    { AVATAR_DRIVER: "null" }, { VISION_ENABLED: "false", VISION_PROVIDER: "stub" }, { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" },
  ]);
  for (const c of calls) for (const name of Object.keys(ISOLATION_OVERRIDES)) assert.equal(c.env[name], undefined, `${name} is set on no process`);
});

// @spec CTRL-RUNTIME-009
test("compose: every manifest preset is accepted, and a name that is no isolation override fails the action without running docker", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec, env: {} });
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
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec: fakeExec("no such service").exec });
  assert.deepEqual(await rt.start("cortex"), { ok: false, detail: "no such service" });
});

/**
 * A docker stand-in for a one-shot: `compose run -d` starts the container, `wait` prints `status`, `logs -f` prints `stdout` and
 * `stderr` (or fails with them), and `exec -i` (a delivery) is recorded with its input.
 */
function oneShotDocker(o: { status?: string; stdout?: string; stderr?: string; runFail?: string; logsFail?: boolean; waitFail?: boolean } = {}) {
  const calls: { args: string[]; timeoutMs?: number; cwd?: string; input?: string }[] = [];
  const exec: ExecFile = async (_file, args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs, cwd: opts.cwd, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (args[0] === "compose" && args[1] === "run" && o.runFail) throw Object.assign(new Error("exit 1"), { stdout: "", stderr: o.runFail });
    if (args[0] === "wait") {
      if (o.waitFail) throw Object.assign(new Error("timed out"), { stdout: "", stderr: "timed out after 1800000 ms" });
      return { stdout: `${o.status ?? "0"}\n`, stderr: "" };
    }
    if (args[0] === "logs") {
      if (o.logsFail) throw Object.assign(new Error("exit 1"), { stdout: o.stdout ?? "", stderr: o.stderr ?? "" });
      return { stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/** A provisioner that records the one-shot it is asked to deliver to, and can fail the delivery. */
function recordingProvision(fail?: string) {
  const seen: ({ name: string; unit: string } | undefined)[] = [];
  const provision: Provisioner = { before: async () => ({ ok: true, after: async (one) => { seen.push(one); return fail ? { ok: false, detail: fail } : { ok: true }; } }) };
  return { provision, seen };
}

// @spec CTRL-RUNTIME-010, CTRL-RUNTIME-018
test("compose: consolidate runs `run -d --rm --name <name> consolidate`, delivers the memory unit's message to that container, then follows and waits with a long timeout", async () => {
  const d = oneShotDocker({ stdout: "starting\nconsolidate completed\n\n", stderr: "" });
  const p = recordingProvision();
  const rt = new ComposeRuntime({ provision: p.provision, cwd: WS, onPath: hasDocker, exec: d.exec, env: {} });
  assert.deepEqual(await rt.consolidate(), { ok: true, detail: "consolidate completed" });
  const run = d.calls[0]!;
  assert.deepEqual(run.args.slice(0, 5), ["compose", "run", "-d", "--rm", "--name"]);
  const name = run.args[5]!;
  assert.match(name, /^cohost-consolidate-[a-z0-9]+$/);
  assert.equal(run.args[6], "consolidate");
  assert.equal(run.args.length, 7, "the argv is fixed apart from the generated name");
  assert.deepEqual(p.seen, [{ name, unit: "memory" }]);
  const wait = d.calls.find((c) => c.args[0] === "wait")!;
  const logs = d.calls.find((c) => c.args[0] === "logs")!;
  assert.deepEqual(wait.args, ["wait", name]);
  assert.deepEqual(logs.args, ["logs", "-f", name]);
  assert.equal(wait.timeoutMs, 30 * 60_000);
  assert.equal(logs.timeoutMs, 30 * 60_000);
});

// @spec CTRL-RUNTIME-011
test("compose: reembed behaves as consolidate with the reembed service, and reports the failure's output tail", async () => {
  const d = oneShotDocker({ stdout: "x\nreembed completed\n" });
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec: d.exec, env: {} });
  assert.deepEqual(await rt.reembed(), { ok: true, detail: "reembed completed" });
  assert.equal(d.calls[0]!.args[6], "reembed");
  const failed = oneShotDocker({ status: "1", stdout: "", stderr: " boom \n" });
  assert.deepEqual(await new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec: failed.exec }).reembed(), { ok: false, detail: "boom" });
});

// @spec CTRL-RUNTIME-010
test("compose: a failing consolidate is ok:false with stderr, else the stdout tail, else the exit status, cut to 500; a failed run or delivery stops there", async () => {
  const run = async (o: Parameters<typeof oneShotDocker>[0]) => new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec: oneShotDocker(o).exec }).consolidate();
  assert.deepEqual(await run({ status: "1", stderr: " no such table \n" }), { ok: false, detail: "no such table" });
  assert.deepEqual(await run({ status: "1", stdout: "a\nconsolidate failed\n" }), { ok: false, detail: "consolidate failed" });
  assert.deepEqual(await run({ status: "3" }), { ok: false, detail: "exit 3" });
  assert.equal((await run({ status: "1", stderr: "x".repeat(900) })).detail?.length, 500);
  assert.deepEqual(await run({ runFail: " no such service \n" }), { ok: false, detail: "no such service" });

  const d = oneShotDocker();
  const p = recordingProvision("the credentials of memory could not be delivered (docker exec exited 1)");
  const r = await new ComposeRuntime({ provision: p.provision, cwd: WS, onPath: hasDocker, exec: d.exec, env: {} }).consolidate();
  assert.deepEqual(r, { ok: false, detail: "the credentials of memory could not be delivered (docker exec exited 1)" });
  const name = d.calls[0]!.args[5]!;
  assert.ok(d.calls.some((c) => c.args.join(" ") === `rm -f ${name}`), "a container waiting for a delivery that failed is removed");
});

// @spec CTRL-RUNTIME-010, CTRL-RUNTIME-018
test("compose: a one-shot whose docker wait fails or times out is removed with docker rm -f and reported", async () => {
  const d = oneShotDocker({ waitFail: true });
  const r = await new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec: d.exec, env: {} }).consolidate();
  const name = d.calls[0]!.args[5]!;
  assert.equal(r.ok, false);
  assert.match(r.detail!, new RegExp(`consolidate did not finish .*its container ${name} was removed`));
  assert.ok(d.calls.some((c) => c.args.join(" ") === `rm -f ${name}`), "the container is removed");
});

// @spec CTRL-RUNTIME-014
test("compose: a refusal or a projection failure runs no docker command; stop runs no provisioner", async () => {
  const d = oneShotDocker();
  let asked = 0;
  const refuse: Provisioner = { before: async () => { asked++; return { ok: false, detail: "the environment defines CONTROL_TOKEN: unset it" }; } };
  const rt = new ComposeRuntime({ provision: refuse, cwd: WS, onPath: hasDocker, exec: d.exec, env: {} });
  for (const r of [await rt.start("cortex"), await rt.restart("cortex"), await rt.consolidate(), await rt.reembed()]) {
    assert.deepEqual(r, { ok: false, detail: "the environment defines CONTROL_TOKEN: unset it" });
  }
  assert.equal(d.calls.length, 0);
  assert.equal((await rt.stop("cortex")).ok, true);
  assert.equal(asked, 4, "stop asks nothing");
  assert.deepEqual(d.calls.map((c) => c.args), [["compose", "stop", "cortex"]]);
});

// @spec CTRL-STACK-012
test("compose: the docker binary is COHOST_DOCKER_BIN, else docker, else docker.exe, with the same argv", async () => {
  const run = async (env: NodeJS.ProcessEnv, onPath: (n: string) => boolean) => {
    const { exec, calls } = fakeExec();
    const r = await new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, exec, env, onPath }).start("cortex");
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
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, exec, env: {}, onPath: () => false });
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
    await new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, exec, env: { COHOST_DOCKER_BIN: bin, ...env } }).start("mouth", { env: preset });
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
    void new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, exec, env: { COHOST_DOCKER_BIN: "docker.exe", [ISOLATION_ENV]: "ambient" } }).stop("mouth").then(() => resolve(calls[0]!.env));
  });
  assert.equal(none[ISOLATION_ENV], "", "no preset: empty, replacing the ambient value");
  assert.equal(none.WSLENV, ISOLATION_ENV, "the empty value is forwarded too, so Windows Compose does not read .env");
  assert.equal((await run("docker", {})).WSLENV, undefined);
  assert.equal((await run("docker", { WSLENV: "PATH/l" })).WSLENV, "PATH/l");
});

// @spec CTRL-RUNTIME-013
test("compose: every action without a preset sets COHOST_ISOLATION to the empty string over an ambient value", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ provision: NO_PROVISION, cwd: WS, onPath: hasDocker, exec, env: { [ISOLATION_ENV]: '{"CHAT_SOURCES":"[fake]"}' } });
  await rt.start("chat");
  await rt.start("chat", { env: {} });
  await rt.stop("chat");
  await rt.restart("chat");
  await rt.consolidate();
  await rt.reembed();
  // The one-shots also run `docker wait` and `docker logs`, which are no Compose command and read no isolation.
  const compose = () => calls.filter((c) => c.args[0] === "compose");
  assert.equal(compose().length, 6);
  for (const c of compose()) assert.equal(c.env[ISOLATION_ENV], "", c.args.join(" "));
  await rt.start("chat", { env: { CHAT_SOURCES: "[fake]" } });
  assert.equal(compose()[6]!.env[ISOLATION_ENV], '{"CHAT_SOURCES":"[fake]"}', "a preset replaces the ambient value too");
});
