import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, ears: {},
});
const parse = (salience: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), brain: { salience } });
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// @spec CFG-SCH-034
test("brain.salience.trigger_on_speech defaults to true and accepts a boolean", () => {
  const dflt = parse({});
  assert.ok(dflt.success, JSON.stringify(dflt.error?.issues));
  assert.equal((dflt.data.brain.salience as unknown as Record<string, unknown>).trigger_on_speech, true);
  for (const v of [true, false]) {
    const r = parse({ trigger_on_speech: v });
    assert.ok(r.success);
    assert.equal((r.data.brain.salience as unknown as Record<string, unknown>).trigger_on_speech, v);
  }
});

// @spec CFG-SCH-034
test("brain.salience.trigger_on_speech rejects a non-boolean", () => {
  for (const bad of ["yes", 1, null]) {
    const r = parse({ trigger_on_speech: bad });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".").startsWith("brain.salience.trigger_on_speech")), `${String(bad)} fails naming the key`);
  }
});

// @spec CFG-SCH-034
test("config.example.yaml lists trigger_on_speech beside tick_ms and notes that tick_ms stays the poll", () => {
  const y = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const lines = y.split("\n");
  const tick = lines.findIndex((l) => /^\s+tick_ms:/.test(l));
  const trig = lines.findIndex((l) => /^\s+trigger_on_speech:\s*true\b/.test(l));
  assert.ok(trig >= 0, "trigger_on_speech: true is listed");
  assert.ok(tick >= 0 && Math.abs(trig - tick) <= 2, "next to tick_ms");
  assert.match(lines.slice(Math.min(tick, trig), Math.max(tick, trig) + 1).join("\n"), /poll/i);
});
