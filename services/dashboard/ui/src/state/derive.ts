import type { ServiceHealth } from "./types";

/** States that need the operator's attention: they sort first on the Services screen and are counted beside its nav item. */
const ATTENTION = new Set(["down", "crash-looping", "stale"]);

export const needsAttention = (s: Pick<ServiceHealth, "state">): boolean => ATTENTION.has(s.state);
export const attentionCount = (services: readonly Pick<ServiceHealth, "state">[] | null): number => (services ?? []).filter(needsAttention).length;
