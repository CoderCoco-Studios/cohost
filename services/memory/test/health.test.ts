import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { MemoryHealth } from "../src/health.js";

test("ready with postgres and ollama ok", async () => {
  const h = new MemoryHealth();
  h.setPostgres(true); h.setOllama(true);
  const hbs = await runHeartbeat(h.spec);
  assert.equal(hbs[1]!.service, "memory");
  assert.equal(hbs[1]!.state, "ready");
  assert.deepEqual(hbs[1]!.deps, { postgres: "ok", ollama: "ok" });
  assert.equal(hbs.at(-1)!.state, "stopping");
});

test("a failing embedding marks ollama down (degraded) and the next success restores it", async () => {
  const h = new MemoryHealth();
  h.setPostgres(true);
  let fail = true;
  const emb = h.embedder({ embed: async () => { if (fail) throw new Error("no ollama"); return [1]; } });
  await assert.rejects(emb.embed("x"));
  let hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { postgres: "ok", ollama: "down" });
  assert.equal(hbs[1]!.state, "degraded");
  fail = false;
  await emb.embed("x");
  hbs = await runHeartbeat(h.spec);
  assert.equal(hbs[1]!.state, "ready");
});
