import type { HeartbeatSpec } from "@cohost/bus";

/** cortex depends on the chat LLM backend; `llm` follows the last `ping()` result. The mock provider reports mode `mock`. */
export function cortexHealth(llmOk: () => boolean, provider = "ollama"): HeartbeatSpec {
  return { service: "cortex", mode: provider === "mock" ? "mock" : "live", deps: () => ({ llm: llmOk() ? "ok" : "down" }) };
}
