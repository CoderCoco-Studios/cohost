import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigProblem } from "@cohost/config";
import { configRefusal, executeCli, type CliWiring, type LockResult } from "../src/index.js";

const problem = (path: string, file = "/x/config.yaml"): ConfigProblem => ({ file, path, message: "bad", kind: "placeholder" });

// @spec CTRL-GATE-001
test("configRefusal is undefined for a valid config and otherwise names the count, the first path and the recovery screen", () => {
  assert.equal(configRefusal(() => []), undefined);
  assert.equal(
    configRefusal(() => [problem("llm.model"), problem("cohost.name")]),
    "the config is invalid (2 problems; first: llm.model): fix it on the dashboard's config recovery screen (mise run dashboard), then try again",
  );
  assert.match(configRefusal(() => [problem("", "/x/secrets.yaml")])!, /^the config is invalid \(1 problem; first: \/x\/secrets\.yaml\)/);
  assert.throws(() => configRefusal(() => { throw new Error("EACCES"); }), /EACCES/);
});

// @spec CTRL-GATE-001
test("configRefusal reads the loader's files fresh by default", () => {
  const file = join(process.env.CONFIG_DIR!, "config.yaml");
  const before = (() => { try { return readFileSync(file, "utf8"); } catch { return undefined; } })();
  try {
    if (before === undefined) writeFileSync(file, readFileSync(join(process.env.CONFIG_DIR!, "config.example.yaml"), "utf8"));
    assert.equal(configRefusal(), undefined, "the shipped example validates");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^ {2}name: "Coco"/m, '  name: "${NAME}"'));
    assert.match(configRefusal()!, /first: cohost\.name/);
  } finally {
    writeFileSync(file, before ?? readFileSync(join(process.env.CONFIG_DIR!, "config.example.yaml"), "utf8"));
  }
});

/** A wiring whose every factory records being used; only the config gate decides the outcome. */
function wiring(refusal: string | undefined) {
  const used: string[] = [];
  const err: string[] = [];
  const ok = async () => { used.push("runtime"); return { ok: true }; };
  const w: CliWiring = {
    configRefusal: () => refusal,
    openBus: () => { used.push("bus"); return { publish: async () => "1", resetGroup: async () => {}, recentHealth: async () => [], recent: async () => [], stop: () => {} } as never; },
    buildRuntime: () => ({ name: "compose", start: ok, stop: ok, restart: ok, consolidate: ok, reembed: ok }) as never,
    buildStack: () => { used.push("stack"); return { launch: async () => ({ ok: true }), rebuild: async () => ({ ok: true }), stopAll: async () => ({ ok: true }), restartAll: async () => ({ ok: true, restarts: [] }), statusWithRestarts: async () => ({ docker: { ok: false, detail: "x" }, services: [] }) } as never; },
    lock: { tryAcquire: (): LockResult => { used.push("lock"); return { ok: true, release: () => {} }; } },
    out: () => {}, err: (l) => err.push(l), env: {},
  };
  return { w, used, err };
}

// @spec CTRL-CLI-018
test("launch, rebuild, start, restart and restart-all print the refusal and exit 1 before the lock, the bus or Docker", async () => {
  for (const argv of [["launch"], ["rebuild"], ["start", "voice"], ["restart", "voice"], ["restart-all"]]) {
    const h = wiring("the config is invalid (1 problem; first: llm.model): fix it");
    assert.equal(await executeCli(argv, h.w), 1, argv.join(" "));
    assert.deepEqual(h.used, [], argv.join(" "));
    assert.deepEqual(h.err, ["the config is invalid (1 problem; first: llm.model): fix it"]);
  }
});

// @spec CTRL-CLI-018
test("stop, stop-all, consolidate and reembed are not gated, and a valid config lets a gated command run", async () => {
  for (const argv of [["stop", "voice"], ["stop-all"], ["consolidate"], ["reembed"]]) {
    const h = wiring("refused");
    assert.equal(await executeCli(argv, h.w), 0, argv.join(" "));
  }
  const h = wiring(undefined);
  assert.equal(await executeCli(["launch"], h.w), 0);
  assert.ok(h.used.includes("lock"));
  const bad = wiring("x");
  assert.equal(await executeCli(["launch", "extra"], bad.w), 2, "usage still comes first");
});
