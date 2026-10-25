import type { HeartbeatSpec } from "@cohost/bus";

/**
 * chat's heartbeat identity. `fake` is `mock` with twitch n/a; `twitch` is `live`
 * with twitch tracking the IRC connection (down when no channel is configured).
 */
export function chatHealth(channel: string, twitchConnected: () => boolean, source: "twitch" | "fake" = "twitch"): HeartbeatSpec {
  if (source === "fake") return { service: "chat", mode: "mock", deps: () => ({ twitch: "n/a" }) };
  return {
    service: "chat",
    mode: "live",
    deps: () => ({ twitch: channel && twitchConnected() ? "ok" : "down" }),
  };
}
