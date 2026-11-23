import type { EventInput } from "@cohost/bus";
import type { Config } from "@cohost/config";
import { boundText, UNKNOWN_NAME } from "@cohost/shared/untrusted";

/** The parts of a twurple ChatUser the filter reads. */
export interface ChatUserInfo {
  displayName: string;
  userId: string;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber: boolean;
}

// @spec CHAT-PLAN-004
/** `#SomeChannel` → `somechannel`. */
export function channelName(cfg: Config["chat"]): string {
  return cfg.twitch.channel.replace(/^#/, "").toLowerCase();
}

// @spec CHAT-PLAN-001, CHAT-PLAN-002, CHAT-PLAN-003
/**
 * What the service should do for this config: `fake` publishes scripted/stdin chat,
 * `twitch` connects, `idle` is twitch with no channel (stay up degraded; never exit).
 */
export function chatPlan(cfg: Config["chat"]): "fake" | "twitch" | "idle" {
  if (cfg.source === "fake") return "fake";
  return channelName(cfg) ? "twitch" : "idle";
}

// @spec CHAT-FILT-007, CHAT-FILT-011
/** The one mention test: `name` as a case-insensitive substring of `text` (pass the bounded text). */
export function mentionsCohost(text: string, name: string): boolean {
  return text.toLowerCase().includes(name.toLowerCase());
}

// @spec CHAT-FILT-001, CHAT-FILT-002, CHAT-FILT-003, CHAT-FILT-004, CHAT-FILT-005, CHAT-FILT-006, CHAT-FILT-007, CHAT-FILT-008, CHAT-FILT-009, CHAT-FILT-011
/** Twitch message → `chat.message` payload, or undefined for bots, commands and lines empty after bounding. */
export function createChatFilter(cfg: Config): (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined {
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
      platform: "twitch",
      user: name,
      userId: info.userId,
      text: bounded,
      isMod: info.isMod || info.isBroadcaster,
      isSub: info.isSubscriber,
      mentionsCohost: mentionsCohost(bounded, cohostName),
    };
  };
}
