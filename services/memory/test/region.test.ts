import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, testConfig } from "@cohost/testing";
import { createMemoryHandler } from "../src/region.js";
import type { Memory, MemoryKind } from "../src/store.js";

function setup(viewer = { msgCount: 1, notes: "", isNew: true }, recalled: Memory[] = []) {
  const calls: { op: string; args: unknown[] }[] = [];
  const store = {
    touchViewer: async (...args: [string, string]) => { calls.push({ op: "touchViewer", args }); return viewer; },
    remember: async (...args: [MemoryKind, string, string]) => { calls.push({ op: "remember", args }); },
    recall: async (...args: [string, number?]) => { calls.push({ op: "recall", args }); return recalled; },
  };
  const bus = new FakeBus();
  const onEvent = createMemoryHandler({ cfg: testConfig(), bus, store });
  return { onEvent, bus, calls };
}
const chat = (extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "Bob", userId: "123", text: "hey Coco", isMod: false, isSub: false, mentionsCohost: false, ...extra });

test("every chat line counts toward the viewer; only lines addressed to the co-host are remembered", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat());
  assert.deepEqual(calls, [{ op: "touchViewer", args: ["123", "Bob"] }]);
  assert.equal(bus.published.length, 0);
  await onEvent(chat({ userId: undefined })); // no platform id: key by name
  assert.deepEqual(calls[1], { op: "touchViewer", args: ["Bob", "Bob"] });
});

test("a mention announces the viewer before the (slow) embed + store", async () => {
  const { onEvent, bus, calls } = setup({ msgCount: 30, notes: "speedrunner", isNew: false });
  await onEvent(chat({ mentionsCohost: true }));
  assert.deepEqual(bus.of("memory.viewer"), [{ user: "Bob", isNew: false, msgCount: 30, notes: "speedrunner" }]);
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember"]);
  assert.deepEqual(calls[1]!.args, ["chat", "Bob", "hey Coco"]);
});

test("speech is always remembered; the co-host's own lines under its name, skipping one-character ones", async () => {
  const { onEvent, calls } = setup();
  await onEvent(event("speech.heard", { speaker: "Chris", text: "we're live", durationMs: 800 }));
  await onEvent(event("brain.say", { id: "1", text: "Hi chat!", emotion: "happy" }));
  await onEvent(event("brain.say", { id: "2", text: "k", emotion: "neutral" }));
  assert.deepEqual(calls.map((c) => c.args), [["speech", "Chris", "we're live"], ["self", "Coco", "Hi chat!"]]);
});

test("recall requests are answered on the bus with the same id, timestamps as epoch ms", async () => {
  const ts = new Date("2026-01-02T03:04:05Z");
  const { onEvent, bus, calls } = setup(undefined, [{ id: 9, ts, kind: "chat", who: "bob", text: "gg", similarity: 0.8 }]);
  await onEvent(event("memory.recall.request", { id: "req-1", query: "good game", k: 2 }));
  assert.deepEqual(calls, [{ op: "recall", args: ["good game", 2] }]);
  assert.deepEqual(bus.of("memory.recall.reply"), [{ id: "req-1", memories: [{ ts: ts.getTime(), kind: "chat", who: "bob", text: "gg", similarity: 0.8 }] }]);
});

test("unrelated events are ignored", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(event("affect.state", { valence: 0, arousal: 0, mood: "neutral" }));
  assert.equal(calls.length + bus.published.length, 0);
});
