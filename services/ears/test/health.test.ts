import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth, earsPlan, readEarsToken, idleDetail } from "../src/health.js";

// @spec EARS-START-002, EARS-HLTH-001, EARS-HLTH-002
test("no token: mode live, discord down, degraded (idle, not exited)", async () => {
  const hbs = await runHeartbeat(new EarsHealth("no-token", () => false).spec, (hb) => hb.degraded(idleDetail(readEarsToken({}))));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
  assert.equal(hb.detail, "EARS_DISCORD_TOKEN is not set");
});

// @spec EARS-START-001, EARS-HLTH-001
test("source off: mode off, deps n/a, ready", async () => {
  const hbs = await runHeartbeat(new EarsHealth("off", () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a", stt: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec EARS-START-004
test("earsPlan: off wins; discord needs a token and otherwise idles instead of exiting", () => {
  assert.equal(earsPlan("off", true), "off");
  assert.equal(earsPlan("off", false), "off");
  assert.equal(earsPlan("discord", false), "no-token");
  assert.equal(earsPlan("discord", true), "discord");
});

// @spec EARS-START-004, EARS-SESS-009
test("readEarsToken: the token is EARS_DISCORD_TOKEN alone; DISCORD_TOKEN is never used as a fallback", () => {
  assert.deepEqual(readEarsToken({ EARS_DISCORD_TOKEN: "ears-tok", DISCORD_TOKEN: "mouth-tok" }), { token: "ears-tok", hasToken: true, conflict: false });
  assert.deepEqual(readEarsToken({ EARS_DISCORD_TOKEN: "ears-tok" }), { token: "ears-tok", hasToken: true, conflict: false });
  assert.deepEqual(readEarsToken({ DISCORD_TOKEN: "mouth-tok" }), { token: "", hasToken: false, conflict: false });
  assert.deepEqual(readEarsToken({ EARS_DISCORD_TOKEN: "", DISCORD_TOKEN: "" }), { token: "", hasToken: false, conflict: false });
  assert.deepEqual(readEarsToken({}), { token: "", hasToken: false, conflict: false });
});

// @spec EARS-START-004, EARS-START-007
test("readEarsToken: a token equal to the non-empty DISCORD_TOKEN is not usable and is flagged as a conflict", () => {
  const r = readEarsToken({ EARS_DISCORD_TOKEN: "same", DISCORD_TOKEN: "same" });
  assert.equal(r.hasToken, false);
  assert.equal(r.conflict, true);
  assert.equal(earsPlan("discord", r.hasToken), "no-token");
});

// @spec EARS-START-002, EARS-START-007
test("idleDetail names the missing token or the shared token", () => {
  assert.equal(idleDetail(readEarsToken({})), "EARS_DISCORD_TOKEN is not set");
  assert.equal(idleDetail(readEarsToken({ EARS_DISCORD_TOKEN: "", DISCORD_TOKEN: "x" })), "EARS_DISCORD_TOKEN is not set");
  assert.equal(
    idleDetail(readEarsToken({ EARS_DISCORD_TOKEN: "same", DISCORD_TOKEN: "same" })),
    "EARS_DISCORD_TOKEN is the mouth bot's DISCORD_TOKEN; ears needs a bot of its own",
  );
});

// @spec EARS-START-007, EARS-HLTH-001
test("shared token: heartbeat degraded with the conflict detail, mode live, discord down", async () => {
  const detail = idleDetail(readEarsToken({ EARS_DISCORD_TOKEN: "same", DISCORD_TOKEN: "same" }));
  const hbs = await runHeartbeat(new EarsHealth("no-token", () => false).spec, (hb) => hb.degraded(detail));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
  assert.match(hb.detail ?? "", /ears needs a bot of its own/);
});

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003
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

// @spec EARS-CAP-004
test("earsPlan: http and dir are plans of their own, token or not; dir without a path is no-dir", () => {
  assert.equal(earsPlan("http", false), "http");
  assert.equal(earsPlan("http", true), "http");
  assert.equal(earsPlan("dir", false), "dir");
  assert.equal(earsPlan("dir", false, true), "dir");
  assert.equal(earsPlan("dir", true, false), "no-dir");
  assert.equal(earsPlan("discord", false, false), "no-token");
  assert.equal(earsPlan("off", true, false), "off");
});

// @spec EARS-CAP-011
test("http and dir heartbeats: discord n/a, stt as usual, and the source's own dep follows the listener", async () => {
  let status: "ok" | "down" = "ok";
  for (const plan of ["http", "dir"] as const) {
    const h = new EarsHealth(plan, () => false, false, () => status);
    const up = (await runHeartbeat(h.spec))[1]!;
    assert.deepEqual(up.deps, { discord: "n/a", stt: "ok", [plan]: "ok" });
    assert.equal(up.mode, "live");
    status = "down";
    assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "n/a", stt: "ok", [plan]: "down" });
    status = "ok";
  }
  const stub = (await runHeartbeat(new EarsHealth("http", () => false, true, () => "ok").spec))[1]!;
  assert.equal(stub.mode, "mock");
  assert.deepEqual(stub.deps, { discord: "n/a", stt: "n/a", http: "ok" });
  const noDir = (await runHeartbeat(new EarsHealth("no-dir", () => false).spec))[1]!;
  assert.deepEqual(noDir.deps, { discord: "n/a", stt: "ok", dir: "down" });
});
