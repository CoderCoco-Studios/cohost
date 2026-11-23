import type { HeartbeatSpec } from "@cohost/shared";
import type { ChatSourceName, ChatSourceStatus } from "./source.js";

type Dep = "ok" | "down" | "n/a";

// @spec CHAT-HEALTH-001, CHAT-HEALTH-002, CHAT-HEALTH-003, CHAT-HEALTH-006, CHAT-HEALTH-007, CHAT-HEALTH-008, CHAT-HEALTH-009, CHAT-HEALTH-012
/**
 * chat's heartbeat. `mode` is fixed by the listed sources: `mock` with fake, `off` with none, `live` otherwise.
 * A listed twitch or youtube dependency is `ok` only while that source is `reading`, otherwise `down`; a source not
 * listed is `n/a`. `states` is read at every heartbeat check.
 */
export function chatHealth(listed: ChatSourceName[], states: () => Partial<Record<ChatSourceName, ChatSourceStatus>>): HeartbeatSpec {
  const mode = listed.includes("fake") ? "mock" : listed.length === 0 ? "off" : "live";
  const dep = (name: "twitch" | "youtube", s: Partial<Record<ChatSourceName, ChatSourceStatus>>): Dep => {
    if (!listed.includes(name)) return "n/a";
    return s[name]?.state === "reading" ? "ok" : "down";
  };
  return {
    service: "chat",
    mode,
    deps: () => {
      const s = states();
      return { twitch: dep("twitch", s), youtube: dep("youtube", s) };
    },
  };
}
