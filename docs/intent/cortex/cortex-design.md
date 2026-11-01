---
parent: high-level-design
prefix: CTX
---

# cortex

Mapped 2026-10-31 at git `686cc8f`. Brownfield: this document describes what
the code does today. Rationale cells are `[inferred]` from code, not authored.

## Context and Design Philosophy

`[inferred]` cortex is the language region (`services/cortex/src/index.ts:2`): the
only service that calls the chat LLM. It does not decide whether to speak
(salience does) and it does not remember beyond a rolling window (memory does).
It waits for `attention.focus`, assembles a prompt from personality, mood, viewer
notes, recalled memories and a working-memory transcript, calls the model, runs the
reply past the `cortex.critic` hook, and publishes `brain.say`.

Observed principles:

- Single-threaded thinking: at most one LLM call in flight, and nothing is spoken
  over someone else's line.
- Every exit from `think()` reports a `brain.status`, because salience assumes the
  cortex is busy once it fires (`cortex.ts:101` comment).
- Degrade rather than block: a silent memory region costs `recall_timeout_ms`, a
  failing LLM or critic goes back to `idle`, a down model backend is waited for at
  startup and reported `degraded`.
- All logic lives in the `Cortex` class (`cortex.ts`) with the bus, LLM, critic,
  logger and personality loader injected (`CortexDeps`, `cortex.ts:10-17`);
  `index.ts` is only wiring.

## Event wiring

Subscription (`index.ts:36-46`): group `cortex`, `fromNow: true`, types
`chat.message, speech.heard, vision.summary, brain.say, voice.done, attention.focus,
memory.recall.reply, memory.viewer, affect.state, control`. Subscribing happens
only after the model backend answered `ping()` (`index.ts:34`), so events during
that wait are lost. The service publishes `brain.status`, `brain.say` and
`memory.recall.request`.

| Event in | Handling | Evidence |
|----------|----------|----------|
| `chat.message`, `speech.heard`, `vision.summary` | `ctx.push(ev)` into the `Context` window (`brain.working_memory_events`, default 24) | `cortex.ts:41-45`, `cortex.ts:36` |
| `brain.say` (any source) | `ctx.pushSelf(text, emotion)`; if `ev.source !== "cortex"` also record `speakingId = d.id` and the time | `cortex.ts:46-52` |
| `voice.done` | if `d.id === speakingId`: clear it, publish `brain.status` `muted` (muted or paused) else `idle` | `cortex.ts:53-57` |
| `attention.focus` | `void this.think(...)`; deliberately not awaited so the recall reply can be delivered | `cortex.ts:58-62` |
| `memory.recall.reply` | resolve the pending recall with the same `id`; unknown ids ignored | `cortex.ts:63-67` |
| `memory.viewer` | build or clear a one-line note for that user | `cortex.ts:68-80` |
| `affect.state` | store as the latest `Mood` | `cortex.ts:81-83` |
| `control` | see Control commands | `cortex.ts:84-95` |

Own versus other lines are distinguished purely by the bus source string:
`ev.source !== "cortex"` (`cortex.ts:50`) depends on `new Bus("cortex", ...)`
(`index.ts:25`). The cortex's own line sets `speakingId` inside `say()` before it
publishes (`cortex.ts:161-167`); lines from salience reflexes or the operator set it
on arrival.

## The think pipeline

`think(focus)` (`cortex.ts:99-135`):

1. Gates, in order, each publishing a status and returning without an LLM call:
   already `thinking` → `thinking` with the new reason (publish failure swallowed,
   `cortex.ts:102`); `muted || paused` → `muted` (`cortex.ts:103`); `voiceBusy()` →
   `speaking` (`cortex.ts:104`).
2. Set `thinking = true` (cleared in `finally`, `cortex.ts:133`), publish
   `thinking` with `focus.reason` as detail.
3. Recall (`cortex.ts:109-110`, `148-159`): query = `focus.focus.text`, else the last
   vision summary; empty query skips recall. If `brain.memory.recall_k <= 0` no
   request is made. Otherwise publish `memory.recall.request {id: uuid, query,
   k: recall_k}` and wait up to `brain.cortex.recall_timeout_ms` (default 2500) for the
   reply; timeout logs `memory region did not answer in time` and continues with
   `[]`; a failed publish resolves `[]` immediately.
4. Viewer note: look up `focus.focus.who` lowercased and delete it (one-shot,
   `cortex.ts:111-113`); the note is consumed even if the reply is later vetoed or
   fails.
5. `buildMessages` (below), then `llm.chat(messages)` with no per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. The raw model
   text, elapsed ms, reason and memory count are logged at `info` (`cortex.ts:118`).
6. `parseReply`; if the text is shorter than 2 characters publish `idle` and stop
   (`cortex.ts:119`).
7. Critic (`cortex.critic` module): `ok:false` → log, publish `idle`, stop; a returned
   `text` or `emotion` replaces the originals (`cortex.ts:121-124`).
8. Re-check after the slow work: muted/paused → publish `muted`; `voiceBusy()` (a
   reflex or operator line began) → log `dropped`, publish `speaking`
   (`cortex.ts:126-127`).
9. `say(text, emotion, gesture, focus.reason, propagatedFlags(focus))` publishes
   `brain.say {id, text, emotion, gesture, reason, ...flags}` then `brain.status`
   `speaking` with the text as detail. Flags `injected` and `remember` are copied
   only from an injected focus (`@cohost/working-memory` `propagatedFlags`).
10. Any thrown error is logged `think failed` and publishes `idle` (publish failure
    swallowed, `cortex.ts:129-131`).

`voiceBusy()` also resets `speakingId` once `speaking_timeout_ms` (default 20000)
has elapsed (`cortex.ts:142-145`): a stuck voice sink releases the cortex, but no
status is re-published at that moment; the next `think` simply proceeds.

### Prompt and reply (`prompt.ts`)

`buildMessages` returns exactly two messages. System: trimmed personality, `## Now`
(local time in `cohost.timezone`, streamer, co-host name), optional screen line
(`ctx.lastVision`), optional mood line (`describeMood`: valence to
"in a great mood / cheerful / even / a bit down / fed up", arousal to
"buzzing / engaged / relaxed"), optional viewer note, optional
`## Things you remember` block of `- (YYYY-MM-DD) who: text`, and an `## Output`
instruction (one short spoken line, leading `[emotion]` tag from `EMOTIONS`, optional
`[gesture:name]`). User: `## Recent transcript` (or `(quiet)`) and a closing nudge
chosen by `reason` and focus kind (`describeFocus`, `prompt.ts:58-67`).

`parseReply` (`prompt.ts:69-85`): first line only; strip a leading `Name:` before a
tag; parse `[emotion]` and optional `[gesture:x]`; strip all remaining bracketed
text, surrounding quotes and a leading `word:`; unknown emotion becomes `neutral`;
gestures are not validated.

### Viewer notes

`memory.viewer` → note text: `isNew` gives "`<user>` is new here (first message).";
`msgCount > 25` gives "`<user>` is a regular (N messages)." plus " Notes: ..." if the
memory region sent notes; otherwise no note. The magic threshold is literal 25
(`cortex.ts:72`). Notes are keyed by lowercased user, a new event replaces or clears
the old one, and the map is capped at 50 with oldest-first eviction
(`cortex.ts:75-78`).

### Critic (`critic.ts`)

`createCritic` wraps `Module("cortex.critic", cfg.brain.cortex.critic, ...)`
(`critic.ts:44`) from `@cohost/modules`. Kinds: `rules` (default, always
`{ok:true}`), `llm` (an "inner editor" system prompt, JSON reply, 160 tokens) and
`http` (POST the `CriticInput`). `validate` requires boolean `ok`, trims `text` and
drops blank text, drops unknown `emotion`, keeps `note` only if a string
(`critic.ts:15-23`). Anything unusable, a thrown error or a timeout falls back to
the rules result (pass-through) inside `Module.run` (`packages/modules/src/index.ts:53-64`),
so the critic can never block speech by failing.

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts:137-139`; schema `packages/bus/src/events.ts:59-62`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts:86` |
| `pause` | `paused = true`, publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts:87` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts:88` |
| `mute` / `unmute` | `muted` flag; `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts:89-90` |
| `forget_context` | clear `Context` and viewer notes (not mood, not pending recalls) | `cortex.ts:91` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts:92` |
| `say` with `text` | `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; overwrites `speakingId` | `cortex.ts:93`, `161-167` |

State summary: the cortex reports `muted` for both mute and pause so salience stops
waiting on it. After a successful `say` it stays `speaking` until the matching
`voice.done` returns it to `idle`/`muted`; if no sink ever reports done, no `idle`
status is published (only the internal busy flag expires).

## Startup, health and shutdown

`index.ts:23-30` builds config, `Bus("cortex")`, the chat provider
(`createChatProvider(cfg.llm)`), the critic and the `Cortex`. The heartbeat starts
immediately with `cortexHealth(() => llmOk, cfg.llm.provider)` (`index.ts:27`).
`main()`:

1. Warn if the provider is `mock` (`index.ts:33`).
2. `waitForLlm` (`startup.ts:19-30`): loop `llm.ping()`; every result goes to
   `setOk` (so `llmOk`); each miss logs a warning and calls
   `heartbeat.degraded("model backend unreachable (name/model): lastError")`; sleep 3 s
   (`retryMs`); never throws, never gives up. The mock provider answers at once.
3. Publish `brain.status idle`, subscribe, `heartbeat.ready()`, log `cortex online`.

Health (`health.ts:4-6`): service `cortex`, mode `mock` if the provider is `mock`
else `live`, deps `{llm: ok|down}` read from `llmOk`. `llmOk` is assigned only inside
`waitForLlm`, so after `ready()` it is constantly `true`; a model outage during
operation surfaces only as `think failed` log lines, not in the heartbeat.

Shutdown: `onShutdown` stops the bus (`index.ts:52`); the `stopping` heartbeat is the
heartbeat package's job. Fatal startup errors exit 1 (`index.ts:51`).

Config keys read: `brain.working_memory_events`, `brain.memory.recall_k`,
`brain.cortex.{recall_timeout_ms, speaking_timeout_ms, critic.*}`, `cohost.{name,
streamer, timezone}`, `llm.*`. Env: `LLM_PROVIDER` selects the mock preset
(`add-isolated-backends`), `HEARTBEAT_INTERVAL_MS`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Do not await `attention.focus` | `void this.think()` | await inside the handler | `[inferred]` an awaited LLM call would block the subscription loop and the memory reply could never be delivered; comment `cortex.ts:59-60`, test `cortex.region.test.ts:91` |
| Recall over the bus with timeout | request/reply with `recall_timeout_ms`, proceed with `[]` | call Postgres directly; no timeout | `[inferred]` only memory touches Postgres and the cortex must answer even if memory is down; `cortex.ts:147-159`, `index.ts:11-13` |
| One thought at a time | `thinking` flag plus status echo | queue focuses; cancel in-flight | `[inferred]` salience re-fires on its tick and expects a status for every focus; `cortex.ts:101-102`, test `cortex.region.test.ts:99` |
| Own vs other `brain.say` | compare `ev.source` to `"cortex"` | tag lines with an origin field | `[inferred]` cheap; relies on bus source naming; `cortex.ts:50` |
| Re-check busy and mute after the LLM | drop the reply if something else started speaking | speak anyway | `[inferred]` avoid talking over reflexes or the operator; `cortex.ts:126-127`, test `cortex.region.test.ts:170` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()` | rely on `voice.done` only | `[inferred]` a missing sink must not freeze the brain; `cortex.ts:142-145` |
| Operator `say` bypasses gates | no mute, pause or busy check | route through `think` | `[inferred]` operator override; `cortex.ts:93` |
| Viewer notes one-shot, capped | delete on use, 50 entries FIFO | persistent per-viewer notes | `[inferred]` "one viewer's framing never lands on another's reply" (`cortex.ts:30`) and bounded memory |
| Pause reported as `muted` | reuse existing status | add a `paused` state | `[inferred]` salience already understands `muted`; comment `cortex.ts:24` |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | `[inferred]` same pluggable-hook pattern as salience and affect; `critic.ts:25-44` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | `[inferred]` never silent and never fatal; `startup.ts:14-18` |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | `[inferred]` `MockProvider` returns `[happy] mock: ...` (`packages/llm/src/mock.ts:10-24`), tested in `mock.test.ts:22` |

## Open Questions & Future Decisions

### Resolved
1. None authored. Everything above is observed, not confirmed by the owner.

### Deferred (observed, unexplained, or technical debt)
1. **`deps.llm` is never re-evaluated after ready.** `health.ts:3` comment says it
   follows the last `ping()` result, but `ping()` runs only in `waitForLlm`
   (`startup.ts:22`); LLM failures in `think` are only logged (`cortex.ts:130`).
   OpenSpec `add-service-health` says `ping()` failure gives `down`/`degraded`.
   `CTX-HEALTH-003`.
2. **Raw LLM text is logged at info on every reply** (`cortex.ts:118`, field `raw`),
   which can carry whatever the model emits (chat content echoes, unfiltered text
   before the critic).
3. **Unguarded status publishes can reject an unawaited promise.**
   `await this.status("muted")` and `await this.status("speaking")` on the early gate
   paths (`cortex.ts:103-104`) are outside the `try`, while `think` is invoked as
   `void this.think(...)` (`cortex.ts:61`). A failing publish there is an unhandled
   rejection; the branch at `cortex.ts:102` alone has `.catch`. Comment at
   `cortex.ts:101` claims every path reports a status. `CTX-GATE-008`.
4. **Speaking release is silent.** When `speaking_timeout_ms` expires with no
   `voice.done`, the cortex re-opens internally but `brain.status` stays `speaking`
   until its next think publishes something (`cortex.ts:142-145`).
5. **Two reply-length rules.** The cortex prompt asks for "ONE short spoken line"
   (`prompt.ts:36`) while the llm critic blocks lines "longer than two sentences"
   (`critic.ts:36`).
6. **Viewer note consumed before success** (`cortex.ts:111-113`): a vetoed, errored or
   dropped reply loses that viewer's note.
7. **Operator `say` ignores mute, pause and busy** and overwrites `speakingId`
   (`cortex.ts:93`, `161-167`); it also has no `voice.done` reconciliation if it
   interrupts a pending line. Intent unclear.
8. **Events during startup are lost.** Subscription starts after `waitForLlm` and is
   `fromNow` (`index.ts:34-43`).
9. **Cast and mutability smells.** `emotion` is a `string` from `parseReply` cast to
   `Emotion` (`cortex.ts:121,128`); `let { text, emotion, gesture }` never reassigns
   `gesture`; `viewerNotes.keys().next().value!` uses a non-null assertion
   (`cortex.ts:78`); the 25-message "regular" threshold is a literal (`cortex.ts:72`).
10. **`forget_context` leaves `mood` and `pendingRecall` untouched** (`cortex.ts:91`).
11. **Test coverage.** `index.ts` is untested (wiring, subscription list, heartbeat
    readiness ordering); `cortex.test.ts` only covers `parseReply`; the 50-entry cap,
    the post-think `muted` path with pause, and the operator-`say` gate bypass have no
    direct assertion.

## References

- Code: `services/cortex/src/{index,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,critic,health,mock,prompt}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (`Bus`, event schemas for the ten subscribed types and
  `brain.status`, `brain.say`, `memory.recall.request`), config (`loadConfig`,
  `loadPersonality`, `EMOTIONS`), model-backends (`createChatProvider`, `ChatProvider.ping`,
  `MockProvider`), region-hooks (`Module` for `cortex.critic`), working-memory
  (`Context`, `propagatedFlags`), control-plane (heartbeat contract: `startHeartbeat`,
  `HeartbeatSpec`), memory (request/reply and `memory.viewer`), salience (`attention.focus`
  producer, consumes `brain.status`), affect (`affect.state`), voice (`voice.done`)
- Depended on by: salience (waits on `brain.status`), voice and avatar (consume `brain.say`),
  memory (stores `brain.say` as `self`), dashboard (displays `brain.status`, sends `control`)
- External: the configured chat LLM backend (Ollama, OpenAI-compatible, Anthropic, Bedrock, or mock), optional HTTP critic endpoint
- OpenSpec: `openspec/specs/cortex/spec.md`; deltas
  `openspec/changes/archive/2026-11-01-add-service-health/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-service-control/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-test-injection/specs/cortex/spec.md`
