import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, recordingLog, testConfig } from "@cohost/testing";
import { createInjectHandler } from "../src/inject.js";

const cfg = testConfig({ chat: { ignore_users: ["nightbot"], ignore_prefixes: ["!"] } });
function setup(now?: () => number) {
  const bus = new FakeBus();
  const handle = createInjectHandler({ bus, log: recordingLog().log, cohostName: cfg.cohost.name, now });
  return { bus, handle };
}
const req = (over: Record<string, unknown> = {}) =>
  event("inject.request", { id: "r1", target: "chat", kind: "text", text: "hi", remember: false, ...over });

test("viewer fields and defaults, then ok result", async () => {
  const { bus, handle } = setup();
  await handle(req({ meta: { user: "bob", isMod: true } }));
  assert.deepEqual(bus.of("chat.message"), [{ platform: "twitch", user: "bob", text: "hi", isMod: true, isSub: false, mentionsCohost: false, injected: true, remember: false }]);
  assert.deepEqual(bus.of("inject.result"), [{ id: "r1", ok: true }]);
});

test("defaults: injected_viewer on twitch; remember copied; platform from meta", async () => {
  const { bus, handle } = setup();
  await handle(req({ remember: true }));
  await handle(req({ id: "r2", meta: { platform: "youtube" } }));
  const [a, b] = bus.of("chat.message");
  assert.equal(a!.user, "injected_viewer");
  assert.equal(a!.platform, "twitch");
  assert.equal(a!.remember, true);
  assert.equal(b!.platform, "youtube");
});

test("ignore_users / ignore_prefixes are bypassed", async () => {
  const { bus, handle } = setup();
  await handle(req({ text: "!hello", meta: { user: "nightbot" } }));
  assert.equal(bus.of("chat.message")[0]!.text, "!hello");
  assert.equal(bus.of("chat.message")[0]!.user, "nightbot");
});

test("mention is detected case-insensitively; whitespace collapsed", async () => {
  const { bus, handle } = setup();
  await handle(req({ text: "  hey   COCO  " }));
  assert.equal(bus.of("chat.message")[0]!.mentionsCohost, true);
  assert.equal(bus.of("chat.message")[0]!.text, "hey COCO");
});

test("blank text: no message, ok:false", async () => {
  const { bus, handle } = setup();
  await handle(req({ text: "   " }));
  assert.equal(bus.of("chat.message").length, 0);
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});

test("stale request: only ok:false stale", async () => {
  const { bus, handle } = setup(() => Date.now() + 61_000);
  await handle(req());
  assert.deepEqual(bus.published.map((p) => p.type), ["inject.result"]);
  assert.deepEqual(bus.of("inject.result")[0], { id: "r1", ok: false, detail: "stale" });
});

test("other target publishes nothing; wrong kind for chat is ok:false", async () => {
  const { bus, handle } = setup();
  await handle(req({ target: "eyes", kind: "image", url: "http://x/uploads/1" }));
  assert.equal(bus.published.length, 0);
  await handle(req({ kind: "audio" }));
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});

test("publish failure becomes ok:false when the bus can still answer", async () => {
  const { bus, handle } = setup();
  bus.fail = (t) => t === "chat.message";
  await handle(req());
  assert.equal(bus.of("inject.result")[0]!.ok, false);
});
