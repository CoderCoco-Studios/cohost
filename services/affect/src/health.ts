import type { Config } from "@cohost/config";
import type { HeartbeatSpec } from "@cohost/shared";

/**
 * affect has no external dependencies besides Redis. The mode is `mock` where the appraiser hook is an `llm` hook that
 * inherits the mock provider (no per-hook provider override), because such an appraiser falls back to the rules on every
 * call; otherwise `live`.
 */
export function affectHealth(cfg: Config): HeartbeatSpec { // @spec AFF-HEALTH-001, AFF-HEALTH-003
  const m = cfg.brain.affect.module;
  const mock = m.kind === "llm" && !m.llm.provider && cfg.llm.provider === "mock";
  return { service: "affect", mode: mock ? "mock" : "live", deps: {} };
}
