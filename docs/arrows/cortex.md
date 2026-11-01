# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/cortex/cortex-design.md

### EARS
- docs/intent/cortex/cortex-specs.md (54 specs, prefix `CTX`)

### Tests
- services/cortex/test/cortex.region.test.ts
- services/cortex/test/cortex.test.ts
- services/cortex/test/critic.test.ts
- services/cortex/test/prompt.test.ts
- services/cortex/test/mock.test.ts
- services/cortex/test/health.test.ts

### Code
- services/cortex/src/index.ts
- services/cortex/src/startup.ts
- services/cortex/src/cortex.ts
- services/cortex/src/prompt.ts
- services/cortex/src/critic.ts
- services/cortex/src/health.ts
- services/cortex/package.json
- services/cortex/tsconfig.json

### OpenSpec
- openspec/specs/cortex/spec.md
- openspec/changes/add-service-health/specs/cortex/spec.md
- openspec/changes/add-isolated-backends/specs/cortex/spec.md
- openspec/changes/add-service-control/specs/cortex/spec.md
- openspec/changes/add-test-injection/specs/cortex/spec.md

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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event handling | CTX-EVT-001 to CTX-EVT-007 | 7 | 0 | 0 |
| Think gating | CTX-GATE-001 to CTX-GATE-008 | 7 | 0 | 1 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 5 | 0 | 0 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-003 | 3 | 0 | 0 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-007 | 7 | 0 | 0 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-005 | 5 | 0 | 0 |
| Saying | CTX-SAY-001 to CTX-SAY-004 | 4 | 0 | 0 |
| Control | CTX-CTRL-001 to CTX-CTRL-006 | 6 | 0 | 0 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 2 | 0 | 0 |
| Startup and shutdown | CTX-START-001 to CTX-START-004 | 4 | 0 | 0 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-003 | 2 | 0 | 1 |

**Summary:** 52 of 54 specs observed working; 0 deferred; 2 gaps (`CTX-GATE-008`, `CTX-HEALTH-003`).

## Key Findings

1. **`deps.llm` never changes after startup** — `llmOk` is written only by `waitForLlm` (services/cortex/src/index.ts:26,34; startup.ts:23), so the heartbeat reports `ready`/`llm: ok` forever even when `think` fails against a dead backend (cortex.ts:129-131). The doc comment on `cortexHealth` says it "follows the last ping() result" (health.ts:3).
2. **Raw LLM text logged at info** — `log.info({ ms, reason, memories, raw }, "llm reply")` on every reply (cortex.ts:118), before the critic has seen it.
3. **Unawaited think can raise an unhandled rejection** — `void this.think(...)` (cortex.ts:61) and early-gate `await this.status("muted"|"speaking")` outside the `try` (cortex.ts:103-104); only the `thinking` branch has `.catch` (cortex.ts:102). `[inferred]` a Redis publish failure there would crash on Node's default unhandled-rejection policy; comment at cortex.ts:101 says every path reports a status.
4. **Speaking release is internal only** — `voiceBusy()` clears `speakingId` after `speaking_timeout_ms` (cortex.ts:142-145) but `brain.status` stays `speaking` until the next think publishes something; salience has its own valve.
5. **Operator `say` bypasses every gate** — no mute, pause or busy check, overwrites `speakingId` (cortex.ts:93, 161-167); intent unclear (`[inferred]` operator override).
6. **Inconsistent length rules** — cortex prompt asks for "ONE short spoken line" (prompt.ts:36); the llm critic blocks lines "longer than two sentences" (critic.ts:36).
7. **Viewer note is consumed before success** — deleted at cortex.ts:112-113, so a vetoed, dropped or failed reply loses that viewer's one-shot note; "regular" is a bare literal `> 25` (cortex.ts:72).
8. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` (cortex.ts:50) ties behavior to `new Bus("cortex")` at index.ts:25.
9. **Test coverage** — `index.ts` wiring is untested; `cortex.test.ts` covers only `parseReply`; the 50-entry viewer cap and the operator-`say` gate bypass have no assertion.

## Work Required

### Must Fix
1. Make `deps.llm` reflect runtime backend health, not just startup (CTX-HEALTH-003).
2. Absorb status-publish failures on the early gate paths so the unawaited think cannot reject (CTX-GATE-008).

### Should Fix
3. Decide and document whether raw LLM text should be logged at info (CTX-PROMPT-007).
4. Publish a status when the speaking timeout releases the voice (CTX-GATE-004), or document why not.
5. Decide whether operator `say` should respect mute/pause (CTX-CTRL-006).
6. Reconcile the "one line" vs "two sentences" length rule between prompt and critic.

### Nice to Have
7. Move the viewer-note delete after a successful reply, or document one-shot-on-attempt (CTX-VIEWER-003).
8. Name the "regular" threshold (25) in config or a constant (CTX-VIEWER-001).
9. Add tests for `index.ts` wiring and the viewer cap (CTX-EVT-001, CTX-VIEWER-002).
