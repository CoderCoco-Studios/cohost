import type { HeartbeatSpec } from "@cohost/bus";

// @spec DASH-HEALTH-001
/** dashboard has no external dependencies besides Redis. */
export const dashboardHealth: HeartbeatSpec = { service: "dashboard", mode: "live", deps: {} };
