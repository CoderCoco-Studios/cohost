import type { ChatMessage } from "./index.js";

/** `chat()` offers no tools, so a history that holds a tool result or a tool call is a caller's programming error (LLM-IF-012). */
export function assertTextHistory(messages: ChatMessage[]): void { // @spec LLM-IF-012
  if (messages.some((m) => m.role === "tool" || (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0))) {
    throw new TypeError("chat() takes a text-only history: a tool message or an assistant toolCalls needs complete()");
  }
}
