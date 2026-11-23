import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { createInjectHandler } from "../src/inject.js";

const run = async (h: { (ev: never): void; drain(): Promise<void> }, ev: unknown): Promise<void> => { h(ev as never); await h.drain(); };

const cfg = testConfig({ chat: { ignore_users: ["nightbot"], ignore_prefixes: ["!"] }, viewer_text: { max_chars: 16, max_name_chars: 8 } });
function setup(now?: () => number) {
  const bus = new FakeBus();
  const handle = createInjectHandler({ bus, log: recordingLog().log, cohostName: cfg.cohost.name, viewerText: cfg.viewer_text, now });
  return { bus, handle };
}
// @spec CHAT-INJ-010
test("chat takes injection through the shared handler: target chat, kind text only", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "hello Coco" }));
  assert.deepEqual(bus.of("inject.result"), [{ id: "r1", ok: true }]);
  await run(handle, req({ id: "r2", kind: "image", uploadId: "0123456789abcdef0123456789abcdef" }));
  assert.deepEqual(bus.of("inject.result")[1], { id: "r2", ok: false, detail: "chat cannot handle kind 'image'" });
});

const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "r1", target: "chat", kind: "text", text: "hi", remember: false, ...over });

// @spec CHAT-INJ-005
test("viewer fields and defaults, then ok result", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ meta: { user: "bob", isMod: true } }));
  assert.deepEqual(bus.of("chat.message"), [{ platform: "twitch", user: "bob", text: "hi", isMod: true, isSub: false, mentionsCohost: false, injected: true, remember: false }]);
  assert.deepEqual(bus.of("inject.result"), [{ id: "r1", ok: true }]);
});

// @spec CHAT-INJ-005
test("defaults: injected_viewer on twitch; remember copied; platform from meta", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ remember: true }));
  await run(handle, req({ id: "r2", meta: { platform: "youtube" } }));
  const [a, b] = bus.of("chat.message");
  assert.equal(a!.user, "injected_viewer");
  assert.equal(a!.platform, "twitch");
  assert.equal(a!.remember, true);
  assert.equal(b!.platform, "youtube");
});

// @spec CHAT-INJ-006
test("ignore_users / ignore_prefixes are bypassed", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "!hello", meta: { user: "nightbot" } }));
  assert.equal(bus.of("chat.message")[0]!.text, "!hello");
  assert.equal(bus.of("chat.message")[0]!.user, "nightbot");
});

// @spec CHAT-INJ-005, CHAT-INJ-007
test("mention is detected case-insensitively; whitespace collapsed", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "  hey   COCO  " }));
  assert.equal(bus.of("chat.message")[0]!.mentionsCohost, true);
  assert.equal(bus.of("chat.message")[0]!.text, "hey COCO");
});

// @spec CHAT-INJ-004
test("blank text: no message, ok:false", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "   " }));
  assert.equal(bus.of("chat.message").length, 0);
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});

// @spec SHARED-INJ-002
test("stale request: only ok:false stale", async () => {
  const { bus, handle } = setup(() => Date.now() + 61_000);
  await run(handle, req());
  assert.deepEqual(bus.published.map((p) => p.type), ["inject.result"]);
  assert.deepEqual(bus.of("inject.result")[0], { id: "r1", ok: false, detail: "stale" });
});

// @spec SHARED-INJ-001, CHAT-INJ-004
test("other target publishes nothing; wrong kind for chat is ok:false", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ target: "eyes", kind: "image", uploadId: "0123456789abcdef0123456789abcdef" }));
  assert.equal(bus.published.length, 0);
  await run(handle, req({ kind: "audio" }));
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});

// @spec CHAT-INJ-004
test("text blank after the bound (invisible characters only) gets ok:false with a detail", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "\u200b\u2060 \u0007" }));
  assert.equal(bus.of("chat.message").length, 0);
  const [res] = bus.of("inject.result");
  assert.equal(res!.ok, false);
  assert.ok(res!.detail);
});

// @spec CHAT-INJ-005
test("a valid injection carries injected, remember, platform and flags, and no userId", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ remember: true, meta: { platform: "youtube", user: "bob", isMod: true, isSub: true } }));
  const [m] = bus.of("chat.message");
  assert.deepEqual(m, { platform: "youtube", user: "bob", text: "hi", isMod: true, isSub: true, mentionsCohost: false, injected: true, remember: true });
  assert.equal("userId" in m!, false);
});

// @spec CHAT-INJ-011
test("injected text is bounded like real chat", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ text: "a".repeat(40) }));
  assert.equal(bus.of("chat.message")[0]!.text, `${"a".repeat(15)}…`);
});

// @spec CHAT-INJ-012
test("injected user is bounded; injected_viewer when meta.user is absent or bounds to nothing", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ id: "a", meta: { user: "x".repeat(30) } }));
  await run(handle, req({ id: "b", meta: { user: "\u200b" } }));
  await run(handle, req({ id: "c", meta: { user: "" } }));
  await run(handle, req({ id: "d" }));
  const users = bus.of("chat.message").map((m) => m.user);
  assert.deepEqual(users, [`${"x".repeat(7)}…`, "injected_viewer", "injected_viewer", "injected_viewer"]);
});

// @spec CHAT-INJ-007
test("injected mention is computed on the bounded text", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ id: "a", text: `${"x ".repeat(10)}coco` }));
  await run(handle, req({ id: "b", text: "co\u200bco hi" }));
  const [a, b] = bus.of("chat.message");
  assert.equal(a!.mentionsCohost, false);
  assert.equal(b!.mentionsCohost, true);
});

// @spec CHAT-INJ-008
test("publish failure becomes ok:false when the bus can still answer", async () => {
  const { bus, handle } = setup();
  bus.fail = (t) => t === "chat.message";
  await run(handle, req());
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});

// @spec CHAT-INJ-014
test("an injected line naming platform youtube publishes with that platform, no userId and no messageId", async () => {
  const { bus, handle } = setup();
  await run(handle, req({ meta: { platform: "youtube", user: "yt_viewer" } }));
  const m = bus.of("chat.message")[0]!;
  assert.equal(m.platform, "youtube");
  assert.equal("userId" in m, false);
  assert.equal("messageId" in m, false);
  assert.deepEqual(bus.of("inject.result"), [{ id: "r1", ok: true }]);
});
