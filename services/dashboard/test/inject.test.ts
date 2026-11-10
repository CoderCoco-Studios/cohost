import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { UploadStore } from "../src/uploads.js";
import { StackService } from "../src/stack.js";
import { uploadBase } from "../src/inject.js";

class CtlBus extends FakeBus {
  async resetGroup() {}
}

async function boot(env: NodeJS.ProcessEnv = {}, maxImage = 64) {
  const bus = new CtlBus();
  const rec = recordingLog();
  const uploads = new UploadStore({ maxImageBytes: maxImage, maxAudioBytes: 64, ttlMs: 600_000, maxEntries: 16, maxTotalBytes: 10_000 });
  const setup = setupControl(env, bus, rec.log);
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    control: setup.control, uploads, dashboardUrl: "http://dashboard:3000", stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const text = (body: unknown, token?: string) =>
    fetch(`${base}/inject/text`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const bin = (path: string, body: Buffer | string, type: string | undefined, token?: string) =>
    fetch(`${base}${path}`, { method: "POST", body, headers: { ...(type ? { "content-type": type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { bus, base, uploads, text, bin };
}

// @spec DASH-INJ-002
test("bus-level chat publishes an injected chat.message and returns 202 {id}", async () => {
  const t = await boot();
  const r = await t.text({ level: "bus", text: "  hi   there ", user: "bob", isMod: true });
  assert.equal(r.status, 202);
  assert.ok(typeof ((await r.json()) as { id: string }).id === "string");
  assert.deepEqual(t.bus.of("chat.message"), [{ platform: "twitch", user: "bob", text: "hi there", isMod: true, isSub: false, mentionsCohost: false, injected: true, remember: false }]);
});

// @spec DASH-INJ-003
test("bus-level speech and vision", async () => {
  const t = await boot();
  assert.equal((await t.text({ level: "bus", as: "speech", text: "hello", user: "al", remember: true })).status, 202);
  assert.equal((await t.text({ level: "bus", as: "speech", text: "anon" })).status, 202);
  assert.equal((await t.text({ level: "bus", as: "vision", text: "a boss fight", remember: true })).status, 202);
  assert.deepEqual(t.bus.of("speech.heard"), [
    { speaker: "al", text: "hello", durationMs: 0, injected: true, remember: true },
    { speaker: "injected", text: "anon", durationMs: 0, injected: true, remember: false },
  ]);
  assert.deepEqual(t.bus.of("vision.summary"), [{ text: "a boss fight", changed: true, injected: true, remember: true }]);
});

// @spec DASH-INJ-004
test("service-level chat publishes inject.request with the response id", async () => {
  const t = await boot();
  const r = await t.text({ level: "service", text: "hello", user: "bob", platform: "youtube", isSub: true });
  const { id } = (await r.json()) as { id: string };
  assert.equal(r.status, 202);
  assert.deepEqual(t.bus.of("inject.request"), [{ id, target: "chat", kind: "text", text: "hello", meta: { user: "bob", platform: "youtube", isSub: true }, remember: false }]);
  assert.equal(t.bus.of("chat.message").length, 0);
});

// @spec DASH-INJ-001
test("text validation: 400s publish nothing", async () => {
  const t = await boot();
  for (const body of [
    { level: "service", as: "speech", text: "x" },
    { level: "service", as: "vision", text: "x" },
    { level: "bus", text: "   " },
    { level: "bus" },
    { level: "nope", text: "x" },
    { level: "bus", as: "weird", text: "x" },
    { level: "bus", text: "x", platform: "irc" },
    { level: "bus", text: "x", remember: "yes" },
    "not json",
  ]) assert.equal((await t.text(body)).status, 400, JSON.stringify(body));
  assert.equal(t.bus.published.length, 0);
});

// @spec DASH-INJ-005, DASH-INJ-007
test("image upload: stored, served at /uploads/:id, request carries the URL", async () => {
  const t = await boot();
  const png = Buffer.from("PNGDATA");
  const r = await t.bin("/inject/image?remember=1", png, "image/png");
  assert.equal(r.status, 202);
  const { id } = (await r.json()) as { id: string };
  const [req] = t.bus.of("inject.request");
  assert.equal(req!.id, id);
  assert.equal(req!.target, "eyes");
  assert.equal(req!.kind, "image");
  assert.equal(req!.remember, true);
  assert.match(req!.url!, /^http:\/\/dashboard:3000\/uploads\/[0-9a-f]{32}$/);
  const got = await fetch(`${t.base}${new URL(req!.url!).pathname}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "PNGDATA");
});

// @spec DASH-INJ-005
test("the advertised upload base is DASHBOARD_URL when set and non-empty, else host.docker.internal on the LAN port (default 3001)", () => {
  assert.equal(uploadBase({}), "http://host.docker.internal:3001");
  assert.equal(uploadBase({ DASHBOARD_LAN_PORT: "4001" }), "http://host.docker.internal:4001");
  assert.equal(uploadBase({ DASHBOARD_LAN_PORT: "" }), "http://host.docker.internal:3001");
  assert.equal(uploadBase({ DASHBOARD_URL: "http://192.168.1.5:3001" }), "http://192.168.1.5:3001");
  assert.equal(uploadBase({ DASHBOARD_URL: "", DASHBOARD_LAN_PORT: "4001" }), "http://host.docker.internal:4001");
  assert.equal(uploadBase({ DASHBOARD_URL: "http://192.168.1.5:3001", DASHBOARD_LAN_PORT: "4001" }), "http://192.168.1.5:3001");
});

// @spec DASH-INJ-005
test("without an explicit dashboardUrl the handler advertises the env-derived base in inject.request", async () => {
  const bus = new CtlBus();
  const rec = recordingLog();
  const prev = { url: process.env.DASHBOARD_URL, lan: process.env.DASHBOARD_LAN_PORT };
  delete process.env.DASHBOARD_URL; process.env.DASHBOARD_LAN_PORT = "4321";
  const handler = createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], stack: new StackService({ log: rec.log, bus: () => "connected" }),
  });
  if (prev.url !== undefined) process.env.DASHBOARD_URL = prev.url;
  if (prev.lan === undefined) delete process.env.DASHBOARD_LAN_PORT; else process.env.DASHBOARD_LAN_PORT = prev.lan;
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/inject/image`, { method: "POST", body: "PNG", headers: { "content-type": "image/png" } });
  assert.equal(r.status, 202);
  assert.match(bus.of("inject.request")[0]!.url!, /^http:\/\/host\.docker\.internal:4321\/uploads\/[0-9a-f]{32}$/);
});

// @spec DASH-INJ-005
test("audio upload labels the speaker; charset params on content-type are tolerated", async () => {
  const t = await boot();
  assert.equal((await t.bin("/inject/audio?user=alice", Buffer.from("RIFF"), "audio/wav")).status, 202);
  assert.equal((await t.bin("/inject/audio", Buffer.from("OggS"), "audio/ogg; codecs=opus")).status, 202);
  const [a, b] = t.bus.of("inject.request");
  assert.equal(a!.target, "ears");
  assert.equal(a!.kind, "audio");
  assert.equal(a!.meta?.user, "alice");
  assert.equal(a!.remember, false);
  assert.equal(b!.meta, undefined);
});

// @spec DASH-INJ-006
test("binary rejections: 413 too large, 415 wrong type, 400 empty / bus level; nothing stored or published", async () => {
  const t = await boot({}, 8);
  assert.equal((await t.bin("/inject/image", Buffer.alloc(9), "image/png")).status, 413);
  assert.equal((await t.bin("/inject/image", "<html>", "text/html")).status, 415);
  assert.equal((await t.bin("/inject/image", "x", undefined)).status, 415);
  assert.equal((await t.bin("/inject/image", Buffer.alloc(0), "image/png")).status, 400);
  assert.equal((await t.bin("/inject/image?level=bus", Buffer.from("x"), "image/png")).status, 400);
  assert.equal((await t.bin("/inject/audio?level=bus", Buffer.from("x"), "audio/wav")).status, 400);
  assert.equal(t.bus.published.length, 0);
  assert.equal(t.uploads.size, 0);
});

// @spec DASH-INJ-007
test("GET /uploads/:id is 404 for unknown ids", async () => {
  const t = await boot();
  assert.equal((await fetch(`${t.base}/uploads/deadbeef`)).status, 404);
});

// @spec DASH-CTRL-004, DASH-CTRL-005
test("gate: with control enabled the three routes need the bearer token; /uploads stays open", async () => {
  const t = await boot({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "s3cret" });
  assert.equal((await t.text({ level: "bus", text: "hi" })).status, 401);
  assert.equal((await t.text({ level: "bus", text: "hi" }, "wrong")).status, 401);
  assert.equal((await t.bin("/inject/image", Buffer.from("x"), "image/png")).status, 401);
  assert.equal((await t.bin("/inject/audio", Buffer.from("x"), "audio/wav")).status, 401);
  assert.equal(t.bus.published.length, 0);
  assert.equal(t.uploads.size, 0);
  assert.equal((await t.text({ level: "bus", text: "hi" }, "s3cret")).status, 202);
  const r = await t.bin("/inject/image", Buffer.from("x"), "image/png", "s3cret");
  assert.equal(r.status, 202);
  const url = new URL(t.bus.of("inject.request")[0]!.url!);
  assert.equal((await fetch(`${t.base}${url.pathname}`)).status, 200);
});

// @spec DASH-CTRL-001
test("control disabled: routes are open", async () => {
  const t = await boot({});
  assert.equal((await t.text({ level: "bus", text: "hi" })).status, 202);
});
