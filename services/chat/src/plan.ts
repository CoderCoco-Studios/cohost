import type { Config } from "@cohost/config";
import { parseVideoValue } from "@cohost/shared";
import { channelName } from "./filter.js";
import type { ChatSourceName } from "./source.js";

/** A listed source that can run, or a configuration gap with the reasons it cannot (in the order they apply). */
export type PlanEntry =
  | { source: ChatSourceName; status: "runnable" }
  | { source: ChatSourceName; status: "gap"; reasons: string[] };

// @spec CHAT-PLAN-001, CHAT-PLAN-002, CHAT-PLAN-007, CHAT-PLAN-008, CHAT-PLAN-009, CHAT-PLAN-012, CHAT-PLAN-013, CHAT-PLAN-014
/**
 * Which listed sources run and which are gaps, in `chat.sources` order. Absent or null is `[twitch]`; a name listed
 * twice is planned once; an empty list plans nothing. Pure: the same config gives the same plan.
 */
export function sourcePlan(cfg: Config["chat"]): PlanEntry[] {
  const listed = cfg.sources ?? ["twitch"];
  return [...new Set(listed)].map((source): PlanEntry => {
    if (source === "fake") return { source, status: "runnable" };
    if (source === "twitch") {
      return channelName(cfg) ? { source, status: "runnable" } : { source, status: "gap", reasons: ["chat.twitch.channel is not set"] };
    }
    return youtubeEntry(cfg);
  });
}

// @spec CHAT-YT-003, CHAT-PLAN-012, CHAT-PLAN-013, CHAT-PLAN-014, SHARED-VID-002
function youtubeEntry(cfg: Config["chat"]): PlanEntry {
  const reasons: string[] = [];
  if (!(cfg.youtube?.api_key ?? "").trim()) reasons.push("chat.youtube.api_key is not set");
  const video = (cfg.youtube?.video ?? "").trim();
  if (!video) reasons.push("chat.youtube.video is not set");
  else if (parseVideoValue(video) === undefined) reasons.push("chat.youtube.video is not a YouTube video URL or id");
  return reasons.length ? { source: "youtube", status: "gap", reasons } : { source: "youtube", status: "runnable" };
}
