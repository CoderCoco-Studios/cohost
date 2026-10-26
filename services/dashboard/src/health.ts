import type { HeartbeatSpec } from "@cohost/bus";

/** dashboard has no external dependencies besides Redis. */
export const dashboardHealth: HeartbeatSpec = { service: "dashboard", mode: "live", deps: {} };
