import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";

// The voice service the dashboard proxies audio from.
const voice = http.createServer((req, res) => {
  if (req.url === "/audio/a1.wav") { res.writeHead(200, { "content-type": "audio/wav" }); res.end("RIFFDATA"); return; }
  // Promises 100 bytes, sends 3, then drops the connection: the body read fails after the status line arrived.
  if (req.url === "/audio/cut.wav") { res.writeHead(200, { "content-type": "audio/wav", "content-length": "100" }); res.write("abc"); setTimeout(() => res.destroy(), 20); return; }
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
  html: "<title>__COHOST_NAME__ dashboard</title><h1>__COHOST_NAME__</h1>",
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

// @spec DASH-HTTP-001
test("GET / serves the page with every occurrence of the co-host's name filled in", async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.equal(await r.text(), "<title>Coco dashboard</title><h1>Coco</h1>");
});

// @spec DASH-SINK-001
test("GET /audio/* proxies the voice service, passing its status through, uncached", async () => {
  const ok = await fetch(`${base}/audio/a1.wav`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/wav");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(await ok.text(), "RIFFDATA");
  assert.equal((await fetch(`${base}/audio/missing.wav`)).status, 404);
});

// @spec DASH-HTTP-005, DASH-HTTP-006
test("personality: GET reads it; PUT saves it and tells the cortex to reload", async () => {
  assert.equal(await (await fetch(`${base}/personality`)).text(), "# Coco\n");
  bus.clear();
  const r = await post("/personality", "# Coco v2\n", "PUT");
  assert.equal(r.status, 204);
  assert.equal(personality, "# Coco v2\n");
  assert.deepEqual(bus.published, [{ type: "control", data: { cmd: "reload_personality" } }]);
});

// @spec DASH-HTTP-007
test("POST /control forwards operator commands to the bus", async () => {
  bus.clear();
  assert.equal((await post("/control", { cmd: "say", text: "brb" })).status, 204);
  assert.equal((await post("/control", { cmd: "mute" })).status, 204);
  assert.deepEqual(bus.of("control").map((c) => [c.cmd, c.text]), [["say", "brb"], ["mute", undefined]]);
});

// @spec DASH-SINK-002
test("POST /sink reports the browser audio sink's playing / done", async () => {
  bus.clear();
  await post("/sink", { event: "playing", id: "a1" });
  await post("/sink", { event: "done", id: "a1" });
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "a1", sink: "dashboard" } },
    { type: "voice.done", data: { id: "a1", sink: "dashboard" } },
  ]);
});

// @spec DASH-SINK-003
test("POST /sink with an event other than playing/done is a 400 and publishes nothing", async () => {
  bus.clear();
  for (const b of [{ event: "paused", id: "a1" }, { event: "", id: "a1" }, { id: "a1" }, { event: 3, id: "a1" }]) {
    assert.equal((await post("/sink", b)).status, 400, JSON.stringify(b));
  }
  assert.equal(bus.published.length, 0);
});

// @spec DASH-HTTP-011
test("bodies over 64 KiB are a 413 on /control, /personality and /sink: nothing published or saved", async () => {
  bus.clear();
  const before = personality;
  const big = "x".repeat(64 * 1024 + 1);
  assert.equal((await post("/control", JSON.stringify({ cmd: "say", text: big }))).status, 413);
  assert.equal((await post("/personality", big, "PUT")).status, 413);
  assert.equal((await post("/sink", JSON.stringify({ event: "playing", id: big }))).status, 413);
  assert.equal(personality, before);
  assert.equal(bus.published.length, 0);
  // exactly at the cap is still accepted
  assert.equal((await post("/personality", "y".repeat(64 * 1024), "PUT")).status, 204);
  assert.equal(personality.length, 64 * 1024);
});

// @spec DASH-HTTP-004
test("a failed upstream body read is a 500 before any header is sent; a request URL that does not parse is a 500; the server keeps serving", async () => {
  rec.lines.length = 0;
  assert.equal((await fetch(`${base}/audio/cut.wav`)).status, 500);
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: "//" }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject);
  });
  assert.equal(status, 500);
  assert.deepEqual(rec.msgs("error"), ["request failed", "request failed"]);
  assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
});

// @spec DASH-HTTP-002, DASH-HTTP-003, DASH-HTTP-004, DASH-HTTP-007
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

// @spec DASH-FEED-006
test("GET /services lists every known service; unseen ones are unknown, a heartbeating one has its state", async () => {
  tracker.ingest({
    service: "cortex", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready",
    deps: { llm: "ok" }, mode: "live", intervalMs: 5000,
  });
  const r = await fetch(`${base}/services`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /application\/json/);
  const { services } = (await r.json()) as { services: { service: string; state: string }[] };
  assert.equal(services.length, 9);
  assert.equal(services.find((s) => s.service === "cortex")!.state, "up");
  assert.equal(services.filter((s) => s.state === "unknown").length, 8);
});
