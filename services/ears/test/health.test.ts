import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth } from "../src/health.js";

test("no token: mode off, discord n/a", async () => {
  const hbs = await runHeartbeat(new EarsHealth(false, () => false).spec, (hb) => hb.degraded("DISCORD_TOKEN is not set"));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "off");
  assert.equal(hb.deps.discord, "n/a");
});

test("token set: discord follows the session, stt follows transcriptions", async () => {
  let up = true;
  const h = new EarsHealth(true, () => up);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "ok", stt: "ok" });
  await assert.rejects(h.track(async () => { throw new Error("stt 500"); })(Buffer.alloc(0)));
  up = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { discord: "down", stt: "down" });
  assert.equal(hbs[1]!.mode, "live");
  assert.equal(hbs[1]!.service, "ears");
});
