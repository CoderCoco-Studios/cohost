import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, EventPayloads } from "../src/index.js";

// Validation only: no Redis needed.
const P = EventPayloads as Record<string, { safeParse(v: unknown): { success: boolean; data?: any } }>;

// @spec BUS-EVT-002
test("chat.message accepts optional string userId and messageId, round-trips them, and rejects non-strings", () => {
  const base = { platform: "youtube", user: "Ann", text: "hi" };
  const r = P["chat.message"]!.safeParse({ ...base, userId: "UCabc", messageId: "m-1" });
  assert.ok(r.success);
  assert.equal(r.data.userId, "UCabc");
  assert.equal(r.data.messageId, "m-1");
  const bare = P["chat.message"]!.safeParse(base);
  assert.ok(bare.success);
  assert.equal("userId" in bare.data, false);
  assert.equal("messageId" in bare.data, false);
  assert.deepEqual([bare.data.isMod, bare.data.isSub, bare.data.mentionsCohost], [false, false, false]);
  assert.equal(P["chat.message"]!.safeParse({ ...base, messageId: 7 }).success, false);
  assert.equal(P["chat.message"]!.safeParse({ ...base, userId: 7 }).success, false);
});

// @spec BUS-EVT-033
test("chat.removed is a known event requiring platform and scope and accepting optional string messageId, userId and reason", () => {
  assert.ok(EVENT_TYPES.includes("chat.removed" as never));
  const v = P["chat.removed"]!;
  assert.ok(v, "chat.removed has a payload schema");
  assert.ok(v.safeParse({ platform: "twitch", scope: "all" }).success);
  const full = v.safeParse({ platform: "youtube", scope: "message", messageId: "m1", userId: "u1", reason: "deleted" });
  assert.ok(full.success);
  assert.deepEqual(full.data, { platform: "youtube", scope: "message", messageId: "m1", userId: "u1", reason: "deleted" });
  assert.equal(v.safeParse({ scope: "all" }).success, false, "platform is required");
  assert.equal(v.safeParse({ platform: "twitch" }).success, false, "scope is required");
  assert.equal(v.safeParse({ platform: "irc", scope: "all" }).success, false);
  assert.equal(v.safeParse({ platform: "twitch", scope: "channel" }).success, false);
  assert.equal(v.safeParse({ platform: "twitch", scope: "all", reason: 3 }).success, false);
  for (const p of ["twitch", "youtube", "discord"]) for (const s of ["message", "user", "all"]) {
    const extra = s === "message" ? { messageId: "m" } : s === "user" ? { userId: "u" } : {};
    assert.ok(v.safeParse({ platform: p, scope: s, ...extra }).success, `${p}/${s}`);
  }
});

// @spec BUS-EVT-034
test("a chat.removed of scope message without a non-empty messageId is rejected", () => {
  const v = P["chat.removed"]!;
  assert.ok(v, "chat.removed has a payload schema");
  assert.equal(v.safeParse({ platform: "twitch", scope: "message" }).success, false);
  assert.equal(v.safeParse({ platform: "twitch", scope: "message", messageId: "" }).success, false);
  assert.equal(v.safeParse({ platform: "twitch", scope: "message", userId: "u" }).success, false, "a userId does not stand in");
  assert.ok(v.safeParse({ platform: "twitch", scope: "message", messageId: "m" }).success);
});

// @spec BUS-EVT-035
test("a chat.removed of scope user without a non-empty userId is rejected", () => {
  const v = P["chat.removed"]!;
  assert.ok(v, "chat.removed has a payload schema");
  assert.equal(v.safeParse({ platform: "youtube", scope: "user" }).success, false);
  assert.equal(v.safeParse({ platform: "youtube", scope: "user", userId: "" }).success, false);
  assert.equal(v.safeParse({ platform: "youtube", scope: "user", messageId: "m" }).success, false, "a messageId does not stand in");
  assert.ok(v.safeParse({ platform: "youtube", scope: "user", userId: "u" }).success);
});

// @spec BUS-EVT-036
test("attention.focus and memory.viewer keep platform and userId unchanged", () => {
  const focus = P["attention.focus"]!.safeParse({
    reason: "mentioned", score: 1, focus: { kind: "chat", who: "Ann", platform: "youtube", userId: "UCabc", text: "hi" },
  });
  assert.ok(focus.success);
  assert.equal(focus.data.focus.platform, "youtube");
  assert.equal(focus.data.focus.userId, "UCabc");
  assert.equal(P["attention.focus"]!.safeParse({ reason: "r", score: 1, focus: { kind: "chat", platform: "irc", text: "x" } }).success, false);
  const viewer = P["memory.viewer"]!.safeParse({ user: "Ann", platform: "twitch", userId: "123", isNew: true, msgCount: 1, regular: false });
  assert.ok(viewer.success);
  assert.equal(viewer.data.platform, "twitch");
  assert.equal(viewer.data.userId, "123");
  const bare = P["memory.viewer"]!.safeParse({ user: "Ann", isNew: true, msgCount: 1, regular: false });
  assert.ok(bare.success);
  assert.equal("platform" in bare.data, false);
  assert.equal("userId" in bare.data, false);
  assert.equal(P["memory.viewer"]!.safeParse({ user: "Ann", userId: 5, isNew: true, msgCount: 1, regular: false }).success, false);
});

// @spec BUS-EVT-020
test("memory.notes.request and reply entries carry optional platform and userId", () => {
  const req = P["memory.notes.request"]!;
  const r = req.safeParse({ id: "1", viewers: [{ user: "Ann", platform: "youtube", userId: "UCabc" }, { user: "Bob" }] });
  assert.ok(r.success);
  assert.deepEqual(r.data.viewers, [{ user: "Ann", platform: "youtube", userId: "UCabc" }, { user: "Bob" }]);
  assert.equal(req.safeParse({ id: "1", viewers: [] }).success, false, "viewers must be non-empty");
  assert.equal(req.safeParse({ id: "1", viewers: [{ user: "Ann", platform: "irc" }] }).success, false);
  assert.equal(req.safeParse({ id: "1", viewers: [{ user: "Ann", userId: 4 }] }).success, false);

  const rep = P["memory.notes.reply"]!;
  const entry = { user: "Ann", platform: "twitch", userId: "123", regular: true, msgCount: 3, notes: [] };
  const ok = rep.safeParse({ id: "1", viewers: [entry, { user: "Bob", regular: false, msgCount: 0, notes: [] }] });
  assert.ok(ok.success);
  assert.equal(ok.data.viewers[0].platform, "twitch");
  assert.equal(ok.data.viewers[0].userId, "123");
  assert.equal("platform" in ok.data.viewers[1], false);
  assert.equal(rep.safeParse({ id: "1", viewers: [{ ...entry, platform: "irc" }] }).success, false);
  assert.equal(rep.safeParse({ id: "1", viewers: [{ ...entry, userId: 9 }] }).success, false);
});

// @spec BUS-EVT-061
test("a speech focus and notes request and reply entries keep speakerId unchanged", () => {
  const focus = P["attention.focus"]!.safeParse({ reason: "r", score: 1, focus: { kind: "speech", who: "Chris", speakerId: "D1", text: "hi" } });
  assert.ok(focus.success);
  assert.equal(focus.data.focus.speakerId, "D1");
  const req = P["memory.notes.request"]!.safeParse({ id: "n1", viewers: [{ user: "Chris", speakerId: "D1" }] });
  assert.ok(req.success);
  assert.equal(req.data.viewers[0].speakerId, "D1");
  const reply = P["memory.notes.reply"]!.safeParse({ id: "n1", viewers: [{ user: "Ann", speakerId: "D1", regular: false, msgCount: 1, notes: [] }] });
  assert.ok(reply.success);
  assert.equal(reply.data.viewers[0].speakerId, "D1");
  assert.equal(P["memory.notes.request"]!.safeParse({ id: "n1", viewers: [{ user: "x", speakerId: 7 }] }).success, false);
});
