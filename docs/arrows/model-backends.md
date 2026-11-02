# Arrow: model-backends

The `@cohost/llm` package: one `ChatProvider` interface over Ollama, OpenAI-compatible servers, the Claude API, Claude on Bedrock and an offline mock, plus the Ollama and hash embedders.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 44 specs: 42 implemented, 0 deferred, 2 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S17** mock provider vs hash embedder → memory keeps its own `MEMORY_EMBEDDER` switch; `config/config.example.yaml:18` gets corrected. Specs: LLM-EMBED-004 rewritten, `[ ]` → `[x]`.
2. **P10** tag/stop ownership → working-memory owns the tags; the stops mirror them; a cortex-level test checks the pair. Specs: LLM-STOP-006 reworded (cites WM-TRANS-006).
3. **P10** stops: guard or saver → token and latency saver; `parseReply` is the guard; the self line is not a stop. Specs: LLM-STOP-006.
4. **R5** mock announcement → each consumer that builds a mock provider warns once (cortex, hooks, reflect). Specs: LLM-MOCK-005 reworded (points at CTX-START-002, HOOK-WARN-004).
5. **S18** hash-embedder similarity → an expectation, not a guarantee. Specs: LLM-EMBED-005 (confirmed).
6. **R1** request timeouts → config-driven default timeout when the caller passes no signal. Specs: LLM-CHAT-008 (new).
7. **R4** Bedrock ping → stays always-true; cortex flags it in its heartbeat `detail`. Specs: LLM-PING-004 reworded; the heartbeat line is cortex's.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/model-backends/model-backends-design.md

### EARS
- docs/intent/model-backends/model-backends-specs.md (44 specs, prefix LLM: 42 `[x]`, 2 `[ ]`, 0 `[D]`)

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
| Ollama and OpenAI chat | LLM-CHAT-001 to LLM-CHAT-008 | 7 | 0 | 1 | 7 | 5 |
| Stop sequences | LLM-STOP-001 to LLM-STOP-006 | 6 | 0 | 0 | 6 | 5 |
| Claude providers | LLM-CLAUDE-001 to LLM-CLAUDE-010 | 10 | 0 | 0 | 10 | 9 |
| Health ping | LLM-PING-001 to LLM-PING-005 | 5 | 0 | 0 | 5 | 5 |
| Embeddings | LLM-EMBED-001 to LLM-EMBED-006 | 6 | 0 | 0 | 5 | 5 |
| Mock provider | LLM-MOCK-001 to LLM-MOCK-005 | 4 | 0 | 1 | 4 | 4 |

**Summary:** 42 of 44 specs implemented; 0 deferred; 2 gaps (LLM-CHAT-008, LLM-MOCK-005). 41 specs cited from code, 35 from tests. No reverse orphans. Implemented but without a code annotation: LLM-EMBED-004 (realized by memory's switch, `services/memory/src/backend.ts:8-10`). Implemented but without a test annotation: LLM-IF-001, LLM-IF-003 (structural), LLM-CHAT-001, LLM-CHAT-007, LLM-CLAUDE-009, LLM-STOP-006, LLM-EMBED-004.

## Key Findings

1. **Markers.** Every `[x]` line matches the code. Four lines were reworded to match code: LLM-EMBED-005 (the similarity ordering is not guaranteed; S18), LLM-PING-002 (now covers non-auth statuses and unreachable hosts, as the code does), LLM-CLAUDE-007 (field names checked against the installed SDK) and LLM-MOCK-005. LLM-EMBED-004 is now `[x]`: memory's own switch is the intended design (S17).
2. **Claude/Bedrock wire surface is typed by the installed SDK.** `server-side-fallback-2026-07-01`, `fallbacks: "default"`, `output_config` and `AnthropicBedrockMantle` all exist in the lockfile-pinned `@anthropic-ai/sdk` 1.1.0 and `@anthropic-ai/bedrock-sdk` 1.0.0 types, and `tsc -b` compiles the request; no test calls the live API. The registry has 1.3.0 / 1.1.0 inside the declared ranges.
3. **The stop-string contract has four parts in three segments** — working-memory renders the tags, cortex frames the prompt and parses the reply, this package sends the stops (LLD "Stop sequences and the transcript coupling"). `parseReply`'s first-line rule (`services/cortex/src/prompt.ts:76`) is what makes the spoken line correct; the stops only cut generation early (P10). working-memory owns the tags (WM-TRANS-006); LLM-STOP-006 mirrors them. No test links the literals yet; the cross-package check is a cortex-level test.
4. **`createEmbedder` is unused by services** — memory picks its embedder from `brain.memory.embedder` (`services/memory/src/backend.ts:9`), which commit `51d5a9c` records as deliberate and LLM-EMBED-004 now states; `config/config.example.yaml:18` still says mock means hash embeddings (S17).
5. **Mock is not reported everywhere** — only cortex warns and reports `mode: mock`; reflect and mock-backed hooks do not, and salience/affect heartbeats hard-code `live` (LLM-MOCK-005, R5).
6. **No request timeouts or retries** — Ollama/OpenAI `fetch` calls and both pings run without a timeout unless the caller passes a signal (`index.ts:74`, `:97`, `:112`, `:141`, `:162`) (LLM-CHAT-008, R1).
7. **Bedrock `ping` is always true** (`index.ts:250`), so a bad credential reads as a healthy `llm` dependency until the first chat fails; cortex is to say so in its heartbeat `detail` (R4).
8. **`opts.maxTokens` is a floor on Claude** (`index.ts:192`): hooks asking for 60-160 tokens get 2048, and `temperature` is ignored (`index.ts:198`).
9. **Weak or missing assertions** — see LLD Open Question 6: `llm.test.ts:33` checks only that the Ollama stop list includes `"\n\n"`; the Claude tests do not assert the absence of `temperature` or of `betas` when fallbacks are off; there is no Ollama ping success case and no Ollama chat body assertion.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so the many `index.ts:NN` citations in other segments' docs stay valid.

## Work Required

### Must Fix
1. Apply a config-driven default timeout to `chat()`, `embed()` and `ping()` when the caller passes no signal, and pass it to the Claude SDK (LLM-CHAT-008; R1).
2. Warn once when an `llm`-kind `Module` is built on the mock provider (HOOK-WARN-004, region-hooks) and when the reflect job builds one (memory); cortex already warns (LLM-MOCK-005; R5).

### Should Fix
1. Correct the `mock` comment at `config/config.example.yaml:18` to name the separate `MEMORY_EMBEDDER=hash` switch (LLM-EMBED-004; S17).
2. Fix `examples/providers/README.md:86`: Compose mounts no `~/.aws`, so document environment credentials (or an instance role) for Bedrock in Docker (S6, deployment DEPLOY-7); fix `:96`, whose override path `brain.<region>.module.llm` does not fit the critic (`brain.cortex.critic.llm`).
3. Optionally annotate `services/memory/src/backend.ts:8` with `@spec LLM-EMBED-004` (memory segment).

### Nice to Have
1. Tighten the weak assertions listed in Key Finding 9 and add tests for LLM-CHAT-001, LLM-CHAT-007 and LLM-CLAUDE-009.
2. The cortex-level stop/tag test (LLM-STOP-006, WM-TRANS-006) is owned by the cortex segment.
