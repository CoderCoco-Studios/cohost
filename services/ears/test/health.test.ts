import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth, earsPlan, readEarsToken, idleDetail, type EarsPlan } from "../src/health.js";

const gapOf = (p: EarsPlan, name: string) => p.sources.find((x) => x.name === name)?.gap;
const noToken = earsPlan(["discord"], true, "EARS_DISCORD_TOKEN is not set");

// @spec EARS-START-002, EARS-HLTH-001, EARS-HLTH-002
test("no token: mode live, discord down, degraded (idle, not exited)", async () => {
  const hbs = await runHeartbeat(new EarsHealth(noToken, () => false).spec, (hb) => hb.degraded(idleDetail(readEarsToken({}))));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
  assert.equal(hb.detail, "EARS_DISCORD_TOKEN is not set");
});

// @spec EARS-START-001, EARS-HLTH-001
test("source off: mode off, deps n/a, ready", async () => {
  const hbs = await runHeartbeat(new EarsHealth(earsPlan([], true), () => false).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a", stt: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec EARS-SRC-003, EARS-SRC-008
test("earsPlan: a set of sources; only dir without a path (and discord without a token) is a gap; a connector tag is always runnable", () => {
  assert.deepEqual(earsPlan([], false).sources, []);
  const p = earsPlan(["http", "dir", "discord", "desktop"], false, "no token");
  assert.deepEqual(p.sources.map((x) => [x.name, x.gap === undefined]), [["http", true], ["dir", false], ["discord", false], ["desktop", true]]);
  assert.equal(gapOf(p, "dir"), "ears.dir.path is not set");
  assert.equal(gapOf(p, "discord"), "no token");
  assert.deepEqual(p.runnable.map((x) => x.name), ["http", "desktop"]);
  const ok = earsPlan(["dir", "discord"], true);
  assert.deepEqual(ok.runnable.map((x) => x.name), ["dir", "discord"]);
  assert.deepEqual(earsPlan(["http", "http"], true).sources.map((x) => x.name), ["http"], "a repeated name is one source");
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
  assert.equal(earsPlan(["discord"], true, r.hasToken ? undefined : idleDetail(r)).runnable.length, 0);
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
  const hbs = await runHeartbeat(new EarsHealth(noToken, () => false).spec, (hb) => hb.degraded(detail));
  const hb = hbs.find((h) => h.state === "degraded")!;
  assert.equal(hb.mode, "live");
  assert.equal(hb.deps.discord, "down");
  assert.match(hb.detail ?? "", /ears needs a bot of its own/);
});

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003
test("token set: discord follows the session, stt follows transcriptions", async () => {
  let up = true;
  const h = new EarsHealth(earsPlan(["discord"], true), () => up);
  assert.deepEqual((await runHeartbeat(h.spec))[1]!.deps, { discord: "ok", stt: "ok", http: "n/a", dir: "n/a" });
  await assert.rejects(h.track(async () => { throw new Error("stt 500"); })(Buffer.alloc(0)));
  up = false;
  const hbs = await runHeartbeat(h.spec);
  assert.deepEqual(hbs[1]!.deps, { discord: "down", stt: "down", http: "n/a", dir: "n/a" });
  assert.equal(hbs[1]!.mode, "live");
  assert.equal(hbs[1]!.service, "ears");
});

// @spec EARS-SRC-005, EARS-HLTH-001
test("heartbeat: one dep per enabled source, n/a for the rest, stt shared; a gap or failing source is down", async () => {
  const status: Record<string, "ok" | "down"> = { http: "ok", desktop: "down" };
  const plan = earsPlan(["http", "dir", "desktop"], false);
  const h = new EarsHealth(plan, () => false, false, (n) => status[n] ?? "down");
  const hb = (await runHeartbeat(h.spec))[1]!;
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { discord: "n/a", stt: "ok", http: "ok", dir: "down", desktop: "down" });
  status.desktop = "ok";
  assert.equal((await runHeartbeat(h.spec))[1]!.deps.desktop, "ok");
  const only = (await runHeartbeat(new EarsHealth(earsPlan(["dir"], true), () => false, false, () => "ok").spec))[1]!;
  assert.deepEqual(only.deps, { discord: "n/a", stt: "ok", http: "n/a", dir: "ok" });
});

// @spec EARS-SRC-005, EARS-HLTH-001
test("heartbeat: stub engine is mode mock with stt n/a; discord follows the session while enabled", async () => {
  const stub = (await runHeartbeat(new EarsHealth(earsPlan(["http"], true), () => false, true, () => "ok").spec))[1]!;
  assert.equal(stub.mode, "mock");
  assert.deepEqual(stub.deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a" });
  const both = (await runHeartbeat(new EarsHealth(earsPlan(["discord", "http"], true), () => true, false, () => "ok").spec))[1]!;
  assert.deepEqual(both.deps, { discord: "ok", stt: "ok", http: "ok", dir: "n/a" });
});
