# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **Does `llm.provider: mock` imply the hash embedder for memory, or not?** LLM-EMBED-004 (`[ ]`), OpenSpec "Embeddings are always Ollama" and `config/config.example.yaml:18` ("deterministic offline replies + hash embeddings") say yes; commit `51d5a9c` calls memory's separate `MEMORY_EMBEDDER` switch "deliberate, avoids silent offline", and memory picks its embedder itself (`services/memory/src/backend.ts:8`); `createEmbedder` (`packages/llm/src/index.ts:60`) has no production caller. Recommended: keep memory's own switch, rewrite LLM-EMBED-004 as an `[x]` line describing it, and correct `config.example.yaml:18`.
2. **Who owns the transcript-tag / stop-string contract, and what enforces it?** The same invariant is LLM-STOP-006 here and WM-TRANS-006 in working-memory; the literals are hand-copied (`packages/llm/src/index.ts:45` vs `packages/working-memory/src/index.ts:93-95`) and no test imports both packages. Recommended: working-memory owns the tag list (it produces the lines), LLM-STOP-006 cites WM-TRANS-006, and a cortex-level test renders a transcript and asserts each line after the first begins with a stop.
3. **Is the stop list a correctness guard or a token saver?** `parseReply` keeps only the first reply line and strips a leading `Name:` (`services/cortex/src/prompt.ts:71-72`), so the spoken line is correct with or without stops; the self line `<name>: [<emotion>] text` is not a stop (`packages/working-memory/src/index.ts:96`) and OpenAI-style APIs cap stops at four (`index.ts:46`). Recommended: record the stops as a token/latency saver and `parseReply` as the guard; do not add a self-line stop.
4. **Must every mock-backed provider announce itself (LLM-MOCK-005)?** Cortex warns and reports `mode: mock` (`services/cortex/src/index.ts:27`, `:33`); `llm`-kind hooks (`packages/modules/src/index.ts:43`) and the reflect script (`services/memory/src/reflect.ts:17`) do not, and the salience/affect heartbeats hard-code `mode: "live"` (`services/salience/src/health.ts:4`, `services/affect/src/health.ts:4`). Recommended: keep the gap and warn once when a `Module` is built on a mock provider.
5. **Is a guaranteed hash-embedder similarity ordering required?** OpenSpec states shared tokens always score higher; with 64 signed buckets `dog cat`·`dog park` = 0.50 < `dog cat`·`fight` = 0.71 (`packages/llm/src/mock.ts:26-50`). LLM-EMBED-005 now states it as an expectation. Recommended: accept the expectation wording; it is a test stand-in.
6. **Should HTTP providers time out by default?** `chat()`/`ping()` on Ollama/OpenAI have no timeout unless the caller passes a signal (`index.ts:74`, `:112`, `:141`, `:162`), and cortex passes none (`services/cortex/src/cortex.ts:116`). No spec covers it. Recommended: add a spec and a config-driven default timeout in a later change.
7. **Is an always-`true` Bedrock ping acceptable (LLM-PING-004)?** `index.ts:250` reports a healthy `llm` dependency for bad credentials or an un-enabled model. Recommended: keep it, but say so in the cortex heartbeat `detail` when the provider is `bedrock`.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (43 specs, prefix LLM: 41 `[x]`, 2 `[ ]`, 0 `[D]`)

### Tests
- packages/llm/test/llm.test.ts (18 tests, 18 `@spec` lines citing 35 distinct LLM IDs; fake HTTP servers and a stubbed SDK client, no external network)

### Code
- packages/llm/src/index.ts (32 `@spec` lines)
- packages/llm/src/mock.ts (6 `@spec` lines; one also cites HOOK-FALLBACK-006)
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

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Interface and factory | LLM-IF-001 to LLM-IF-004 | 4 | 0 | 0 | 4 | 2 |
| Ollama and OpenAI chat | LLM-CHAT-001 to LLM-CHAT-007 | 7 | 0 | 0 | 7 | 5 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-006 | 6 | 0 | 0 | 6 | 5 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-010 | 10 | 0 | 0 | 10 | 9 |
| Health ping | LLM-PING-001 to LLM-PING-005 | 5 | 0 | 0 | 5 | 5 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 | 5 | 0 | 1 | 5 | 5 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-005 | 4 | 0 | 1 | 4 | 4 |

**Summary:** 41 of 43 specs implemented; 0 deferred; 2 gaps (LLM-EMBED-004, LLM-MOCK-005). 41 specs cited from code, 35 from tests. No reverse orphans. Implemented but without a test annotation: LLM-IF-001, LLM-IF-003 (structural), LLM-CHAT-001, LLM-CHAT-007, LLM-CLAUDE-009, LLM-STOP-006.

## Key Findings

1. **No marker was wrong.** Every `[x]` line matches the code; both `[ ]` lines are real gaps. Four lines were reworded to match code: LLM-EMBED-005 (the similarity ordering is not guaranteed; Question 5), LLM-PING-002 (now covers non-auth statuses and unreachable hosts, as the code does), LLM-CLAUDE-007 (field names checked against the installed SDK) and LLM-MOCK-005 (cortex warns at `services/cortex/src/index.ts:33`, not `:34`).
2. **Claude/Bedrock wire surface is typed by the installed SDK.** `server-side-fallback-2026-07-01`, `fallbacks: "default"`, `output_config` and `AnthropicBedrockMantle` all exist in the lockfile-pinned `@anthropic-ai/sdk` 1.1.0 and `@anthropic-ai/bedrock-sdk` 1.0.0 types, and `tsc -b` compiles the request; no test calls the live API. The registry has 1.3.0 / 1.1.0 inside the declared ranges.
3. **The stop-string contract has four parts in three segments** — working-memory renders the tags, cortex frames the prompt and parses the reply, this package sends the stops (LLD "Stop sequences and the transcript coupling"). `parseReply`'s first-line rule (`services/cortex/src/prompt.ts:72`) is what makes the spoken line correct; the stops only cut generation early. Nothing links the literals, and the invariant is specified twice (LLM-STOP-006, WM-TRANS-006).
4. **`createEmbedder` is unused by services** — memory picks its embedder from `brain.memory.embedder` (`services/memory/src/backend.ts:8`), which commit `51d5a9c` records as deliberate, contradicting LLM-EMBED-004 and `config/config.example.yaml:18` (Question 1).
5. **Mock is not reported everywhere** — only cortex warns and reports `mode: mock`; reflect and mock-backed hooks do not, and salience/affect heartbeats hard-code `live` (LLM-MOCK-005, Question 4).
6. **No request timeouts or retries** — Ollama/OpenAI `fetch` calls and both pings run without a timeout unless the caller passes a signal (`index.ts:74`, `:112`, `:141`, `:162`).
7. **Bedrock `ping` is always true** (`index.ts:250`), so a bad credential reads as a healthy `llm` dependency until the first chat fails.
8. **`opts.maxTokens` is a floor on Claude** (`index.ts:192`): hooks asking for 60-160 tokens get 2048, and `temperature` is ignored (`index.ts:198`).
9. **Weak or missing assertions** — see LLD Open Question 11: `llm.test.ts:33` checks only that the Ollama stop list includes `"\n\n"`; the Claude tests do not assert the absence of `temperature` or of `betas` when fallbacks are off; there is no Ollama ping success case and no Ollama chat body assertion.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so the many `index.ts:NN` citations in other segments' docs stay valid.

## Work Required

### Must Fix
1. Nothing is broken enough to block; the two `[ ]` specs are the only gaps (LLM-EMBED-004, LLM-MOCK-005), and LLM-EMBED-004's intent is disputed (Question 1).

### Should Fix
1. Settle the embedder rule and rewrite LLM-EMBED-004 accordingly; correct `config/config.example.yaml:18` (Question 1).
2. Warn at startup wherever a mock provider is built, including reflect and hooks (LLM-MOCK-005).
3. Add timeouts (or require a signal) for `chat()`/`ping()` on the HTTP providers (Question 6).
4. Settle ownership of the stop/tag contract and add one cross-package test (LLM-STOP-006, WM-TRANS-006; Question 2).

### Nice to Have
1. Tighten the weak assertions listed in Key Finding 9 and add tests for LLM-CHAT-001, LLM-CHAT-007 and LLM-CLAUDE-009.
2. Consider a cheap real Bedrock probe (LLM-PING-004).
3. Fix `examples/providers/README.md:86` (no `~/.aws` mount in compose) and `:96` (critic override path).
