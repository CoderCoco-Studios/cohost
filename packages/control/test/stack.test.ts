import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StackController, ServiceController, stackState,
  type ExecFile, type ContainerStatus, type Runtime, type StackStatus,
} from "../src/index.js";

type Call = { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number };

const ps = (rows: Array<Partial<{ Service: string; State: string; Health: string; ExitCode: number }>>) =>
  JSON.stringify(rows.map((r) => ({ Service: "x", State: "running", Health: "", ExitCode: 0, ...r })));
const ndjson = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).join("\n");

/** A scripted exec: `ps` answers come from `psAnswers` (the last repeats); a fake clock advances only through sleep. */
function harness(o: { psAnswers?: Array<string | Error>; upFail?: string; stopFail?: string } = {}) {
  const calls: Call[] = [];
  const phases: Array<[string, string]> = [];
  const sleeps: number[] = [];
  let t = 0;
  let psN = 0;
  const exec: ExecFile = async (file, args, opts) => {
    calls.push({ file, args, env: opts.env, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    if (args[1] === "ps") {
      const a = o.psAnswers ?? [ps([])];
      const v = a[Math.min(psN++, a.length - 1)]!;
      if (v instanceof Error) throw v;
      return { stdout: v, stderr: "" };
    }
    if (args[1] === "up" && o.upFail) throw Object.assign(new Error("exit 1"), { stderr: ` ${o.upFail} \n` });
    if (args[1] === "stop" && o.stopFail) throw Object.assign(new Error("exit 1"), { stderr: o.stopFail });
    return { stdout: "", stderr: "" };
  };
  const stack = new StackController({
    exec, cwd: "/root", env: { BASE: "1" }, onPath: (n) => n === "docker",
    onPhase: (k, p) => phases.push([k, p]),
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  return { stack, calls, phases, sleeps, now: () => t };
}

const daemonDown = () => Object.assign(new Error("exit 1"), { stderr: "daemon gone" });

const ready = [
  { Service: "redis", State: "running", Health: "healthy" },
  { Service: "ollama", State: "running", Health: "" },
  { Service: "models", State: "exited", ExitCode: 0 },
];

// @spec CTRL-STACK-001, CTRL-STACK-008
test("status: fixed argv, 10 s timeout, workspace cwd, base env; parses a JSON array", async () => {
  const h = harness({ psAnswers: [ps([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "models", State: "exited", ExitCode: 3 }])] });
  const s = await h.stack.status();
  assert.deepEqual(s, { docker: { ok: true }, services: [
    { service: "redis", status: "running", health: "healthy" },
    { service: "models", status: "exited", exitCode: 3 },
  ] });
  assert.deepEqual(h.calls, [{ file: "docker", args: ["compose", "ps", "--all", "--format", "json"], env: { BASE: "1" }, cwd: "/root", timeoutMs: 10_000 }]);
});

// @spec CTRL-STACK-008
test("status: accepts one JSON object per line and an empty project", async () => {
  const lines = ndjson([{ Service: "a", State: "running", Health: "" }, { Service: "b", State: "exited", ExitCode: 1 }]);
  const s = await harness({ psAnswers: [lines] }).stack.status();
  assert.deepEqual(s.services.map((c) => c.service), ["a", "b"]);
  assert.deepEqual(await harness({ psAnswers: [""] }).stack.status(), { docker: { ok: true }, services: [] });
  assert.deepEqual(await harness({ psAnswers: ["[]"] }).stack.status(), { docker: { ok: true }, services: [] });
});

// @spec CTRL-STACK-008
test("status: a failing command, a timeout or unparsable output is docker unavailable and never throws", async () => {
  const fail = Object.assign(new Error("exit 1"), { stderr: "Cannot connect to the Docker daemon" });
  assert.deepEqual(await harness({ psAnswers: [fail] }).stack.status(), { docker: { ok: false, detail: "Cannot connect to the Docker daemon" }, services: [] });
  const b = await harness({ psAnswers: [new Error("timed out")] }).stack.status();
  assert.deepEqual([b.docker.ok, b.docker.detail], [false, "timed out"]);
  assert.equal((await harness({ psAnswers: ["not json"] }).stack.status()).docker.ok, false);
  const d = await harness({ psAnswers: [Object.assign(new Error("x"), { stderr: "y".repeat(900) })] }).stack.status();
  assert.equal(d.docker.detail!.length, 500);
});

// @spec CTRL-STACK-002
test("launch: reports compose-up, runs up -d --remove-orphans with a 30 minute timeout, then waits", async () => {
  const h = harness({ psAnswers: [ps(ready)] });
  assert.equal((await h.stack.launch()).ok, true);
  assert.deepEqual(h.calls[0], { file: "docker", args: ["compose", "up", "-d", "--remove-orphans"], env: { BASE: "1" }, cwd: "/root", timeoutMs: 30 * 60_000 });
  assert.deepEqual(h.phases, [["launch", "compose-up"], ["launch", "waiting"]]);
});

// @spec CTRL-STACK-002
test("launch: a failing up resolves ok:false with trimmed stderr cut to 500 and never polls", async () => {
  const h = harness({ upFail: "pull access denied" });
  assert.deepEqual(await h.stack.launch(), { ok: false, detail: "pull access denied" });
  assert.deepEqual(h.calls.map((c) => c.args[1]), ["up"]);
  assert.deepEqual(h.phases, [["launch", "compose-up"]]);
  assert.equal((await harness({ upFail: "z".repeat(900) }).stack.launch()).detail!.length, 500);
});

// @spec CTRL-STACK-003
test("launch: polls every 2000 ms until every long-running container is running and healthy or has no healthcheck", async () => {
  const starting = ps([{ Service: "redis", State: "running", Health: "starting" }, { Service: "ollama", State: "running" }]);
  const h = harness({ psAnswers: [starting, starting, ps(ready)] });
  const r = await h.stack.launch();
  assert.equal(r.ok, true);
  assert.deepEqual(h.sleeps, [2000, 2000]);
  assert.deepEqual(r.services, [
    { service: "redis", status: "running", health: "healthy" },
    { service: "ollama", status: "running" },
    { service: "models", status: "exited", exitCode: 0 },
  ]);
});

// @spec CTRL-STACK-003
test("launch: the one-shots models and consolidate are not waited for", async () => {
  const h = harness({ psAnswers: [ps([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "models", State: "running" }, { Service: "consolidate", State: "created" }])] });
  assert.equal((await h.stack.launch()).ok, true);
  assert.deepEqual(h.sleeps, []);
});

// @spec CTRL-STACK-004
test("launch: not ready 180 s after up fails naming each container with status and health, and stops nothing", async () => {
  const bad = ps([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "cortex", State: "running", Health: "starting" }, { Service: "tts", State: "restarting" }]);
  const h = harness({ psAnswers: [bad] });
  const r = await h.stack.launch();
  assert.equal(r.ok, false);
  assert.match(r.detail!, /cortex \(running, starting\)/);
  assert.match(r.detail!, /tts \(restarting\)/);
  assert.doesNotMatch(r.detail!, /redis/);
  assert.equal(r.services!.length, 3);
  assert.ok(h.now() >= 180_000 && h.now() < 190_000);
  assert.ok(h.calls.every((c) => !["stop", "down", "rm", "restart"].includes(c.args[1]!)));
});

// @spec CTRL-STACK-004
test("launch: docker becoming unavailable while waiting fails with the probe's detail", async () => {
  const h = harness({ psAnswers: [ps([{ Service: "redis", State: "running", Health: "starting" }]), daemonDown()] });
  const r = await h.stack.launch();
  assert.equal(r.ok, false);
  assert.match(r.detail!, /daemon gone/);
});

// @spec CTRL-STACK-005
test("launch: a one-shot that exited non-zero is appended to detail, ok unchanged", async () => {
  const rows = ps([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "models", State: "exited", ExitCode: 2 }]);
  const r = await harness({ psAnswers: [rows] }).stack.launch();
  assert.deepEqual([r.ok, r.detail], [true, "models exited 2"]);
  const slow = ps([{ Service: "cortex", State: "running", Health: "starting" }, { Service: "models", State: "exited", ExitCode: 1 }]);
  const f = await harness({ psAnswers: [slow] }).stack.launch();
  assert.equal(f.ok, false);
  assert.match(f.detail!, /cortex \(running, starting\).*models exited 1/);
});

// @spec CTRL-STACK-006
test("stopAll: reports stopping, runs docker compose stop with 300 s, never down", async () => {
  const h = harness();
  assert.deepEqual(await h.stack.stopAll(), { ok: true });
  assert.deepEqual(h.calls, [{ file: "docker", args: ["compose", "stop"], env: { BASE: "1" }, cwd: "/root", timeoutMs: 300_000 }]);
  assert.deepEqual(h.phases, [["stop", "stopping"]]);
  assert.deepEqual(await harness({ stopFail: "boom" }).stack.stopAll(), { ok: false, detail: "boom" });
});

function ctl() {
  const log: string[] = [];
  const runtime: Runtime = {
    name: "compose",
    async start(id) { log.push(`start ${id}`); return id === "voice" ? { ok: false, detail: "boom" } : { ok: true }; },
    async stop(id) { log.push(`stop ${id}`); return { ok: true }; },
    async restart(id) { log.push(`restart ${id}`); return { ok: true }; },
  };
  const controller = new ServiceController({ runtime, groups: { resetGroup: async (g) => { log.push(`reset ${g}`); } }, by: "cohostctl" });
  return { log, controller };
}

// @spec CTRL-STACK-007, CTRL-STACK-010
test("restartAll: restarts running application units in manifest order, default mode, never infra or compose-only", async () => {
  const rows = ps([
    { Service: "redis", State: "running" }, { Service: "ollama", State: "running" },
    { Service: "cortex", State: "running" }, { Service: "chat", State: "running" },
    { Service: "memory", State: "exited" }, { Service: "ears", State: "running" },
  ]);
  const h = harness({ psAnswers: [rows] });
  const { controller, log } = ctl();
  const r = await h.stack.restartAll(controller);
  assert.deepEqual(log, ["stop chat", "reset chat", "start chat", "stop cortex", "reset cortex", "start cortex", "stop ears", "reset ears", "start ears"]);
  assert.equal(r.ok, true);
  assert.deepEqual(h.phases, [["restart", "restarting chat"], ["restart", "restarting cortex"], ["restart", "restarting ears"]]);
  assert.deepEqual(r.restarts!.map((x) => [x.id, x.ok]), [["chat", true], ["cortex", true], ["ears", true]]);
});

// @spec CTRL-STACK-007
test("restartAll: continues after a failure, ok only when all succeeded, detail names each failure", async () => {
  const rows = ps([{ Service: "memory", State: "running" }, { Service: "voice", State: "running" }, { Service: "avatar", State: "running" }]);
  const { controller, log } = ctl();
  const r = await harness({ psAnswers: [rows] }).stack.restartAll(controller);
  assert.equal(r.ok, false);
  assert.match(r.detail!, /voice: boom/);
  assert.deepEqual(log, ["restart memory", "stop voice", "reset voice", "start voice", "stop avatar", "reset avatar", "start avatar"]);
  assert.deepEqual(r.restarts!.map((x) => [x.id, x.ok]), [["memory", true], ["voice", false], ["avatar", true]]);
});

// @spec CTRL-STACK-007
test("restartAll: none running is ok:false 'no application service is running'", async () => {
  const { controller, log } = ctl();
  const r = await harness({ psAnswers: [ps([{ Service: "redis", State: "running" }])] }).stack.restartAll(controller);
  assert.deepEqual([r.ok, r.detail], [false, "no application service is running"]);
  assert.deepEqual(log, []);
});

// @spec CTRL-STACK-007
test("restartAll: docker unavailable is ok:false with the probe's detail", async () => {
  const { controller } = ctl();
  const r = await harness({ psAnswers: [daemonDown()] }).stack.restartAll(controller);
  assert.deepEqual([r.ok, r.detail], [false, "daemon gone"]);
});

// @spec CTRL-STACK-009
test("consolidate: runs the fixed one-shot through the compose runtime with the running phase", async () => {
  const h = harness();
  assert.deepEqual(await h.stack.consolidate(), { ok: true });
  assert.deepEqual(h.calls[0]!.args, ["compose", "run", "--rm", "-T", "consolidate"]);
  assert.equal(h.calls[0]!.timeoutMs, 30 * 60_000);
  assert.deepEqual(h.phases, [["consolidate", "running"]]);
});

// @spec CTRL-STACK-012
test("stack: docker binary lookup is COHOST_DOCKER_BIN, else docker, else docker.exe; none found names the variable", async () => {
  const mk = (env: NodeJS.ProcessEnv, onPath: (n: string) => boolean) => {
    const calls: Call[] = [];
    const exec: ExecFile = async (file, args, opts) => { calls.push({ file, args, env: opts.env }); return { stdout: "[]", stderr: "" }; };
    return { calls, stack: new StackController({ exec, env, onPath, cwd: "/r" }) };
  };
  const a = mk({ COHOST_DOCKER_BIN: "/opt/d" }, () => true);
  await a.stack.status();
  assert.equal(a.calls[0]!.file, "/opt/d");
  const b = mk({ COHOST_DOCKER_BIN: "" }, () => true);
  await b.stack.status();
  assert.equal(b.calls[0]!.file, "docker");
  const c = mk({}, (n) => n === "docker.exe");
  await c.stack.status();
  assert.deepEqual([c.calls[0]!.file, ...c.calls[0]!.args], ["docker.exe", "compose", "ps", "--all", "--format", "json"]);
  const none = mk({}, () => false);
  const s = await none.stack.status();
  assert.equal(s.docker.ok, false);
  assert.match(s.docker.detail!, /COHOST_DOCKER_BIN/);
  for (const r of [await none.stack.launch(), await none.stack.stopAll(), await none.stack.consolidate()]) {
    assert.equal(r.ok, false);
    assert.match(r.detail!, /COHOST_DOCKER_BIN/);
  }
  assert.equal(none.calls.length, 0);
});

// @spec CTRL-STACK-011
test("stackState: precedence docker-unavailable, stopping, starting, down, up, starting, degraded", () => {
  const st = (services: ContainerStatus[], docker: StackStatus["docker"] = { ok: true }): StackStatus => ({ docker, services });
  const run = (service: string, health?: string): ContainerStatus => ({ service, status: "running", ...(health ? { health } : {}) });
  const exited = (service: string, exitCode = 0): ContainerStatus => ({ service, status: "exited", exitCode });
  assert.equal(stackState(st([], { ok: false, detail: "x" }), "stop"), "docker-unavailable");
  assert.equal(stackState(st([run("redis", "healthy")]), "stop"), "stopping");
  assert.equal(stackState(st([run("redis", "healthy")]), "launch"), "starting");
  assert.equal(stackState(st([]), "launch"), "starting");
  assert.equal(stackState(st([]), undefined), "down");
  assert.equal(stackState(st([exited("redis"), run("models")]), undefined), "down");
  assert.equal(stackState(st([run("redis", "healthy"), run("ollama"), exited("models", 1)]), undefined), "up");
  assert.equal(stackState(st([run("redis", "healthy"), run("cortex", "starting")]), undefined), "starting");
  assert.equal(stackState(st([run("redis", "healthy"), exited("cortex", 1)]), undefined), "degraded");
  assert.equal(stackState(st([run("redis", "healthy"), { service: "tts", status: "restarting" }]), undefined), "degraded");
  assert.equal(stackState(st([run("redis", "unhealthy")]), undefined), "degraded");
  assert.equal(stackState(st([run("cortex", "starting"), exited("tts", 1)]), undefined), "degraded");
});
