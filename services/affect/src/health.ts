import type { HeartbeatSpec } from "@cohost/shared";

/** affect has no external dependencies besides Redis. */
export const affectHealth: HeartbeatSpec = { service: "affect", mode: "live", deps: {} }; // @spec AFF-HEALTH-001
