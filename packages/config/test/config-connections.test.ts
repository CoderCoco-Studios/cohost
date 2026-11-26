import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, parseConfigText } from "../src/index.js";

const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, dashboard: {}, brain: {}, ears: {},
});
const DEFAULTS = { discord: { enabled: true, guild_id: "", voice_channel_id: "", token: "" } };

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
  assert.deepEqual(set.connections.discord, { enabled: false, guild_id: "g", voice_channel_id: "c", token: "" });
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), connections: { discord: { enabled: "maybe" } } }).success, false);
});

// @spec CFG-SCH-040
test("an unquoted numeric guild or channel id fails the load naming the key and saying to write it in quotes", () => {
  for (const key of ["guild_id", "voice_channel_id"]) {
    // oxlint-disable-next-line eslint/no-loss-of-precision -- the unquoted snowflake that loses precision is the input under test
    const r = ConfigSchema.safeParse({ ...baseCfg(), connections: { discord: { [key]: 1234567890123456789 } } });
    assert.ok(!r.success);
    const issue = r.error.issues.find((i) => i.path.join(".") === `connections.discord.${key}`);
    assert.ok(issue, key);
    assert.match(issue.message, /quotes/);
  }
  assert.equal(ConfigSchema.safeParse({ ...baseCfg(), connections: { discord: { guild_id: "123456789012345678", voice_channel_id: "987654321098765432" } } }).success, true);
  const loaded = parseConfigText("cohost: { name: a, streamer: b }\nllm: { model: m, embed_model: e }\nvision: { obs: {} }\nchat: { twitch: {} }\nbrain: {}\nvoice: {}\navatar: { vtube_studio: {}, vmc: {} }\nears: {}\ndashboard: {}\nconnections: { discord: { guild_id: 1234567890123456789 } }\n");
  assert.ok(!loaded.ok && loaded.issues.some((i) => i.path === "connections.discord.guild_id" && /quotes/.test(i.message)));
});
