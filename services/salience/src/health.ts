import type { HeartbeatSpec } from "@cohost/bus";

/** salience has no external dependencies besides Redis. */
export const salienceHealth: HeartbeatSpec = { service: "salience", mode: "live", deps: {} };
