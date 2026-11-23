# Arrow: cortex

The language region: the only service that calls the chat LLM. Turns `attention.focus` into a spoken `brain.say` via recall, prompt, LLM, parse and critic, and reports `brain.status`.

## Status

**AUDITED** (date and commit in `index.yaml`). The spec file holds 285 specs: 135 `[x]`, 149 `[ ]`, 1 `[D]` (CTX-REPLAN-001, dynamic speech). The gaps are the streamed-reply specs not yet built (below), the early-reply, tool and release specs (CTX-PROV, CTX-INTJ, CTX-TOOL, CTX-REL) and the fallback and control specs still open. The LLD has open questions (a repeat on a mention).

## Spoken fallback line

Design: LLD § Fallback acknowledgement. The transcript marks a line replaced by a fallback; the next reply gets a hint stating the base chance (`brain.cortex.fallback_ack_chance`, 0.25) and the model decides in character; nothing enforces the rate, so it drifts. `CTX-EVT-008`, `CTX-FALL-001` to `007`. `voice.failed` is subscribed in `startup.ts`; `cortex.ts` keeps the pending glitch and consumes it when the reply that carried its hint is published; `prompt.ts` renders the one `## Now` line (`glitchLine`).

## Viewer notes

Design: LLD § Viewer notes. `CTX-VIEWER-001` to `004` (familiarity line from memory's `regular` flag, keyed by `viewerKey`; a `memory.viewer` without `platform` makes no note) and `CTX-NOTES-001` to `011` (`notesViewers` and `fetchNotes` in `cortex.ts`, requested in parallel with recall under one deadline; `matchNotes` matches reply entries by platform and user id, else by name; `peopleBlock` in `prompt.ts`). `CTX-FORGET-001` to `003`: `chat.removed` calls `ctx.forget` and, for `scope: user`, deletes that viewer's familiarity note; the think in flight is not aborted and builds its prompt, after the recall and notes replies, from the window and notes as they then stand.

## Streamed reply

Design: LLD §§ The think pipeline, Streaming the reply, Critic, Repetition check. `services/cortex/src/clauses.ts` holds the pure parts: `readHead` (the leading `Name:`, `[emotion]` and `[gesture:name]`, decided at the first non-tag character, at 80 characters, or at the end), `cutClause` (boundaries, `clause_min_chars`/`clause_max_chars`, bracketed spans) and `cleanClause`. `cortex.ts` `readReply` reads `llm.stream` under an `AbortSignal`: with a `rules` critic each clause is checked as it arrives (critic on the first clause only, then repetition, then the mute and busy re-check) and published; with an `llm` or `http` critic the whole reply is read, criticised once and then cut. The first clause is `brain.say` (`more` unless it is the whole reply); later clauses are `brain.clause` with `seq` from 1; exactly one closing `brain.clause` (`last`, `through`, optional `cut`: `repeat`, `muted`, `busy`, `length`, `stopped`) closes each line that had `more`. `closeLine` aborts the stream before the closing event. `stop()` is async and closes an open line as `stopped`. The cortex's own `brain.clause` extends its working-memory line (`extendSelf`). `trackLlm` in `startup.ts` tracks `stream()` outcomes (CTX-HEALTH-003).

Open in this area: CTX-STREAM-001, 003, 004 (the first newline ends the reply; implemented, not yet flipped), 011 to 013 and 019 (ownership to be confirmed), 030, 031, 035 and 036 (stream failure and valve cuts, CTX-STREAM-031 and -036 in #197).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice), each with the spec that carries it.

1. **R4** Runtime `deps.llm` → every `llm.chat` and `llm.stream` outcome feeds it through `tracked()`. `CTX-HEALTH-003`.
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
- docs/intent/cortex/cortex-specs.md (285 specs, prefix `CTX`: 135 `[x]`, 149 `[ ]`, 1 `[D]`)

### Tests (files carrying `@spec CTX-`)
- services/cortex/test/cortex.region.test.ts
- services/cortex/test/cortex.stream.test.ts
- services/cortex/test/transcript-stops.test.ts
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
- services/cortex/src/clauses.ts
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
4. `startup.ts` — `waitForLlm` ping loop (infinite, reports degraded), `startCortex` (idle, group reset, subscribe at `latest`, then `ready`), `trackLlm` (every `chat` and `stream` outcome feeds `deps.llm`).
5. `health.ts` — heartbeat spec (`mode`, `deps.llm`); `main.ts` adds the critic hook's `hook.cortex.critic` dependency and pings it (`CTX-HEALTH-006`, `CTX-HEALTH-007`).
6. `main.ts` — `cortexMain` on the shared `runService` bootstrap: provider, critic, `Cortex`, `waitForLlm`, `startCortex`; `index.ts` only calls `runCortex()`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event handling | CTX-EVT-001 to CTX-EVT-013 | 8 | 0 | 5 |
| Think gating | CTX-GATE-001 to CTX-GATE-013 | 10 | 0 | 3 |
| Memory recall | CTX-RECALL-001 to CTX-RECALL-005 | 5 | 0 | 0 |
| Viewer notes | CTX-VIEWER-001 to CTX-VIEWER-004 | 4 | 0 | 0 |
| Viewer notes from memory | CTX-NOTES-001 to CTX-NOTES-011 | 11 | 0 | 0 |
| Prompt and reply | CTX-PROMPT-001 to CTX-PROMPT-020 | 13 | 0 | 7 |
| Fallback acknowledgement | CTX-FALL-001 to CTX-FALL-012 | 4 | 0 | 8 |
| Critic | CTX-CRITIC-001 to CTX-CRITIC-013 | 13 | 0 | 0 |
| Saying | CTX-SAY-001 to CTX-SAY-010 | 4 | 0 | 6 |
| Control | CTX-CTRL-001 to CTX-CTRL-011 | 7 | 0 | 4 |
| Interruptible speech | CTX-REPLAN-001 | 0 | 1 | 0 |
| Test injection | CTX-INJ-001 to CTX-INJ-002 | 1 | 0 | 1 |
| Startup and shutdown | CTX-START-001 to CTX-START-005 | 4 | 0 | 1 |
| Health | CTX-HEALTH-001 to CTX-HEALTH-009 | 7 | 0 | 2 |
| Repetition check | CTX-REPEAT-001 to CTX-REPEAT-015 | 15 | 0 | 0 |
| Streamed reply | CTX-STREAM-001 to CTX-STREAM-037 | 26 | 0 | 11 |
| Forgetting | CTX-FORGET-001 to CTX-FORGET-003 | 3 | 0 | 0 |
| Early reply, tools, release | CTX-PROV, CTX-INTJ, CTX-TOOL, CTX-REL | 0 | 0 | 101 |

**Summary:** 285 specs: 135 implemented, 149 gaps, 1 deferred. The early-reply, tool and release specs (CTX-PROV, CTX-INTJ, CTX-TOOL, CTX-REL) are gaps. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **Status publishes are guarded** — the three early gates log a failed `brain.status` publish (`statusLogged` in `cortex.ts`), and the unawaited think logs a rejection.
2. **Speaking release is published** — `startSpeaking` in `cortex.ts` arms a timer that publishes `idle`/`muted` when `speaking_timeout_ms` elapses without `voice.done`; `voiceBusy()` keeps the lazy check.
3. **Readiness follows the group** — `startCortex` in `startup.ts` awaits `Bus.resetGroup("cortex")` before it subscribes at start mode `latest` and reports `ready`.
4. **`deps.llm` follows replies** — `trackLlm` in `startup.ts` wraps `llm.chat` in `tracked()` and `llm.stream` in `trackStream` (an abort or an abandoned stream is ok); `main.ts` owns `llmOk` and `llmProbed`.
5. **Viewer notes are consumed after the say** — `readReply` calls its `onSaid` once the first clause's `brain.say` is out; a newer note is never deleted by an older reply.
6. **Raw LLM text is `debug` only**, logged once per think in `readReply`'s `finally`; the `llm reply` info line is logged only when the reply was not stopped (`cortex.ts`).
7. **Tag/stop contract is pinned** — `transcript-stops.test.ts` captures the stop list the Ollama and OpenAI-compatible providers send (`TRANSCRIPT_STOPS` is not exported) and checks it against `TRANSCRIPT_TAGS` and the rendered transcript.
8. **`forget_context` relies on `Context.clear`** — the cortex calls `ctx.clear()`, which also resets `lastVision` (working-memory).
9. **Own-vs-other `brain.say` depends on the bus source string** — `ev.source !== "cortex"` in `cortex.ts` ties behaviour to `new Bus("cortex")` built by the bootstrap.
10. **Critic misconfiguration fails through the bootstrap** — the `Module` constructor throws for an unusable critic config (`packages/modules/src/index.ts`) while `cortexMain` builds the critic, so it takes the `fatal` path and exits 1 (`CTX-START-005`).

## Work Required

- Streamed reply: CTX-STREAM-001, 003, 004 (implemented; not yet flipped), 011 to 013, 019, 030, 031, 035, 036 are open.
- Early reply, tools and release (CTX-PROV, CTX-INTJ, CTX-TOOL, CTX-REL) are open.
- The LLD's open questions: a repeat on a mention.
