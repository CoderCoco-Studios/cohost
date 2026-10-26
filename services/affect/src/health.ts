import type { HeartbeatSpec } from "@cohost/bus";

/** affect has no external dependencies besides Redis. */
export const affectHealth: HeartbeatSpec = { service: "affect", mode: "live", deps: {} };
