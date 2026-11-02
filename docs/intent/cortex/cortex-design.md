---
parent: high-level-design
prefix: CTX
---

# cortex

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01. A rationale cell
marked `[inferred]` is read from the code and not confirmed by the owner; a cell
marked `owner decision 2026-11-01` was settled by the owner; any other rationale
cell cites the code comment or commit message that states it.

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
  cortex is busy once it fires (`cortex.ts:115` comment); a failed status publish is
  logged, never left as an unhandled rejection (`CTX-GATE-008`).
- Turn-taking is owned upstream of the body: cortex and salience are the only
  services that read `mute` and `pause`; voice and ears stay unaware of them. The
  operator's `say` is an override that bypasses mute, pause and busy.
- Degrade rather than block: a silent memory region costs `recall_timeout_ms`, a
  failing LLM or critic goes back to `idle`, a down model backend is waited for at
  startup and reported `degraded`.
- All logic lives in the `Cortex` class (`cortex.ts`) with the bus, LLM, critic,
  logger and personality loader injected (`CortexDeps`, `cortex.ts:10-17`);
  `index.ts` is only wiring.

## Event wiring

Subscription (`index.ts:39-49`): group `cortex`, start mode `latest`, types
`chat.message, speech.heard, vision.summary, brain.say, voice.done, attention.focus,
memory.recall.reply, memory.viewer, affect.state, control`. The service publishes
`brain.status`, `brain.say` and `memory.recall.request`.

Subscribing happens only after the model backend answered `ping()` (`index.ts:36`).
Start mode `latest` resets the `cortex` group to the stream's newest entry on every
start (`CTX-EVT-001`), so nothing published while the cortex was down or waiting
for its backend is delivered: a stale `attention.focus` must never trigger an LLM
call and a late `brain.say`. Delivery across a restart is at-most-once (event-bus).
The code still passes `fromNow: true`, which positions only a newly created group;
an existing group resumes after its last delivered entry
(`packages/bus/src/index.ts:133-138`), so today a crash or container restart
replays the backlog and only a control-plane `fresh` start, cortex's default
manifest mode (`packages/control/src/manifest.ts:44`), skips it.

`ready` is reported once the `cortex` group exists (`CTX-START-003`); the code
starts the subscription with `void` and calls `heartbeat.ready()` at once.

| Event in | Handling | Evidence |
|----------|----------|----------|
| `chat.message`, `speech.heard`, `vision.summary` | `ctx.push(ev)` into the `Context` window (`brain.working_memory_events`, default 24) | `cortex.ts:42-46`, `cortex.ts:36` |
| `brain.say` (any source) | `ctx.pushSelf(text, emotion)`; if `ev.source !== "cortex"` also record `speakingId = d.id` and the time | `cortex.ts:48-54` |
| `voice.done` | if `d.id === speakingId`: clear it, publish `brain.status` `muted` (muted or paused) else `idle` | `cortex.ts:56-60` |
| `attention.focus` | `void this.think(...)`; deliberately not awaited so the recall reply can be delivered | `cortex.ts:62-66` |
| `memory.recall.reply` | resolve the pending recall with the same `id`; unknown or late ids ignored | `cortex.ts:68-72` |
| `memory.viewer` | build or clear a one-line note for that user | `cortex.ts:74-86` |
| `affect.state` | store as the latest `Mood` | `cortex.ts:88-90` |
| `control` | see Control commands | `cortex.ts:91-108` |

Own versus other lines are distinguished purely by the bus source string:
`ev.source !== "cortex"` (`cortex.ts:52`) depends on `new Bus("cortex", ...)`
(`index.ts:25`). The cortex's own line sets `speakingId` inside `say()` before it
publishes (`cortex.ts:189-195`); lines from salience reflexes or the operator set it
on arrival.

## The think pipeline

`think(focus)` (`cortex.ts:113-160`):

1. Gates, in order, each publishing a status and returning without an LLM call:
   already `thinking` → `thinking` with the new reason (publish failure swallowed,
   `cortex.ts:117`); `muted || paused` → `muted` (`cortex.ts:119`); `voiceBusy()` →
   `speaking` (`cortex.ts:121`). A failed publish on these paths is logged and the
   think returns (`CTX-GATE-008`); the code guards only the first
   (`cortex.ts:117`), so the other two can raise an unhandled rejection.
2. Set `thinking = true` (cleared in `finally`, `cortex.ts:158`), publish
   `thinking` with `focus.reason` as detail.
3. Recall (`cortex.ts:127-128`, `174-186`): the query is the focus text when it is
   non-empty, else the last vision summary; when both are empty recall is skipped
   (`CTX-RECALL-001`). The code uses `focus.focus?.text ?? ctx.lastVision`, so an
   empty focus text skips recall instead of falling back. If
   `brain.memory.recall_k <= 0` no request is made. Otherwise publish
   `memory.recall.request {id: uuid, query, k: recall_k}` and wait up to
   `brain.cortex.recall_timeout_ms` (default 2500) for the reply; timeout logs
   `memory region did not answer in time` and continues with `[]`; a failed publish
   resolves `[]` immediately.
4. Viewer note: look up `focus.focus.who` lowercased and put it in the prompt; it
   is deleted only once the reply's `brain.say` is published, so a vetoed, dropped
   or failed reply keeps it for the next one (`CTX-VIEWER-003`). The code deletes it
   here, before the LLM call (`cortex.ts:130-132`).
5. `buildMessages` (below), then `llm.chat(messages)` with no per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. Elapsed ms,
   reason and memory count are logged at `info`; the raw model text, which can echo
   chat and is unfiltered by the critic, only at `debug` (`CTX-PROMPT-007`; the code
   logs it at `info`, `cortex.ts:138`). Each `llm.chat` outcome also feeds
   `deps.llm` (`CTX-HEALTH-003`).
6. `parseReply`; if the text is shorter than 2 characters publish `idle` and stop
   (`cortex.ts:140`).
7. Critic (`cortex.critic` module): `ok:false` → log, publish `idle`, stop; a returned
   `text` or `emotion` replaces the originals (`cortex.ts:143-146`).
8. Re-check after the slow work: muted/paused → publish `muted`; `voiceBusy()` (a
   reflex or operator line began) → log `dropped`, publish `speaking`
   (`cortex.ts:149-151`).
9. `say(text, emotion, gesture, focus.reason, propagatedFlags(focus))` publishes
   `brain.say {id, text, emotion, gesture, reason, ...flags}` then `brain.status`
   `speaking` with the text as detail. Flags `injected` and `remember` are copied
   only from an injected focus (`@cohost/working-memory` `propagatedFlags`).
10. Any thrown error is logged `think failed` and publishes `idle` (publish failure
    swallowed, `cortex.ts:154-156`).

`voiceBusy()` also resets `speakingId` once `speaking_timeout_ms` (default 20000)
has elapsed (`cortex.ts:168-171`): a stuck voice sink releases the cortex. When the
timeout fires, the cortex publishes `idle` (or `muted` when muted or paused) at that
moment, so salience and the dashboard see the release (`CTX-GATE-009`); the code
checks the timeout only when a later focus arrives and publishes nothing then.

### Prompt and reply (`prompt.ts`)

`buildMessages` returns exactly two messages. System: trimmed personality, `## Now`
(local time in `cohost.timezone`, streamer, co-host name), optional screen line
(`ctx.lastVision`), optional mood line (`describeMood`: valence to
"in a great mood / cheerful / even / a bit down / fed up", arousal to
"buzzing / engaged / relaxed"), optional viewer note, optional
`## Things you remember` block of `- (YYYY-MM-DD) who: text`, and an `## Output`
instruction (one short spoken line, leading `[emotion]` tag from `EMOTIONS`, optional
`[gesture:name]`). User: `## Recent transcript` (or `(quiet)`) and a closing nudge
chosen by `reason` and focus kind (`describeFocus`, `prompt.ts:61-70`).

Transcript tags are owned by working-memory (`[chat]`, `[voice]`, `[screen]`); the
chat providers stop on the same tags only to save tokens, and `parseReply` keeps the
first line regardless. The co-host's own lines begin with its name and are not a
stop. A cortex-level test renders each line kind through `Context.transcript` and
checks it against the provider's stop list (`CTX-PROMPT-008`); today the literals
are copied by hand (`packages/working-memory/src/index.ts:93-95`,
`packages/llm/src/index.ts:45`).

`parseReply` (`prompt.ts:72-89`): first line only; strip a leading `Name:` before a
tag; parse `[emotion]` and optional `[gesture:x]`; strip all remaining bracketed
text, surrounding quotes and a leading `word:`; unknown emotion becomes `neutral`;
gestures are not validated.

### Viewer notes

`memory.viewer` → note text: `isNew` gives "`<user>` is new here (first message).";
`msgCount > 25` gives "`<user>` is a regular (N messages)." plus " Notes: ..." if the
memory region sent notes; otherwise no note. The threshold is the literal 25
(`cortex.ts:78`). Notes are keyed by lowercased user, a new event replaces or clears
the old one, and the map is capped at 50 with oldest-first eviction
(`cortex.ts:81-84`). The counts come from the memory region; with its Postgres store
`msgCount` is one less than the messages seen (memory segment, `MEM-VIEWER-001`).

### Critic (`critic.ts`)

`createCritic` wraps `Module("cortex.critic", cfg.brain.cortex.critic, ...)`
(`critic.ts:46`) from `@cohost/modules`. Kinds: `rules` (default, always
`{ok:true}`), `llm` (an "inner editor" system prompt, JSON reply, 160 tokens,
`critic.ts:34-43`) and `http` (POST the `CriticInput`). The llm critic applies the
reply prompt's length rule, one short spoken line (`CTX-CRITIC-006`); its prompt
still says "longer than two sentences" (`critic.ts:38`). `validate` requires boolean
`ok`, trims `text` and drops blank text, drops unknown `emotion`, keeps `note` only
if a string (`critic.ts:16-24`). Anything unusable, a thrown error or a timeout falls
back to the rules result (pass-through) inside `Module.run`
(`packages/modules/src/index.ts:53-63`), so the critic can never block speech by
failing at run time. A critic configuration the `Module` constructor rejects (for
example `kind: http` with an empty `url`, `packages/modules/src/index.ts:41-48`)
throws while `index.ts:29` builds the critic, before `main()` runs.

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts:162-164`; schema `packages/bus/src/events.ts:66-69`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts:94` |
| `pause` | `paused = true`, publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts:96` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts:97` |
| `mute` / `unmute` | `muted` flag; `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts:99-100` |
| `forget_context` | clear the `Context` event window, the last vision summary and viewer notes; the mood and pending recalls are kept (`CTX-CTRL-004`; the code keeps `ctx.lastVision`) | `cortex.ts:102`, `packages/working-memory/src/index.ts:81-83` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts:104` |
| `say` with `text` | operator override: `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; overwrites `speakingId` | `cortex.ts:106`, `cortex.ts:189-195` |

These are all seven `control` commands in the bus schema
(`packages/bus/src/events.ts:176`). State summary: the cortex reports `muted` for
both mute and pause so salience stops waiting on it. After a successful `say` it
stays `speaking` until the matching `voice.done` returns it to `idle`/`muted`, or
until `speaking_timeout_ms` releases it (`CTX-GATE-009`).

## Startup, health and shutdown

`index.ts:23-30` builds config, `Bus("cortex")`, the chat provider
(`createChatProvider(cfg.llm)`), the critic and the `Cortex`. The heartbeat starts
immediately with `cortexHealth(() => llmOk, cfg.llm.provider)` (`index.ts:27`).
`main()`:

1. Warn if the provider is `mock` (`index.ts:34`).
2. `waitForLlm` (`startup.ts:20-31`): loop `llm.ping()`; every result goes to
   `setOk` (so `llmOk`); each miss logs a warning and calls
   `heartbeat.degraded("model backend unreachable (name/model): lastError")`; sleep 3 s
   (`retryMs`); never throws, never gives up. The mock provider answers at once.
3. Publish `brain.status idle`, start the subscription, `heartbeat.ready()` once
   the group exists (`CTX-START-003`), log `cortex online` (`index.ts:38-51`).

Health (`health.ts:5-7`): service `cortex`, mode `mock` if the provider is `mock`
else `live`, deps `{llm: ok|down}` read from `llmOk`. After startup every `llm.chat`
outcome feeds `llmOk` through `tracked()`, so a model outage during operation shows
as `degraded` (`CTX-HEALTH-003`); today `llmOk` is assigned only inside
`waitForLlm`, so after `ready()` it stays `true` and an outage surfaces only as
`think failed` log lines. Bedrock has no cheap probe and its `ping()` always answers
true (`packages/llm/src/index.ts:250`); with that provider the heartbeat `detail`
says the `llm` dependency is not probed (`CTX-HEALTH-004`).

Shutdown: `onShutdown` stops the bus (`index.ts:56`); the `stopping` heartbeat is the
heartbeat package's job. Errors thrown inside `main()` log `fatal` and exit 1
(`index.ts:55`).

Config keys read: `brain.working_memory_events`, `brain.memory.recall_k`,
`brain.cortex.{recall_timeout_ms, speaking_timeout_ms, critic.*}`, `cohost.{name,
streamer, timezone}`, `llm.*`. Env: `LLM_PROVIDER` selects the mock preset
(`add-isolated-backends`), `HEARTBEAT_INTERVAL_MS`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Do not await `attention.focus` | `void this.think()` | await inside the handler | Comment `cortex.ts:63-64`: "the LLM call must not block the subscription loop, or the memory reply we're waiting on could never be delivered"; test `cortex.region.test.ts:97` |
| Recall over the bus with timeout | request/reply with `recall_timeout_ms`, proceed with `[]` | call Postgres directly; no timeout | Only memory touches Postgres and the cortex answers without recall when memory is down or slow: comment `index.ts:11-13`, `config/config.example.yaml:115`, commit `969f6d7` ("cortex: ... answers without recall if memory doesn't reply in time") |
| One thought at a time | `thinking` flag plus status echo | queue focuses; cancel in-flight | Status echo: comment `cortex.ts:115` ("Salience assumes we're busy once it fires, so every path out of here reports a status"). Single flight instead of a queue: `[inferred]`; test `cortex.region.test.ts:106` |
| Own vs other `brain.say` | compare `ev.source` to `"cortex"` | tag lines with an origin field | `[inferred]` cheap; relies on bus source naming; `cortex.ts:52` |
| Restart start mode | `latest`: reset the `cortex` group to `$` on every start | `resume` (replay the backlog); drop old focuses by age | owner decision 2026-11-01: a stale `attention.focus` must not produce an LLM call and a late line; only memory keeps its backlog; `CTX-EVT-001` |
| Who sees mute and pause | cortex and salience only | voice and ears also gate on mute | owner decision 2026-11-01: the services that decide to speak own the gate; the body plays what it is given |
| Status publish failures | log and continue on every think exit | let the unawaited think reject | owner decision 2026-11-01: an unhandled rejection ends the process; `CTX-GATE-008` |
| Speaking-timeout release | publish `idle`/`muted` when the timeout fires | release silently on the next think | owner decision 2026-11-01: salience and the dashboard see the release; `CTX-GATE-009` |
| Raw reply logging | raw model text at `debug`, timings and counts at `info` | raw text at `info` | owner decision 2026-11-01: the raw reply can echo chat and is unfiltered; `CTX-PROMPT-007` |
| Reply length | one short spoken line in both the prompt and the llm critic | critic allows two sentences | owner decision 2026-11-01: the critic enforces the prompt's rule; `CTX-CRITIC-006` |
| Transcript tags and stops | working-memory owns the tags; provider stops are a token saver; the self line is not a stop; a cortex test pins tags against stops | model-backends owns the list; stops as a correctness guard | owner decision 2026-11-01: `parseReply` keeps only the first line, so stops only save tokens; `CTX-PROMPT-008` |
| Runtime model health | every `llm.chat` outcome feeds `deps.llm`; Bedrock flagged as unprobed in `detail` | startup ping only | owner decision 2026-11-01: the heartbeat reflects runtime dependency state; `CTX-HEALTH-003`, `CTX-HEALTH-004` |
| Re-check busy and mute after the LLM | drop the reply if something else started speaking | speak anyway | Comment `cortex.ts:147`: "A reflex or operator line may have started while we were thinking; don't talk over it."; test `cortex.region.test.ts:183` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()` | rely on `voice.done` only | Comment `cortex.ts:167` ("stuck-sink safety valve"), `packages/config/src/schema.ts:153` ("Give up on a stuck utterance / voice sink after this long") |
| Operator `say` bypasses gates | no mute, pause or busy check | route through `think` | owner decision 2026-11-01: `say` is the operator's override; `cortex.ts:106`, `CTX-CTRL-006` |
| Viewer notes one-shot, capped | delete after the reply is published, 50 entries FIFO | delete before the LLM call; persistent per-viewer notes | Per-viewer keying: comment `cortex.ts:30` ("so one viewer's framing never lands on another's reply"). Delete after success: owner decision 2026-11-01, so a vetoed or failed reply does not lose the note (`CTX-VIEWER-003`). The 50 cap: `[inferred]` bounded memory |
| `forget_context` scope | clear the window, the vision summary and viewer notes; keep mood and pending recalls | keep the vision summary | owner decision 2026-11-01: a forgotten screen must not keep feeding the prompt and the recall fallback; `CTX-CTRL-004` |
| Recall query | focus text, else the vision summary when the text is empty | fall back only when there is no focus object | owner decision 2026-11-01; `CTX-RECALL-001` |
| Pause reported as `muted` | reuse existing status | add a `paused` state | Comment `cortex.ts:24`: "Reported as \"muted\" so salience stops waiting." |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | Commit `969f6d7`: regions "expose their judgement as a Module"; "cortex.critic: inhibition; can veto or rewrite a reply before it's spoken"; "Any failure falls back to rules". `critic.ts:27-30` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | Comment `startup.ts:15-19` ("Never silent and never fatal ... a supervisor sees `degraded` instead of a service that just hangs"); commit `51d5a9c` ("cortex (LLM down) now idle and report `degraded` instead of exiting or blocking silently") |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | Comment `packages/llm/src/mock.ts:7`: "`[happy] mock: <last user message>`, in the tag format the cortex parses"; tested in `mock.test.ts:23` |

## Open Questions & Future Decisions

### Resolved
1. The owner's decisions of 2026-11-01 (start mode, mute ownership, operator
   override, status-publish failures, speaking-timeout release, raw-reply logging,
   reply length, viewer-note timing, `forget_context` scope, recall fallback,
   runtime model health, tag/stop ownership) are recorded in the Decisions table and
   the spec lines they cite.

### Deferred (observed, unexplained, or technical debt)
1. **Operator `say` and a pending line.** The override overwrites `speakingId`
   (`cortex.ts:189-195`), so a line it interrupts gets no `voice.done`
   reconciliation in the cortex.
2. **Cast and mutability smells.** `emotion` is a `string` from `parseReply` cast to
   `Emotion` (`cortex.ts:143,153`); `let { text, emotion, gesture }` never reassigns
   `gesture`; `viewerNotes.keys().next().value!` uses a non-null assertion
   (`cortex.ts:84`); the 25-message "regular" threshold is a literal (`cortex.ts:78`).
3. **Critic misconfiguration fails outside `main()`.** A rejected critic config
   throws while the module is constructed (`index.ts:29`,
   `packages/modules/src/index.ts:41-48`), so it surfaces as an uncaught exception at
   import rather than through `CTX-START-004`'s `fatal` log; no spec line covers it.
4. **Test coverage.** `index.ts` is untested (wiring, subscription list, heartbeat
   readiness ordering); `cortex.test.ts` only covers `parseReply`; the 50-entry cap,
   the post-think `muted` path with pause, the `recall_k <= 0` skip, the llm critic
   prompt and the operator-`say` gate bypass have no direct assertion.

## References

- Code: `services/cortex/src/{index,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,critic,health,mock,prompt}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (`Bus`, event schemas for the ten subscribed types and
  `brain.status`, `brain.say`, `memory.recall.request`, start mode `latest`),
  config (`loadConfig`, `loadPersonality`, `EMOTIONS`), model-backends
  (`createChatProvider`, `ChatProvider.ping`, `MockProvider`), region-hooks (`Module`
  for `cortex.critic`), working-memory (`Context`, `propagatedFlags`), control-plane
  (heartbeat contract: `startHeartbeat`, `HeartbeatSpec`; manifest start mode `fresh`
  and group `cortex`), memory (request/reply and `memory.viewer`), salience
  (`attention.focus` producer, consumes `brain.status`), affect (`affect.state`),
  voice (`voice.done`)
- Depended on by: salience (waits on `brain.status`), voice and avatar (consume `brain.say`),
  memory (stores `brain.say` as `self`), dashboard (displays `brain.status`, sends `control`)
- External: the configured chat LLM backend (Ollama, OpenAI-compatible, Anthropic, Bedrock, or mock), optional HTTP critic endpoint
- OpenSpec: `openspec/specs/cortex/spec.md`; deltas
  `openspec/changes/archive/2026-11-01-add-service-health/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-service-control/specs/cortex/spec.md`,
  `openspec/changes/archive/2026-11-01-add-test-injection/specs/cortex/spec.md`
