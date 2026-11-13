import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, brain: {}, ears: {},
});
const DEFAULTS = { discord: { enabled: true, guild_id: "", voice_channel_id: "" } };

// @spec CFG-SCH-032
test("the connections section is optional: absent or partial, it loads with the Discord connector on and an empty target", () => {
  const absent = ConfigSchema.safeParse(baseCfg());
  assert.ok(absent.success);
  assert.deepEqual(absent.data.connections, DEFAULTS);
  for (const partial of [{}, { discord: {} }]) {
    const r = ConfigSchema.safeParse({ ...baseCfg(), connections: partial });
    assert.ok(r.success, JSON.stringify(partial));
    assert.deepEqual(r.data.connections, DEFAULTS);
  }
  const set = ConfigSchema.parse({ ...baseCfg(), connections: { discord: { enabled: false, guild_id: "g", voice_channel_id: "c" } } });
  assert.deepEqual(set.connections.discord, { enabled: false, guild_id: "g", voice_channel_id: "c" });
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), connections: { discord: { enabled: "maybe" } } }).success, false);
});
