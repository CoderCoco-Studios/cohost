import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { createChatFilter } from "../src/filter.js";
import { mapLiveChatItem } from "../src/youtube-map.js";
import { banned, text, tombstone, type Item } from "./youtube-helpers.js";

const msg = (item: Item) => {
  const r = mapLiveChatItem(item);
  assert.equal(r.kind, "message", `expected a message, got ${r.kind}`);
  return r as Extract<ReturnType<typeof mapLiveChatItem>, { kind: "message" }>;
};

// @spec CHAT-YT-051
test("a textMessageEvent maps to its text, display name, channel id and message id", () => {
  const r = msg(text("m1", 5, "hello there", { displayName: "Ann", channelId: "UCann" }));
  assert.equal(r.text, "hello there");
  assert.equal(r.sender.displayName, "Ann");
  assert.equal(r.sender.userId, "UCann");
  assert.equal(r.messageId, "m1");
  assert.equal(r.sender.login, undefined, "a YouTube author has no login");
});

// @spec CHAT-YT-051
test("through the shared filter the mapped line is a youtube chat.message with user, userId and messageId", () => {
  const r = msg(text("m1", 5, "hello there", { displayName: "Ann", channelId: "UCann" }));
  const ev = createChatFilter(testConfig(), "youtube")(r.sender, r.text, r.messageId);
  assert.equal(ev?.platform, "youtube");
  assert.equal(ev?.user, "Ann");
  assert.equal(ev?.userId, "UCann");
  assert.equal(ev?.messageId, "m1");
  assert.equal(ev?.text, "hello there");
});

// @spec CHAT-YT-052
test("isMod is the chat moderator or the chat owner and isSub is the chat sponsor", () => {
  assert.equal(msg(text("a", 1, "x", { isChatModerator: true })).sender.isMod, true);
  assert.equal(msg(text("b", 1, "x", { isChatOwner: true })).sender.isMod, true, "the owner is the broadcaster");
  assert.equal(msg(text("c", 1, "x", {})).sender.isMod, false);
  assert.equal(msg(text("d", 1, "x", { isChatSponsor: true })).sender.isSub, true);
  assert.equal(msg(text("e", 1, "x", { isChatModerator: true, isChatOwner: true })).sender.isSub, false, "a moderator is not a member");
  const verified = text("f", 1, "x");
  verified.authorDetails.isVerified = true;
  assert.equal(msg(verified).sender.isMod, false, "isVerified is not read");
});

// @spec CHAT-FILT-013
test("the YouTube sender lists the display name, the bare channel id and youtube:<channelId> as ignore identifiers", () => {
  const { sender } = msg(text("m1", 1, "hi", { displayName: "Some Bot", channelId: "UCabc123" }));
  assert.deepEqual([...sender.ignoreIdentifiers].sort(), ["Some Bot", "UCabc123", "youtube:UCabc123"].sort());
});

// @spec CHAT-FILT-013
test("chat.ignore_users matches a YouTube author by name, channel id or youtube:<channelId> in any letter case", () => {
  const { sender, text: body, messageId } = msg(text("m1", 1, "hi", { displayName: "Some Bot", channelId: "UCabc123" }));
  for (const entry of ["SOME BOT", "ucABC123", "YouTube:UCabc123"]) {
    const filter = createChatFilter(testConfig({ chat: { ignore_users: [entry] } }), "youtube");
    assert.equal(filter(sender, body, messageId), undefined, entry);
  }
  const other = createChatFilter(testConfig({ chat: { ignore_users: ["UCother", "youtube:UCother", "Another Bot"] } }), "youtube");
  assert.ok(other(sender, body, messageId), "another author's identifiers do not match");
});

const superChat = (over: Record<string, unknown>): Item => ({
  id: "sc1",
  snippet: {
    type: "superChatEvent", publishedAt: "2026-11-23T12:00:05Z", displayMessage: "$5.00 thanks for the stream",
    superChatDetails: { amountMicros: "5000000", currency: "USD", amountDisplayString: "$5.00", tier: 2, ...over },
  },
  authorDetails: { channelId: "UCpay", displayName: "Payer", isChatModerator: false, isChatOwner: false, isChatSponsor: false },
});

// @spec CHAT-YT-053
test("a Super Chat with a comment publishes the comment alone, with no sign of the payment anywhere", () => {
  const r = msg(superChat({ userComment: "thanks for the stream" }));
  assert.equal(r.text, "thanks for the stream", "the comment, never displayMessage");
  const serialised = JSON.stringify(r);
  for (const leak of ["5000000", "USD", "$5.00", "tier", "amount", "paid"]) assert.ok(!serialised.includes(leak), `${leak} must not appear`);
  const ev = createChatFilter(testConfig(), "youtube")(r.sender, r.text, r.messageId)!;
  assert.deepEqual(Object.keys(ev).sort(), ["isMod", "isSub", "messageId", "mentionsCohost", "platform", "text", "user", "userId"].sort());
});

// @spec CHAT-YT-053
test("a Super Chat whose comment field is absent from the response publishes nothing (displayMessage is not a fallback)", () => {
  assert.equal(mapLiveChatItem(superChat({})).kind, "none");
});

// @spec CHAT-YT-054
test("a Super Chat with an empty comment publishes nothing", () => {
  assert.equal(mapLiveChatItem(superChat({ userComment: "" })).kind, "none");
  assert.equal(mapLiveChatItem(superChat({ userComment: "   " })).kind, "none");
});

// @spec CHAT-YT-055
test("purchase and membership notices and poll events publish nothing", () => {
  for (const type of ["superStickerEvent", "newSponsorEvent", "memberMilestoneChatEvent", "membershipGiftingEvent", "giftMembershipReceivedEvent", "giftEvent", "pollEvent"]) {
    const item = { id: "n1", snippet: { type, publishedAt: "2026-11-23T12:00:05Z", displayMessage: "someone bought something", textMessageDetails: { messageText: "x" } }, authorDetails: { channelId: "UC1", displayName: "n" } };
    assert.equal(mapLiveChatItem(item).kind, "none", type);
  }
});

// @spec CHAT-YT-056
test("sponsor-only mode start and end are reported as a notice, not as chat", () => {
  for (const type of ["sponsorOnlyModeStartedEvent", "sponsorOnlyModeEndedEvent"]) {
    const r = mapLiveChatItem({ id: "s1", snippet: { type, publishedAt: "2026-11-23T12:00:05Z" }, authorDetails: { channelId: "UC1" } });
    assert.equal(r.kind, "notice", type);
  }
});

// @spec CHAT-YT-057
test("a chat-mapped message with no text or an author with no channel id is dropped", () => {
  const noText = text("a", 1);
  delete noText.snippet.textMessageDetails;
  assert.equal(mapLiveChatItem(noText).kind, "none", "no textMessageDetails");
  const emptyText = text("b", 1, "");
  assert.equal(mapLiveChatItem(emptyText).kind, "none", "empty text");
  const noChannel = text("c", 1);
  delete noChannel.authorDetails.channelId;
  assert.equal(mapLiveChatItem(noChannel).kind, "none", "no channel id");
  const noAuthor = text("d", 1);
  delete noAuthor.authorDetails;
  assert.equal(mapLiveChatItem(noAuthor).kind, "none", "no author");
});

// @spec CHAT-YT-057
test("the removal markers are not dropped for a missing author channel id", () => {
  const t = tombstone("t1", "m9");
  delete t.authorDetails;
  assert.equal(mapLiveChatItem(t).kind, "removal");
  const b = banned("b1", "UCbad");
  delete b.authorDetails;
  assert.equal(mapLiveChatItem(b).kind, "removal");
});

// @spec CHAT-YT-058
test("a message of any other type is dropped", () => {
  for (const type of ["fanFundingEvent", "messageRetractedEvent", "someFutureEvent", ""]) {
    assert.equal(mapLiveChatItem({ id: "o1", snippet: { type, publishedAt: "2026-11-23T12:00:05Z", textMessageDetails: { messageText: "x" } }, authorDetails: { channelId: "UC1", displayName: "o" } }).kind, "none", type);
  }
});

// @spec CHAT-YT-050
test("a chatEndedEvent maps to the end of the broadcast", () => {
  assert.equal(mapLiveChatItem({ id: "e1", snippet: { type: "chatEndedEvent", publishedAt: "2026-11-23T12:00:05Z" }, authorDetails: { channelId: "UC1" } }).kind, "ended");
});

// @spec CHAT-FORGET-002
test("a tombstone with the deleted message's id is a message removal carrying its own id as the marker id", () => {
  const r = mapLiveChatItem(tombstone("t1", "m9"));
  assert.deepEqual(r, { kind: "removal", removal: { scope: "message", messageId: "m9" }, markerId: "t1" });
});

// @spec CHAT-FORGET-002
test("a messageDeletedEvent with the deleted message's id is a message removal, as a tombstone is", () => {
  const item = { id: "d1", snippet: { type: "messageDeletedEvent", publishedAt: "2026-11-23T12:00:05Z", messageDeletedDetails: { deletedMessageId: "m9" } }, authorDetails: { channelId: "UCmod" } };
  assert.deepEqual(mapLiveChatItem(item), { kind: "removal", removal: { scope: "message", messageId: "m9" }, markerId: "d1" });
  assert.equal(mapLiveChatItem({ ...item, snippet: { type: "messageDeletedEvent" } }).kind, "unusable", "no id: nothing forgotten");
});

// @spec CHAT-FORGET-003
test("a userBannedEvent is a user removal, banned for a permanent ban and timeout for a temporary one", () => {
  assert.deepEqual(mapLiveChatItem(banned("b1", "UCbad", "permanent")), { kind: "removal", removal: { scope: "user", userId: "UCbad", reason: "banned" }, markerId: "b1" });
  assert.deepEqual(mapLiveChatItem(banned("b2", "UCbad", "temporary")), { kind: "removal", removal: { scope: "user", userId: "UCbad", reason: "timeout" }, markerId: "b2" });
});

// @spec CHAT-FORGET-004
test("a tombstone or userBannedEvent with no usable id maps to unusable, never to a removal", () => {
  assert.equal(mapLiveChatItem(tombstone("t1", undefined)).kind, "unusable");
  assert.equal(mapLiveChatItem(tombstone("t2", "")).kind, "unusable");
  assert.equal(mapLiveChatItem(banned("b1", undefined)).kind, "unusable");
  assert.equal(mapLiveChatItem(banned("b2", "")).kind, "unusable");
});
