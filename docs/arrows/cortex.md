# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 58 specs: 46 implemented, 0 deferred, 12 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **R4** Runtime `deps.llm` → every `llm.chat` outcome feeds it through `tracked()`. Specs: `CTX-HEALTH-003` (reworded).
2. **R1** Failed status publish on the early gates → logged, the think returns. Specs: `CTX-GATE-008` (reworded).
3. **B21** Raw model reply → logged at `debug`; timing and counts stay at `info`. Specs: `CTX-PROMPT-007` (`[x]` → `[ ]`).
4. **P8** Restart replay → start mode `latest`: the `cortex` group is reset to `$` on every start. Specs: `CTX-EVT-001` (`[x]` → `[ ]`).
5. **P7** Operator `say` → kept as the override of mute, pause and busy; only cortex and salience see mute and pause. Specs: `CTX-CTRL-006` (reworded, stays `[x]`).
6. **S28** Speaking-timeout release → publish `idle` (or `muted`) when it fires. Specs: `CTX-GATE-009` (new).
7. **B10** Reply length → the llm critic enforces the prompt's one short spoken line. Specs: `CTX-CRITIC-006` (`[x]` → `[ ]`).
8. **B9** Viewer note → deleted only after the reply's `brain.say` is published. Specs: `CTX-VIEWER-003` (`[x]` → `[ ]`).
9. **S29** `forget_context` → also clears the last vision summary; mood and pending recalls stay. Specs: `CTX-CTRL-004` (`[x]` → `[ ]`; working-memory `WM-WIN-003`).
10. **S30** Empty focus text → recall falls back to the vision summary. Specs: `CTX-RECALL-001` (`[x]` → `[ ]`).
11. **P10** Tag/stop contract → working-memory owns the tags, stops are a token saver, the self line is not a stop, a cortex-level test pins tags against stops. Specs: `CTX-PROMPT-008` (new).
12. **R4** Bedrock ping always true → the cortex heartbeat `detail` says `llm` is not probed. Specs: `CTX-HEALTH-004` (new).
13. **R3** Readiness → `ready` once the `cortex` consumer group exists. Specs: `CTX-START-003` (`[x]` → `[ ]`).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/cortex/cortex-design.md

### EARS
- docs/intent/cortex/cortex-specs.md (58 specs, prefix `CTX`: 46 `[x]`, 12 `[ ]`, 0 `[D]`)

### Tests (`@spec` lines per file; 42 lines citing 47 distinct IDs)
- services/cortex/test/cortex.region.test.ts (25)
- services/cortex/test/cortex.test.ts (1)
- services/cortex/test/critic.test.ts (4)
- services/cortex/test/prompt.test.ts (6)
- services/cortex/test/mock.test.ts (3)
- services/cortex/test/health.test.ts (3)

### Code (`@spec` lines per file; 40 lines citing 53 IDs: the 46 implemented plus the 7 former `[x]` lines now `[ ]`)
- services/cortex/src/index.ts (4)
- services/cortex/src/startup.ts (1)
- services/cortex/src/cortex.ts (28)
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
4. `startup.ts` — `waitForLlm` ping loop (infinite, reports degraded).
5. `health.ts` — heartbeat spec (`mode`, `deps.llm`).
6. `index.ts` — wiring: bus, heartbeat, provider, subscription list.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Event handling | CTX-EVT-001 to CTX-EVT-007 | 6 | 0 | 1 (EVT-001) | 6 |
| Think gating | CTX-GATE-001 to CTX-GATE-009 | 7 | 0 | 2 (GATE-008, 009) | 7 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 4 | 0 | 1 (RECALL-001) | 4 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-003 | 2 | 0 | 1 (VIEWER-003) | 3 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-008 | 6 | 0 | 2 (PROMPT-007, 008) | 6 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-006 | 5 | 0 | 1 (CRITIC-006) | 5 |
| Saying | CTX-SAY-001 to CTX-SAY-004 | 4 | 0 | 0 | 4 |
| Control | CTX-CTRL-001 to CTX-CTRL-006 | 5 | 0 | 1 (CTRL-004) | 6 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 2 | 0 | 0 | 2 |
| Startup and shutdown | CTX-START-001 to CTX-START-004 | 3 | 0 | 1 (START-003) | 2 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-004 | 2 | 0 | 2 (HEALTH-003, 004) | 2 |

**Summary:** 46 of 58 specs implemented and annotated in code; 0 deferred; 12 gaps (`CTX-EVT-001`, `CTX-GATE-008`, `CTX-GATE-009`, `CTX-RECALL-001`, `CTX-VIEWER-003`, `CTX-PROMPT-007`, `CTX-PROMPT-008`, `CTX-CRITIC-006`, `CTX-CTRL-004`, `CTX-START-003`, `CTX-HEALTH-003`, `CTX-HEALTH-004`). Seven gaps are former `[x]` lines whose intent changed (`CTX-EVT-001`, `CTX-RECALL-001`, `CTX-VIEWER-003`, `CTX-PROMPT-007`, `CTX-CRITIC-006`, `CTX-CTRL-004`, `CTX-START-003`); their existing code annotations stay and the fix lands under the same ID. 47 spec lines have a test annotated with `@spec` (the "With test" column; the tests on `CTX-RECALL-001`, `CTX-VIEWER-003` and `CTX-CTRL-004` pin today's behaviour and change with the fix). Implemented specs with no test: `CTX-RECALL-002`, `CTX-START-004`. No `@spec` annotation cites a missing ID.

## Key Findings

1. **Markers verified at audit** — every `[x]` line had implementing code; both original `[ ]` gaps were confirmed absent (`cortex.ts:119-121`; `index.ts:36` is the only writer of `llmOk`).
2. **`deps.llm` never changes after startup** — `llmOk` is written only by `waitForLlm` (`index.ts:26,36`; `startup.ts:24`), so the heartbeat reports `ready`/`llm: ok` forever even when `think` fails against a dead backend (`cortex.ts:154-156`). Commit `691b079` review notes: "cortex `llm` dep reflects the startup ping only". R4, `CTX-HEALTH-003`.
3. **Unawaited think can raise an unhandled rejection** — `void this.think(...)` (`cortex.ts:65`) and early-gate `await this.status("muted"|"speaking")` outside the `try` (`cortex.ts:119-121`); only the `thinking` branch has `.catch` (`cortex.ts:117`), and no process-level `unhandledRejection` handler exists. R1, `CTX-GATE-008`.
4. **Raw LLM text logged at info** — `log.info({ ms, reason, memories, raw }, "llm reply")` on every reply (`cortex.ts:138`), before the critic has seen it. B21, `CTX-PROMPT-007`.
5. **Restarts replay stale focuses** — a plain restart resumes the `cortex` group and processes old `attention.focus` events; only a first start or a control-plane `fresh` start (the manifest default, `packages/control/src/manifest.ts:44`) skips them. P8, `CTX-EVT-001`.
6. **Operator `say` bypasses every gate, by design** — no mute, pause or busy check, overwrites `speakingId` (`cortex.ts:106`, `cortex.ts:189-195`). P7, `CTX-CTRL-006`.
7. **Speaking release is internal only** — `voiceBusy()` clears `speakingId` after `speaking_timeout_ms` (`cortex.ts:168-171`) but `brain.status` stays `speaking` until the next think publishes something. S28, `CTX-GATE-009`.
8. **Inconsistent length rules** — prompt "ONE short spoken line" (`prompt.ts:37`) vs llm critic "longer than two sentences" (`critic.ts:38`). B10, `CTX-CRITIC-006`.
9. **Viewer note is consumed before success** — deleted at `cortex.ts:130-132`, so a vetoed, dropped or failed reply loses that viewer's one-shot note; "regular" is a bare literal `> 25` (`cortex.ts:78`) applied to counts that the memory region's Postgres store reports one low (memory `MEM-VIEWER-001`). B9, `CTX-VIEWER-003`.
10. **`forget_context` keeps the vision summary** — `Context.clear` leaves `lastVision` (`packages/working-memory/src/index.ts:81-83`). S29, `CTX-CTRL-004`.
11. **Tag/stop literals are copied by hand** — `packages/working-memory/src/index.ts:93-95` vs `packages/llm/src/index.ts:45`; no test imports both. P10, `CTX-PROMPT-008`.
12. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` (`cortex.ts:52`) ties behaviour to `new Bus("cortex")` at `index.ts:25`.
13. **Critic misconfiguration fails at import** — the `Module` constructor throws for an unusable critic config (`packages/modules/src/index.ts:41-48`) while `index.ts:29` runs, outside `main()`'s `fatal` handler (`index.ts:55`).
14. **Decision rationale** — the LLD's Decisions table cites a code comment or commit for 8 original rows, records the owner's 2026-11-01 decisions in 12 rows (2 of them, operator `say` and viewer-note deletion, replacing `[inferred]`), and leaves 1 row `[inferred]` (own-vs-other by source) plus 2 partly `[inferred]` (single flight, the 50-note cap).
15. **Test coverage** — `index.ts` wiring is untested; `cortex.test.ts` covers only `parseReply`; the 50-entry viewer cap, the `recall_k <= 0` skip and the operator-`say` gate bypass have no assertion.

## Work Required

### Must Fix
1. Feed every `llm.chat` outcome into `deps.llm` with `tracked()` (`CTX-HEALTH-003`, R4).
2. Log and absorb status-publish failures on the early gate paths (`CTX-GATE-008`, R1).
3. Subscribe with the bus's explicit start mode `latest` once event-bus provides it (`CTX-EVT-001`, P8).
4. Report `ready` only once the `cortex` consumer group exists (`CTX-START-003`, R3).
5. Delete the viewer note only after `say()` succeeds (`CTX-VIEWER-003`, B9).
6. Align the llm critic's length rule with the prompt (`CTX-CRITIC-006`, B10).
7. Log the raw reply at `debug` (`CTX-PROMPT-007`, B21).
8. Flag the unprobed Bedrock `llm` dependency in the heartbeat `detail` (`CTX-HEALTH-004`, R4).

### Should Fix
9. Publish `idle`/`muted` when the speaking timeout fires (`CTX-GATE-009`, S28).
10. Clear the vision summary on `forget_context`, with working-memory (`CTX-CTRL-004`, `WM-WIN-003`, S29).
11. Fall back to the vision summary when the focus text is empty (`CTX-RECALL-001`, S30).
12. Add the cortex-level tag/stop test (`CTX-PROMPT-008`, P10).

### Nice to Have
13. Assert the operator-`say` gate bypass in a test (`CTX-CTRL-006`).
14. Name the "regular" threshold (25) and the 50-note cap as constants (`CTX-VIEWER-001`, `CTX-VIEWER-002`).
15. Add tests for `index.ts` wiring, the viewer cap and the `recall_k <= 0` skip (`CTX-EVT-001`, `CTX-VIEWER-002`, `CTX-RECALL-002`).
