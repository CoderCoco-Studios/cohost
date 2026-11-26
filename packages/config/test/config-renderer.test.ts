import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, ExpressionMapSchema, ISOLATION_OVERRIDES, loadConfig, loadExpressions } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, shippedSandbox, repo } from "./helpers/config-sandbox.js";

isolateEnv();

// The browser renderer's config contract (config design, Schema: key groups, `renderer` and `dashboard`).

const base = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: {}, vmc: {} }, ears: {}, dashboard: {}, brain: {},
});
const parse = (patch: Record<string, unknown> = {}) => ConfigSchema.safeParse({ ...base(), ...patch });
const ok = (patch: Record<string, unknown> = {}): any => { const r = parse(patch); assert.ok(r.success, JSON.stringify(r.error?.issues)); return r.data; };
const failPaths = (patch: Record<string, unknown>): string[] => { const r = parse(patch); return r.success ? [] : r.error.issues.map((i) => i.path.join(".")); };
const renderer = (r: Record<string, unknown>) => ({ renderer: r });
const dashboard = (d: Record<string, unknown>) => ({ dashboard: d });

// @spec CFG-SCH-006, CFG-ISO-005, AVATAR-DRV-004
test("avatar.driver accepts browser, treats blank as null, and an unknown value fails naming avatar.driver", () => {
  assert.equal(ok({ avatar: { driver: "browser", vtube_studio: {}, vmc: {} } }).avatar.driver, "browser");
  assert.equal(ok({ avatar: { driver: "", vtube_studio: {}, vmc: {} } }).avatar.driver, "null");
  assert.equal(ok({ avatar: { driver: "vmc", vtube_studio: {}, vmc: {} } }).avatar.driver, "vmc");
  assert.ok(failPaths({ avatar: { driver: "unity", vtube_studio: {}, vmc: {} } }).includes("avatar.driver"));
});

// @spec CFG-ISO-005
test("a config.yaml with avatar.driver browser loads, and an unknown driver fails the load naming avatar.driver", () => {
  sandbox({ "config.yaml": MINIMAL_YAML.replace("avatar: { vtube_studio: {}, vmc: {} }", "avatar: { driver: browser, vtube_studio: {}, vmc: {} }") });
  assert.equal(loadConfig(true).avatar.driver, "browser");
  sandbox({ "config.yaml": MINIMAL_YAML.replace("avatar: { vtube_studio: {}, vmc: {} }", "avatar: { driver: unity, vtube_studio: {}, vmc: {} }") });
  assert.throws(() => loadConfig(true), /avatar\.driver/);
});

// @spec CFG-SCH-097
test("an absent renderer section, or any absent key, takes the defaults", () => {
  const defaults = { model: "", zoom: 1, offset_y: 0, turn: 0 };
  assert.deepEqual(ok().renderer, defaults);
  assert.deepEqual(ok(renderer({})).renderer, defaults);
  assert.deepEqual(ok(renderer({ zoom: 2 })).renderer, { ...defaults, zoom: 2 });
  assert.deepEqual(ok(renderer({ model: "Coco.vrm", offset_y: 0.5, turn: -30 })).renderer, { model: "Coco.vrm", zoom: 1, offset_y: 0.5, turn: -30 });
});

// @spec CFG-SCH-098
test("renderer.model takes the empty string or a name of the fixed grammar, and any other value fails naming renderer.model", () => {
  for (const good of ["", "a.vrm", "Coco 2_v1-final.vrm", "9.vrm", "a..vrm", `${"a".repeat(76)}.vrm`]) {
    assert.equal(ok(renderer({ model: good })).renderer.model, good, JSON.stringify(good));
  }
  const bad = [
    "coco", "coco.VRM", "coco.vrm.exe", ".vrm", "-a.vrm", " a.vrm", "_a.vrm", ".a.vrm", "../a.vrm", "a/b.vrm", "a\\b.vrm", "a:b.vrm", "é.vrm",
    "a\n.vrm", "a%2e.vrm", `${"a".repeat(77)}.vrm`, 3, null,
  ];
  for (const b of bad) assert.ok(failPaths(renderer({ model: b })).includes("renderer.model"), JSON.stringify(b));
});

// @spec CFG-SCH-099
test("renderer.zoom, offset_y and turn are bounded numbers, each failure naming its key", () => {
  for (const [key, lo, hi] of [["zoom", 0.5, 3], ["offset_y", -1.5, 1.5], ["turn", -90, 90]] as const) {
    assert.equal(ok(renderer({ [key]: lo })).renderer[key], lo);
    assert.equal(ok(renderer({ [key]: hi })).renderer[key], hi);
    for (const out of [lo - 0.01, hi + 0.01]) assert.ok(failPaths(renderer({ [key]: out })).includes(`renderer.${key}`), `${key} ${out}`);
    assert.ok(failPaths(renderer({ [key]: "wide" })).includes(`renderer.${key}`), `${key} string`);
  }
});

// @spec CFG-SCH-100
test("dashboard.models.max_bytes defaults to 100 MiB, takes 1 MiB to 1 GiB integers and fails outside naming its key", () => {
  assert.equal(ok().dashboard.models.max_bytes, 104857600);
  assert.equal(ok(dashboard({ models: {} })).dashboard.models.max_bytes, 104857600);
  assert.equal(ok(dashboard({ models: { max_bytes: 1048576 } })).dashboard.models.max_bytes, 1048576);
  assert.equal(ok(dashboard({ models: { max_bytes: 1073741824 } })).dashboard.models.max_bytes, 1073741824);
  for (const bad of [1048575, 1073741825, 0, -1, 1.5e6 + 0.5, "big"]) {
    assert.ok(failPaths(dashboard({ models: { max_bytes: bad } })).includes("dashboard.models.max_bytes"), String(bad));
  }
  assert.equal(ok().dashboard.port, 3000, "the other dashboard keys are unchanged");
});

// @spec CFG-SCH-101
test("ExpressionMapSchema refuses a browser block value over 64 characters, and loadExpressions names the key", () => {
  assert.equal(ExpressionMapSchema.safeParse({ browser: { happy: "h".repeat(64) } }).success, true);
  assert.equal(ExpressionMapSchema.safeParse({ browser: { happy: "h".repeat(65) } }).success, false);
  assert.equal(ExpressionMapSchema.safeParse({ vmc: { happy: "h".repeat(65) } }).success, true, "only the browser block is capped");
  const dir = sandbox({ "expressions.yaml": `browser:\n  happy: ${"h".repeat(65)}\n` });
  assert.throws(() => loadExpressions(), (e: Error) => e.message.startsWith(`Invalid ${join(dir, "expressions.yaml")}:`) && /browser\.happy/.test(e.message));
});

// @spec CFG-ISO-011
test("ISOLATION_OVERRIDES holds no renderer key and not dashboard.models.max_bytes, and an isolated avatar selects null through avatar.driver", () => {
  const keys = Object.values(ISOLATION_OVERRIDES) as string[];
  assert.deepEqual(keys.filter((k) => k === "renderer" || k.startsWith("renderer.")), []);
  assert.equal(keys.includes("dashboard.models.max_bytes"), false);
  shippedSandbox();
  process.env.COHOST_ISOLATION = JSON.stringify({ AVATAR_DRIVER: "null" });
  assert.equal(loadConfig(true).avatar.driver, "null");
});

// @spec CFG-USR-021
test("config.example.yaml writes the four renderer keys and dashboard.models.max_bytes as literals", () => {
  const text = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const raw = parseYaml(text) as { renderer?: unknown; dashboard?: { models?: { max_bytes?: unknown } }; avatar?: { driver?: unknown } };
  assert.deepEqual(raw.renderer, { model: "", zoom: 1, offset_y: 0, turn: 0 });
  assert.equal(raw.dashboard?.models?.max_bytes, 104857600);
  assert.equal(raw.avatar?.driver, "null");
  assert.doesNotMatch(text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"), /\$\{/);
  shippedSandbox();
  const cfg = loadConfig(true);
  assert.deepEqual(cfg.renderer, { model: "", zoom: 1, offset_y: 0, turn: 0 });
});

// @spec CFG-LOAD-008
test("a running process keeps its cached renderer values: a later edit of config.yaml is not reloaded", () => {
  const dir = sandbox({ "config.yaml": `${MINIMAL_YAML}renderer: { zoom: 2 }\n` });
  const cfg = loadConfig(true);
  assert.equal(cfg.renderer.zoom, 2);
  writeFileSync(join(dir, "config.yaml"), `${MINIMAL_YAML}renderer: { zoom: 3 }\n`);
  assert.equal(loadConfig(), cfg);
  assert.equal(loadConfig().renderer.zoom, 2);
});
