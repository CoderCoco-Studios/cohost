import type { EventInput } from "@cohost/bus";
import type { Config } from "@cohost/config";
import { boundText, UNKNOWN_NAME } from "@cohost/shared/untrusted";
import type { ChatPlatform } from "./source.js";

/**
 * The platform-neutral sender a source builds from what its platform tells it. Every platform decision (which flags
 * mean moderator, which identifiers a platform has) is made by the source; the filter reads the result.
 */
export interface ChatSender {
  displayName: string;
  /** The platform's login name, where the platform has one (Twitch; a YouTube author has none). */
  login?: string;
  /** The platform's own user id for the sender. */
  userId?: string;
  /** Moderator, or broadcaster (the source folds the broadcaster into this). */
  isMod: boolean;
  isSub: boolean;
  /** The identifiers `chat.ignore_users` is matched against, built by the source (CHAT-FILT-012, CHAT-FILT-013). */
  ignoreIdentifiers: string[];
  /** Set only by a source that emits for more than one platform (the fake source); otherwise the source's own platform applies. */
  platform?: ChatPlatform;
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

// @spec CHAT-FILT-001, CHAT-FILT-002, CHAT-FILT-003, CHAT-FILT-004, CHAT-FILT-005, CHAT-FILT-006, CHAT-FILT-007, CHAT-FILT-008, CHAT-FILT-009, CHAT-FILT-011, CHAT-FILT-012, CHAT-FILT-013, CHAT-FILT-014
/**
 * A source's line → `chat.message` payload, or undefined for ignored senders, commands and lines empty after bounding.
 * `platform` is the platform of the source that read the line; the filter itself is the same for every source.
 * A sender is ignored when any of its `ignoreIdentifiers` is listed in `chat.ignore_users`, whatever the platform.
 */
export function createChatFilter(cfg: Config, platform: ChatPlatform): (sender: ChatSender, text: string, messageId?: string) => EventInput<"chat.message"> | undefined {
  const cohostName = cfg.cohost.name;
  const ignoreUsers = new Set(cfg.chat.ignore_users.map((u) => u.toLowerCase()));
  const { max_chars, max_name_chars } = cfg.viewer_text;
  return (sender, text, messageId) => {
    if (sender.ignoreIdentifiers.some((id) => ignoreUsers.has(id.toLowerCase()))) return undefined;
    const bounded = boundText(text, max_chars);
    if (!bounded) return undefined;
    if (cfg.chat.ignore_prefixes.some((p) => bounded.startsWith(p))) return undefined;
    const name = [sender.displayName, sender.login ?? ""].map((n) => boundText(n, max_name_chars)).find((n) => n !== "") ?? UNKNOWN_NAME;
    return {
      platform,
      user: name,
      ...(sender.userId !== undefined ? { userId: sender.userId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      text: bounded,
      isMod: sender.isMod,
      isSub: sender.isSub,
      mentionsCohost: mentionsCohost(bounded, cohostName),
    };
  };
}
