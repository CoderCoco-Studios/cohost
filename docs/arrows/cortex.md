# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet marked audited in `index.yaml`. Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **Should `deps.llm` follow the backend at runtime?** `llmOk` is written only by `waitForLlm` (`services/cortex/src/index.ts:26`, `index.ts:36`; `services/cortex/src/startup.ts:24`), so after `ready` the heartbeat says `llm: ok` while `think` fails (`services/cortex/src/cortex.ts:154-156`); commit `691b079` noted this at merge and `health.ts:4` claims it follows the last ping (`CTX-HEALTH-003`). Recommended: yes; feed each `llm.chat` outcome into `llmOk` with `tracked()`.
2. **Should a failed status publish on the early gates be absorbed?** `cortex.ts:119` and `cortex.ts:121` await `status()` outside any `try` while `think` runs un-awaited (`cortex.ts:65`); no `unhandledRejection` handler exists, so Node exits on such a rejection (`CTX-GATE-008`). Recommended: yes; add `.catch(() => {})` as on `cortex.ts:117`.
3. **Should the raw model reply be logged at `info`?** `cortex.ts:138` logs `raw` on every reply, before the critic has seen it (`CTX-PROMPT-007`). Recommended: move `raw` to `debug`, keep timing and counts at `info`.
4. **Should a plain restart replay stale `attention.focus` events?** `fromNow` only applies when the group is created (`packages/bus/src/index.ts:126-131`); the control plane's default `fresh` start resets the group (`packages/control/src/manifest.ts:43`), but a crash or container restart replays the backlog and can answer old focuses (`CTX-EVT-001`). Recommended: no; reset the `cortex` group to `$` (or drop old focuses) on every start.
5. **Is operator `say` meant to ignore mute, pause and a playing line?** `cortex.ts:106` calls `say()` directly and overwrites `speakingId` (`cortex.ts:189-195`; `CTX-CTRL-006`). Recommended: yes, keep it as the operator override and record that as a decision.
6. **Should the speaking timeout publish a status?** When `speaking_timeout_ms` clears `speakingId` (`cortex.ts:168-171`), `brain.status` stays `speaking` until the next think (`CTX-GATE-004`). Recommended: yes; publish `idle` (or `muted`) when the timeout releases the voice.
7. **Which reply-length rule wins?** The prompt asks for "ONE short spoken line" (`services/cortex/src/prompt.ts:37`); the llm critic blocks lines "longer than two sentences" (`services/cortex/src/critic.ts:38`; `CTX-CRITIC-006`). Recommended: align the critic to the prompt's one short line.
8. **Should a viewer note survive a vetoed, dropped or failed reply?** It is deleted before the LLM call (`cortex.ts:130-132`; `CTX-VIEWER-003`). Recommended: delete it only after `say()` succeeds.
9. **Should `forget_context` also clear the vision summary?** `Context.clear` empties only the event array (`packages/working-memory/src/index.ts:81-83`), so `lastVision` keeps feeding the "On screen right now" line and the recall fallback (`cortex.ts:102`; `CTX-CTRL-004`). Recommended: yes, clear `lastVision` too (mood can stay).
10. **Should an empty focus text fall back to the vision summary for recall?** `cortex.ts:127` uses `??`, so a focus with `text: ""` skips recall; the old spec wording read both ways (`CTX-RECALL-001`). Recommended: yes; use the vision summary whenever the focus text is empty.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/cortex/cortex-design.md

### EARS
- docs/intent/cortex/cortex-specs.md (55 specs, prefix `CTX`: 53 `[x]`, 2 `[ ]`, 0 `[D]`)

### Tests (`@spec` lines per file; 42 lines citing 47 distinct IDs)
- services/cortex/test/cortex.region.test.ts (25)
- services/cortex/test/cortex.test.ts (1)
- services/cortex/test/critic.test.ts (4)
- services/cortex/test/prompt.test.ts (6)
- services/cortex/test/mock.test.ts (3)
- services/cortex/test/health.test.ts (3)

### Code (`@spec` lines per file; 40 lines citing all 53 implemented IDs)
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

| Category | Spec IDs | Implemented | Deferred | Gaps | Tested |
|----------|----------|-------------|----------|------|--------|
| Event handling | CTX-EVT-001 to CTX-EVT-007 | 7 | 0 | 0 | 6 |
| Think gating | CTX-GATE-001 to CTX-GATE-008 | 7 | 0 | 1 | 7 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 5 | 0 | 0 | 4 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-003 | 3 | 0 | 0 | 3 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-007 | 7 | 0 | 0 | 6 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-006 | 6 | 0 | 0 | 5 |
| Saying | CTX-SAY-001 to CTX-SAY-004 | 4 | 0 | 0 | 4 |
| Control | CTX-CTRL-001 to CTX-CTRL-006 | 6 | 0 | 0 | 6 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 2 | 0 | 0 | 2 |
| Startup and shutdown | CTX-START-001 to CTX-START-004 | 4 | 0 | 0 | 2 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-003 | 2 | 0 | 1 | 2 |

**Summary:** 53 of 55 specs implemented and annotated in code; 0 deferred; 2 gaps (`CTX-GATE-008`, `CTX-HEALTH-003`). 47 of the 53 implemented specs have a test annotated with `@spec`; the 6 without one are `CTX-EVT-001`, `CTX-RECALL-002`, `CTX-PROMPT-007`, `CTX-CRITIC-006`, `CTX-START-003` and `CTX-START-004`. No `@spec` annotation cites a missing ID.

## Key Findings

1. **Markers verified, none flipped** — every `[x]` line has implementing code; both `[ ]` gaps are confirmed absent (`cortex.ts:119-121`, `index.ts:36` is the only writer of `llmOk`).
2. **Spec lines corrected to match the code** — `CTX-EVT-001` (`fromNow` only applies when the group is created), `CTX-RECALL-001` (vision fallback only when the focus has no `focus` object, `cortex.ts:127`), `CTX-CRITIC-005` (also trims `text` and keeps a string `note`, `critic.ts:16-24`), `CTX-CTRL-004` (keeps `lastVision`, mood and pending recalls), and the `CTX-RECALL-002` test reference (nothing asserts the skipped request). LLD Open Questions 8, 10 and 11 record that the earlier wording may have been the intent.
3. **New spec line for observed behaviour** — `CTX-CRITIC-006`: the llm critic's inner-editor prompt and 160-token cap (`critic.ts:34-43`).
4. **`deps.llm` never changes after startup** — `llmOk` is written only by `waitForLlm` (`index.ts:26,36`; `startup.ts:24`), so the heartbeat reports `ready`/`llm: ok` forever even when `think` fails against a dead backend (`cortex.ts:154-156`). Commit `691b079` review notes: "cortex `llm` dep reflects the startup ping only". Question 1.
5. **Unawaited think can raise an unhandled rejection** — `void this.think(...)` (`cortex.ts:65`) and early-gate `await this.status("muted"|"speaking")` outside the `try` (`cortex.ts:119-121`); only the `thinking` branch has `.catch` (`cortex.ts:117`), and no process-level `unhandledRejection` handler exists. Question 2.
6. **Raw LLM text logged at info** — `log.info({ ms, reason, memories, raw }, "llm reply")` on every reply (`cortex.ts:138`), before the critic has seen it. Question 3.
7. **Restarts replay stale focuses** — a plain restart resumes the `cortex` group and processes old `attention.focus` events; only a first start or a control-plane `fresh` start (the default, `packages/control/src/manifest.ts:43`) skips them. Question 4.
8. **Operator `say` bypasses every gate** — no mute, pause or busy check, overwrites `speakingId` (`cortex.ts:106`, `cortex.ts:189-195`). Question 5.
9. **Speaking release is internal only** — `voiceBusy()` clears `speakingId` after `speaking_timeout_ms` (`cortex.ts:168-171`) but `brain.status` stays `speaking` until the next think publishes something. Question 6.
10. **Inconsistent length rules** — prompt "ONE short spoken line" (`prompt.ts:37`) vs llm critic "longer than two sentences" (`critic.ts:38`). Question 7.
11. **Viewer note is consumed before success** — deleted at `cortex.ts:130-132`, so a vetoed, dropped or failed reply loses that viewer's one-shot note; "regular" is a bare literal `> 25` (`cortex.ts:78`) applied to counts that the memory region's Postgres store reports one low (memory `MEM-VIEWER-001`). Question 8.
12. **`forget_context` keeps the vision summary** — `Context.clear` leaves `lastVision` (`packages/working-memory/src/index.ts:81-83`). Question 9.
13. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` (`cortex.ts:52`) ties behaviour to `new Bus("cortex")` at `index.ts:25`.
14. **Critic misconfiguration fails at import** — the `Module` constructor throws for an unusable critic config (`packages/modules/src/index.ts:41-48`) while `index.ts:29` runs, outside `main()`'s `fatal` handler (`index.ts:55`).
15. **Decision rationale** — 8 of the 12 LLD decision rows cite the code comment or commit that states their rationale (`969f6d7`, `51d5a9c`, comments at `cortex.ts:24,63-64,147,167`, `startup.ts:15-19`, `index.ts:11-13`, `packages/llm/src/mock.ts:7`); 2 are partly settled (status echo, per-viewer keying) and 2 remain `[inferred]` (own-vs-other by source, operator `say` bypass).
16. **Test coverage** — `index.ts` wiring is untested; `cortex.test.ts` covers only `parseReply`; the 50-entry viewer cap, the `recall_k <= 0` skip and the operator-`say` gate bypass have no assertion.

## Work Required

### Must Fix
1. Make `deps.llm` reflect runtime backend health, not just startup (`CTX-HEALTH-003`, question 1).
2. Absorb status-publish failures on the early gate paths so the unawaited think cannot reject (`CTX-GATE-008`, question 2).

### Should Fix
3. Decide raw LLM text logging (`CTX-PROMPT-007`, question 3).
4. Decide restart replay for the `cortex` group (`CTX-EVT-001`, question 4).
5. Publish a status when the speaking timeout releases the voice, or record why not (`CTX-GATE-004`, question 6).
6. Record the operator `say` override decision (`CTX-CTRL-006`, question 5).
7. Reconcile the "one line" vs "two sentences" length rule (`CTX-CRITIC-006`, question 7).

### Nice to Have
8. Move the viewer-note delete after a successful reply, or record one-shot-on-attempt (`CTX-VIEWER-003`, question 8).
9. Decide `forget_context` and the recall fallback (`CTX-CTRL-004`, `CTX-RECALL-001`, questions 9 and 10).
10. Name the "regular" threshold (25) and the 50-note cap as constants (`CTX-VIEWER-001`, `CTX-VIEWER-002`).
11. Add tests for `index.ts` wiring, the viewer cap and the `recall_k <= 0` skip (`CTX-EVT-001`, `CTX-VIEWER-002`, `CTX-RECALL-002`).
