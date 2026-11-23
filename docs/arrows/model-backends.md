# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): every client is built from `secrets.yaml` credentials alone, the Bedrock client from the region and both keys (LLM-CLAUDE-009, -015 to -018). Built on Ollama and OpenAI-compatible only: the result contract (`ChatMessage` as a closed union by role, `ChatResult`, `ChatRequest`, `ToolSpec`, `ToolCall`, `ChatEvent` types), `ChatError` with kinds `http`, `connect` and `stream`, `complete()` and `stream()` with tools (definitions out; calls back whole on Ollama and assembled by `index` from fragments on OpenAI-compatible; results forward; a call the cap cut off is dropped; calls delivered after the text and before `done`), and the tool rules shared in `index.ts` (name pattern, `json` with tools, `tools: []` as none, stop omission, argument parsing, finish mapping). `chat()` rejects a tool history with a `TypeError` on every provider, and `chat()` on the Claude, Bedrock and mock providers is text-only as before. Not yet built: `complete()` and tools on the Claude and Bedrock providers (#161, #163; the `any provider` lines LLM-TOOL-017, LLM-TOOL-025, LLM-STREAM-032 and LLM-STOP-019 stay open until the Claude providers carry tools), image input on every provider (#164), and the `not_configured` kind of `ChatError` on the Claude paths. The spec file now holds 226 specs: 164 `[x]`, 62 `[ ]`, 0 `[D]`. Existing `chat()` specs keep their markers except LLM-VIS-002 and LLM-VIS-003, whose `chat()` behaviour reverses (images are sent, not dropped) and are `[ ]`. Not covered by the last audit.

**AUDITED** — 54 specs: 54 implemented (`[x]`), 0 gaps (`[ ]`), 0 deferred (`[D]`). The docs site's extension guides added LLM-EX-001 to LLM-EX-006 (the OpenAI-compatible stub servers in Python and TypeScript and their try-it script), implemented and tested, not yet audited; the spec file then held 60 specs (60 `[x]`, 0 `[ ]`, 0 `[D]`).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (226 specs, prefix LLM: 164 `[x]`, 62 `[ ]`, 0 `[D]`)

### Tests
- packages/llm/test/tools.test.ts (tool calls on Ollama and OpenAI-compatible, complete() and stream(): definitions, calls, results, arguments, finish, streamed calls, the shared request checks; fake HTTP servers, no external network)
- packages/llm/test/complete.test.ts (the result contract: `complete()` on Ollama and OpenAI-compatible, `ChatError`, the `chat()` tool-history rejection on every provider; recorder and black-hole servers, stubbed Claude and Bedrock transports; no external network)
- packages/llm/test/mock.test.ts (the mock provider: complete(), stream(), the `[mock-tool]` round trip, the `[mock-fail-after]` failing stream, `json` and abort precedence, images ignored; no I/O)
- packages/llm/test/llm.test.ts (fake HTTP servers, including a black-hole server for the timeout tests, and a stubbed SDK client; no external network)
- packages/llm/test/backends.test.ts (Claude and Bedrock through the real SDK clients against recorded fixtures; an opt-in live smoke test)
- packages/llm/test/fixtures/ (recorded Claude and Bedrock responses)
- packages/modules/test/module.test.ts, packages/modules/test/hooks.test.ts, services/memory/test/reflect.test.ts (cite LLM IDs for the mock warning and hook fallbacks)

### Code
- packages/llm/src/index.ts
- packages/llm/src/mock.ts
- packages/llm/src/request.ts (the request checks shared by the tool-carrying providers, LLM-TOOL-001, LLM-TOOL-002)
- packages/llm/package.json, packages/llm/tsconfig.json
- Other files citing LLM IDs: packages/modules/src/index.ts, services/memory/src/reflect-run.ts, services/memory/src/backend.ts
- docs/guide/tune/model.md (operator recipes, docs-site)
- scripts/dev/stub-llm.ts (fake Ollama server, reference only)

## Architecture

**Purpose:** Let regions call a chat model without knowing the vendor, so that a stronger model is a config change. Keep embeddings on Ollama (or the hash stand-in under `mock`) so the memory vector size never depends on the chat model.

**Key Components:**
1. `ChatProvider` / `Embedder` / `ChatOptions` / `ChatRequest` / `ChatResult` / `ChatEvent` / `ChatError` (`index.ts`) - the contract: `chat()` text, `complete()` a result with tool calls, `stream()` events; `json: true` means "no stop sequences".
2. `createChatProvider` (`index.ts`) - the factory switch over `llm.provider`.
3. `Ollama` (`index.ts`) - chat, embeddings and ping against a local Ollama.
4. `OpenAICompatible` (`index.ts`) - `/chat/completions` and `/models`, optional bearer key.
5. `ClaudeBase` / `AnthropicProvider` / `BedrockProvider` (`index.ts`) - shared Claude request building (system join, `(begin)` turn, caller's token budget, effort, refusal, optional server-side fallbacks).
6. `TRANSCRIPT_STOPS` / `REPLY_STOPS` (`index.ts`) - truncation lists implicitly coupled to working-memory transcript tags.
7. `MockProvider` / `HashEmbedder` (`mock.ts`) - deterministic offline backends for isolated runs.

Consumers: cortex (`services/cortex/src/main.ts`), memory (`services/memory/src/backend.ts`, `reflect.ts`), and the `Module` runner in region-hooks (`packages/modules/src/index.ts`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test pointers |
|----------|----------|-------------|----------|------|----------------|
| Interface and factory | LLM-IF-001 to LLM-IF-022 | 15 | 0 | 7 | 15 |
| Errors | LLM-ERR-001 to LLM-ERR-009 | 6 | 0 | 3 | 6 |
| Ollama and OpenAI-compatible chat | LLM-CHAT-001 to LLM-CHAT-022 | 20 | 0 | 2 | 20 |
| Vision | LLM-VIS-001 to LLM-VIS-013 | 2 | 0 | 11 | 2 |
| Streamed replies | LLM-STREAM-001 to LLM-STREAM-037 | 27 | 0 | 10 | 27 |
| Tool calls | LLM-TOOL-001 to LLM-TOOL-030 | 20 | 0 | 10 | 20 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-019 | 14 | 0 | 5 | 14 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-033 | 19 | 0 | 14 | 19 |
| Health ping | LLM-PING-001 to LLM-PING-007 | 7 | 0 | 0 | 7 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 (003 retired) | 5 | 0 | 0 | 5 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-021 | 21 | 0 | 0 | 21 |
| Example stub servers | LLM-EX-001 to LLM-EX-008 | 8 | 0 | 0 | 8 |

**Summary:** 164 of 226 specs implemented; 0 deferred; 62 gaps. The gaps are the Claude and Bedrock lines (complete, tools, streamed tool calls, continuation, refusal, retries, abort and timeouts on `complete()`), the `any provider` lines LLM-TOOL-017, LLM-TOOL-025, LLM-STREAM-032 and LLM-STOP-019, image input on every provider, the `not_configured` kind of `ChatError` on the Claude paths, and LLM-VIS-002 and LLM-VIS-003.

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
- Build the revised contract (all `[ ]` lines of LLM-IF, LLM-ERR, LLM-CHAT, LLM-VIS, LLM-STREAM, LLM-TOOL, LLM-STOP, LLM-CLAUDE): `complete()` on `anthropic` and `bedrock` (#161), tools and streamed tool calls on the Claude and Bedrock providers (#163), images on OpenAI-compatible, `anthropic` and `bedrock` (#164), and the `ChatError` kind `not_configured`.
- Audit the stub model servers (LLM-EX-001..006), cited by the docs site's Extend pages.
1. Fix the docs site's Choose a model page (`docs/guide/tune/model.md`): its override path `brain.<region>.module.llm` does not fit the critic (`brain.cortex.critic.llm`).

### Nice to Have
None.
