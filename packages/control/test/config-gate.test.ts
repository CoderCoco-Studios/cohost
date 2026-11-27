import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@cohost/store";
import { StackController, configRefusal, executeCli, type CliWiring, type ExecFile, type LockResult } from "../src/index.js";

// @spec CTRL-GATE-001
test("configRefusal is undefined for a usable store and otherwise names the count, the first path or cause and the recovery screen", async () => {
  assert.equal(await configRefusal(() => []), undefined);
  assert.equal(
    await configRefusal(() => [{ cause: "settings", path: "llm.model", message: "bad" }, { cause: "settings", path: "cohost.name", message: "bad" }]),
    "the settings store cannot be used (2 problems; first: llm.model): fix it on the dashboard's recovery screen (mise run dashboard) or with mise run config:check, then try again",
  );
  assert.match((await configRefusal(async () => [{ cause: "key", message: "the master key file is missing" }]))!, /^the settings store cannot be used \(1 problem; first: key\)/);
  await assert.rejects(configRefusal(() => { throw new Error("EACCES"); }), /EACCES/);
});

// @spec CTRL-GATE-001
test("configRefusal checks the settings store fresh by default", async () => {
  const saved = process.env.COHOST_DATA_DIR;
  try {
    process.env.COHOST_DATA_DIR = mkdtempSync(join(tmpdir(), "cohost-gate-"));
    (await openStore({ notice: { isTTY: false, write: () => {}, warn: () => {} }, warn: () => {} })).close();
    assert.equal(await configRefusal(), undefined, "a store seeded from the shipped examples can be used");
    const damaged = mkdtempSync(join(tmpdir(), "cohost-gate-"));
    mkdirSync(join(damaged, "store"));
    writeFileSync(join(damaged, "store", "cohost.db"), "not a database at all, just text that is long enough to be read as a header");
    process.env.COHOST_DATA_DIR = damaged;
    assert.match((await configRefusal())!, /first: damaged\)/);
  } finally {
    if (saved === undefined) delete process.env.COHOST_DATA_DIR; else process.env.COHOST_DATA_DIR = saved;
  }
});

/** A wiring whose every factory records being used; only the config gate decides the outcome. */
function wiring(refusal: string | undefined) {
  const used: string[] = [];
  const err: string[] = [];
  const ok = async () => { used.push("runtime"); return { ok: true }; };
  const w: CliWiring = {
    configRefusal: async () => refusal,
    openBus: () => { used.push("bus"); return { publish: async () => "1", resetGroup: async () => {}, recentHealth: async () => [], recent: async () => [], stop: () => {} } as never; },
    buildRuntime: () => ({ name: "compose", start: ok, stop: ok, restart: ok, consolidate: ok, reembed: ok }) as never,
    buildStack: () => { used.push("stack"); return { launch: async () => ({ ok: true }), rebuild: async () => ({ ok: true }), stopAll: async () => ({ ok: true }), restartAll: async () => ({ ok: true, restarts: [] }), statusWithRestarts: async () => ({ docker: { ok: false, detail: "x" }, services: [] }) } as never; },
    redeliver: async () => { used.push("deliver"); return { delivered: [], failures: [] }; },
    lock: { tryAcquire: (): LockResult => { used.push("lock"); return { ok: true, release: () => {} }; } },
    out: () => {}, err: (l) => err.push(l), env: {},
  };
  return { w, used, err };
}

// @spec CTRL-CLI-018
test("launch, rebuild, start, restart, restart-all, deliver, consolidate and reembed print the refusal and exit 1 before the lock, the bus or Docker", async () => {
  for (const argv of [["launch"], ["rebuild"], ["start", "voice"], ["restart", "voice"], ["restart-all"], ["deliver"], ["consolidate"], ["reembed"]]) {
    const h = wiring("the settings store cannot be used (1 problem; first: llm.model): fix it");
    assert.equal(await executeCli(argv, h.w), 1, argv.join(" "));
    assert.deepEqual(h.used, [], argv.join(" "));
    assert.deepEqual(h.err, ["the settings store cannot be used (1 problem; first: llm.model): fix it"]);
  }
});

// @spec CTRL-CLI-018
test("stop, stop-all, status and latency are not gated, and a usable store lets a gated command run", async () => {
  for (const argv of [["stop", "voice"], ["stop-all"], ["latency"], ["status"]]) {
    const h = wiring("refused");
    assert.equal(await executeCli(argv, h.w), 0, argv.join(" "));
  }
  const h = wiring(undefined);
  assert.equal(await executeCli(["launch"], h.w), 0);
  assert.ok(h.used.includes("lock"));
  const bad = wiring("x");
  assert.equal(await executeCli(["launch", "extra"], bad.w), 2, "usage still comes first");
});

// @spec CTRL-GATE-002
test("a StackController is built and stops the stack without opening the settings store, while the store is damaged", async () => {
  const saved = process.env.COHOST_DATA_DIR;
  const damaged = mkdtempSync(join(tmpdir(), "cohost-gate-stop-"));
  mkdirSync(join(damaged, "store"));
  writeFileSync(join(damaged, "store", "cohost.db"), "not a database at all, just text that is long enough to be read as a header");
  process.env.COHOST_DATA_DIR = damaged;
  try {
    assert.match((await configRefusal())!, /^the settings store cannot be used/, "the store really is damaged");
    const calls: { file: string; args: string[]; cwd?: string; isolation?: string; composeFile?: string }[] = [];
    const exec: ExecFile = async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd, isolation: opts.env.COHOST_ISOLATION, composeFile: opts.env.COMPOSE_FILE }); return { stdout: "", stderr: "" }; };
    const stack = new StackController({ exec, cwd: "/ws", env: { COHOST_DOCKER_BIN: "/opt/docker", COMPOSE_FILE: "docker-compose.yml:docker-compose.gpu.yml" } });
    assert.deepEqual(await stack.stopAll(), { ok: true });
    assert.deepEqual(calls, [{ file: "/opt/docker", args: ["compose", "stop"], cwd: "/ws", isolation: "", composeFile: "docker-compose.yml:docker-compose.gpu.yml" }]);
  } finally {
    if (saved === undefined) delete process.env.COHOST_DATA_DIR; else process.env.COHOST_DATA_DIR = saved;
  }
});
