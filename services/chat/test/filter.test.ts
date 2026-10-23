import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { channelName, createChatFilter, type ChatUserInfo } from "../src/filter.js";

const cfg = testConfig({ chat: { ignore_users: ["Nightbot"], ignore_prefixes: ["!", "#"] } });
const filter = createChatFilter(cfg);
const info = (over: Partial<ChatUserInfo> = {}): ChatUserInfo =>
  ({ displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false, ...over });

test("channelName strips # and lowercases", () => {
  assert.equal(channelName(testConfig({ chat: { twitch: { channel: "#CoderCoco" } } }).chat), "codercoco");
  assert.equal(channelName(testConfig({ chat: { twitch: { channel: "" } } }).chat), "");
});

test("a normal message becomes a chat.message payload", () => {
  assert.deepEqual(filter("bob", "hello   there\n friend ", info()), {
    platform: "twitch", user: "Bob", userId: "42", text: "hello there friend", isMod: false, isSub: false, mentionsCohost: false,
  });
});

test("bots (case-insensitive), commands and blank lines are dropped", () => {
  assert.equal(filter("nightbot", "Follow the stream!", info()), undefined);
  assert.equal(filter("NIGHTBOT", "Follow the stream!", info()), undefined);
  assert.equal(filter("bob", "!uptime", info()), undefined);
  assert.equal(filter("bob", "#ad", info()), undefined);
  assert.equal(filter("bob", "   ", info()), undefined);
});

test("mentions are matched anywhere, case-insensitively", () => {
  assert.equal(filter("bob", "what do you think COCO", info())!.mentionsCohost, true);
  assert.equal(filter("bob", "@coco_fan hi", info())!.mentionsCohost, true); // substring match, by design
  assert.equal(filter("bob", "hi chat", info())!.mentionsCohost, false);
});

test("broadcaster counts as mod; subscriber flag and display-name fallback", () => {
  const m = filter("chris", "hi", info({ isBroadcaster: true, isSubscriber: true, displayName: "" }))!;
  assert.equal(m.isMod, true);
  assert.equal(m.isSub, true);
  assert.equal(m.user, "chris");
});
