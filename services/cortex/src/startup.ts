import type { Logger } from "@cohost/config";
import type { ChatProvider } from "@cohost/llm";

export interface WaitForLlmOptions {
  log: Logger;
  /** Called after every ping with its result (feeds `deps.llm`). */
  setOk?: (ok: boolean) => void;
  /** Called on each failed ping with a human-readable reason (the degraded heartbeat hook). */
  onDown?: (detail: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
  retryMs?: number;
}

/**
 * Block until the model backend answers `ping()`. Never silent and never fatal:
 * every miss is logged and reported through `onDown`, so a supervisor sees `degraded`
 * instead of a service that just hangs. The mock provider answers immediately.
 */
export async function waitForLlm(llm: ChatProvider, o: WaitForLlmOptions): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const ok = await llm.ping();
    o.setOk?.(ok);
    if (ok) return;
    const detail = `model backend unreachable (${llm.name}/${llm.model})${llm.lastError ? `: ${llm.lastError}` : ""}`;
    o.log.warn({ provider: llm.name, model: llm.model, error: llm.lastError }, "waiting for the model backend...");
    o.onDown?.(detail);
    await sleep(o.retryMs ?? 3000);
  }
}
