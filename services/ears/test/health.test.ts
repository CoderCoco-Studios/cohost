import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "@cohost/testing";
import { EarsHealth, earsPlan, type EarsPlan } from "../src/health.js";
import { STT_PING_INTERVAL_MS } from "../src/engines.js";
import { SttStatus, boot, connectorOffer, fakeStreaming, fakeStt, feed, resetSeq, sleep } from "./rig.js";
import { waitFor } from "@cohost/testing";

process.env.HEARTBEAT_INTERVAL_MS = "40"; // the service tests below read deps.stt and its detail from the heartbeat

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

// ---- deps.stt for the selected engine (EARS-HLTH-003 to 012), through the real service on a fake bus.
// Test seams (besides rig.ts): `STT_PING_INTERVAL_MS` (10000) exported by src/engines.ts: the re-probe period of EARS-HLTH-008.

const reg = (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => b.register("discord", connectorOffer);
const cfg = (over: Record<string, unknown> = {}) => ({
  sources: ["discord"], stt_engine: "speaches", partials: "off", vad: { engine: "gap" }, silence_ms: 150, min_speech_ms: 100, stt_timeout_ms: 300, ...over,
});
type Rig = Awaited<ReturnType<typeof boot>>;
async function run<T>(ears: Record<string, unknown>, stt: ReturnType<typeof fakeStt>, body: (r: Rig) => Promise<T>, o: Parameters<typeof boot>[1] = {}): Promise<T> {
  resetSeq();
  const r = await boot(ears, { setup: reg, ...o });
  try { await sleep(60); return await body(r); } finally { await r.stop(); stt.restore(); }
}
const stt = (r: Rig) => r.lastHeartbeat()?.deps.stt;
const detail = (r: Rig) => r.lastHeartbeat()?.detail ?? "";
const say = (r: Rig) => feed(r.bus, 10, { gapMs: 15 });
const everDown = (r: Rig) => r.bus.health.some((h) => h.deps.stt === "down");
const warnText = (r: Rig) => r.log.lines.filter((l) => l.level === "warn").map((l) => `${l.msg ?? ""} ${JSON.stringify(l.obj)}`);

// @spec EARS-HLTH-003, EARS-ENG-009
test("batch engine: a refused connection, timeout, 5xx, 401, 403, 404, 429 or any other failed status is an outage (deps.stt down), and the next successful call returns it to ok", async () => {
  let answer: () => string | Promise<string> = () => "fine";
  const s = fakeStt(() => answer());
  await run(cfg({ stt_timeout_ms: 80 }), s, async (r) => {
    for (const [i, fail] of [
      () => { throw new SttStatus(500); }, () => { throw new SttStatus(502); }, () => { throw new SttStatus(401); }, () => { throw new SttStatus(403); },
      () => { throw new SttStatus(404); }, () => { throw new SttStatus(429); }, () => { throw new SttStatus(418); }, () => new Promise<string>(() => {}),
    ].entries()) {
      answer = fail;
      assert.equal((await r.inject(`o${i}`)).ok, false);
      await waitFor(() => stt(r) === "down", `down after failure ${i}`, 3000);
      answer = () => "fine";
      assert.equal((await r.inject(`k${i}`)).ok, true);
      await waitFor(() => stt(r) === "ok", `ok after success ${i}`, 3000);
    }
  });
});

// @spec EARS-HLTH-004, EARS-ENG-009
test("batch engine: a 400 or 422 for one clip leaves deps.stt unchanged", async () => {
  let status = 400;
  const s = fakeStt(() => { throw new SttStatus(status); });
  await run(cfg(), s, async (r) => {
    for (status of [400, 422]) {
      assert.equal((await r.inject(`b${status}`)).ok, false);
      await sleep(150);
    }
    assert.equal(stt(r), "ok");
    assert.ok(!everDown(r));
  });
});

// @spec EARS-HLTH-003, EARS-HLTH-005, EARS-HLTH-011
test("streaming engine down: utterances are transcribed by the fallback with deps.stt kept down and the detail naming it; only a session that opens and delivers its final returns it to ok", async () => {
  const s = fakeStt(() => "from the fallback");
  const eng = fakeStreaming({ open: (n) => { if (n === 0) throw new Error("connect ECONNREFUSED"); }, finish: () => "from the session" });
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "heard by the fallback");
    assert.equal(r.heard()[0]!.text, "from the fallback");
    await waitFor(() => stt(r) === "down" && /nemotron unavailable: .*ECONNREFUSED.*; transcribing with speaches/.test(detail(r)), "down, transcribing with speaches", 3000);
    assert.equal(r.lastHeartbeat()?.state, "degraded");
    await sleep(200);
    assert.equal(stt(r), "down", "a successful fallback call does not set it back to ok");
    await say(r); // the next utterance tries a session again and this one opens
    await waitFor(() => r.heard().length === 2, "heard by the session");
    assert.equal(r.heard()[1]!.text, "from the session");
    await waitFor(() => stt(r) === "ok", "ok after a session delivered its final", 3000);
  }, { streaming: eng.engine });
});

// @spec EARS-HLTH-007
test("the fallback batch engine failing while the selected engine is down adds 'fallback <name> failed: <reason>' to the detail", async () => {
  const s = fakeStt(() => { throw new SttStatus(503, "overloaded"); });
  const eng = fakeStreaming({ open: () => { throw new Error("connect ECONNREFUSED"); } });
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    await say(r);
    await waitFor(() => stt(r) === "down" && /fallback speaches failed: .*503/.test(detail(r)), "fallback failure in the detail", 3000);
    assert.equal(r.heard().length, 0);
  }, { streaming: eng.engine });
});

// @spec EARS-HLTH-008
test("an engine with a readiness probe starts down until the first ping succeeds, pings at start and on the period while down, and stops pinging once ok", async () => {
  assert.equal(STT_PING_INTERVAL_MS, 10_000);
  let ready = false;
  const s = fakeStt(() => "x");
  const eng = fakeStreaming({ ping: () => ready });
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    assert.equal(r.bus.health[0]!.deps.stt, "down", "down from the first heartbeat");
    await waitFor(() => eng.stats.pings >= 3, "repeated pings while down", 3000);
    assert.equal(stt(r), "down");
    ready = true;
    await waitFor(() => stt(r) === "ok", "ok after a ping succeeds", 3000);
    const n = eng.stats.pings;
    await sleep(200);
    assert.equal(eng.stats.pings, n, "no ping while ok");
  }, { streaming: eng.engine, pingIntervalMs: 30 });
});

// @spec EARS-HLTH-008
test("an engine with no readiness probe starts with deps.stt ok", async () => {
  const s = fakeStt(() => "x");
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    assert.equal(r.bus.health[0]!.deps.stt, "ok");
  }, { streaming: fakeStreaming().engine });
});

// @spec EARS-HLTH-009
test("the heartbeat detail names the selected engine and the host it talks to", async () => {
  const prev = process.env.STT_URL;
  process.env.STT_URL = "http://10.1.2.3:8000";
  try {
    const cases: { ears: Record<string, unknown>; streaming?: ReturnType<typeof fakeStreaming>; engine: string; host: string }[] = [
      { ears: { stt_engine: "speaches" }, engine: "speaches", host: "10.1.2.3" },
      { ears: { stt_engine: "openai", openai: { base_url: "https://api.example.com/v1" } }, engine: "openai", host: "api.example.com" },
      { ears: { stt_engine: "nemotron" }, streaming: fakeStreaming({ destination: "stt-box.example" }), engine: "nemotron", host: "stt-box.example" },
    ];
    for (const c of cases) {
      const s = fakeStt(() => "x");
      await run(cfg(c.ears), s, async (r) => {
        await waitFor(() => detail(r).includes(c.engine) && detail(r).includes(c.host), `detail names ${c.engine} and ${c.host}`, 3000);
      }, c.streaming ? { streaming: c.streaming.engine } : {});
    }
  } finally { if (prev === undefined) delete process.env.STT_URL; else process.env.STT_URL = prev; }
});

// @spec EARS-HLTH-010
test("start-up logs one warning for each engine audio is sent to that is off the LAN, naming the engine and its host; the fallback only counts while the selected engine streams", async () => {
  const off = { base_url: "https://api.openai.com/v1" };
  const hit = (r: Rig, host: string) => warnText(r).filter((w) => w.includes(host));
  let s = fakeStt(() => "x");
  await run(cfg({ stt_engine: "openai", openai: off }), s, async (r) => {
    const w = hit(r, "api.openai.com");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /openai/);
  });
  s = fakeStt(() => "x");
  await run(cfg({ stt_engine: "speaches", stt_fallback_engine: "openai", openai: off }), s, async (r) => {
    assert.equal(hit(r, "api.openai.com").length, 0, "the fallback of a batch selected engine receives no audio");
    assert.equal(warnText(r).filter((w) => /127\.0\.0\.1/.test(w)).length, 0, "a LAN engine is not warned about");
  });
  s = fakeStt(() => "x");
  await run(cfg({ stt_engine: "nemotron", stt_fallback_engine: "openai", openai: off, nemotron: { url: "http://stt-nemotron:8080" } }), s, async (r) => {
    const w = hit(r, "api.openai.com");
    assert.equal(w.length, 1, "the fallback of a streaming engine does");
    assert.match(w[0]!, /openai/);
    assert.equal(hit(r, "stt-nemotron").length, 0);
  }, { streaming: fakeStreaming().engine });
  s = fakeStt(() => "x");
  await run(cfg({ stt_engine: "kyutai", kyutai: { url: "https://asr.example.com" } }), s, async (r) => {
    const w = hit(r, "asr.example.com");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /kyutai/);
  }, { streaming: fakeStreaming({ name: "kyutai" }).engine });
});

// @spec EARS-HLTH-012
test("the batch engine failing on a whole clip while the selected streaming engine is up warns, leaves deps.stt unchanged and is that input's own outcome", async () => {
  const s = fakeStt(() => { throw new SttStatus(503); });
  const eng = fakeStreaming();
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    const before = warnText(r).length;
    const res = await r.inject("w1");
    assert.equal(res.ok, false, "the injection reports the failure");
    await sleep(200);
    assert.ok(warnText(r).length > before, "a warning is logged");
    assert.equal(stt(r), "ok");
    assert.ok(!everDown(r));
  }, { streaming: eng.engine });
});

// @spec EARS-HLTH-003, EARS-HLTH-005
test("a session that drops mid-stream sets deps.stt down with the reason, and the fallback transcribes the utterance", async () => {
  const s = fakeStt(() => "from the fallback");
  const eng = fakeStreaming({ finish: () => "unused" });
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    const speaking = say(r);
    await waitFor(() => eng.sessions.length === 1, "session");
    eng.sessions[0]!.fail(new Error("server closed"));
    await speaking;
    await waitFor(() => r.heard().length === 1, "heard by the fallback", 3000);
    assert.equal(r.heard()[0]!.text, "from the fallback");
    await waitFor(() => stt(r) === "down" && /nemotron unavailable: server closed; transcribing with speaches/.test(detail(r)), "down on the drop", 3000);
  }, { streaming: eng.engine });
});

// @spec EARS-HLTH-003, EARS-ENG-009
test("a failed finish() sets deps.stt down with the reason, and the batch fallback transcribes the retained clip", async () => {
  const s = fakeStt(() => "rescued");
  const eng = fakeStreaming({ finish: () => { throw new Error("no final"); } });
  await run(cfg({ stt_engine: "nemotron" }), s, async (r) => {
    await say(r);
    await waitFor(() => r.heard().length === 1, "rescued", 3000);
    assert.equal(r.heard()[0]!.text, "rescued");
    await waitFor(() => stt(r) === "down" && /nemotron unavailable: no final; transcribing with speaches/.test(detail(r)), "down after a failed finish", 3000);
  }, { streaming: eng.engine });
});

// @spec EARS-HLTH-008, EARS-ENG-007
test("a ping that never answers is bounded by ears.stt_timeout_ms, and no second ping is sent while it is in flight", async () => {
  const s = fakeStt(() => "x");
  const eng = fakeStreaming({ ping: () => new Promise<boolean>(() => {}) });
  await run(cfg({ stt_engine: "nemotron", stt_timeout_ms: 100 }), s, async (r) => {
    await sleep(500);
    assert.equal(eng.stats.maxPingsInFlight, 1, "never more than one ping in flight");
    assert.equal(eng.stats.pings, 1, "the hung ping is not joined by another");
    assert.equal(stt(r), "down");
    assert.match(detail(r), /awaiting first ping|ping did not answer/);
  }, { streaming: eng.engine, pingIntervalMs: 30 });
});

// @spec EARS-HLTH-008
test("a ping that answers after the bound is not ok, and the next probe after it settles can bring deps.stt ok", async () => {
  let n = 0;
  const s = fakeStt(() => "x");
  const eng = fakeStreaming({ ping: async (signal) => { n++; if (n === 1) { await new Promise((r) => setTimeout(r, 250)); return true; } return true; } });
  await run(cfg({ stt_engine: "nemotron", stt_timeout_ms: 100 }), s, async (r) => {
    await waitFor(() => stt(r) === "ok", "ok after the second ping", 3000);
    assert.equal(eng.stats.pings, 2, "a second ping followed the first once it settled");
  }, { streaming: eng.engine, pingIntervalMs: 30 });
});
