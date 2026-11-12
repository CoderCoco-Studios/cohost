import type { Config } from "@cohost/config";
import type { HeartbeatSpec } from "@cohost/shared";

/**
 * salience has no external dependencies besides Redis. The mode is `mock` where the scorer hook is an `llm` hook that
 * inherits the mock provider (no per-hook provider override), because such a scorer falls back to the rules on every
 * call; otherwise `live`.
 */
export function salienceHealth(cfg: Config): HeartbeatSpec { // @spec SAL-HEALTH-001, SAL-HEALTH-005
  const m = cfg.brain.salience.module;
  const mock = m.kind === "llm" && !m.llm.provider && cfg.llm.provider === "mock";
  return { service: "salience", mode: mock ? "mock" : "live", deps: {} };
}
