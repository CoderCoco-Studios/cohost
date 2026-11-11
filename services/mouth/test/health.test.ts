import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { MouthHealth, mouthPlan, readToken } from "../src/health.js";

const on = { discord: { enabled: true } };
const offOutputs = { discord: { enabled: false } };

// @spec MOUTH-START-003
test("mouthPlan: no enabled output is off whatever the token; discord needs a token and otherwise idles instead of exiting", () => {
  assert.equal(mouthPlan(offOutputs, true), "off");
  assert.equal(mouthPlan(offOutputs, false), "off");
  assert.equal(mouthPlan(on, false), "no-token");
  assert.equal(mouthPlan(on, true), "discord");
});

// @spec MOUTH-SESS-008
test("readToken reads DISCORD_TOKEN and no other Discord token variable", () => {
  assert.equal(readToken({ DISCORD_TOKEN: "abc" }), "abc");
  assert.equal(readToken({ EARS_DISCORD_TOKEN: "ears-only" }), "", "ears' token is not mouth's");
  assert.equal(readToken({ DISCORD_TOKEN: "", EARS_DISCORD_TOKEN: "x" }), "");
  assert.equal(readToken({}), "");
});

// @spec MOUTH-START-001, MOUTH-HLTH-001
test("plan off: mode off, deps n/a for the disabled output, ready at once", async () => {
  const hbs = await runHeartbeat(new MouthHealth("off", offOutputs, () => false).spec);
  assert.equal(hbs[1]!.service, "mouth");
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec MOUTH-START-002, MOUTH-HLTH-001, MOUTH-HLTH-002
test("no token: mode live, discord down, degraded with the detail (idle, not exited)", async () => {
  const hbs = await runHeartbeat(new MouthHealth("no-token", on, () => false).spec, (hb) => hb.degraded("DISCORD_TOKEN is not set"));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
  assert.match(hb.detail ?? "", /DISCORD_TOKEN is not set/);
});

// @spec MOUTH-HLTH-002
test("a discord plan reports ok only while the output is ready, and down otherwise", async () => {
  let up = true;
  const h = new MouthHealth("discord", on, (name) => name === "discord" && up);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "ok" });
  up = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { discord: "down" });
  assert.equal(hbs[1]!.mode, "live");
  assert.equal(hbs[1]!.service, "mouth");
});

// @spec MOUTH-HLTH-001
test("an output that is disabled reports n/a even while the plan runs other outputs", async () => {
  const h = new MouthHealth("discord", offOutputs, () => true);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "n/a" });
});
