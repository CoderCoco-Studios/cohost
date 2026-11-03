import type { HeartbeatSpec } from "@cohost/bus";

// @spec CTX-HEALTH-001, CTX-HEALTH-002, CTX-HEALTH-004
/**
 * cortex depends on the chat LLM backend; `llm` follows the last `ping()` and, once the cortex is
 * thinking, the outcome of each reply. The mock provider reports mode `mock`. While `llmProbed()`
 * is false (a provider whose ping is nominal and no reply has been tried yet) `llm` is `n/a`.
 */
export function cortexHealth(llmOk: () => boolean, provider = "ollama", llmProbed: () => boolean = () => true): HeartbeatSpec {
  return {
    service: "cortex",
    mode: provider === "mock" ? "mock" : "live",
    deps: () => ({ llm: !llmProbed() ? "n/a" : llmOk() ? "ok" : "down" }),
  };
}
