import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { channelName, createChatFilter, mentionsCohost, type ChatSender } from "../src/filter.js";

const cfg = testConfig({ chat: { ignore_users: ["Nightbot"], ignore_prefixes: ["!", "#"] } });

/** What the older tests vary; `sender` turns it into the platform-neutral sender a source builds. */
interface Line { displayName: string; userId?: string; isMod: boolean; isBroadcaster: boolean; isSubscriber: boolean; messageId?: string }
const info = (over: Partial<Line> = {}): Line =>
  ({ displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false, ...over });
/** A Twitch sender as the Twitch source builds it: the ignore identifiers are the login and the display name. */
const sender = (login: string, i: Line): ChatSender => ({
  displayName: i.displayName, login, userId: i.userId, isMod: i.isMod || i.isBroadcaster, isSub: i.isSubscriber,
  ignoreIdentifiers: [login, i.displayName],
});
const twitchFilter = createChatFilter(cfg, "twitch");
const filter = (login: string, text: string, i: Line) => twitchFilter(sender(login, i), text, i.messageId);

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

const boundedFilter = createChatFilter(testConfig({ chat: { ignore_prefixes: ["!"] }, viewer_text: { max_chars: 16, max_name_chars: 8 } }), "twitch");
const bounded = (login: string, text: string, i: Line) => boundedFilter(sender(login, i), text, i.messageId);

// @spec CHAT-FILT-002, CHAT-FILT-003
test("a prefix hidden behind whitespace or an invisible character still drops the line as a command", () => {
  assert.equal(filter("bob", " !cmd", info()), undefined);
  assert.equal(filter("bob", "\u200b!cmd", info()), undefined);
  assert.equal(filter("bob", "\u200b \u2060!cmd", info()), undefined);
});

// @spec CHAT-FILT-004
test("a line of only control and invisible characters publishes nothing", () => {
  assert.equal(filter("bob", "\u200b\u2060\u0007 \u00ad", info()), undefined);
  assert.equal(filter("bob", "\n\u200b\n", info()), undefined);
});

// @spec CHAT-FILT-008
test("text is bounded to viewer_text.max_chars and cut with an ellipsis", () => {
  const m = bounded("bob", "a".repeat(40), info())!;
  assert.equal([...m.text].length, 16);
  assert.equal(m.text, `${"a".repeat(15)}…`);
  assert.equal(bounded("bob", "ab\u200bcd", info())!.text, "abcd");
});

// @spec CHAT-FILT-009
test("user is the first non-empty bounded display name or login, else unknown", () => {
  assert.equal(bounded("bobby", "hi", info({ displayName: "\u200b" }))!.user, "bobby");
  assert.equal(bounded("bobby", "hi", info({ displayName: "Bob\u200b" }))!.user, "Bob");
  assert.equal(bounded("bobby", "hi", info({ displayName: "x".repeat(30) }))!.user, `${"x".repeat(7)}…`);
  assert.equal(bounded("\u200b", "hi", info({ displayName: "" }))!.user, "unknown");
  assert.equal(bounded("y".repeat(30), "hi", info({ displayName: "" }))!.user, `${"y".repeat(7)}…`);
});

// @spec CHAT-FILT-007
test("a co-host name past the cut is not a mention; one inside the cut is", () => {
  assert.equal(bounded("bob", `${"x ".repeat(10)}coco`, info())!.mentionsCohost, false);
  assert.equal(bounded("bob", "hi cocoa", info())!.mentionsCohost, true);
  assert.equal(bounded("bob", "@coco_fan", info())!.mentionsCohost, true);
  assert.equal(bounded("bob", "co\u200bco", info())!.mentionsCohost, true); // judged on the bounded text
});

// @spec CHAT-FILT-011
test("the filter exports the one mention helper", () => {
  assert.equal(typeof mentionsCohost, "function");
  assert.equal(mentionsCohost("hey COCO", "Coco"), true);
  assert.equal(mentionsCohost("hey there", "Coco"), false);
});

const ids = (cohostIgnore: string[], platform: "twitch" | "youtube") =>
  createChatFilter(testConfig({ chat: { ignore_users: cohostIgnore, ignore_prefixes: ["!"] } }), platform);
const ytSender = (over: Partial<ChatSender> = {}): ChatSender => ({
  displayName: "Some Bot", userId: "UCabc123", isMod: false, isSub: false,
  ignoreIdentifiers: ["Some Bot", "UCabc123", "youtube:UCabc123"], ...over,
});

// @spec CHAT-FILT-001, CHAT-FILT-012
test("a Twitch line is dropped when its login or its display name is listed, in any letter case", () => {
  const f = ids(["NightBot", "Fancy Name"], "twitch");
  const twitch = (login: string, displayName: string): ChatSender => ({ displayName, login, userId: "1", isMod: false, isSub: false, ignoreIdentifiers: [login, displayName] });
  assert.equal(f(twitch("nightbot", "Someone"), "hi", "m1"), undefined, "by login");
  assert.equal(f(twitch("someone", "NIGHTBOT"), "hi", "m2"), undefined, "by display name");
  assert.equal(f(twitch("fancy name", "x"), "hi", "m3"), undefined, "listed name in another case");
  assert.equal(f(twitch("bob", "Bob"), "hi", "m4")!.user, "Bob", "an unlisted sender passes");
});

// @spec CHAT-FILT-001, CHAT-FILT-013
test("a YouTube line is dropped by display name, bare channel id or youtube:<channelId>, in any letter case", () => {
  assert.equal(ids(["some bot"], "youtube")(ytSender(), "hi", "m"), undefined, "display name");
  assert.equal(ids(["UCABC123"], "youtube")(ytSender(), "hi", "m"), undefined, "bare channel id");
  assert.equal(ids(["YouTube:ucabc123"], "youtube")(ytSender(), "hi", "m"), undefined, "prefixed channel id");
  assert.ok(ids(["UCother"], "youtube")(ytSender(), "hi", "m"), "another channel id does not match");
  assert.ok(ids(["youtube:UCother"], "youtube")(ytSender(), "hi", "m"), "another prefixed id does not match");
});

// @spec CHAT-FILT-014
test("ignore_users is not scoped to a platform: one entry drops a Twitch login and a YouTube display name", () => {
  const list = ["nightbot"];
  const twitch: ChatSender = { displayName: "Whoever", login: "nightbot", userId: "9", isMod: false, isSub: false, ignoreIdentifiers: ["nightbot", "Whoever"] };
  const yt = ytSender({ displayName: "NightBot", ignoreIdentifiers: ["NightBot", "UCabc123", "youtube:UCabc123"] });
  assert.equal(ids(list, "twitch")(twitch, "hi", "m"), undefined);
  assert.equal(ids(list, "youtube")(yt, "hi", "m"), undefined);
});

// @spec CHAT-FILT-005
test("the payload carries the platform, userId, messageId, the source's flags, and the bounded text and name", () => {
  const yt = ids([], "youtube")(ytSender({ displayName: "Zed", isMod: true, isSub: true }), "  hello \n there ", "ytmsg-1");
  assert.deepEqual(yt, {
    platform: "youtube", user: "Zed", userId: "UCabc123", messageId: "ytmsg-1", text: "hello there",
    isMod: true, isSub: true, mentionsCohost: false,
  });
  const tw = twitchFilter({ displayName: "Bob", login: "bob", userId: "42", isMod: false, isSub: false, ignoreIdentifiers: ["bob", "Bob"] }, "hi", "tw-9")!;
  assert.deepEqual([tw.platform, tw.userId, tw.messageId], ["twitch", "42", "tw-9"]);
});

// @spec CHAT-FILT-005
test("a sender with no login still gets a name, and a missing message id is left off the payload", () => {
  const ev = ids([], "youtube")(ytSender({ login: undefined }), "hi")!;
  assert.equal(ev.user, "Some Bot");
  assert.equal("messageId" in ev, false);
});
