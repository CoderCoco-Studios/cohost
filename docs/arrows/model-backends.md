# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

**AUDITED** — 54 specs: 54 implemented (`[x]`), 0 gaps (`[ ]`), 0 deferred (`[D]`).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (54 specs, prefix LLM: 54 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- packages/llm/test/llm.test.ts (fake HTTP servers, including a black-hole server for the timeout tests, and a stubbed SDK client; no external network)
- packages/llm/test/backends.test.ts (Claude and Bedrock through the real SDK clients against recorded fixtures; an opt-in live smoke test)
- packages/llm/test/fixtures/ (recorded Claude and Bedrock responses)
- packages/modules/test/module.test.ts, packages/modules/test/hooks.test.ts, services/memory/test/reflect.test.ts (cite LLM IDs for the mock warning and hook fallbacks)

### Code
- packages/llm/src/index.ts
- packages/llm/src/mock.ts
- packages/llm/package.json, packages/llm/tsconfig.json
- Other files citing LLM IDs: packages/modules/src/index.ts, services/memory/src/reflect-run.ts, services/memory/src/backend.ts
- docs/guide/tune/model.md (operator recipes, docs-site)
- scripts/dev/stub-llm.ts (fake Ollama server, reference only)

## Architecture

**Purpose:** Let regions call a chat model without knowing the vendor, so that a stronger model is a config change. Keep embeddings on Ollama (or the hash stand-in under `mock`) so the memory vector size never depends on the chat model.

**Key Components:**
1. `ChatProvider` / `Embedder` / `ChatOptions` (`index.ts`) - the contract; `json: true` means "no stop sequences".
2. `createChatProvider` (`index.ts`) - the factory switch over `llm.provider`.
3. `Ollama` (`index.ts`) - chat, embeddings and ping against a local Ollama.
4. `OpenAICompatible` (`index.ts`) - `/chat/completions` and `/models`, optional bearer key.
5. `ClaudeBase` / `AnthropicProvider` / `BedrockProvider` (`index.ts`) - shared Claude request building (system join, `(begin)` turn, caller's token budget, effort, refusal, optional server-side fallbacks).
6. `TRANSCRIPT_STOPS` / `REPLY_STOPS` (`index.ts`) - truncation lists implicitly coupled to working-memory transcript tags.
7. `MockProvider` / `HashEmbedder` (`mock.ts`) - deterministic offline backends for isolated runs.

Consumers: cortex (`services/cortex/src/main.ts`), memory (`services/memory/src/backend.ts`, `reflect.ts`), and the `Module` runner in region-hooks (`packages/modules/src/index.ts`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Interface and factory | LLM-IF-001 to LLM-IF-004 | 4 | 0 | 0 | 3 |
| Ollama and OpenAI-compatible chat | LLM-CHAT-001 to LLM-CHAT-010 | 10 | 0 | 0 | 10 |
| Vision | LLM-VIS-001 to LLM-VIS-003 | 3 | 0 | 0 | 3 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-007 | 7 | 0 | 0 | 7 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-014 | 14 | 0 | 0 | 14 |
| Health ping | LLM-PING-001 to LLM-PING-006 | 6 | 0 | 0 | 6 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 (003 retired) | 5 | 0 | 0 | 5 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-005 | 5 | 0 | 0 | 5 |

**Summary:** 54 of 54 specs implemented; 0 deferred; 0 gaps. 53 carry a test `@spec` annotation; implemented without one: LLM-IF-001 (verified by the type system).

## Key Findings

1. **Claude/Bedrock wire surface is typed by the installed SDK.** `server-side-fallback-2026-07-01`, `fallbacks: "default"`, `output_config` and `AnthropicBedrockMantle` exist in the lockfile-pinned `@anthropic-ai/sdk` 1.8.0 and `@anthropic-ai/bedrock-sdk` 1.1.2 types, and `tsc -b` compiles the request. `backends.test.ts` replays recorded responses through the real clients.
2. **The stop-string contract has four parts in three segments** — working-memory renders the tags, cortex frames the prompt and parses the reply, this package sends the stops (LLD "Stop sequences and the transcript coupling"). `parseReply`'s first-line rule in `services/cortex/src/prompt.ts` is what makes the spoken line correct; the stops only cut generation early. working-memory owns the tags (WM-TRANS-006); LLM-STOP-007 derives the stops from the export (`TRANSCRIPT_TAGS`, WM-TRANS-009), and `@cohost/llm` depends on `@cohost/working-memory`. `services/cortex/test/transcript-stops.test.ts` checks the pair at the cortex level.
3. **Mock is reported by cortex, hooks and the reflect job** — cortex warns and reports `mode: mock`; `llm`-kind hooks warn once at construction (HOOK-WARN-004) and so does the reflect job (MEM-REFLECT-010); salience/affect heartbeats hard-code `live` (LLM-MOCK-005).
4. **Requests are bounded; there are no retries in this package** — Ollama/OpenAI `fetch` calls and both pings take `AbortSignal.timeout(llm.timeout_ms)` when the caller passes no signal, and the Claude path passes the SDK `timeout` request option (`requestSignal`; LLM-CHAT-008). The Claude and Bedrock SDK clients retry a failed request at most twice, stated as `maxRetries: 2` (LLM-CLAUDE-014).
5. **Bedrock `ping` is always true**, so a bad credential reads as a healthy `llm` dependency until the first chat fails; the provider exposes `pingIsNominal = true` (LLM-PING-006) and cortex says so in its heartbeat `detail` (CTX-HEALTH-004).
6. **The caller's `maxTokens` is honoured on Claude** (LLM-CLAUDE-003); `temperature` is never sent.
7. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line.

## Work Required

### Must Fix
None.

### Should Fix
1. Fix the docs site's Choose a model page (`docs/guide/tune/model.md`): its override path `brain.<region>.module.llm` does not fit the critic (`brain.cortex.critic.llm`).

### Nice to Have
None.
