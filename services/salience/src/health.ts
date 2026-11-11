import type { HeartbeatSpec } from "@cohost/shared";

/** salience has no external dependencies besides Redis. */
export const salienceHealth: HeartbeatSpec = { service: "salience", mode: "live", deps: {} }; // @spec SAL-HEALTH-001
