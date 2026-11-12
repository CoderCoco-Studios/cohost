import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { MouthHealth, mouthPlan, readToken } from "../src/health.js";

const on = { discord: { enabled: true }, dryrun: { enabled: false } };
const offOutputs = { discord: { enabled: false }, dryrun: { enabled: false } };
const dry = { discord: { enabled: false }, dryrun: { enabled: true } };
const both = { discord: { enabled: true }, dryrun: { enabled: true } };

// @spec MOUTH-START-003
test("mouthPlan: no enabled output is off whatever the token; discord needs a token and otherwise idles instead of exiting", () => {
  assert.equal(mouthPlan(offOutputs, true), "off");
  assert.equal(mouthPlan(offOutputs, false), "off");
  assert.equal(mouthPlan(on, false), "no-token");
  assert.equal(mouthPlan(on, true), "discord");
});

// @spec MOUTH-START-003
test("mouthPlan: dryrun runs locally when discord is off or has no token, and beside discord when it has one", () => {
  assert.equal(mouthPlan(dry, false), "local");
  assert.equal(mouthPlan(dry, true), "local");
  assert.equal(mouthPlan(both, false), "local");
  assert.equal(mouthPlan(both, true), "discord");
});

// @spec MOUTH-START-003
test("mouthPlan: an outputs map without a dryrun key (a config older than the output) plans as before", () => {
  assert.equal(mouthPlan({ discord: { enabled: true } }, true), "discord");
  assert.equal(mouthPlan({ discord: { enabled: true } }, false), "no-token");
  assert.equal(mouthPlan({}, true), "off");
});

// @spec MOUTH-SESS-008
test("readToken reads DISCORD_TOKEN and no other Discord token variable", () => {
  assert.equal(readToken({ DISCORD_TOKEN: "abc" }), "abc");
  assert.equal(readToken({ EARS_DISCORD_TOKEN: "ears-only" }), "", "ears' token is not mouth's");
  assert.equal(readToken({ DISCORD_TOKEN: "", EARS_DISCORD_TOKEN: "x" }), "");
  assert.equal(readToken({}), "");
});

// @spec MOUTH-START-001, MOUTH-HLTH-001
test("plan off: mode off, deps n/a for the disabled outputs, ready at once", async () => {
  const hbs = await runHeartbeat(new MouthHealth("off", offOutputs, () => false).spec);
  assert.equal(hbs[1]!.service, "mouth");
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a", dryrun: "n/a", file: "n/a", http: "n/a" });
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
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "ok", dryrun: "n/a", file: "n/a", http: "n/a" });
  up = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { discord: "down", dryrun: "n/a", file: "n/a", http: "n/a" });
  assert.equal(hbs[1]!.mode, "live");
  assert.equal(hbs[1]!.service, "mouth");
});

// @spec MOUTH-HLTH-001
test("an output that is disabled reports n/a even while the plan runs other outputs", async () => {
  const h = new MouthHealth("discord", offOutputs, () => true);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "n/a", dryrun: "n/a", file: "n/a", http: "n/a" });
});

// @spec MOUTH-DRY-004
test("dryrun: deps.dryrun is ok while enabled and n/a while disabled, and alone it makes the mode mock", async () => {
  const alone = (await runHeartbeat(new MouthHealth("local", dry, (n) => n === "dryrun").spec))[1]!;
  assert.deepEqual(alone.deps, { discord: "n/a", dryrun: "ok", file: "n/a", http: "n/a" });
  assert.equal(alone.mode, "mock");
  const off = (await runHeartbeat(new MouthHealth("discord", on, (n) => n === "discord").spec))[1]!;
  assert.equal(off.deps.dryrun, "n/a");
  assert.equal(off.mode, "live");
});

// @spec MOUTH-DRY-004, MOUTH-START-003
test("dryrun beside an enabled discord output keeps the mode live, and discord without a token stays down", async () => {
  const hb = (await runHeartbeat(new MouthHealth("local", both, (n) => n === "dryrun").spec, (h) => h.degraded("DISCORD_TOKEN is not set")))
    .find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { discord: "down", dryrun: "ok", file: "n/a", http: "n/a" });
});
