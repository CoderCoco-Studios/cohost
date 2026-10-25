import type { HeartbeatSpec } from "@cohost/bus";

/** chat's heartbeat identity: `off` with no channel configured, otherwise `live` with twitch tracking the IRC connection. */
export function chatHealth(channel: string, twitchConnected: () => boolean): HeartbeatSpec {
  return {
    service: "chat",
    mode: channel ? "live" : "off",
    deps: () => ({ twitch: !channel ? "n/a" : twitchConnected() ? "ok" : "down" }),
  };
}
