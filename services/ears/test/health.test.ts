import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth, earsPlan, type EarsPlan } from "../src/health.js";

const gapOf = (p: EarsPlan, name: string) => p.sources.find((x) => x.name === name)?.gap;

// @spec EARS-START-001, EARS-HLTH-001
test("source off: mode off, deps n/a, ready", async () => {
  const hbs = await runHeartbeat(new EarsHealth(earsPlan([], true)).spec);
  assert.equal(hbs[1]!.mode, "off");
  assert.deepEqual(hbs[1]!.deps, { discord: "n/a", stt: "n/a" });
  assert.equal(hbs[1]!.state, "ready");
});

// @spec EARS-SRC-003, EARS-SRC-008, EARS-START-004, EARS-CAP-004
test("earsPlan: a set of sources; only dir without a path is a gap; every other name, discord included, is a connector tag and always runnable", () => {
  assert.deepEqual(earsPlan([], false).sources, []);
  const p = earsPlan(["http", "dir", "discord", "desktop"], false);
  assert.deepEqual(p.sources.map((x) => [x.name, x.kind, x.gap === undefined]), [["http", "http", true], ["dir", "dir", false], ["discord", "connector", true], ["desktop", "connector", true]]);
  assert.equal(gapOf(p, "dir"), "ears.dir.path is not set");
  assert.deepEqual(p.runnable.map((x) => x.name), ["http", "discord", "desktop"]);
  assert.deepEqual(earsPlan(["dir", "discord"], true).runnable.map((x) => x.name), ["dir", "discord"]);
  assert.deepEqual(earsPlan(["http", "http"], true).sources.map((x) => x.name), ["http"], "a repeated name is one source");
  assert.deepEqual(earsPlan(["discord"], true).sources.map((x) => x.kind), ["connector"], "no token or client is involved: discord is a plain tag");
});

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003
test("discord is a connector source: its dependency follows the source, stt follows transcriptions", async () => {
  let up = true;
  const h = new EarsHealth(earsPlan(["discord"], true), false, () => (up ? "ok" : "down"));
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
  const h = new EarsHealth(plan, false, (n) => status[n] ?? "down");
  const hb = (await runHeartbeat(h.spec))[1]!;
  assert.equal(hb.mode, "live");
  assert.deepEqual(hb.deps, { discord: "n/a", stt: "ok", http: "ok", dir: "down", desktop: "down" });
  status.desktop = "ok";
  assert.equal((await runHeartbeat(h.spec))[1]!.deps.desktop, "ok");
  const only = (await runHeartbeat(new EarsHealth(earsPlan(["dir"], true), false, () => "ok").spec))[1]!;
  assert.deepEqual(only.deps, { discord: "n/a", stt: "ok", http: "n/a", dir: "ok" });
});

// @spec EARS-SRC-005, EARS-HLTH-001
test("heartbeat: stub engine is mode mock with stt n/a", async () => {
  const stub = (await runHeartbeat(new EarsHealth(earsPlan(["http"], true), true, () => "ok").spec))[1]!;
  assert.equal(stub.mode, "mock");
  assert.deepEqual(stub.deps, { discord: "n/a", stt: "n/a", http: "ok", dir: "n/a" });
  const both = (await runHeartbeat(new EarsHealth(earsPlan(["discord", "http"], true), false, () => "ok").spec))[1]!;
  assert.deepEqual(both.deps, { discord: "ok", stt: "ok", http: "ok", dir: "n/a" });
});
