import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {},
});
const parseSal = (salience: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), ears: {}, brain: { salience } });
const parseEars = (ears: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), brain: {}, ears });
const sal = (s: Record<string, unknown>) => { const r = parseSal(s); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data.brain.salience as unknown as Record<string, unknown>; };
const ears = (e: Record<string, unknown>) => { const r = parseEars(e); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data.ears as unknown as Record<string, unknown>; };
const failsNaming = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, key: string, label: string) =>
  assert.ok(!r.success && r.error!.issues.some((i) => i.path.join(".").startsWith(key)), `${label} fails naming ${key}`);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const exampleLines = () => readFileSync(join(repoRoot, "config", "config.example.yaml"), "utf8").split("\n");

// @spec CFG-SCH-035
test("brain.salience barge-in keys default to false, [discord] and 2", () => {
  const s = sal({});
  assert.equal(s.barge_in, false);
  assert.deepEqual(s.barge_in_sources, ["discord"]);
  assert.equal(s.barge_in_min_words, 2);
  assert.equal(sal({ barge_in: true }).barge_in, true);
  assert.deepEqual(sal({ barge_in_sources: ["http", "dir", "desktop"] }).barge_in_sources, ["http", "dir", "desktop"]);
  assert.equal(sal({ barge_in_min_words: 1 }).barge_in_min_words, 1);
});

// @spec CFG-SCH-035
test("brain.salience.barge_in rejects a non-boolean; barge_in_sources rejects a bad name; barge_in_min_words must be an integer >= 1", () => {
  for (const bad of ["yes", 1, null]) failsNaming(parseSal({ barge_in: bad }), "brain.salience.barge_in", String(bad));
  for (const bad of ["Desktop", "1abc", "has space", "", "a".repeat(33), "x_y"]) failsNaming(parseSal({ barge_in_sources: [bad] }), "brain.salience.barge_in_sources", JSON.stringify(bad));
  assert.equal(parseSal({ barge_in_sources: ["a".repeat(32)] }).success, true);
  for (const bad of [0, -1, 1.5, "2"]) failsNaming(parseSal({ barge_in_min_words: bad }), "brain.salience.barge_in_min_words", String(bad));
});

// @spec CFG-SCH-035
test("config.example.yaml lists barge_in, barge_in_sources and barge_in_min_words beside trigger_on_speech", () => {
  const lines = exampleLines();
  const trig = lines.findIndex((l) => /^\s+trigger_on_speech:/.test(l));
  assert.ok(trig >= 0);
  for (const key of ["barge_in", "barge_in_sources", "barge_in_min_words"]) {
    const at = lines.findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
    assert.ok(at >= 0 && Math.abs(at - trig) <= 6, `${key} is listed near trigger_on_speech`);
  }
});

// @spec CFG-SCH-036
test("ears.echo_suppress_sources defaults to [desktop] (empty allowed) and echo_tail_ms to 1500", () => {
  const e = ears({});
  assert.deepEqual(e.echo_suppress_sources, ["desktop"]);
  assert.equal(e.echo_tail_ms, 1500);
  assert.deepEqual(ears({ echo_suppress_sources: [] }).echo_suppress_sources, []);
  assert.deepEqual(ears({ echo_suppress_sources: ["http", "dir", "loopback"] }).echo_suppress_sources, ["http", "dir", "loopback"]);
  assert.equal(ears({ echo_tail_ms: 0 }).echo_tail_ms, 0);
  assert.equal(ears({ echo_tail_ms: 3000 }).echo_tail_ms, 3000);
});

// @spec CFG-SCH-036
test("ears.echo_suppress_sources rejects a bad name; echo_tail_ms an integer below 0 or a non-integer; a name that is not an enabled source loads", () => {
  for (const bad of ["Desktop", "1abc", "has space", "", "a".repeat(33), "x_y"]) failsNaming(parseEars({ echo_suppress_sources: [bad] }), "ears.echo_suppress_sources", JSON.stringify(bad));
  for (const bad of [-1, 1.5, "1500"]) failsNaming(parseEars({ echo_tail_ms: bad }), "ears.echo_tail_ms", String(bad));
  assert.equal(parseEars({ sources: ["discord"], echo_suppress_sources: ["desktop"] }).success, true, "desktop is not an enabled source and still loads");
});

// @spec CFG-SCH-036
test("config.example.yaml lists echo_suppress_sources and echo_tail_ms beside silence_ms", () => {
  const lines = exampleLines();
  const silence = lines.findIndex((l) => /^\s+silence_ms:/.test(l));
  assert.ok(silence >= 0);
  for (const key of ["echo_suppress_sources", "echo_tail_ms"]) {
    const at = lines.findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
    assert.ok(at >= 0 && Math.abs(at - silence) <= 6, `${key} is listed near silence_ms`);
  }
});
