import { test } from "node:test";
import assert from "node:assert/strict";
import { StackController, type ExecFile } from "../src/index.js";

type Call = { args: string[]; timeoutMs?: number };

const ID_A = "a".repeat(64);
const ID_B = "b1".repeat(6);

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
    exec, cwd: "/root", env: {}, onPath: (n) => n === "docker",
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
test("rebuild: a failing build resolves ok:false with the trimmed stderr and never polls; launch never passes --build", async () => {
  const h = harness({ upFail: " build failed " });
  assert.deepEqual(await h.stack.rebuild(), { ok: false, detail: "build failed" });
  assert.deepEqual(h.calls.map((c) => c.args[1]), ["up"]);
  const l = harness();
  await l.stack.launch();
  assert.ok(!l.calls[0]!.args.includes("--build"));
});

// @spec CTRL-STACK-014
test("statusWithRestarts: ps -q then one fixed-format inspect over the ids, counts land on their containers", async () => {
  const h = harness({
    psJson: JSON.stringify([{ Service: "redis", State: "running", Health: "healthy" }, { Service: "cortex", State: "restarting" }]),
    psQ: `${ID_A}\n${ID_B}\n`,
    inspect: "cortex 7\nredis 0\n",
  });
  const s = await h.stack.statusWithRestarts();
  assert.deepEqual(s.services, [
    { service: "redis", status: "running", health: "healthy", restartCount: 0 },
    { service: "cortex", status: "restarting", restartCount: 7 },
  ]);
  const ps = h.calls.find((c) => c.args.includes("-q"))!;
  assert.deepEqual(ps.args, ["compose", "ps", "--all", "-q"]);
  const inspect = h.calls.find((c) => c.args[0] === "inspect")!;
  assert.deepEqual(inspect.args, ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}} {{.RestartCount}}', ID_A, ID_B]);
});

// @spec CTRL-STACK-014
test("statusWithRestarts: only ids shaped like container ids reach the argv", async () => {
  const h = harness({ psQ: `${ID_A}\n--privileged\n; rm -rf /\nzz\n`, inspect: "redis 1\n" });
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

// @spec CTRL-STACK-014
test("status and the launch readiness poll run no extra command", async () => {
  const h = harness();
  await h.stack.status();
  await h.stack.launch();
  assert.ok(h.calls.every((c) => c.args[0] !== "inspect" && !c.args.includes("-q")));
});
