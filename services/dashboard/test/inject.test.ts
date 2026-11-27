import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { setupControl } from "../src/control.js";
import { StackService } from "../src/stack.js";
import { TEST_GATE, TOKEN, UNUSED_STORE } from "./control-fixture.js";

/** Every unit up: the not-running refusal (MOD-TEST-005) has its own tests in inject-event.test.ts. */
const UP = ["chat", "eyes", "ears"].map((service) => ({ service, state: "up" as const, restarts: 0 }));

class CtlBus extends FakeBus {
  /** The bus id `publish` answered for each event, in order. */
  ids: string[] = [];
  async resetGroup() {}
  override async publish(...a: Parameters<FakeBus["publish"]>): Promise<string> {
    const id = await super.publish(...a);
    this.ids.push(id);
    return id;
  }
}

async function boot(env: NodeJS.ProcessEnv = {}, maxImage = 64, ttlMs = 300_000) {
  const bus = new CtlBus();
  const rec = recordingLog();
  const uploads = { maxImageBytes: maxImage, maxAudioBytes: 64, ttlMs };
  const setup = setupControl(env, bus, rec.log, TEST_GATE);
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: UNUSED_STORE, services: () => UP,
    control: setup.control, uploads, stack: new StackService({ log: rec.log, bus: () => "connected" }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const text = (body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}/inject/text`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const bin = (path: string, body: Buffer | string, type: string | undefined, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, { method: "POST", body, headers: { ...(type ? { "content-type": type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { bus, ids: bus.ids, base, uploads, text, bin };
}

// @spec DASH-INJ-002
test("bus-level chat publishes an injected chat.message and returns 202 {id}", async () => {
  const t = await boot();
  const r = await t.text({ level: "bus", text: "  hi   there ", user: "bob", isMod: true });
  assert.equal(r.status, 202);
  assert.equal(((await r.json()) as { id: string }).id, t.ids.at(-1), "the answer carries the published event's bus id");
  assert.deepEqual(t.bus.of("chat.message"), [{ platform: "twitch", user: "bob", text: "hi there", isMod: true, isSub: false, mentionsCohost: false, injected: true, remember: false }]);
});

// @spec DASH-INJ-003
test("bus-level speech and vision", async () => {
  const t = await boot();
  for (const body of [
    { level: "bus", as: "speech", text: "hello", user: "al", remember: true },
    { level: "bus", as: "speech", text: "anon" },
    { level: "bus", as: "vision", text: "a boss fight", remember: true },
  ]) {
    const r = await t.text(body);
    assert.equal(r.status, 202);
    assert.equal(((await r.json()) as { id: string }).id, t.ids.at(-1), "the answer carries the published event's bus id");
  }
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

// @spec DASH-INJ-005, DASH-UPL-002
test("image upload: bytes stored in Redis under a 128-bit id with the TTL, the request carries the id and content type and no URL", async () => {
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
  assert.match(req!.uploadId!, /^[0-9a-f]{32}$/);
  assert.equal(req!.contentType, "image/png");
  assert.equal("url" in req!, false);
  const stored = t.bus.uploads.get(req!.uploadId!);
  assert.equal(stored!.bytes.toString(), "PNGDATA");
  assert.equal(stored!.ttlMs, 300_000);
  assert.equal(JSON.stringify(t.bus.published).includes("PNGDATA"), false, "the bytes are not on the event stream");
});

// @spec DASH-UPL-002
test("the stored upload's expiry is dashboard.inject.ttl_ms, 5 minutes by default", async () => {
  const stored = async (t: Awaited<ReturnType<typeof boot>>) => {
    assert.equal((await t.bin("/inject/image", Buffer.from("PNG"), "image/png")).status, 202);
    return t.bus.uploads.get(t.bus.of("inject.request")[0]!.uploadId!)!.ttlMs;
  };
  assert.equal(await stored(await boot()), 300_000);
  assert.equal(await stored(await boot({}, 64, 90_000)), 90_000);
});

// @spec DASH-UPL-003
test("a failed Redis write answers 503 and publishes nothing", async () => {
  const t = await boot();
  t.bus.failUpload = true;
  const r = await t.bin("/inject/audio", Buffer.from("RIFF"), "audio/wav");
  assert.equal(r.status, 503);
  assert.equal(await r.text(), "upload store unavailable");
  assert.equal(t.bus.of("inject.request").length, 0);
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
  assert.equal(t.bus.uploads.size, 0);
});

// @spec DASH-INJ-007
test("there is no upload route: GET /uploads/<id> is 404 even for a stored upload", async () => {
  const t = await boot();
  await t.bin("/inject/image", Buffer.from("x"), "image/png");
  const id = t.bus.of("inject.request")[0]!.uploadId!;
  assert.equal((await fetch(`${t.base}/uploads/${id}`)).status, 404);
});

// @spec DASH-CTRL-004, DASH-CTRL-005
test("gate: the three routes need the bearer token, CONTROL_ENABLED or not", async () => {
  for (const flag of ["0", "1"]) {
    const t = await boot({ CONTROL_ENABLED: flag });
    assert.equal((await t.text({ level: "bus", text: "hi" }, null)).status, 401);
    assert.equal((await t.text({ level: "bus", text: "hi" }, "wrong")).status, 401);
    assert.equal((await t.bin("/inject/image", Buffer.from("x"), "image/png", null)).status, 401);
    assert.equal((await t.bin("/inject/audio", Buffer.from("x"), "audio/wav", null)).status, 401);
    assert.equal(t.bus.published.length, 0);
    assert.equal(t.bus.uploads.size, 0);
    assert.equal((await t.text({ level: "bus", text: "hi" })).status, 202);
    const r = await t.bin("/inject/image", Buffer.from("x"), "image/png");
    assert.equal(r.status, 202);
    assert.equal(t.bus.uploads.size, 1);
  }
});

// @spec DASH-INJ-009
test("bus-level speech with a source sets it on the speech.heard; without it the event carries none", async () => {
  const t = await boot();
  assert.equal((await t.text({ level: "bus", as: "speech", text: "hello", user: "al", source: "desktop" })).status, 202);
  assert.equal((await t.text({ level: "bus", as: "speech", text: "plain" })).status, 202);
  const [withSource, without] = t.bus.of("speech.heard");
  assert.deepEqual(withSource, { speaker: "al", text: "hello", durationMs: 0, injected: true, remember: false, source: "desktop" });
  assert.equal("source" in without!, false);
});

// @spec DASH-INJ-009
test("audio upload with ?source= sets meta.source on the inject.request; without it there is none", async () => {
  const t = await boot();
  assert.equal((await t.bin("/inject/audio?source=desktop&user=al", Buffer.from("RIFF"), "audio/wav")).status, 202);
  assert.equal((await t.bin("/inject/audio?user=al", Buffer.from("RIFF"), "audio/wav")).status, 202);
  const [a, b] = t.bus.of("inject.request");
  assert.equal(a!.meta?.source, "desktop");
  assert.equal(a!.meta?.user, "al");
  assert.equal(b!.meta?.source, undefined);
});

// @spec DASH-INJ-009
test("a source that is not a tag is 400 and publishes and stores nothing", async () => {
  const t = await boot();
  for (const bad of ["Desktop", "1abc", "has space", "", "a".repeat(33), "x_y"]) {
    assert.equal((await t.text({ level: "bus", as: "speech", text: "hi", source: bad })).status, 400, `text ${JSON.stringify(bad)}`);
    assert.equal((await t.bin(`/inject/audio?source=${encodeURIComponent(bad)}`, Buffer.from("RIFF"), "audio/wav")).status, 400, `audio ${JSON.stringify(bad)}`);
  }
  assert.equal((await t.text({ level: "bus", as: "speech", text: "hi", source: 3 })).status, 400);
  assert.equal(t.bus.published.length, 0);
  assert.equal(t.bus.uploads.size, 0);
});

// @spec DASH-INJ-009
test("a source on any other route or kind is 400", async () => {
  const t = await boot();
  assert.equal((await t.text({ level: "bus", text: "hi", source: "desktop" })).status, 400, "bus chat");
  assert.equal((await t.text({ level: "bus", as: "vision", text: "hi", source: "desktop" })).status, 400, "bus vision");
  assert.equal((await t.text({ level: "service", text: "hi", source: "desktop" })).status, 400, "service chat");
  assert.equal((await t.bin("/inject/image?source=desktop", Buffer.from("x"), "image/png")).status, 400, "image upload");
  assert.equal(t.bus.published.length, 0);
  assert.equal(t.bus.uploads.size, 0);
});
