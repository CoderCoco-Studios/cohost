# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); gap fixes applied 2026-11-02. 58 specs: 58 implemented, 0 deferred, 0 gaps.

## Planned: viewer notes (designed, not built)

Design: LLD § Viewer notes. The spec file now holds 66 specs: 56 `[x]`, 10 `[ ]`.

- Amended to `[ ]`: `CTX-EVT-001` (subscribe to `memory.notes.reply`), `CTX-VIEWER-001` (regular from memory's `regular` flag, no notes text, no literal 25).
- New `[ ]`: `CTX-NOTES-001` to `008` (notes requested per think for the replied-to viewer and the window's chat users, shared recall deadline, `## People here` block, sensitive notes as hint-only guidance, no subscriber status, no caching, no note text in logs).
- Lands in build chunk 3 (memory LLD § Build order). Owner decisions: sensitive notes reach the prompt as hint only; subscriber status is never rendered.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice), each with the spec that carries it.

1. **R4** Runtime `deps.llm` → every `llm.chat` outcome feeds it through `tracked()`. `CTX-HEALTH-003`.
2. **R1** Failed status publish on the early gates, and a rejected unawaited think → logged. `CTX-GATE-008`.
3. **B21** Raw model reply → logged at `debug`; timing and counts stay at `info`. `CTX-PROMPT-007`.
4. **P8** Restart replay → start mode `latest`. `CTX-EVT-001`.
5. **P7** Operator `say` → the override of mute, pause and busy. `CTX-CTRL-006`.
6. **S28** Speaking-timeout release → publish `idle` (or `muted`) when it fires. `CTX-GATE-009`.
7. **B10** Reply length → the llm critic enforces the prompt's one short spoken line. `CTX-CRITIC-006`.
8. **B9** Viewer note → deleted only after the reply's `brain.say` is published. `CTX-VIEWER-003`.
9. **S29** `forget_context` → also clears the last vision summary. `CTX-CTRL-004`.
10. **S30** Empty focus text → recall falls back to the vision summary. `CTX-RECALL-001`.
11. **P10** Tag/stop contract → working-memory owns the tags; a cortex-level test pins tags against the provider's stops. `CTX-PROMPT-008`.
12. **R4** Bedrock ping always true → the heartbeat `detail` says `llm` is not probed; `deps.llm` reads `n/a` until the first reply. `CTX-HEALTH-004`.
13. **R3** Readiness → `ready` once the `cortex` consumer group exists. `CTX-START-003`.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/cortex/cortex-design.md

### EARS
- docs/intent/cortex/cortex-specs.md (58 specs, prefix `CTX`: 57 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests (`@spec` lines per file; 55 lines citing 56 distinct IDs)
- services/cortex/test/cortex.region.test.ts (31)
- services/cortex/test/cortex.test.ts (1)
- services/cortex/test/critic.test.ts (5)
- services/cortex/test/prompt.test.ts (6)
- services/cortex/test/mock.test.ts (3)
- services/cortex/test/health.test.ts (5)
- services/cortex/test/startup.test.ts (3)
- services/cortex/test/transcript-stops.test.ts (1)

### Code (`@spec` lines per file; 46 lines citing 57 IDs)
- services/cortex/src/index.ts (4)
- services/cortex/src/startup.ts (3)
- services/cortex/src/cortex.ts (32)
- services/cortex/src/prompt.ts (4)
- services/cortex/src/critic.ts (2)
- services/cortex/src/health.ts (1)
- services/cortex/package.json
- services/cortex/tsconfig.json

### OpenSpec (retired, reference only)
- openspec/specs/cortex/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/cortex/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/cortex/spec.md
- openspec/changes/archive/2026-11-01-add-service-control/specs/cortex/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/cortex/spec.md

## Architecture

**Purpose:** Decide what to say once salience has decided to speak: gather working memory, mood, viewer notes and recalled memories, ask the LLM, filter through the critic hook, publish the line and track speaking state.

**Key Components:**
1. `cortex.ts` — `Cortex` class: event handling, think pipeline, `brain.status` state machine (`idle`/`thinking`/`speaking`/`muted`), recall request/reply, control commands, speaking-release logic.
2. `prompt.ts` — `buildMessages` (system + user prompt) and `parseReply` (emotion/gesture tags).
3. `critic.ts` — `cortex.critic` `Module` hook (rules pass-through, llm or http veto/rewrite).
4. `startup.ts` — `waitForLlm` ping loop (infinite, reports degraded), `startCortex` (idle, group reset, subscribe at `latest`, then `ready`), `trackLlm` (every `chat` outcome feeds `deps.llm`).
5. `health.ts` — heartbeat spec (`mode`, `deps.llm`).
6. `index.ts` — wiring: bus, heartbeat, provider, critic, `startCortex`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Event handling | CTX-EVT-001 to CTX-EVT-007 | 7 | 0 | 0 | 7 |
| Think gating | CTX-GATE-001 to CTX-GATE-009 | 9 | 0 | 0 | 9 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 5 | 0 | 0 | 4 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-003 | 3 | 0 | 0 | 3 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-008 | 8 | 0 | 0 | 8 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-006 | 6 | 0 | 0 | 6 |
| Saying | CTX-SAY-001 to CTX-SAY-004 | 4 | 0 | 0 | 4 |
| Control | CTX-CTRL-001 to CTX-CTRL-006 | 6 | 0 | 0 | 6 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 2 | 0 | 0 | 2 |
| Startup and shutdown | CTX-START-001 to CTX-START-004 | 4 | 0 | 0 | 3 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-004 | 4 | 0 | 0 | 4 |

**Summary:** 58 of 58 specs implemented and annotated in code; 0 deferred; 0 gaps. `CTX-HEALTH-004` rides on the standing `detail` option of `startHeartbeat` (`packages/bus/src/heartbeat.ts`); `deps.llm` is `n/a` for a provider whose ping is nominal (Bedrock) until the first reply.

## Key Findings

1. **Status publishes are guarded** — the three early gates log a failed `brain.status` publish (`statusLogged`, `cortex.ts:168-170`), and the unawaited think logs a rejection (`cortex.ts:67`).
2. **Speaking release is published** — `startSpeaking` (`cortex.ts:184-197`) arms a timer that publishes `idle`/`muted` when `speaking_timeout_ms` elapses without `voice.done`; `voiceBusy()` (`cortex.ts:178-181`) keeps the lazy check.
3. **Readiness follows the group** — `startCortex` (`startup.ts:55-60`) awaits `Bus.resetGroup("cortex")` before it subscribes at start mode `latest` and reports `ready`.
4. **`deps.llm` follows replies** — `trackLlm` (`startup.ts:64-73`) wraps `llm.chat` in `tracked()`; `index.ts:27-32` owns `llmOk` and `llmProbed`.
5. **Viewer notes are consumed after the say** — `say()` calls `onPublished` once `brain.say` is out (`cortex.ts:156-158`, `cortex.ts:221-227`); a newer note is never deleted by an older reply.
6. **Raw LLM text is `debug` only** — `cortex.ts:139-140`.
7. **Tag/stop contract is pinned** — `transcript-stops.test.ts` captures the stop list the Ollama and OpenAI-compatible providers send (`TRANSCRIPT_STOPS` is not exported) and checks it against `TRANSCRIPT_TAGS` and the rendered transcript.
8. **`forget_context` resets `lastVision` in the cortex** (`cortex.ts:104`), independent of `Context.clear`.
9. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` (`cortex.ts:54`) ties behaviour to `new Bus("cortex")` at `index.ts:25`.
10. **Critic misconfiguration fails at import** — the `Module` constructor throws for an unusable critic config (`packages/modules/src/index.ts:41-48`) while `index.ts:33` runs, outside `main()`'s `fatal` handler (`index.ts:46`).
11. **Test coverage** — `index.ts` itself is untested (its startup logic is tested through `startCortex`); `cortex.test.ts` covers only `parseReply`; the 50-entry viewer cap, the `recall_k <= 0` skip and the operator-`say` gate bypass have no assertion.

## Work Required

### Must Fix
None.

### Nice to Have
2. Assert the operator-`say` gate bypass in a test (`CTX-CTRL-006`).
3. Name the "regular" threshold (25) and the 50-note cap as constants (`CTX-VIEWER-001`, `CTX-VIEWER-002`).
4. Add tests for the viewer cap and the `recall_k <= 0` skip (`CTX-VIEWER-002`, `CTX-RECALL-002`).
