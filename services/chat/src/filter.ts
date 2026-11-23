import type { EventInput } from "@cohost/bus";
import type { Config } from "@cohost/config";
import { boundText, UNKNOWN_NAME } from "@cohost/shared/untrusted";
import type { ChatPlatform } from "./source.js";

/** What a source tells the filter about the sender of a line. */
export interface ChatUserInfo {
  displayName: string;
  userId?: string;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber: boolean;
  messageId?: string;
}

// @spec CHAT-PLAN-004
/** `#SomeChannel` → `somechannel`. */
export function channelName(cfg: Config["chat"]): string {
  return cfg.twitch.channel.replace(/^#/, "").toLowerCase();
}

// @spec CHAT-FILT-007, CHAT-FILT-011
/** The one mention test: `name` as a case-insensitive substring of `text` (pass the bounded text). */
export function mentionsCohost(text: string, name: string): boolean {
  return text.toLowerCase().includes(name.toLowerCase());
}

// @spec CHAT-FILT-001, CHAT-FILT-002, CHAT-FILT-003, CHAT-FILT-004, CHAT-FILT-005, CHAT-FILT-006, CHAT-FILT-007, CHAT-FILT-008, CHAT-FILT-009, CHAT-FILT-011
/**
 * A source's line → `chat.message` payload, or undefined for ignored users, commands and lines empty after bounding.
 * `platform` is the platform of the source that read the line; the filter itself is the same for every source.
 */
export function createChatFilter(cfg: Config, platform: ChatPlatform): (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined {
  const cohostName = cfg.cohost.name;
  const ignoreUsers = new Set(cfg.chat.ignore_users.map((u) => u.toLowerCase()));
  const { max_chars, max_name_chars } = cfg.viewer_text;
  return (user, text, info) => {
    if (ignoreUsers.has(user.toLowerCase())) return undefined;
    const bounded = boundText(text, max_chars);
    if (!bounded) return undefined;
    if (cfg.chat.ignore_prefixes.some((p) => bounded.startsWith(p))) return undefined;
    const name = [info.displayName, user].map((n) => boundText(n, max_name_chars)).find((n) => n !== "") ?? UNKNOWN_NAME;
    return {
      platform,
      user: name,
      ...(info.userId !== undefined ? { userId: info.userId } : {}),
      ...(info.messageId !== undefined ? { messageId: info.messageId } : {}),
      text: bounded,
      isMod: info.isMod || info.isBroadcaster,
      isSub: info.isSubscriber,
      mentionsCohost: mentionsCohost(bounded, cohostName),
    };
  };
}
