import type { HeartbeatSpec } from "@cohost/shared";

// @spec CTX-HEALTH-001, CTX-HEALTH-002, CTX-HEALTH-004
/**
 * cortex depends on the chat LLM backend; `llm` follows the last `ping()` and, once the cortex is
 * thinking, the outcome of each reply. The mock provider reports mode `mock`. While `llmProbed()`
 * is false (a provider whose ping is nominal and no reply has been tried yet) `llm` is `n/a`.
 * A nominal-ping provider (bedrock) also carries a standing `detail` saying `llm` is not probed.
 * `deps.tools` is the tool catalog's state as cortex reads it (CTX-HEALTH-008).
 */
/** The standing detail of a provider whose ping is nominal (CTX-HEALTH-004). */
export const NOMINAL_PING_DETAIL = "llm dependency not probed: provider ping is nominal (no cheap health probe)";

// @spec CTX-HEALTH-008
export function cortexHealth(
  llmOk: () => boolean,
  provider = "ollama",
  llmProbed: () => boolean = () => true,
  pingIsNominal = false,
  tools: () => "ok" | "down" | "n/a" = () => "n/a",
): HeartbeatSpec {
  return {
    service: "cortex",
    mode: provider === "mock" ? "mock" : "live",
    ...(pingIsNominal ? { detail: NOMINAL_PING_DETAIL } : {}),
    deps: () => ({ llm: !llmProbed() ? "n/a" : llmOk() ? "ok" : "down", tools: tools() }),
  };
}
