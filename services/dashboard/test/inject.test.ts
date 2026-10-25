import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { UploadStore } from "../src/uploads.js";

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
    control: setup.control, uploads, dashboardUrl: "http://dashboard:3000",
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

test("bus-level chat publishes an injected chat.message and returns 202 {id}", async () => {
  const t = await boot();
  const r = await t.text({ level: "bus", text: "  hi   there ", user: "bob", isMod: true });
  assert.equal(r.status, 202);
  assert.ok(typeof ((await r.json()) as { id: string }).id === "string");
  assert.deepEqual(t.bus.of("chat.message"), [{ platform: "twitch", user: "bob", text: "hi there", isMod: true, isSub: false, mentionsCohost: false, injected: true, remember: false }]);
});

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

test("service-level chat publishes inject.request with the response id", async () => {
  const t = await boot();
  const r = await t.text({ level: "service", text: "hello", user: "bob", platform: "youtube", isSub: true });
  const { id } = (await r.json()) as { id: string };
  assert.equal(r.status, 202);
  assert.deepEqual(t.bus.of("inject.request"), [{ id, target: "chat", kind: "text", text: "hello", meta: { user: "bob", platform: "youtube", isSub: true }, remember: false }]);
  assert.equal(t.bus.of("chat.message").length, 0);
});

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

test("GET /uploads/:id is 404 for unknown ids", async () => {
  const t = await boot();
  assert.equal((await fetch(`${t.base}/uploads/deadbeef`)).status, 404);
});

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

test("control disabled: routes are open", async () => {
  const t = await boot({});
  assert.equal((await t.text({ level: "bus", text: "hi" })).status, 202);
});
