import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ComposeRuntime, ProcessRuntime, type ChildLike, type ExecFile, type Spawner } from "../src/index.js";

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

test("compose: crafted ids are rejected without exec", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ exec });
  for (const id of ["nope", "cortex; rm -rf /", "$(id)", "--help"]) {
    const r = await rt.start(id);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0);
});

test("compose: isolated env goes in the child env and restart recreates", async () => {
  const { exec, calls } = fakeExec();
  const rt = new ComposeRuntime({ exec, env: { A: "1" } });
  await rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } });
  assert.deepEqual(calls[0]!.args, ["compose", "up", "-d", "--force-recreate", "cortex"]);
  assert.equal(calls[0]!.env.LLM_PROVIDER, "mock");
  assert.equal(calls[0]!.env.A, "1");
});

test("compose: a failing command is ok:false with stderr as detail", async () => {
  const rt = new ComposeRuntime({ exec: fakeExec("no such service").exec });
  assert.deepEqual(await rt.start("cortex"), { ok: false, detail: "no such service" });
});

// ---- process ----

class FakeChild extends EventEmitter implements ChildLike {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(public pid: number) { super(); }
  exit() { this.exitCode = 0; this.emit("exit", 0, null); }
}

function fakeSpawner(opts: { failSpawn?: boolean; ignoreTerm?: boolean } = {}) {
  const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const signals: { pid: number; sig: string }[] = [];
  const children: FakeChild[] = [];
  const spawn: Spawner = (cmd, args, o) => {
    spawned.push({ cmd, args, env: o.env });
    const c = new FakeChild(1000 + children.length);
    children.push(c);
    process.nextTick(() => (opts.failSpawn ? c.emit("error", new Error("ENOENT")) : c.emit("spawn")));
    return c;
  };
  const signal = (c: ChildLike, sig: NodeJS.Signals) => {
    signals.push({ pid: c.pid!, sig });
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !opts.ignoreTerm)) process.nextTick(() => (c as FakeChild).exit());
  };
  return { spawn, signal, spawned, signals, children };
}

test("process: spawns pnpm with a fixed argv and records the pid", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal, env: {} });
  const r = await rt.start("cortex");
  assert.equal(r.ok, true);
  assert.deepEqual(f.spawned[0]!.cmd, "pnpm");
  assert.deepEqual(f.spawned[0]!.args, ["--filter", "@cohost/cortex", "dev"]);
  assert.equal(rt.pid("cortex"), 1000);
  await rt.start("voice", { processMode: "start", env: { VOICE_ENGINE: "stub" } });
  assert.deepEqual(f.spawned[1]!.args, ["--filter", "@cohost/voice", "start"]);
  assert.equal(f.spawned[1]!.env.VOICE_ENGINE, "stub");
});

test("process: starting twice does not spawn a second copy", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal });
  await rt.start("affect");
  const r = await rt.start("affect");
  assert.equal(r.ok, true);
  assert.equal(f.spawned.length, 1);
});

test("process: crafted/unknown ids and compose-only services never spawn", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal });
  for (const id of ["nope", "cortex; rm -rf /", "redis", "ollama"]) assert.equal((await rt.start(id)).ok, false, id);
  assert.equal(f.spawned.length, 0);
});

test("process: a spawn error is ok:false and nothing is tracked", async () => {
  const f = fakeSpawner({ failSpawn: true });
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal });
  const r = await rt.start("cortex");
  assert.equal(r.ok, false);
  assert.match(r.detail!, /ENOENT/);
  assert.equal(rt.pid("cortex"), undefined);
});

test("process: stop sends SIGTERM and only SIGTERM when the process exits", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal, killTimeoutMs: 1000 });
  await rt.start("cortex");
  const r = await rt.stop("cortex");
  assert.equal(r.ok, true);
  assert.deepEqual(f.signals, [{ pid: 1000, sig: "SIGTERM" }]);
  assert.equal(rt.pid("cortex"), undefined);
});

test("process: SIGKILL after the timeout when SIGTERM is ignored", async () => {
  const f = fakeSpawner({ ignoreTerm: true });
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal, killTimeoutMs: 20 });
  await rt.start("cortex");
  const r = await rt.stop("cortex");
  assert.deepEqual(f.signals.map((s) => s.sig), ["SIGTERM", "SIGKILL"]);
  assert.match(r.detail!, /SIGKILL/);
});

test("process: stopping something it did not start is ok:false; a self-exit clears the pid", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal });
  assert.equal((await rt.stop("cortex")).ok, false);
  await rt.start("cortex");
  f.children[0]!.exit();
  assert.equal(rt.pid("cortex"), undefined);
});

test("process: restart stops then starts a fresh process", async () => {
  const f = fakeSpawner();
  const rt = new ProcessRuntime({ spawn: f.spawn, signal: f.signal });
  await rt.start("cortex");
  assert.equal((await rt.restart("cortex")).ok, true);
  assert.equal(f.spawned.length, 2);
  assert.equal(rt.pid("cortex"), 1001);
});
