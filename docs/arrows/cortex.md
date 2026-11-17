# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**AUDITED** (date and commit in `index.yaml`). The spec file holds 124 specs: 78 `[x]`, 45 `[ ]`, 1 `[D]` (CTX-REPLAN-001, dynamic speech). The gaps are the chat safety work (below). The LLD has open questions (a stop while a think is in flight; streamed replies and the checks after parsing; a repeat on a mention).

## Spoken fallback line

Design: LLD § Fallback acknowledgement. The transcript marks a line replaced by a fallback; the next reply gets a hint stating the base chance (`brain.cortex.fallback_ack_chance`, 0.25) and the model decides in character; nothing enforces the rate, so it drifts. `CTX-EVT-008`, `CTX-FALL-001` to `007`. `voice.failed` is subscribed in `startup.ts`; `cortex.ts` keeps the pending glitch and consumes it when the reply that carried its hint is published; `prompt.ts` renders the one `## Now` line (`glitchLine`).

## Viewer notes

Design: LLD § Viewer notes. `CTX-VIEWER-001` to `003` (familiarity line from memory's `regular` flag) and `CTX-NOTES-001` to `008` (`fetchNotes` in `cortex.ts`, requested in parallel with recall under one deadline; `peopleBlock` in `prompt.ts`).

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

## Barge-in and echo gate

CTX-EVT-010 (end pending lines on `voice.stop`), CTX-GATE-010 (no abort) and CTX-GATE-011 (late interrupted `voice.done` ignored) are `[x]`; CTX-REPLAN-001 is `[D]`. Design: LLD § Interruption and the HLD's Barge-in and echo gate protocol.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/cortex/cortex-design.md

### EARS
- docs/intent/cortex/cortex-specs.md (124 specs, prefix `CTX`: 78 `[x]`, 45 `[ ]`, 1 `[D]`)

### Tests (files carrying `@spec CTX-`)
- services/cortex/test/cortex.region.test.ts
- services/cortex/test/cortex.dispositions.test.ts
- services/cortex/test/cortex.stop.test.ts
- services/cortex/test/cortex.test.ts
- services/cortex/test/critic.test.ts
- services/cortex/test/fallback.test.ts
- services/cortex/test/health.test.ts
- services/cortex/test/main.test.ts
- services/cortex/test/mock.test.ts
- services/cortex/test/partial.test.ts
- services/cortex/test/prompt.test.ts
- services/cortex/test/startup.test.ts
- services/cortex/test/timing.test.ts
- services/cortex/test/transcript-stops.test.ts

### Code (files carrying `@spec CTX-`)
- services/cortex/src/cortex.ts
- services/cortex/src/critic.ts
- services/cortex/src/health.ts
- services/cortex/src/main.ts
- services/cortex/src/prompt.ts
- services/cortex/src/startup.ts
- services/cortex/package.json
- services/cortex/tsconfig.json

## Architecture

**Purpose:** Decide what to say once salience has decided to speak: gather working memory, mood, viewer notes and recalled memories, ask the LLM, filter through the critic hook, publish the line and track speaking state.

**Key Components:**
1. `cortex.ts` — `Cortex` class: event handling, think pipeline, `brain.status` state machine (`idle`/`thinking`/`speaking`/`muted`), recall request/reply, control commands, speaking-release logic.
2. `prompt.ts` — `buildMessages` (system + user prompt) and `parseReply` (emotion/gesture tags).
3. `critic.ts` — `cortex.critic` `Module` hook (rules pass-through, llm or http veto/rewrite).
4. `startup.ts` — `waitForLlm` ping loop (infinite, reports degraded), `startCortex` (idle, group reset, subscribe at `latest`, then `ready`), `trackLlm` (every `chat` outcome feeds `deps.llm`).
5. `health.ts` — heartbeat spec (`mode`, `deps.llm`); `main.ts` adds the critic hook's `hook.cortex.critic` dependency and pings it (`CTX-HEALTH-006`, `CTX-HEALTH-007`).
6. `main.ts` — `cortexMain` on the shared `runService` bootstrap: provider, critic, `Cortex`, `waitForLlm`, `startCortex`; `index.ts` only calls `runCortex()`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event handling | CTX-EVT-001 to CTX-EVT-012 | 9 | 0 | 3 |
| Think gating | CTX-GATE-001 to CTX-GATE-013 | 10 | 0 | 3 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 5 | 0 | 0 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-004 | 2 | 0 | 2 |
| Viewer notes from memory | CTX-NOTES-001 to CTX-NOTES-010 | 7 | 0 | 3 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-015 | 6 | 0 | 9 |
| Fallback acknowledgement | CTX-FALL-001 to CTX-FALL-007 | 6 | 0 | 1 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-013 | 4 | 0 | 9 |
| Saying | CTX-SAY-001 to CTX-SAY-008 | 8 | 0 | 0 |
| Control | CTX-CTRL-001 to CTX-CTRL-007 | 7 | 0 | 0 |
| Interruptible speech | CTX-REPLAN-001 | 0 | 1 | 0 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 2 | 0 | 0 |
| Startup and shutdown | CTX-START-001 to CTX-START-005 | 5 | 0 | 0 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-007 | 7 | 0 | 0 |
| Repetition check | CTX-REPEAT-001 to CTX-REPEAT-015 | 0 | 0 | 15 |

**Summary:** 124 specs: 78 implemented, 1 deferred, 45 gaps.

## Key Findings

1. **Status publishes are guarded** — the three early gates log a failed `brain.status` publish (`statusLogged` in `cortex.ts`), and the unawaited think logs a rejection.
2. **Speaking release is published** — `startSpeaking` in `cortex.ts` arms a timer that publishes `idle`/`muted` when `speaking_timeout_ms` elapses without `voice.done`; `voiceBusy()` keeps the lazy check.
3. **Readiness follows the group** — `startCortex` in `startup.ts` awaits `Bus.resetGroup("cortex")` before it subscribes at start mode `latest` and reports `ready`.
4. **`deps.llm` follows replies** — `trackLlm` in `startup.ts` wraps `llm.chat` in `tracked()`; `main.ts` owns `llmOk` and `llmProbed`.
5. **Viewer notes are consumed after the say** — `say()` calls `onPublished` once `brain.say` is out; a newer note is never deleted by an older reply.
6. **Raw LLM text is `debug` only** (`cortex.ts`).
7. **Tag/stop contract is pinned** — `transcript-stops.test.ts` captures the stop list the Ollama and OpenAI-compatible providers send (`TRANSCRIPT_STOPS` is not exported) and checks it against `TRANSCRIPT_TAGS` and the rendered transcript.
8. **`forget_context` relies on `Context.clear`** — the cortex calls `ctx.clear()`, which also resets `lastVision` (working-memory).
9. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` in `cortex.ts` ties behaviour to `new Bus("cortex")` built by the bootstrap.
10. **Critic misconfiguration fails through the bootstrap** — the `Module` constructor throws for an unusable critic config (`packages/modules/src/index.ts`) while `cortexMain` builds the critic, so it takes the `fatal` path and exits 1 (`CTX-START-005`).

## Work Required

### Must Fix
The repetition check, the no-line exit status, parsed critic rewrites, the guarded prompt (names, recalled memories, viewer notes, notice) and heard-text records are specified and not built (CTX-REPEAT-001 to CTX-REPEAT-015, CTX-GATE-012, CTX-CRITIC-002, CTX-CRITIC-003, CTX-CRITIC-007 to CTX-CRITIC-011, CTX-PROMPT-002, CTX-PROMPT-006, CTX-PROMPT-009 to CTX-PROMPT-015, CTX-EVT-005, CTX-EVT-011, CTX-EVT-012, CTX-FALL-007, CTX-NOTES-004, CTX-NOTES-009, CTX-NOTES-010, CTX-VIEWER-004). The LLD has three open questions: a stop during a think, streamed replies and the checks after parsing, and a repeat on a mention.

### Nice to Have
None.
