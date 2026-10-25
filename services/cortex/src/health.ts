import type { HeartbeatSpec } from "@cohost/bus";

/** cortex depends on the chat LLM backend; `llm` follows the last `ping()` result. */
export function cortexHealth(llmOk: () => boolean): HeartbeatSpec {
  return { service: "cortex", mode: "live", deps: () => ({ llm: llmOk() ? "ok" : "down" }) };
}
