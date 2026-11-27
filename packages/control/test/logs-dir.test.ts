import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposeRuntime, StackController, type ExecFile, NO_PROVISION } from "../src/index.js";

const initial = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in initial)) delete process.env[k];
  Object.assign(process.env, initial);
});

const onPath = (n: string): boolean => n === "docker";

/** A workspace root with no `data/logs`. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cohost-ctl-logs-"));
}

/** An exec that records, for each docker command, whether `data/logs` existed as a directory when it ran. */
function recorder(root: string) {
  const calls: { args: string[]; logs: boolean }[] = [];
  const exec: ExecFile = async (_file, args) => {
    const logs = join(root, "data", "logs");
    calls.push({ args, logs: existsSync(logs) && statSync(logs).isDirectory() });
    return { stdout: args[1] === "ps" ? "" : args[0] === "wait" ? "0\n" : "done\n", stderr: "" };
  };
  return { exec, calls };
}

// @spec CTRL-RUNTIME-016
test("start, both forms of restart, consolidate and reembed create data/logs before their docker compose command; stop does not", async () => {
  const stopRoot = workspace();
  const stopper = recorder(stopRoot);
  assert.equal((await new ComposeRuntime({ provision: NO_PROVISION, exec: stopper.exec, onPath, cwd: stopRoot, env: {} }).stop("cortex")).ok, true);
  assert.equal(existsSync(join(stopRoot, "data", "logs")), false, "stop creates nothing");

  const verbs: [string, (rt: ComposeRuntime) => Promise<{ ok: boolean }>][] = [
    ["start", (rt) => rt.start("cortex")],
    ["restart", (rt) => rt.restart("cortex")],
    ["restart with a preset", (rt) => rt.restart("cortex", { env: { LLM_PROVIDER: "mock" } })],
    ["consolidate", (rt) => rt.consolidate()],
    ["reembed", (rt) => rt.reembed()],
  ];
  for (const [name, run] of verbs) {
    const root = workspace();
    const { exec, calls } = recorder(root);
    assert.equal((await run(new ComposeRuntime({ provision: NO_PROVISION, exec, onPath, cwd: root, env: {} }))).ok, true, name);
    assert.deepEqual(calls.filter((c) => c.args[0] === "compose").map((c) => c.logs), [true], `${name}: data/logs exists when docker compose runs`);
  }
});

// @spec CTRL-RUNTIME-016
test("StackController.launch and rebuild create data/logs before docker compose up", async () => {
  for (const kind of ["launch", "rebuild"] as const) {
    const root = workspace();
    const { exec, calls } = recorder(root);
    await new StackController({ provision: NO_PROVISION, exec, onPath, cwd: root, env: {}, now: () => 0, sleep: async () => {} })[kind]();
    const up = calls.find((c) => c.args[1] === "up");
    assert.ok(up, `${kind} ran docker compose up`);
    assert.equal(up.logs, true, `${kind}: data/logs exists before up`);
  }
});

// @spec CTRL-RUNTIME-016
test("a data/logs that cannot be created is a warning and the command still runs", async () => {
  const root = workspace();
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "logs"), "a file where the directory belongs");
  const warnings: string[] = [];
  const { exec, calls } = recorder(root);
  const rt = new ComposeRuntime({ provision: NO_PROVISION, exec, onPath, cwd: root, env: {}, warn: (m) => warnings.push(m) });
  assert.equal((await rt.start("cortex")).ok, true);
  assert.equal(calls.length, 1, "docker compose still ran");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /data\/logs.*EEXIST/);

  const stackWarnings: string[] = [];
  const stack = recorder(root);
  await new StackController({ provision: NO_PROVISION, exec: stack.exec, onPath, cwd: root, env: {}, now: () => 0, sleep: async () => {}, warn: (m) => stackWarnings.push(m) }).launch();
  assert.ok(stack.calls.some((c) => c.args[1] === "up"), "launch still ran up");
  assert.equal(stackWarnings.length, 1);
});
