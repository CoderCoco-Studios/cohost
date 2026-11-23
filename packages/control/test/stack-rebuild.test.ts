import { test } from "node:test";
import assert from "node:assert/strict";
import { StackController, type ExecFile } from "../src/index.js";

type Call = { args: string[]; timeoutMs?: number };

const ID_A = "a".repeat(64);
const ID_B = "b1".repeat(6);
/** The `{{json .Config.Env}}` part of an inspect line: a JSON array of `NAME=value` entries. */
const env = (...entries: string[]): string => JSON.stringify(["PATH=/usr/bin", ...entries]);
const iso = (o: unknown): string => `COHOST_ISOLATION=${typeof o === "string" ? o : JSON.stringify(o)}`;

/** A scripted exec. `psJson` answers `ps --format json`, `psQ` answers `ps -q`, `inspect` answers `docker inspect`. */
function harness(o: { psJson?: string; psQ?: string | Error; inspect?: string | Error; upFail?: string } = {}) {
  const calls: Call[] = [];
  const phases: Array<[string, string]> = [];
  let t = 0;
  const exec: ExecFile = async (_file, args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    if (args[0] === "inspect") {
      if (o.inspect instanceof Error) throw o.inspect;
      return { stdout: o.inspect ?? "", stderr: "" };
    }
    if (args[1] === "ps" && args.includes("-q")) {
      if (o.psQ instanceof Error) throw o.psQ;
      return { stdout: o.psQ ?? "", stderr: "" };
    }
    if (args[1] === "ps") return { stdout: o.psJson ?? JSON.stringify([{ Service: "redis", State: "running", Health: "healthy" }]), stderr: "" };
    if (args[1] === "up" && o.upFail) throw Object.assign(new Error("exit 1"), { stderr: o.upFail });
    return { stdout: "", stderr: "" };
  };
  const stack = new StackController({
    exec, cwd: "/root", env: {}, onPath: (n) => n === "docker", readPocketConfig: () => ({ token: "", engine: "kokoro" }),
    onPhase: (k, p) => phases.push([k, p]), now: () => t, sleep: async (ms) => { t += ms; },
  });
  return { stack, calls, phases };
}

// @spec CTRL-STACK-013
test("rebuild: reports compose-build, runs up -d --build --remove-orphans with the launch timeout, then waits like launch", async () => {
  const h = harness();
  const r = await h.stack.rebuild();
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls[0], { args: ["compose", "up", "-d", "--build", "--remove-orphans"], timeoutMs: 30 * 60_000 });
  assert.deepEqual(h.phases, [["rebuild", "compose-build"], ["rebuild", "waiting"]]);
  assert.deepEqual(r.services, [{ service: "redis", status: "running", health: "healthy" }]);
});

// @spec CTRL-STACK-013
test("rebuild: a failing build resolves ok:false with the trimmed stderr and never polls; launch passes --build too (it is the same command)", async () => {
  const h = harness({ upFail: " build failed " });
  assert.deepEqual(await h.stack.rebuild(), { ok: false, detail: "build failed" });
  assert.deepEqual(h.calls.map((c) => c.args[1]), ["up"]);
  const l = harness();
  await l.stack.launch();
  assert.deepEqual(l.calls[0]!.args, h.calls[0]!.args);
});

// @spec CTRL-STACK-014
test("statusWithRestarts: ps -q then one fixed-format inspect over the ids, counts land on their containers", async () => {
  const h = harness({
    psJson: JSON.stringify([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "cortex", State: "restarting" }]),
    psQ: `${ID_A}\n${ID_B}\n`,
    inspect: `cortex 7 ${env()}\nredis 0 ${env()}\n`,
  });
  const s = await h.stack.statusWithRestarts();
  assert.deepEqual(s.services, [
    { service: "redis", status: "running", health: "healthy", restartCount: 0, overrides: {} },
    { service: "cortex", status: "restarting", restartCount: 7, overrides: {} },
  ]);
  const ps = h.calls.find((c) => c.args.includes("-q"))!;
  assert.deepEqual(ps.args, ["compose", "ps", "--all", "-q"]);
  const inspect = h.calls.find((c) => c.args[0] === "inspect")!;
  assert.deepEqual(inspect.args, ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}} {{.RestartCount}} {{json .Config.Env}}', ID_A, ID_B]);
});

// @spec CTRL-STACK-014
test("statusWithRestarts: only ids shaped like container ids reach the argv", async () => {
  const h = harness({ psQ: `${ID_A}\n--privileged\n; rm -rf /\nzz\n`, inspect: `redis 1 ${env()}\n` });
  await h.stack.statusWithRestarts();
  const inspect = h.calls.find((c) => c.args[0] === "inspect")!;
  assert.deepEqual(inspect.args.slice(3), [ID_A]);
});

// @spec CTRL-STACK-014
test("statusWithRestarts: a failing ps -q or inspect still resolves the status, without counts; docker down skips both", async () => {
  const noCounts = [{ service: "redis", status: "running", health: "healthy" }];
  assert.deepEqual((await harness({ psQ: new Error("boom") }).stack.statusWithRestarts()).services, noCounts);
  assert.deepEqual((await harness({ psQ: ID_A, inspect: new Error("boom") }).stack.statusWithRestarts()).services, noCounts);
  assert.deepEqual((await harness({ psQ: ID_A, inspect: "garbage line without a count\n" }).stack.statusWithRestarts()).services, noCounts);
  const down = harness({ psJson: "not json" });
  const s = await down.stack.statusWithRestarts();
  assert.equal(s.docker.ok, false);
  assert.equal(down.calls.length, 1);
});

// @spec CTRL-STACK-016
test("statusWithRestarts: overrides keep only the manifest's isolation names with a non-empty value, from the COHOST_ISOLATION entry", async () => {
  const h = harness({
    psJson: JSON.stringify([
      { Service: "cortex", State: "running" }, { Service: "avatar", State: "running" }, { Service: "redis", State: "running" }, { Service: "voice", State: "running" },
    ]),
    psQ: ID_A,
    inspect: [
      `cortex 0 ${env("TOKEN=hunter2", iso({ LLM_PROVIDER: "mock", DISCORD_TOKEN: "hunter2", VOICE_ENGINE: "" }))}`,
      `avatar 2 ${env(iso({ AVATAR_DRIVER: "null" }), "LLM_PROVIDER=mock")}`,
      `redis 0 ${env()}`,
      `voice 0 ${env(iso(""))}`,
    ].join("\n"),
  });
  const s = await h.stack.statusWithRestarts();
  const of = (name: string) => s.services.find((c) => c.service === name)!;
  assert.deepEqual(of("cortex").overrides, { LLM_PROVIDER: "mock" }, "other names and empty values are dropped");
  assert.deepEqual(of("avatar").overrides, { AVATAR_DRIVER: "null" }, "a per-name variable is not read");
  assert.deepEqual(of("redis").overrides, {}, "an absent entry reports none");
  assert.deepEqual(of("voice").overrides, {}, "an empty entry reports none");
  assert.equal(of("avatar").restartCount, 2);
  assert.ok(!JSON.stringify(s).includes("hunter2"), "no other environment entry reaches the status");
});

// @spec CTRL-STACK-016
test("statusWithRestarts: an entry that is not a JSON object leaves that container without overrides, its count kept", async () => {
  const bad = [iso("not json"), iso("[1]"), iso("null"), iso('"x"')];
  for (const entry of bad) {
    const h = harness({ psQ: ID_A, inspect: `redis 3 ${env(entry)}\n` });
    const [c] = (await h.stack.statusWithRestarts()).services;
    assert.deepEqual(c, { service: "redis", status: "running", health: "healthy", restartCount: 3 }, entry);
  }
  const noEnv = harness({ psQ: ID_A, inspect: "redis 3 null\n" }); // a container with no environment at all sets none
  assert.deepEqual((await noEnv.stack.statusWithRestarts()).services, [{ service: "redis", status: "running", health: "healthy", restartCount: 3, overrides: {} }]);
});

// @spec CTRL-STACK-014, CTRL-STACK-016
test("statusWithRestarts: the inspect output never reaches a detail, a status field or a log line, whether it parsed or the command failed", async () => {
  const logged: string[] = [];
  const realWrite = process.stdout.write, realErr = process.stderr.write;
  const spy = (chunk: unknown): boolean => { logged.push(String(chunk)); return true; };
  process.stdout.write = spy as typeof process.stdout.write; process.stderr.write = spy as typeof process.stderr.write;
  const results: unknown[] = [];
  try {
    const secret = env("DISCORD_TOKEN=hunter2", "CONTROL_TOKEN=hunter2");
    results.push(await harness({ psQ: ID_A, inspect: `redis 0 ${secret}\n` }).stack.statusWithRestarts());
    results.push(await harness({ psQ: ID_A, inspect: Object.assign(new Error(`inspect failed ${secret}`), { stderr: secret }) }).stack.statusWithRestarts());
    results.push(await harness({ psQ: ID_A, inspect: `redis 0 ${secret} trailing\n` }).stack.statusWithRestarts());
  } finally { process.stdout.write = realWrite; process.stderr.write = realErr; }
  assert.ok(!JSON.stringify(results).includes("hunter2"));
  assert.ok(!logged.join("").includes("hunter2"));
  assert.deepEqual((results[1] as { services: unknown[] }).services, [{ service: "redis", status: "running", health: "healthy" }]);
  assert.deepEqual((results[2] as { services: unknown[] }).services, [{ service: "redis", status: "running", health: "healthy", restartCount: 0 }], "an unparsable environment gives no overrides");
});

// @spec CTRL-STACK-014
test("status and the launch readiness poll run no extra command", async () => {
  const h = harness();
  await h.stack.status();
  await h.stack.launch();
  assert.ok(h.calls.every((c) => c.args[0] !== "inspect" && !c.args.includes("-q")));
});
