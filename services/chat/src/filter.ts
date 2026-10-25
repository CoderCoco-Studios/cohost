import type { EventInput } from "@cohost/bus";
import type { Config } from "@cohost/config";

/** The parts of a twurple ChatUser the filter reads. */
export interface ChatUserInfo {
  displayName: string;
  userId: string;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber: boolean;
}

/** `#SomeChannel` → `somechannel`. */
export function channelName(cfg: Config["chat"]): string {
  return cfg.twitch.channel.replace(/^#/, "").toLowerCase();
}

/**
 * What the service should do for this config: `fake` publishes scripted/stdin chat,
 * `twitch` connects, `idle` is twitch with no channel (stay up degraded; never exit).
 */
export function chatPlan(cfg: Config["chat"]): "fake" | "twitch" | "idle" {
  if (cfg.source === "fake") return "fake";
  return channelName(cfg) ? "twitch" : "idle";
}

/** Twitch message → `chat.message` payload, or undefined for bots, commands and blank lines. */
export function createChatFilter(cfg: Config): (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined {
  const cohostName = cfg.cohost.name.toLowerCase();
  const ignoreUsers = new Set(cfg.chat.ignore_users.map((u) => u.toLowerCase()));
  return (user, text, info) => {
    if (ignoreUsers.has(user.toLowerCase())) return undefined;
    if (cfg.chat.ignore_prefixes.some((p) => text.startsWith(p))) return undefined;
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return undefined;
    return {
      platform: "twitch",
      user: info.displayName || user,
      userId: info.userId,
      text: clean,
      isMod: info.isMod || info.isBroadcaster,
      isSub: info.isSubscriber,
      mentionsCohost: clean.toLowerCase().includes(cohostName),
    };
  };
}
