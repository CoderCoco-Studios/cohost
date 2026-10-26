import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth, earsPlan } from "../src/health.js";

test("no token: mode live, discord down, degraded (idle, not exited)", async () => {
  const hbs = await runHeartbeat(new EarsHealth("no-token", () => false).spec, (hb) => hb.degraded("DISCORD_TOKEN is not set"));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
});

test("source off: mode off, deps n/a, ready", async () => {
  const hbs = await runHeartbeat(new EarsHealth("off", () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a", stt: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

test("earsPlan: off wins; discord needs a token and otherwise idles instead of exiting", () => {
  assert.equal(earsPlan("off", true), "off");
  assert.equal(earsPlan("off", false), "off");
  assert.equal(earsPlan("discord", false), "no-token");
  assert.equal(earsPlan("discord", true), "discord");
});

test("token set: discord follows the session, stt follows transcriptions", async () => {
  let up = true;
  const h = new EarsHealth("discord", () => up);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "ok", stt: "ok" });
  await assert.rejects(h.track(async () => { throw new Error("stt 500"); })(Buffer.alloc(0)));
  up = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { discord: "down", stt: "down" });
  assert.equal(hbs[1]!.mode, "live");
  assert.equal(hbs[1]!.service, "ears");
});
