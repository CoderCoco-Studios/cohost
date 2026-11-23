/**
 * Request checks shared by every provider that offers tools. Kept apart from `index.ts` so `mock.ts` can run them without
 * importing the provider module back.
 */
import type { ChatRequest } from "./index.js";

/** The tool names the backends accept (LLM-TOOL-001). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The checks every `complete()` and `stream()` runs before any request is sent: a tool name outside the pattern, and `json: true`
 * with non-empty `tools`, are `TypeError`s (LLM-TOOL-001, LLM-TOOL-002).
 */
export function checkRequest(req: ChatRequest): void { // @spec LLM-TOOL-001, LLM-TOOL-002
  for (const t of req.tools ?? []) {
    if (!TOOL_NAME.test(t.name)) throw new TypeError(`tool name ${JSON.stringify(t.name)} must match [A-Za-z0-9_-]{1,64}`);
  }
  if (req.json && (req.tools?.length ?? 0) > 0) throw new TypeError("json: true cannot be combined with tools: a reply is either JSON or tool calls");
}
