# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (43 specs, prefix LLM)

### Tests
- packages/llm/test/llm.test.ts (18 tests; fake HTTP servers and a stubbed SDK client, no external network)

### Code
- packages/llm/src/index.ts
- packages/llm/src/mock.ts
- packages/llm/package.json, packages/llm/tsconfig.json
- examples/providers/README.md (operator recipes)
- scripts/dev/stub-llm.ts (fake Ollama server, reference only)

### OpenSpec
- openspec/specs/llm/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/llm/spec.md

## Architecture

**Purpose:** Let regions call a chat model without knowing the vendor, so that a stronger model is a config change. Keep embeddings on Ollama (or the hash stand-in under `mock`) so the memory vector size never depends on the chat model.

**Key Components:**
1. `ChatProvider` / `Embedder` / `ChatOptions` (`index.ts:22-42`) - the contract; `json: true` means "no stop sequences".
2. `createChatProvider` / `createEmbedder` (`index.ts:49-63`) - the factory switch over `llm.provider`.
3. `Ollama` (`index.ts:68`) - chat, embeddings and ping against a local Ollama.
4. `OpenAICompatible` (`index.ts:125`) - `/chat/completions` and `/models`, optional bearer key.
5. `ClaudeBase` / `AnthropicProvider` / `BedrockProvider` (`index.ts:177-251`) - shared Claude request building (system join, `(begin)` turn, token floor, effort, refusal, optional server-side fallbacks).
6. `TRANSCRIPT_STOPS` / `REPLY_STOPS` (`index.ts:45-47`) - truncation lists implicitly coupled to working-memory transcript tags.
7. `MockProvider` / `HashEmbedder` (`mock.ts`) - deterministic offline backends for isolated runs.

Consumers: cortex (`services/cortex/src/index.ts:28`), memory (`services/memory/src/backend.ts`, `reflect.ts`), and the `Module` runner in region-hooks (`packages/modules/src/index.ts:43`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Interface and factory | LLM-IF-001 to LLM-IF-004 | 4 | 0 | 0 |
| Ollama and OpenAI chat | LLM-CHAT-001 to LLM-CHAT-007 | 7 | 0 | 0 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-006 | 6 | 0 | 0 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-010 | 10 | 0 | 0 |
| Health ping | LLM-PING-001 to LLM-PING-005 | 5 | 0 | 0 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 | 5 | 0 | 1 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-005 | 4 | 0 | 1 |

**Summary:** 41 of 43 specs observed working; 0 deferred; 2 gaps.

## Key Findings

1. **Unverifiable Claude/Bedrock wire surface** — the beta `server-side-fallback-2026-07-01`, `fallbacks: "default"` and `AnthropicBedrockMantle` (`index.ts:16`, `:202`, `:248`) cannot be confirmed from the repo; tests only assert the code sends them (`llm.test.ts:177-178`). Treated as an Open Question, not a fact either way.
2. **`createEmbedder` is unused by services** — memory picks its embedder from `brain.memory.embedder` (`services/memory/src/backend.ts:7-9`), so the OpenSpec rule "mock -> hash" is only test-proven (LLM-EMBED-004).
3. **Mock is not reported everywhere** — only cortex warns and reports `mode: mock` (`services/cortex/src/index.ts:34`); reflect and mock-backed hooks do not (LLM-MOCK-005).
4. **No request timeouts or retries** — Ollama/OpenAI `fetch` calls and both pings run without a timeout unless the caller passes a signal (`index.ts:74`, `:112`, `:141`, `:162`); cortex's `llm.chat(messages)` passes none (`services/cortex/src/cortex.ts:116`).
5. **Bedrock `ping` is always true** (`index.ts:250`), so a bad credential or un-enabled model reads as a healthy `llm` dependency until the first chat fails.
6. **Stop strings are hand-copied from working-memory** (`index.ts:45` vs `packages/working-memory/src/index.ts:93-95`); the co-host self-line `Name: [emotion] text` is not a stop.
7. **`opts.maxTokens` is a floor on Claude** (`index.ts:192`): hooks asking for 60-160 tokens get 2048, and `temperature` is ignored (`index.ts:198`).

## Work Required

### Must Fix
1. Nothing is broken enough to block; the two `[ ]` specs are the only gaps (LLM-EMBED-004, LLM-MOCK-005).

### Should Fix
1. Decide whether `createEmbedder` should be wired into memory or removed, and document the real isolation switch (LLM-EMBED-003, LLM-EMBED-004).
2. Warn at startup wherever a mock provider is built, including reflect and hooks (LLM-MOCK-005).
3. Add timeouts (or require a signal) for `chat()`/`ping()` on the HTTP providers (no spec yet; see LLD Open Question 2).
4. Verify the Claude fallbacks beta and the Bedrock client class against the SDK/API and record the result (LLM-CLAUDE-007, LLM-CLAUDE-008).

### Nice to Have
1. Share the transcript tag list between working-memory and llm, or add a cross-package test (LLM-STOP-006).
2. Consider a cheap real Bedrock probe (LLM-PING-004).
3. Add tests for Ollama chat body fields (`num_ctx`, `num_predict`, `keep_alive`) and the mock-through-hook fallback.
