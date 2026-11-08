# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 46 specs: 46 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below; the timeout and Bedrock-ping fixes have landed (platform-models cascade fix).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S17** mock provider vs hash embedder → memory keeps its own `MEMORY_EMBEDDER` switch; `config/config.example.yaml:18` gets corrected. Specs: LLM-EMBED-004 rewritten, `[ ]` → `[x]`.
2. **P10** tag/stop ownership → working-memory owns the tags; the stops are derived from working-memory's exported `TRANSCRIPT_TAGS`; a cortex-level test checks the pair. Specs: LLM-STOP-006 (cites WM-TRANS-006), LLM-STOP-007 (cites WM-TRANS-009; implemented).
3. **P10** stops: guard or saver → token and latency saver; `parseReply` is the guard; the self line is not a stop. Specs: LLM-STOP-006.
4. **R5** mock announcement → each consumer that builds a mock provider warns once (cortex, hooks, reflect). Specs: LLM-MOCK-005 (points at CTX-START-002, HOOK-WARN-004; hooks and the reflect job all warn).
5. **S18** hash-embedder similarity → an expectation, not a guarantee. Specs: LLM-EMBED-005 (confirmed).
6. **R1** request timeouts → config-driven default timeout when the caller passes no signal. Specs: LLM-CHAT-008.
7. **R4** Bedrock ping → stays always-true; cortex flags it in its heartbeat `detail`. Specs: LLM-PING-004, LLM-PING-006 (`pingIsNominal`); the heartbeat line is cortex's (CTX-HEALTH-004).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (46 specs, prefix LLM: 44 `[x]`, 2 `[ ]`, 0 `[D]`)

### Tests
- packages/llm/test/llm.test.ts (23 tests, 23 `@spec` lines citing 37 distinct LLM IDs; fake HTTP servers, including a black-hole server for the timeout tests, and a stubbed SDK client, no external network)

### Code
- packages/llm/src/index.ts (41 `@spec` lines)
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
1. `ChatProvider` / `Embedder` / `ChatOptions` (`index.ts:22-44`) - the contract; `json: true` means "no stop sequences".
2. `createChatProvider` / `createEmbedder` (`index.ts:61-75`) - the factory switch over `llm.provider`.
3. `Ollama` (`index.ts:80`) - chat, embeddings and ping against a local Ollama.
4. `OpenAICompatible` (`index.ts:138`) - `/chat/completions` and `/models`, optional bearer key.
5. `ClaudeBase` / `AnthropicProvider` / `BedrockProvider` (`index.ts:190-265`) - shared Claude request building (system join, `(begin)` turn, token floor, effort, refusal, optional server-side fallbacks).
6. `TRANSCRIPT_STOPS` / `REPLY_STOPS` (`index.ts:47-49`) - truncation lists implicitly coupled to working-memory transcript tags.
7. `MockProvider` / `HashEmbedder` (`mock.ts`) - deterministic offline backends for isolated runs.

Consumers: cortex (`services/cortex/src/index.ts:28`), memory (`services/memory/src/backend.ts`, `reflect.ts`), and the `Module` runner in region-hooks (`packages/modules/src/index.ts:43`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Interface and factory | LLM-IF-001 to LLM-IF-004 | 4 | 0 | 0 | 4 | 2 |
| Ollama and OpenAI chat | LLM-CHAT-001 to LLM-CHAT-008 | 8 | 0 | 0 | 8 | 6 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-007 | 7 | 0 | 0 | 7 | 6 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-010 | 10 | 0 | 0 | 10 | 9 |
| Health ping | LLM-PING-001 to LLM-PING-006 | 6 | 0 | 0 | 6 | 6 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 | 6 | 0 | 0 | 5 | 5 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-005 | 5 | 0 | 0 | 5 | 5 |

**Summary:** 46 of 46 specs implemented; 0 deferred; 0 gaps. 46 specs cited from code (LLM-EMBED-004 is annotated at memory's switch, `services/memory/src/backend.ts:6`), 39 from tests. No reverse orphans. Implemented but without a test annotation: LLM-IF-001, LLM-IF-003 (structural), LLM-CHAT-001, LLM-CHAT-007, LLM-CLAUDE-009, LLM-STOP-006, LLM-EMBED-004.

## Key Findings

1. **Markers.** Every `[x]` line matches the code. Four lines were reworded to match code: LLM-EMBED-005 (the similarity ordering is not guaranteed; S18), LLM-PING-002 (now covers non-auth statuses and unreachable hosts, as the code does), LLM-CLAUDE-007 (field names checked against the installed SDK) and LLM-MOCK-005. LLM-EMBED-004 is now `[x]`: memory's own switch is the intended design (S17).
2. **Claude/Bedrock wire surface is typed by the installed SDK.** `server-side-fallback-2026-07-01`, `fallbacks: "default"`, `output_config` and `AnthropicBedrockMantle` all exist in the lockfile-pinned `@anthropic-ai/sdk` 1.1.0 and `@anthropic-ai/bedrock-sdk` 1.0.0 types, and `tsc -b` compiles the request; no test calls the live API. The registry has 1.3.0 / 1.1.0 inside the declared ranges.
3. **The stop-string contract has four parts in three segments** — working-memory renders the tags, cortex frames the prompt and parses the reply, this package sends the stops (LLD "Stop sequences and the transcript coupling"). `parseReply`'s first-line rule (`services/cortex/src/prompt.ts:76`) is what makes the spoken line correct; the stops only cut generation early (P10). working-memory owns the tags (WM-TRANS-006); LLM-STOP-007 makes the stops derive from the export (`TRANSCRIPT_TAGS`, WM-TRANS-009), and `@cohost/llm` depends on `@cohost/working-memory`. `llm.test.ts:34` pins the derivation; the cross-package check is a cortex-level test.
4. **`createEmbedder` is unused by services** — memory picks its embedder from `brain.memory.embedder` (`services/memory/src/backend.ts:9`), which commit `51d5a9c` records as deliberate and LLM-EMBED-004 now states; `config/config.example.yaml:18` still says mock means hash embeddings (S17).
5. **Mock is reported by cortex and by hooks** — cortex warns and reports `mode: mock`; `llm`-kind hooks warn once at construction (HOOK-WARN-004) and so does the reflect job (MEM-REFLECT-010); salience/affect heartbeats hard-code `live` (LLM-MOCK-005, R5).
6. **Requests are bounded; there are no retries** — Ollama/OpenAI `fetch` calls and both pings take `AbortSignal.timeout(llm.timeout_ms)` when the caller passes no signal, and the Claude path passes the SDK `timeout` request option (`requestSignal`, `index.ts:59`; LLM-CHAT-008, R1). The package falls back to 60000 when the config object has no `timeout_ms`. The Claude SDK keeps its own retry behaviour.
7. **Bedrock `ping` is always true** (`index.ts:264`), so a bad credential reads as a healthy `llm` dependency until the first chat fails; the provider now exposes `pingIsNominal = true` (LLM-PING-006) for cortex to say so in its heartbeat `detail` (R4, CTX-HEALTH-004).
8. **`opts.maxTokens` is a floor on Claude** (`index.ts:205`): hooks asking for 60-160 tokens get 2048, and `temperature` is ignored (`index.ts:211`).
9. **Weak or missing assertions** — see LLD Open Question 6: `llm.test.ts:33` checks only that the Ollama stop list includes `"\n\n"`; the Claude tests do not assert the absence of `temperature` or of `betas` when fallbacks are off; there is no Ollama ping success case and no Ollama chat body assertion.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so most `index.ts:NN` citations in other segments' docs stay valid; the timeout and `pingIsNominal` changes added about 14 lines to `packages/llm/src/index.ts`, so citations to code after line 38 in other segments' docs may be off by up to that much.

## Work Required

### Must Fix
None.

### Should Fix
1. Correct the `mock` comment at `config/config.example.yaml:18` to name the separate `MEMORY_EMBEDDER=hash` switch (LLM-EMBED-004; S17; config segment).
2. Fix `examples/providers/README.md:86`: Compose mounts no `~/.aws`, so document environment credentials (or an instance role) for Bedrock in Docker (S6, deployment DEPLOY-7); fix `:96`, whose override path `brain.<region>.module.llm` does not fit the critic (`brain.cortex.critic.llm`).
3. Cortex reads `pingIsNominal` to flag the unprobed Bedrock dependency in its heartbeat `detail` (CTX-HEALTH-004; cortex segment).

### Nice to Have
1. Tighten the weak assertions listed in Key Finding 9 and add tests for LLM-CHAT-001, LLM-CHAT-007 and LLM-CLAUDE-009.
2. The cortex-level stop/tag test (LLM-STOP-006, WM-TRANS-006) is owned by the cortex segment.
