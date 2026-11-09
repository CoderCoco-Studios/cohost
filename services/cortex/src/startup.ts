import { tracked, type Bus } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { ChatProvider } from "@cohost/llm";
import type { Cortex } from "./cortex.js";

export interface WaitForLlmOptions {
  log: Logger;
  /** Called after every ping with its result (feeds `deps.llm`). */
  setOk?: (ok: boolean) => void;
  /** Called on each failed ping with a human-readable reason (the degraded heartbeat hook). */
  onDown?: (detail: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
  retryMs?: number;
}

// @spec CTX-START-001, CTX-HEALTH-002
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

/** Every bus event type the cortex reads. */
const CORTEX_EVENTS = [
  "chat.message", "speech.heard", "vision.summary", "brain.say", "voice.done", "voice.failed",
  "attention.focus", "memory.recall.reply", "memory.notes.reply", "memory.viewer", "affect.state", "control",
] as const;

export interface StartCortexOptions {
  bus: Pick<Bus, "resetGroup" | "subscribe">;
  cortex: Pick<Cortex, "status" | "onEvent">;
  heartbeat: { ready(): void };
  /** The subscription loop ended with an error. */
  onFatal: (err: unknown) => void;
}

// @spec CTX-START-003, CTX-EVT-001
/**
 * Go idle, make sure the `cortex` consumer group exists at the stream's newest entry, subscribe at
 * start mode `latest`, and only then report `ready`. `resetGroup` is awaited because `subscribe`
 * creates its group asynchronously and gives the caller no signal when it has.
 */
export async function startCortex(o: StartCortexOptions): Promise<void> {
  await o.cortex.status("idle");
  await o.bus.resetGroup("cortex");
  o.bus.subscribe({ group: "cortex", types: CORTEX_EVENTS, start: "latest" }, (ev) => o.cortex.onEvent(ev)).catch(o.onFatal);
  o.heartbeat.ready();
}

// @spec CTX-HEALTH-003
/** The provider with every `chat` outcome reported to `set` (ok after a reply, not ok after a failure). */
export function trackLlm(llm: ChatProvider, set: (ok: boolean) => void): ChatProvider {
  return {
    get name() { return llm.name; },
    get model() { return llm.model; },
    get lastError() { return llm.lastError; },
    get pingIsNominal() { return llm.pingIsNominal; },
    chat: tracked((m, opts) => llm.chat(m, opts), set),
    ping: () => llm.ping(),
  };
}
