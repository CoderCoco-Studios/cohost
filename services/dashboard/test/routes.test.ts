import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";

// The voice service the dashboard proxies audio from.
const voice = http.createServer((req, res) => {
  if (req.url === "/audio/a1.wav") { res.writeHead(200, { "content-type": "audio/wav" }); res.end("RIFFDATA"); return; }
  res.writeHead(404); res.end("gone");
});
await new Promise<void>((r) => voice.listen(0, r));
after(() => voice.close());

const bus = new FakeBus();
const tracker = new HealthTracker();
const rec = recordingLog();
let personality = "# Coco\n";
const server = http.createServer(createDashboardHandler({
  bus, log: rec.log,
  html: "<title>__COHOST_NAME__ dashboard</title>",
  cohostName: "Coco",
  voiceUrl: `http://127.0.0.1:${(voice.address() as { port: number }).port}`,
  loadPersonality: () => personality,
  savePersonality: (t) => { personality = t; },
  services: () => tracker.snapshot(),
}));
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (path: string, body: unknown, method = "POST") => fetch(`${base}${path}`, { method, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET / serves the page with the co-host's name filled in", async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.equal(await r.text(), "<title>Coco dashboard</title>");
});

test("GET /audio/* proxies the voice service, passing its status through, uncached", async () => {
  const ok = await fetch(`${base}/audio/a1.wav`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/wav");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(await ok.text(), "RIFFDATA");
  assert.equal((await fetch(`${base}/audio/missing.wav`)).status, 404);
});

test("personality: GET reads it; PUT saves it and tells the cortex to reload", async () => {
  assert.equal(await (await fetch(`${base}/personality`)).text(), "# Coco\n");
  bus.clear();
  const r = await post("/personality", "# Coco v2\n", "PUT");
  assert.equal(r.status, 204);
  assert.equal(personality, "# Coco v2\n");
  assert.deepEqual(bus.published, [{ type: "control", data: { cmd: "reload_personality" } }]);
});

test("POST /control forwards operator commands to the bus", async () => {
  bus.clear();
  assert.equal((await post("/control", { cmd: "say", text: "brb" })).status, 204);
  assert.equal((await post("/control", { cmd: "mute" })).status, 204);
  assert.deepEqual(bus.of("control").map((c) => [c.cmd, c.text]), [["say", "brb"], ["mute", undefined]]);
});

test("POST /sink reports the browser audio sink's playing / done", async () => {
  bus.clear();
  await post("/sink", { event: "playing", id: "a1" });
  await post("/sink", { event: "done", id: "a1" });
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "a1", sink: "dashboard" } },
    { type: "voice.done", data: { id: "a1", sink: "dashboard" } },
  ]);
});

test("bad input is a 500 with the error logged, not a crash; unknown routes 404", async () => {
  bus.clear();
  rec.lines.length = 0;
  assert.equal((await post("/control", "{not json")).status, 500);
  assert.equal((await post("/control", { cmd: "self_destruct" })).status, 500); // rejected by the event schema
  assert.equal(bus.published.length, 0);
  assert.deepEqual(rec.msgs("error"), ["request failed", "request failed"]);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await post("/", "x")).status, 404);
  assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
});

test("GET /services lists every known service; unseen ones are unknown, a heartbeating one has its state", async () => {
  tracker.ingest({
    service: "cortex", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready",
    deps: { llm: "ok" }, mode: "live", intervalMs: 5000,
  });
  const r = await fetch(`${base}/services`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /application\/json/);
  const { services } = (await r.json()) as { services: { service: string; state: string }[] };
  assert.equal(services.length, 10);
  assert.equal(services.find((s) => s.service === "cortex")!.state, "up");
  assert.equal(services.filter((s) => s.state === "unknown").length, 9);
});
