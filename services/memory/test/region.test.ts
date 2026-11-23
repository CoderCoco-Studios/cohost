import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, testConfig } from "@cohost/testing";
import { createMemoryHandler } from "../src/region.js";
import type { Memory, MemoryKind } from "../src/store.js";
import { viewerKey } from "@cohost/shared/untrusted";
import { InMemoryStore } from "../src/fake-store.js";

function setup(viewer = { msgCount: 1, isNew: true, regular: false }, recalled: Memory[] = [], opts: { touchFails?: boolean; forgetFails?: boolean; onBrainStatus?: (s: string) => void; cfg?: Record<string, unknown> } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const warnings: unknown[] = [];
  const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
  const store = {
    touchViewer: async (...args: [string, string, { isSub?: boolean }?]) => {
      calls.push({ op: "touchViewer", args });
      if (opts.touchFails) throw new Error("db down");
      return viewer;
    },
    touchSpeaker: async (...args: [string, string]) => {
      calls.push({ op: "touchSpeaker", args });
      if (opts.touchFails) throw new Error("db down");
      return {} as never;
    },
    remember: async (...args: unknown[]) => { calls.push({ op: "remember", args }); },
    forgetChat: async (...args: unknown[]) => { calls.push({ op: "forgetChat", args }); if (opts.forgetFails) throw new Error("db down"); },
    recall: async (...args: [string, number?]) => { calls.push({ op: "recall", args }); return recalled; },
  };
  const bus = new FakeBus();
  const onEvent = createMemoryHandler({ cfg: testConfig(opts.cfg), bus, store, log, onBrainStatus: opts.onBrainStatus as never });
  return { onEvent, bus, calls, warnings };
}
const chat = (extra: Record<string, unknown> = {}) =>
  event("chat.message", { platform: "twitch", user: "Bob", userId: "123", text: "hey Coco", isMod: false, isSub: false, mentionsCohost: false, ...extra });

// @spec MEM-WRITE-001, MEM-VIEWER-001, MEM-VIEWER-002
test("every chat line counts toward the viewer; only lines addressed to the co-host are remembered", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat());
  assert.deepEqual(calls, [{ op: "touchViewer", args: [viewerKey({ platform: "twitch", userId: "123", user: "Bob" }), "Bob", { isSub: false }] }]);
  assert.equal(bus.published.length, 0);
  await onEvent(chat({ userId: undefined })); // no platform id: key by name
  assert.deepEqual(calls[1], { op: "touchViewer", args: [viewerKey({ platform: "twitch", user: "Bob" }), "Bob", { isSub: false }] });
});

// @spec MEM-WRITE-001, MEM-VIEWER-002
test("a mention announces the viewer (with regular, no notes text) before the (slow) embed + store", async () => {
  const { onEvent, bus, calls } = setup({ msgCount: 30, isNew: false, regular: true });
  await onEvent(chat({ mentionsCohost: true }));
  assert.deepEqual(bus.of("memory.viewer"), [{ user: "Bob", platform: "twitch", userId: "123", isNew: false, msgCount: 30, regular: true }]);
  assert.deepEqual(calls.map((c) => c.op), ["touchViewer", "remember"]);
  assert.deepEqual(calls[1]!.args, ["chat", "Bob", "hey Coco", { platform: "twitch", userId: "123", messageId: undefined }]);
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
  await admin.touchViewer("twitch:id:1", "Alice");
  const bus = new FakeBus();
  const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
  const onEvent = createMemoryHandler({ cfg, bus, log, store: admin, admin });
  await onEvent(event("memory.viewers.request", { id: "v-1", op: "list" }));
  const [reply] = bus.of("memory.viewers.reply");
  assert.equal(reply!.id, "v-1");
  assert.equal(reply!.ok, true);
  assert.deepEqual((reply!.data as { viewers: { key: string }[] }).viewers.map((v) => v.key), ["twitch:id:1"]);
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
    touchViewer: async () => ({ msgCount: 1, isNew: true, regular: false }), remember: async () => {}, recall: async () => [],
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
  await onEvent(event("memory.notes.request", { id: "n1", viewers: [{ user: "alice" }] }));
  assert.deepEqual(bus.of("memory.notes.reply"), [{ id: "n1", viewers: [{ user: "Alice", regular: true, msgCount: 40, notes: [] }] }]);
  await onEvent(event("memory.notes.request", { id: "n2", viewers: [{ user: "Boom" }] }));
  assert.deepEqual(bus.of("memory.notes.reply")[1], { id: "n2", viewers: [] });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /Boom|Alice/, "no names or note text in the warning");
});

const speech = (extra: Record<string, unknown> = {}) => event("speech.heard", { speaker: "Chris", speakerId: "D1", text: "hello there", durationMs: 500, ...extra });

// @spec MEM-VOICE-002
test("a voice line with a speakerId touches the speaker, is remembered, and announces no memory.viewer", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(speech());
  assert.deepEqual(calls, [{ op: "touchSpeaker", args: ["D1", "Chris"] }, { op: "remember", args: ["speech", "Chris", "hello there"] }]);
  assert.equal(bus.of("memory.viewer").length, 0);
});

// @spec MEM-VOICE-002
test("a voice line without a speakerId, or an injected one, makes no viewer row (an injected remembered one is still remembered)", async () => {
  const { onEvent, calls } = setup();
  await onEvent(speech({ speakerId: undefined }));
  await onEvent(speech({ injected: true }));
  await onEvent(speech({ injected: true, remember: true, speakerId: undefined }));
  assert.deepEqual(calls.map((c) => c.op), ["remember", "remember"]);
});

// @spec MEM-VOICE-002
test("a failed speaker touch logs a warning and the utterance is still remembered", async () => {
  const { onEvent, calls, warnings } = setup(undefined, [], { touchFails: true });
  await onEvent(speech());
  assert.deepEqual(calls.map((c) => c.op), ["touchSpeaker", "remember"]);
  assert.equal(warnings.length, 1);
});

// ---- bounded intake (issue #170)

const small = { viewer_text: { max_chars: 20, max_name_chars: 10 }, brain: { input_limits: { speech_max_chars: 30 } } };

// @spec MEM-WRITE-001, MEM-WRITE-006
test("a remembered chat line is bounded by viewer_text.max_chars before it is stored; unaddressed chat stores nothing", async () => {
  const { onEvent, calls } = setup(undefined, [], { cfg: small });
  const long = "x".repeat(200);
  await onEvent(chat({ text: long })); // not addressed
  assert.equal(calls.filter((c) => c.op === "remember").length, 0);
  await onEvent(chat({ text: long, mentionsCohost: true }));
  const stored = calls.find((c) => c.op === "remember")!.args[2] as string;
  assert.equal([...stored].length, 20);
  assert.ok(stored.endsWith("…"));
  await onEvent(chat({ text: "line one\nline\ttwo ​", mentionsCohost: true }));
  assert.equal(calls.filter((c) => c.op === "remember")[1]!.args[2], "line one line two");
});

// @spec MEM-WRITE-002, MEM-WRITE-007
test("a remembered speech line is bounded by brain.input_limits.speech_max_chars, not the chat limit", async () => {
  const { onEvent, calls } = setup(undefined, [], { cfg: small });
  await onEvent(event("speech.heard", { speaker: "Chris", text: "y".repeat(200), durationMs: 5 }));
  const stored = calls.find((c) => c.op === "remember")!.args[2] as string;
  assert.equal([...stored].length, 30);
  assert.ok(stored.endsWith("…"));
});

// @spec MEM-WRITE-008
test("user and speaker names are bounded to viewer_text.max_name_chars, with unknown when nothing remains, before who, viewer display and memory.viewer", async () => {
  const { onEvent, bus, calls } = setup(undefined, [], { cfg: small });
  await onEvent(chat({ user: "AVeryLongViewerName", mentionsCohost: true }));
  const bounded = calls.find((c) => c.op === "touchViewer")!.args[1] as string;
  assert.equal([...bounded].length, 10);
  assert.ok(bounded.endsWith("…"));
  assert.equal(calls.find((c) => c.op === "remember")!.args[1], bounded);
  assert.equal((bus.of("memory.viewer")[0] as { user: string }).user, bounded);
  await onEvent(event("speech.heard", { speaker: "S".repeat(50), speakerId: "D1", text: "hello there", durationMs: 5 }));
  assert.equal([...(calls.find((c) => c.op === "touchSpeaker")!.args[1] as string)].length, 10);
  assert.equal([...(calls.filter((c) => c.op === "remember")[1]!.args[1] as string)].length, 10);
  calls.length = 0;
  await onEvent(chat({ user: " ​\n ", userId: "9", mentionsCohost: true }));
  assert.equal(calls.find((c) => c.op === "touchViewer")!.args[1], "unknown");
  assert.equal(calls.find((c) => c.op === "remember")!.args[1], "unknown");
  await onEvent(event("speech.heard", { speaker: "​", text: "hello there", durationMs: 5 }));
  assert.equal(calls.filter((c) => c.op === "remember")[1]!.args[1], "unknown");
});

// @spec MEM-VIEWER-007
test("an empty userId is no id: the viewer is keyed by the bounded name, never by an empty key", async () => {
  const { onEvent, calls } = setup();
  await onEvent(chat({ userId: "", user: "Bob", mentionsCohost: true }));
  assert.equal(calls.find((c) => c.op === "touchViewer")!.args[0], viewerKey({ platform: "twitch", user: "Bob" }));
});

// @spec MEM-VIEWER-007
test("chat with no userId and user unknown creates no viewer row and no memory.viewer; the memory row is still written when it mentions the co-host", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat({ userId: undefined, user: "unknown", mentionsCohost: true }));
  await onEvent(chat({ userId: undefined, user: "​", mentionsCohost: true })); // bounds to unknown
  assert.equal(calls.filter((c) => c.op === "touchViewer").length, 0);
  assert.equal(bus.of("memory.viewer").length, 0);
  assert.equal(calls.filter((c) => c.op === "remember").length, 2);
  await onEvent(chat({ userId: "42", user: "unknown", mentionsCohost: true })); // an id is enough
  assert.equal(calls.filter((c) => c.op === "touchViewer").length, 1);
  assert.equal(bus.of("memory.viewer").length, 1);
});

// @spec MEM-WRITE-009, MEM-VIEWER-002
test("a remembered chat line carries platform, userId and messageId; memory.viewer carries platform and no userId when the line has none", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(chat({ mentionsCohost: true, platform: "youtube", userId: "UCabc", messageId: "m-9" }));
  assert.deepEqual(calls[1]!.args, ["chat", "Bob", "hey Coco", { platform: "youtube", userId: "UCabc", messageId: "m-9" }]);
  assert.deepEqual(calls[0]!.args[0], viewerKey({ platform: "youtube", userId: "UCabc", user: "Bob" }), "an id is never case-folded");
  await onEvent(chat({ mentionsCohost: true, userId: undefined }));
  const last = bus.of("memory.viewer").at(-1)!;
  assert.equal(last.platform, "twitch");
  assert.equal("userId" in last, false);
});

// @spec MEM-VIEWER-008, MEM-VIEWER-009
test("the viewer key comes from the shared viewerKey of platform, userId and the bounded user", async () => {
  const { onEvent, calls } = setup();
  await onEvent(chat({ platform: "youtube", user: "  Zed  ", userId: "UCmixedCase" }));
  await onEvent(chat({ platform: "discord", user: "KIT", userId: undefined }));
  assert.deepEqual(calls.map((c) => c.args[0]), [
    viewerKey({ platform: "youtube", userId: "UCmixedCase", user: "Zed" }),
    viewerKey({ platform: "discord", user: "kit" }),
  ]);
});

// @spec MEM-FORGET-002, MEM-FORGET-003, MEM-FORGET-004, MEM-FORGET-007
test("chat.removed asks the store to forget by the event's scope and touches no viewer", async () => {
  const { onEvent, bus, calls } = setup();
  await onEvent(event("chat.removed", { platform: "twitch", scope: "message", messageId: "m1" }));
  await onEvent(event("chat.removed", { platform: "youtube", scope: "user", userId: "UCx", reason: "ban" }));
  await onEvent(event("chat.removed", { platform: "twitch", scope: "all" }));
  assert.deepEqual(calls.map((c) => [c.op, (c.args[0] as { platform: string; scope: string }).platform, (c.args[0] as { scope: string }).scope]), [
    ["forgetChat", "twitch", "message"], ["forgetChat", "youtube", "user"], ["forgetChat", "twitch", "all"],
  ]);
  assert.equal((calls[0]!.args[0] as { messageId?: string }).messageId, "m1");
  assert.equal((calls[1]!.args[0] as { userId?: string }).userId, "UCx");
  assert.equal(bus.published.length, 0);
});

// @spec MEM-FORGET-006
test("a failed delete logs a warning and the next event is still handled", async () => {
  const { onEvent, calls, warnings } = setup(undefined, [], { forgetFails: true });
  await onEvent(event("chat.removed", { platform: "twitch", scope: "message", messageId: "m1" }));
  assert.equal(warnings.length, 1);
  await onEvent(chat({ mentionsCohost: true }));
  assert.deepEqual(calls.map((c) => c.op), ["forgetChat", "touchViewer", "remember"]);
});
