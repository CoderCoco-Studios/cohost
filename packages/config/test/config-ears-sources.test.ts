import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, earsSources } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, brain: {},
});
const parse = (ears: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), ears: { discord: {}, ...ears } });
const sourcesOf = (ears: Record<string, unknown>) => earsSources(parse(ears).data!.ears);

// @spec CFG-SCH-030, EARS-SRC-001, EARS-SRC-002
test("ears.sources defaults to [discord]; the legacy ears.source is read only when sources is unset; sources wins", () => {
  assert.deepEqual(sourcesOf({}), ["discord"]);
  assert.deepEqual(sourcesOf({ source: "" }), ["discord"]);
  assert.deepEqual(sourcesOf({ source: "off" }), []);
  assert.deepEqual(sourcesOf({ source: "http" }), ["http"]);
  assert.deepEqual(sourcesOf({ sources: ["http", "dir", "desktop"] }), ["http", "dir", "desktop"]);
  assert.deepEqual(sourcesOf({ sources: [] }), []);
  assert.deepEqual(sourcesOf({ source: "off", sources: ["dir"] }), ["dir"]);
  assert.deepEqual(sourcesOf({ sources: ["http", "http", "dir"] }), ["http", "dir"], "a repeated name is one source");
});

// @spec CFG-SCH-030, EARS-SRC-001
test("a source name that is not http, dir or a valid tag fails the load naming ears.sources", () => {
  for (const bad of ["Desktop", "1abc", "has space", "", "a".repeat(33), "x_y"]) {
    const r = parse({ sources: [bad] });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.slice(0, 2).join(".") === "ears.sources"), JSON.stringify(bad));
  }
  assert.equal(parse({ sources: ["a".repeat(32)] }).success, true);
  assert.equal(parse({ source: "bogus" }).success, false);
});

// @spec CFG-SCH-030, EARS-SRC-013
test("ears.http.token defaults to the empty string", () => {
  assert.equal(parse({}).data!.ears.http.token, "");
  assert.equal(parse({ http: { token: "s3cret" } }).data!.ears.http.token, "s3cret");
});
