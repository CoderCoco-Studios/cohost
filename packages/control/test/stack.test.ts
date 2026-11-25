import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS } from "./workspace.js";
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
  const cwd = mkdtempSync(join(tmpdir(), "cohost-stack-")); // a writable workspace: the Pocket token file goes under it
  const stack = new StackController({
    exec, cwd, env: { BASE: "1" }, onPath: (n) => n === "docker",
    onPhase: (k, p) => phases.push([k, p]),
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    readPocketConfig: () => ({ token: "", engine: "kokoro" }), // the config loader is never read here
  });
  return { stack, calls, phases, sleeps, now: () => t, cwd };
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
  assert.deepEqual(h.calls, [{ file: "docker", args: ["compose", "ps", "--all", "--format", "json"], env: { BASE: "1", COHOST_ISOLATION: "" }, cwd: h.cwd, timeoutMs: 10_000 }]);
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
test("launch: reports compose-build, runs up -d --build --remove-orphans with a 30 minute timeout, then waits", async () => {
  const h = harness({ psAnswers: [ps(ready)] });
  assert.equal((await h.stack.launch()).ok, true);
  assert.deepEqual(h.calls[0], { file: "docker", args: ["compose", "up", "-d", "--build", "--remove-orphans"], env: { BASE: "1", COHOST_ISOLATION: "" }, cwd: h.cwd, timeoutMs: 30 * 60_000 });
  assert.deepEqual(h.phases, [["launch", "compose-build"], ["launch", "waiting"]]);
});

// @spec CTRL-STACK-002
test("launch: a failing up resolves ok:false with trimmed stderr cut to 500 and never polls", async () => {
  const h = harness({ upFail: "pull access denied" });
  assert.deepEqual(await h.stack.launch(), { ok: false, detail: "pull access denied" });
  assert.deepEqual(h.calls.map((c) => c.args[1]), ["up"]);
  assert.deepEqual(h.phases, [["launch", "compose-build"]]);
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
  assert.deepEqual(h.calls, [{ file: "docker", args: ["compose", "stop"], env: { BASE: "1", COHOST_ISOLATION: "" }, cwd: h.cwd, timeoutMs: 300_000 }]);
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
    return { calls, stack: new StackController({ exec, env, onPath, cwd: WS }) };
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

// @spec CTRL-STACK-017
test("every docker compose call sets COHOST_ISOLATION to the empty string, whatever the process environment holds; WSLENV forwards it for docker.exe", async () => {
  for (const bin of ["docker", "docker.exe"]) {
    const calls: Call[] = [];
    const exec: ExecFile = async (file, args, opts) => { calls.push({ file, args, env: opts.env }); return { stdout: args[1] === "ps" ? ps([]) : "", stderr: "" }; };
    const stack = new StackController({
      exec, cwd: WS, env: { COHOST_ISOLATION: '{"AVATAR_DRIVER":"null"}', WSLENV: "PATH/l" }, onPath: (n) => n === bin,
      now: () => 0, sleep: async () => {}, readPocketConfig: () => ({ token: "", engine: "kokoro" }),
    });
    await stack.status();
    await stack.launch();
    await stack.stopAll();
    const compose = calls.filter((c) => c.args[0] === "compose");
    assert.ok(compose.length >= 3, "ps, up and stop all ran");
    for (const c of compose) {
      assert.equal(c.env.COHOST_ISOLATION, "", `${c.args.join(" ")} on ${bin}`);
      if (bin === "docker.exe") assert.equal(c.env.WSLENV, "PATH/l:COHOST_ISOLATION");
      else assert.equal(c.env.WSLENV, "PATH/l");
    }
  }
});

// @spec CTRL-STACK-018
test("launch: enabled engine profiles add no argument: the command is the same with COMPOSE_PROFILES naming pocket, nemotron and kyutai, or none of them", async () => {
  const argv = ["compose", "up", "-d", "--build", "--remove-orphans"];
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-")); // the token file goes under the workspace root, so a writable one
  for (const profiles of [undefined, "pocket", "nemotron,kyutai", "discord,ears,pocket,nemotron,kyutai"]) {
    const calls: Call[] = [];
    const exec: ExecFile = async (file, args, opts) => { calls.push({ file, args, env: opts.env, cwd: opts.cwd, timeoutMs: opts.timeoutMs }); return { stdout: args[1] === "ps" ? ps(ready) : "", stderr: "" }; };
    const env: NodeJS.ProcessEnv = { BASE: "1", ...(profiles ? { COMPOSE_PROFILES: profiles } : {}) };
    const stack = new StackController({ exec, cwd: dir, env, onPath: (n) => n === "docker", now: () => 0, sleep: async () => {}, readPocketConfig: () => ({ token: "", engine: "kokoro" }) });
    assert.equal((await stack.launch()).ok, true);
    const up = calls.find((c) => c.args[1] === "up")!;
    assert.deepEqual([up.file, ...up.args], ["docker", ...argv], `COMPOSE_PROFILES=${profiles}`);
    assert.equal(up.env.COMPOSE_PROFILES, profiles, "the variable reaches Compose unchanged, which selects the profiles");
    assert.ok(!calls.some((c) => c.args.includes("--profile")), "no --profile argument is added");
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Launches in the throwaway workspace `dir`. The Pocket reader is stubbed: it returns `token` and `engine`, or throws
 * `readError`. `blockDir` puts a file where `data/` must be, so the token directory cannot be created.
 */
async function launchIn(dir: string, opts: { token?: string; engine?: string; readError?: string; blockDir?: boolean } = {}) {
  const saw: { dir: boolean; file: boolean; content?: string; mode?: number; order: string[] } = { dir: false, file: false, order: [] };
  const secretDir = join(dir, "data", "tts-pocket-secret");
  const exec: ExecFile = async (_file, args) => {
    saw.order.push(args[1]!);
    if (args[1] === "up") {
      saw.dir = existsSync(secretDir) && statSync(secretDir).isDirectory();
      saw.file = existsSync(join(secretDir, "hf_token"));
      if (saw.file) {
        saw.content = readFileSync(join(secretDir, "hf_token"), "utf8");
        saw.mode = statSync(join(secretDir, "hf_token")).mode & 0o777;
      }
    }
    return { stdout: args[1] === "ps" ? ps(ready) : "", stderr: "" };
  };
  const readPocketConfig = () => {
    if (opts.readError !== undefined) throw new Error(opts.readError);
    return { token: opts.token ?? "", engine: opts.engine ?? "kokoro" };
  };
  if (opts.blockDir) writeFileSync(join(dir, "data"), "not a directory");
  const stack = new StackController({ exec, cwd: dir, env: { BASE: "1" }, onPath: (n) => n === "docker", now: () => 0, sleep: async () => {}, readPocketConfig });
  const r = await stack.launch();
  return { r, saw, secretDir };
}

// @spec CTRL-STACK-019
test("launch: writes the Pocket token to data/tts-pocket-secret/hf_token under the workspace root, directory created first, before docker compose up, and no other file under data/", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    const { r, saw, secretDir } = await launchIn(dir, { token: "hf_abc123", engine: "pocket" });
    assert.equal(r.ok, true, r.detail);
    assert.ok(saw.dir, "the directory existed when up ran");
    assert.equal(saw.content, "hf_abc123", "the file holds only the token");
    assert.ok(saw.order.indexOf("up") >= 0);
    assert.equal(readFileSync(join(secretDir, "hf_token"), "utf8"), "hf_abc123");
    const written = new Set<string>();
    const walk = (d: string, rel = ""): void => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, `${rel}${n}/`) : written.add(`${rel}${n}`); } };
    walk(join(dir, "data"));
    assert.deepEqual([...written], ["tts-pocket-secret/hf_token"], "no other secret is written to a file under data/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec CTRL-STACK-019
test("launch: the token file is mode 0600 and rewritten on every launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    const first = await launchIn(dir, { token: "first" });
    assert.equal(first.saw.content, "first");
    assert.equal(first.saw.mode, 0o600, "mode 0600 on creation");
    const second = await launchIn(dir, { token: "second" });
    assert.equal(second.saw.content, "second", "rewritten on every launch");
    assert.equal(second.saw.mode, 0o600, "mode 0600 after a rewrite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec CTRL-STACK-019
test("launch: a blank or whitespace-only token leaves the file absent, removing a stale one, and the directory is still created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    assert.equal((await launchIn(dir, { token: "stale" })).saw.file, true);
    for (const token of ["", "   \n\t "]) {
      const blank = await launchIn(dir, { token });
      assert.equal(blank.r.ok, true, blank.r.detail);
      assert.ok(blank.saw.dir, "the directory is created even with no token");
      assert.equal(blank.saw.file, false, `token ${JSON.stringify(token)} leaves the file absent`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec CTRL-STACK-019
test("launch: when the pocket engine is selected and the token file cannot be written, Launch fails before up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    const { r, saw } = await launchIn(dir, { token: "hf_abc", engine: "pocket", blockDir: true });
    assert.equal(r.ok, false);
    assert.match(r.detail!, /^cannot write the tts-pocket token file: /);
    assert.deepEqual(saw.order, [], "docker compose up never ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec CTRL-STACK-019
test("launch: an unreadable config proceeds with a warning and removes a stale token file, the pocket engine not being known", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    assert.equal((await launchIn(dir, { token: "stale" })).saw.file, true);
    const { r, saw } = await launchIn(dir, { readError: "bad secrets.yaml\nmore" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.detail, "cannot read voice.pocket.hf_token: bad secrets.yaml", "the warning is reported");
    assert.ok(saw.order.includes("up"));
    assert.equal(saw.file, false, "the stale token is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec CTRL-STACK-019
test("launch: a blocked token directory with the kokoro engine selected warns and proceeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-stack-"));
  try {
    const { r, saw } = await launchIn(dir, { token: "hf_abc", blockDir: true });
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail!, /^cannot write the tts-pocket token file: /);
    assert.ok(saw.order.includes("up"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
