import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { channelName, createChatFilter, mentionsCohost, type ChatUserInfo } from "../src/filter.js";

const cfg = testConfig({ chat: { ignore_users: ["Nightbot"], ignore_prefixes: ["!", "#"] } });
const filter = createChatFilter(cfg);
const info = (over: Partial<ChatUserInfo> = {}): ChatUserInfo =>
  ({ displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false, ...over });

// @spec CHAT-PLAN-004
test("channelName strips # and lowercases", () => {
  assert.equal(channelName(testConfig({ chat: { twitch: { channel: "#CoderCoco" } } }).chat), "codercoco");
  assert.equal(channelName(testConfig({ chat: { twitch: { channel: "" } } }).chat), "");
});

// @spec CHAT-FILT-005
test("a normal message becomes a chat.message payload", () => {
  assert.deepEqual(filter("bob", "hello   there\n friend ", info()), {
    platform: "twitch", user: "Bob", userId: "42", text: "hello there friend", isMod: false, isSub: false, mentionsCohost: false,
  });
});

// @spec CHAT-FILT-001, CHAT-FILT-002, CHAT-FILT-004
test("bots (case-insensitive), commands and blank lines are dropped", () => {
  assert.equal(filter("nightbot", "Follow the stream!", info()), undefined);
  assert.equal(filter("NIGHTBOT", "Follow the stream!", info()), undefined);
  assert.equal(filter("bob", "!uptime", info()), undefined);
  assert.equal(filter("bob", "#ad", info()), undefined);
  assert.equal(filter("bob", "   ", info()), undefined);
});

// @spec CHAT-FILT-003
test("whitespace before a prefix is trimmed first, so the line is still dropped as a command", () => {
  assert.equal(filter("bob", " !cmd", info()), undefined);
  assert.equal(filter("bob", "\t  #ad  ", info()), undefined);
  assert.equal(filter("bob", "  hi !not-a-prefix", info())!.text, "hi !not-a-prefix");
});

// @spec CHAT-FILT-007
test("mentions are matched anywhere, case-insensitively", () => {
  assert.equal(filter("bob", "what do you think COCO", info())!.mentionsCohost, true);
  assert.equal(filter("bob", "@coco_fan hi", info())!.mentionsCohost, true); // substring match, by design
  assert.equal(filter("bob", "hi chat", info())!.mentionsCohost, false);
});

// @spec CHAT-FILT-005, CHAT-FILT-006
test("broadcaster counts as mod; subscriber flag and display-name fallback", () => {
  const m = filter("chris", "hi", info({ isBroadcaster: true, isSubscriber: true, displayName: "" }))!;
  assert.equal(m.isMod, true);
  assert.equal(m.isSub, true);
  assert.equal(m.user, "chris");
});

const bounded = createChatFilter(testConfig({ chat: { ignore_prefixes: ["!"] }, viewer_text: { max_chars: 16, max_name_chars: 8 } }));

// @spec CHAT-FILT-002, CHAT-FILT-003
test("a prefix hidden behind whitespace or an invisible character still drops the line as a command", () => {
  assert.equal(filter("bob", " !cmd", info()), undefined);
  assert.equal(filter("bob", "​!cmd", info()), undefined);
  assert.equal(filter("bob", "​ ⁠!cmd", info()), undefined);
});

// @spec CHAT-FILT-004
test("a line of only control and invisible characters publishes nothing", () => {
  assert.equal(filter("bob", "\u200b\u2060\u0007 \u00ad", info()), undefined);
  assert.equal(filter("bob", "\n​\n", info()), undefined);
});

// @spec CHAT-FILT-008
test("text is bounded to viewer_text.max_chars and cut with an ellipsis", () => {
  const m = bounded("bob", "a".repeat(40), info())!;
  assert.equal([...m.text].length, 16);
  assert.equal(m.text, `${"a".repeat(15)}…`);
  assert.equal(bounded("bob", "ab​cd", info())!.text, "abcd");
});

// @spec CHAT-FILT-009
test("user is the first non-empty bounded display name or login, else unknown", () => {
  assert.equal(bounded("bobby", "hi", info({ displayName: "​" }))!.user, "bobby");
  assert.equal(bounded("bobby", "hi", info({ displayName: "Bob​" }))!.user, "Bob");
  assert.equal(bounded("bobby", "hi", info({ displayName: "x".repeat(30) }))!.user, `${"x".repeat(7)}…`);
  assert.equal(bounded("​", "hi", info({ displayName: "" }))!.user, "unknown");
  assert.equal(bounded("y".repeat(30), "hi", info({ displayName: "" }))!.user, `${"y".repeat(7)}…`);
});

// @spec CHAT-FILT-007
test("a co-host name past the cut is not a mention; one inside the cut is", () => {
  assert.equal(bounded("bob", `${"x ".repeat(10)}coco`, info())!.mentionsCohost, false);
  assert.equal(bounded("bob", "hi cocoa", info())!.mentionsCohost, true);
  assert.equal(bounded("bob", "@coco_fan", info())!.mentionsCohost, true);
  assert.equal(bounded("bob", "co​co", info())!.mentionsCohost, true); // judged on the bounded text
});

// @spec CHAT-FILT-011
test("the filter exports the one mention helper", () => {
  assert.equal(typeof mentionsCohost, "function");
  assert.equal(mentionsCohost("hey COCO", "Coco"), true);
  assert.equal(mentionsCohost("hey there", "Coco"), false);
});
