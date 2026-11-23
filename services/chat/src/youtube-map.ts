import type { ChatSender } from "./filter.js";
import type { ChatRemoval } from "./source.js";

/** One item of the API's `liveChatMessage` shape (the transport produces it from the proto, the REST poll returns it as is). */
export type LiveChatItem = Record<string, any>;

export type MapResult =
  | { kind: "message"; sender: ChatSender; text: string; messageId: string }
  | { kind: "removal"; removal: ChatRemoval; markerId: string }
  | { kind: "unusable"; type: string }
  | { kind: "notice"; notice: string }
  | { kind: "ended" }
  | { kind: "none" };

/** The sender a YouTube author is: display name, channel id and the prefixed form as ignore identifiers (CHAT-FILT-013). */
// @spec CHAT-YT-052, CHAT-FILT-013
function senderOf(author: Record<string, any>): ChatSender {
  const channelId: string | undefined = author.channelId || undefined;
  const identifiers = [author.displayName, channelId, channelId ? `youtube:${channelId}` : undefined]
    .filter((v): v is string => typeof v === "string" && v !== "");
  return {
    displayName: typeof author.displayName === "string" ? author.displayName : "",
    userId: channelId,
    isMod: author.isChatModerator === true || author.isChatOwner === true,
    isSub: author.isChatSponsor === true,
    ignoreIdentifiers: identifiers,
  };
}

/** A chat-mapped message: needs a non-empty text and an author with a channel id, otherwise it is dropped (CHAT-YT-057). */
function chatMessage(item: LiveChatItem, body: unknown): MapResult {
  if (typeof body !== "string" || body.trim() === "") return { kind: "none" };
  const author = item.authorDetails as Record<string, any> | undefined;
  if (!author || !author.channelId || typeof item.id !== "string") return { kind: "none" };
  return { kind: "message", sender: senderOf(author), text: body, messageId: item.id };
}

/**
 * Maps one API `liveChatMessage` to what the source does with it. Text messages publish their text; a Super Chat publishes
 * only its own comment; notices and other types publish nothing; the removal markers become removals: a `tombstone` or a
 * `messageDeletedEvent` removes its deleted message, a `userBannedEvent` removes its channel (CHAT-YT-051..058, CHAT-FORGET-002..004).
 */
// @spec CHAT-YT-050, CHAT-YT-051, CHAT-YT-052, CHAT-YT-053, CHAT-YT-054, CHAT-YT-055, CHAT-YT-056, CHAT-YT-057, CHAT-YT-058, CHAT-FORGET-002, CHAT-FORGET-003, CHAT-FORGET-004
export function mapLiveChatItem(item: LiveChatItem): MapResult {
  const snippet = (item.snippet ?? {}) as Record<string, any>;
  const type = typeof snippet.type === "string" ? snippet.type : "";
  switch (type) {
    case "textMessageEvent":
      return chatMessage(item, snippet.textMessageDetails?.messageText);
    case "superChatEvent":
      return chatMessage(item, snippet.superChatDetails?.userComment);
    case "tombstone":
    case "messageDeletedEvent": {
      const deleted = snippet.messageDeletedDetails?.deletedMessageId;
      if (typeof deleted !== "string" || deleted === "") return { kind: "unusable", type };
      return { kind: "removal", removal: { scope: "message", messageId: deleted }, markerId: item.id };
    }
    case "userBannedEvent": {
      const channel = snippet.userBannedDetails?.bannedUserDetails?.channelId;
      if (typeof channel !== "string" || channel === "") return { kind: "unusable", type };
      const reason = snippet.userBannedDetails?.banType === "temporary" ? "timeout" : "banned";
      return { kind: "removal", removal: { scope: "user", userId: channel, reason }, markerId: item.id };
    }
    case "chatEndedEvent":
      return { kind: "ended" };
    case "sponsorOnlyModeStartedEvent":
    case "sponsorOnlyModeEndedEvent":
      return { kind: "notice", notice: type };
    default:
      return { kind: "none" };
  }
}
