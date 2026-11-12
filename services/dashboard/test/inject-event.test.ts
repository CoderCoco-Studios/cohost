import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import type { HealthState, ServiceHealth } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { StackService } from "../src/stack.js";

// Test injection at the bus level (POST /inject/event) and the not-running refusal every injection route shares
// (module-contract MOD-TEST-002 to MOD-TEST-006).

const ids = ["chat", "eyes", "ears", "salience", "affect", "memory", "cortex", "voice", "mouth", "avatar"];
const health = (state: HealthState): ServiceHealth[] => ids.map((service) => ({ service, state, restarts: 0 }));

async function boot(env: NodeJS.ProcessEnv = {}, states: Record<string, HealthState> = {}) {
  const bus = new (class extends FakeBus { async resetGroup() {} })();
  const rec = recordingLog();
  const setup = setupControl(env, bus, rec.log);
  const services = () => health("up").map((s) => (states[s.service] ? { ...s, state: states[s.service]! } : s));
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services,
    control: setup.control,
    uploads: { maxImageBytes: 64, maxAudioBytes: 64, ttlMs: 300_000 },
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const event = (body: unknown, token?: string) =>
    fetch(`${base}/inject/event`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (path: string, body: BodyInit, type: string) => fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": type } });
  return { bus, base, event, post };
}

const chat = { platform: "twitch", user: "bob", text: "hi" };

// @spec MOD-TEST-002
test("400 unless unit is a unit and type is one of that unit's test inputs", async () => {
  const t = await boot();
  assert.equal((await t.event("not json")).status, 400);
  assert.equal((await t.event([1])).status, 400);
  assert.equal((await t.event({ type: "chat.message", data: chat })).status, 400, "no unit");
  assert.equal((await t.event({ unit: "nope", type: "chat.message", data: chat })).status, 400, "unknown unit");
  assert.equal((await t.event({ unit: "redis", type: "chat.message", data: chat })).status, 400, "a manifest service that is not a unit");
  assert.equal((await t.event({ unit: "cortex", type: "chat.message", data: chat })).status, 400, "type not an input of that unit");
  assert.equal((await t.event({ unit: "chat", type: "text", data: {} })).status, 400, "a service-level kind is not a bus type");
  assert.equal((await t.event({ unit: "salience", type: "no.such", data: {} })).status, 400);
  assert.equal(t.bus.published.length, 0);
});

// @spec MOD-TEST-002
test("400 with the schema issues unless data validates against the bus schema for type", async () => {
  const t = await boot();
  const r = await t.event({ unit: "salience", type: "chat.message", data: { platform: "irc", user: 7 } });
  assert.equal(r.status, 400);
  const j = (await r.json()) as { ok: boolean; issues: { path: string; message: string }[] };
  assert.equal(j.ok, false);
  assert.ok(j.issues.some((i) => i.path === "platform") && j.issues.some((i) => i.path === "user") && j.issues.some((i) => i.path === "text"), JSON.stringify(j.issues));
  assert.equal((await t.event({ unit: "salience", type: "chat.message" })).status, 400, "data missing");
  assert.equal(t.bus.published.length, 0);
});

// @spec MOD-TEST-003
test("an accepted injection publishes one event of that type with injected: true and answers 202 with the bus id", async () => {
  const t = await boot();
  const r = await t.event({ unit: "salience", type: "chat.message", data: chat });
  assert.equal(r.status, 202);
  const { id } = (await r.json()) as { id: string };
  assert.match(id, /^\d+-\d+$/, "the id FakeBus gave the published event");
  assert.deepEqual(t.bus.published.map((p) => p.type), ["chat.message"]);
  assert.deepEqual(t.bus.of("chat.message"), [{ ...chat, isMod: false, isSub: false, mentionsCohost: false, injected: true }]);
});

// @spec MOD-TEST-003
test("injected is left unset where the event schema has no injected field, and an operator's own injected: false is overridden", async () => {
  const t = await boot();
  assert.equal((await t.event({ unit: "avatar", type: "affect.state", data: { valence: 0.2, arousal: 0.3, mood: "neutral" } })).status, 202);
  assert.deepEqual(t.bus.of("affect.state"), [{ valence: 0.2, arousal: 0.3, mood: "neutral" }]);
  assert.equal((await t.event({ unit: "memory", type: "memory.recall.request", data: { id: "r1", query: "q" } })).status, 202);
  assert.deepEqual(t.bus.of("memory.recall.request"), [{ id: "r1", query: "q" }]);
  assert.equal((await t.event({ unit: "salience", type: "vision.summary", data: { text: "boss", injected: false } })).status, 202);
  assert.equal(t.bus.of("vision.summary")[0]!.injected, true);
});

// @spec MOD-TEST-004
test("with control enabled POST /inject/event needs the bearer token; a body over 64 KiB is 413 and publishes nothing", async () => {
  const t = await boot({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" });
  assert.equal((await t.event({ unit: "salience", type: "chat.message", data: chat })).status, 401);
  assert.equal((await t.event({ unit: "salience", type: "chat.message", data: chat }, "wrong")).status, 401);
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.event({ unit: "salience", type: "chat.message", data: chat }, "s3cret")).status, 202);
  const big = JSON.stringify({ unit: "salience", type: "chat.message", data: { ...chat, text: "x".repeat(70 * 1024) } });
  assert.equal((await t.event(big, "s3cret")).status, 413);
  assert.equal(t.bus.of("chat.message").length, 1);
});

// @spec MOD-TEST-005, DASH-INJ-008
test("an injection for a unit that is down or unknown is refused 409 and publishes nothing; one that is stale, degraded or crash-looping is accepted", async () => {
  const t = await boot({}, { salience: "down", affect: "unknown", cortex: "stale", memory: "degraded", voice: "crash-looping" });
  for (const unit of ["salience", "affect"]) {
    const r = await t.event({ unit, type: "chat.message", data: chat });
    assert.equal(r.status, 409, unit);
    assert.deepEqual(await r.json(), { ok: false, detail: `service not running: ${unit}` });
  }
  assert.equal(t.bus.published.length, 0);
  assert.equal((await t.event({ unit: "cortex", type: "attention.focus", data: { reason: "r", score: 0.5 } })).status, 202);
  assert.equal((await t.event({ unit: "memory", type: "memory.recall.request", data: { id: "r", query: "q" } })).status, 202);
  assert.equal((await t.event({ unit: "voice", type: "brain.say", data: { id: "s", text: "hi", emotion: "neutral" } })).status, 202);
});

// @spec MOD-TEST-005, DASH-INJ-008
test("the same refusal covers service-level text, image and audio, and bus-level text is not refused", async () => {
  const t = await boot({}, { chat: "down", eyes: "unknown", ears: "down" });
  const text = await fetch(`${t.base}/inject/text`, { method: "POST", body: JSON.stringify({ level: "service", text: "hi" }) });
  assert.equal(text.status, 409);
  assert.deepEqual(await text.json(), { ok: false, detail: "service not running: chat" });
  const img = await t.post("/inject/image", "PNG", "image/png");
  assert.equal(img.status, 409);
  assert.deepEqual(await img.json(), { ok: false, detail: "service not running: eyes" });
  const audio = await t.post("/inject/audio", "RIFF", "audio/wav");
  assert.equal(audio.status, 409);
  assert.deepEqual(await audio.json(), { ok: false, detail: "service not running: ears" });
  assert.equal(t.bus.published.length, 0);
  const bus = await fetch(`${t.base}/inject/text`, { method: "POST", body: JSON.stringify({ level: "bus", text: "hi" }) });
  assert.equal(bus.status, 202);
});

// @spec MOD-TEST-006
test("an injected brain.say is published once, as injected, only through /inject/event and never as a cortex control say", async () => {
  const t = await boot();
  const say = { id: "s1", text: "testing", emotion: "happy" };
  assert.equal((await t.event({ unit: "voice", type: "brain.say", data: say })).status, 202);
  assert.deepEqual(t.bus.published.map((p) => p.type), ["brain.say"]);
  assert.equal(t.bus.of("brain.say")[0]!.injected, true);
  assert.equal(t.bus.of("control").length, 0, "nothing is routed through the control say that cortex answers");
  // not an input of cortex or chat: those units never get one
  assert.equal((await t.event({ unit: "cortex", type: "brain.say", data: say })).status, 400);
  assert.equal((await t.event({ unit: "chat", type: "brain.say", data: say })).status, 400);
  // salience consumes brain.say but only for its own bookkeeping; the manifest lists it as observed, not an input
  assert.equal((await t.event({ unit: "salience", type: "brain.say", data: say })).status, 400);
});
