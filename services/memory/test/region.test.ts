import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, testConfig } from "@cohost/testing";
import { createMemoryHandler } from "../src/region.js";
import type { Memory, MemoryKind } from "../src/store.js";
import { InMemoryStore } from "../src/fake-store.js";

function setup(viewer = { msgCount: 1, notes: "", isNew: true, regular: false }, recalled: Memory[] = [], opts: { touchFails?: boolean; onBrainStatus?: (s: string) => void } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const warnings: unknown[] = [];
  const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
  const store = {
    touchViewer: async (...args: [string, string, { isSub?: boolean }?]) => {
      calls.push({ op: "touchViewer", args });
      if (opts.touchFails) throw new Error("db down");
      return viewer;
    },
    remember: async (...args: [MemoryKind, string, string]) => { calls.push({ op: "remember", args }); },
    recall: async (...args: [string, number?]) => { calls.push({ op: "recall", args }); return recalled; },
  };
  const bus = new FakeBus();
  const onEvent = createMemoryHandler({ cfg: testConfig(), bus, store, log, onBrainStatus: opts.onBrainStatus as never });
  return { onEvent, bus, calls, warnings };
}
const chat = (extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "Bob", userId: "123", text: "hey Coco", isMod: false, isSub: false, mentionsCohost: false, ...extra });

// @spec MEM-WRITE-001, MEM-VIEWER-001, MEM-VIEWER-002
test("every chat line counts toward the viewer; only lines addressed to the co-host are remembered", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat());
  assert.deepEqual(calls, [{ op: "touchViewer", args: ["123", "Bob", { isSub: false }] }]);
  assert.equal(bus.published.length, 0);
  await onEvent(chat({ userId: undefined })); // no platform id: key by name
  assert.deepEqual(calls[1], { op: "touchViewer", args: ["Bob", "Bob", { isSub: false }] });
});

// @spec MEM-WRITE-001, MEM-VIEWER-002
test("a mention announces the viewer (with regular, no notes text) before the (slow) embed + store", async () => {
  const { onEvent, bus, calls } = setup({ msgCount: 30, notes: "legacy text", isNew: false, regular: true });
  await onEvent(chat({ mentionsCohost: true }));
  assert.deepEqual(bus.of("memory.viewer"), [{ user: "Bob", isNew: false, msgCount: 30, regular: true }]);
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember"]);
  assert.deepEqual(calls[1]!.args, ["chat", "Bob", "hey Coco"]);
});

// @spec MEM-WRITE-002, MEM-WRITE-003
test("speech is always remembered; the co-host's own lines under its name, skipping one-character ones", async () => {
  const { onEvent, calls } = setup();
  await onEvent(event("speech.heard", { speaker: "Chris", text: "we're live", durationMs: 800 }));
  await onEvent(event("brain.say", { id: "1", text: "Hi chat!", emotion: "happy" }));
  await onEvent(event("brain.say", { id: "2", text: "k", emotion: "neutral" }));
  assert.deepEqual(calls.map((c) => c.args), [["speech", "Chris", "we're live"], ["self", "Coco", "Hi chat!"]]);
});

// @spec MEM-RECALL-001
test("recall requests are answered on the bus with the same id, timestamps as epoch ms", async () => {
  const ts = new Date("2026-01-02T03:04:05Z");
  const { onEvent, bus, calls } = setup(undefined, [{ id: 9, ts, kind: "chat", who: "bob", text: "gg", similarity: 0.8 }]);
  await onEvent(event("memory.recall.request", { id: "req-1", query: "good game", k: 2 }));
  assert.deepEqual(calls, [{ op: "recall", args: ["good game", 2] }]);
  assert.deepEqual(bus.of("memory.recall.reply"), [{ id: "req-1", memories: [{ ts: ts.getTime(), kind: "chat", who: "bob", text: "gg", similarity: 0.8 }] }]);
});

// @spec MEM-EVT-002
test("unrelated events are ignored", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(event("affect.state", { valence: 0, arousal: 0, mood: "neutral" }));
  assert.equal(calls.length + bus.published.length, 0);
});

// ---- test injection

// @spec MEM-INJ-001
test("injected, not remembered: nothing stored, no viewer row, no memory.viewer", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat({ mentionsCohost: true, injected: true, remember: false }));
  await onEvent(chat({ mentionsCohost: true, injected: true })); // remember absent
  await onEvent(event("speech.heard", { speaker: "Chris", text: "hi", durationMs: 0, injected: true, remember: false }));
  await onEvent(event("brain.say", { id: "1", text: "a reply", emotion: "happy", injected: true, remember: false }));
  await onEvent(event("brain.say", { id: "2", text: "a reply", emotion: "happy", injected: true }));
  assert.deepEqual(calls, []);
  assert.equal(bus.published.length, 0);
});

// @spec MEM-INJ-002
test("injected and remembered: handled exactly like real events", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat({ mentionsCohost: true, injected: true, remember: true }));
  await onEvent(event("speech.heard", { speaker: "Chris", text: "hi", durationMs: 0, injected: true, remember: true }));
  await onEvent(event("brain.say", { id: "1", text: "a reply", emotion: "happy", injected: true, remember: true }));
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember", "remember", "remember"]);
  assert.deepEqual(calls.slice(1).map((c) => c.args[0]), ["chat", "speech", "self"]);
  assert.deepEqual(bus.types(), ["memory.viewer"]);
});

// @spec MEM-INJ-003
test("remember:false on a real event is ignored", async () => {
  const { onEvent, calls } = setup();
  await onEvent(event("speech.heard", { speaker: "Chris", text: "hi", durationMs: 1, remember: false }));
  await onEvent(chat({ mentionsCohost: true, remember: false }));
  await onEvent(event("brain.say", { id: "1", text: "reply", emotion: "happy", remember: false }));
  assert.deepEqual(calls.map((c) => c.op), ["remember", "touchViewer", "remember", "remember"]);
});

// @spec MEM-VIEWER-006
test("a failed viewer upsert is logged, publishes no memory.viewer, and the mention is still remembered", async () => {
  const { onEvent, bus, calls, warnings } = setup(undefined, [], { touchFails: true });
  await onEvent(chat({ mentionsCohost: true }));
  assert.equal(warnings.length, 1);
  assert.deepEqual(bus.published, []);
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember"]);
  await onEvent(chat()); // unaddressed: nothing to remember, still no throw
  assert.equal(warnings.length, 2);
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember", "touchViewer"]);
});

// @spec MEM-REG-005
test("a chat line passes its isSub flag to the viewer upsert, mentioning the co-host or not", async () => {
  const { onEvent, calls } = setup();
  await onEvent(chat({ isSub: true }));
  await onEvent(chat({ isSub: false, mentionsCohost: true }));
  assert.deepEqual(calls.filter((c) => c.op === "touchViewer").map((c) => c.args[2]), [{ isSub: true }, { isSub: false }]);
});

// @spec MEM-CONSOL-002, MEM-CONSOL-003
test("brain.status is passed on so consolidation knows when the cortex is idle; memory publishes nothing for it", async () => {
  const seen: string[] = [];
  const { onEvent, bus, calls } = setup(undefined, [], { onBrainStatus: (s) => seen.push(s) });
  await onEvent(event("brain.status", { state: "thinking" }));
  await onEvent(event("brain.status", { state: "idle", detail: "x" }));
  assert.deepEqual(seen, ["thinking", "idle"]);
  assert.equal(bus.published.length, 0);
  assert.deepEqual(calls, []);
  const { onEvent: bare } = setup();
  await bare(event("brain.status", { state: "muted" })); // no listener: ignored
});

// @spec MEM-ADMIN-007
test("a viewers request is answered on the bus with the same id and the operation's data; a store failure with ok:false", async () => {
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash" } } });
  const admin = new InMemoryStore(cfg.brain.memory);
  await admin.touchViewer("1", "Alice");
  const bus = new FakeBus();
  const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
  const onEvent = createMemoryHandler({ cfg, bus, log, store: admin, admin });
  await onEvent(event("memory.viewers.request", { id: "v-1", op: "list" }));
  const [reply] = bus.of("memory.viewers.reply");
  assert.equal(reply!.id, "v-1");
  assert.equal(reply!.ok, true);
  assert.deepEqual((reply!.data as { viewers: { key: string }[] }).viewers.map((v) => v.key), ["1"]);
  admin.listViewers = async () => { throw new Error("db down"); };
  await onEvent(event("memory.viewers.request", { id: "v-2", op: "list" }));
  assert.deepEqual(bus.of("memory.viewers.reply")[1], { id: "v-2", ok: false, error: "failed", detail: "Error: db down" });
});

// @spec MEM-ADMIN-007
test("without an admin store a viewers request is ignored", async () => {
  const { onEvent, bus } = setup();
  await onEvent(event("memory.viewers.request", { id: "v-1", op: "list" }));
  assert.equal(bus.published.length, 0);
});

// @spec MEM-SURF-001, MEM-SURF-005
test("memory.notes.request is answered with the same id; a store error answers an empty list and logs a warning", async () => {
  const store = {
    touchViewer: async () => ({ msgCount: 1, notes: "", isNew: true, regular: false }), remember: async () => {}, recall: async () => [],
    findViewerByDisplay: async (name: string) => {
      if (name === "Boom") throw new Error("db down");
      return { key: "u1", display: "Alice", msgCount: 40, regular: true, regularManual: false, isSub: true, placeholder: false, firstSeen: new Date(), lastSeen: new Date() };
    },
    listNotes: async () => [], markSurfaced: async () => {},
  };
  const warnings: unknown[] = [];
  const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
  const bus = new FakeBus();
  const onEvent = createMemoryHandler({ cfg: testConfig(), bus, store, log });
  await onEvent(event("memory.notes.request", { id: "n1", users: ["alice"] }));
  assert.deepEqual(bus.of("memory.notes.reply"), [{ id: "n1", viewers: [{ user: "Alice", regular: true, msgCount: 40, notes: [] }] }]);
  await onEvent(event("memory.notes.request", { id: "n2", users: ["Boom"] }));
  assert.deepEqual(bus.of("memory.notes.reply")[1], { id: "n2", viewers: [] });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /Boom|Alice/, "no names or note text in the warning");
});
