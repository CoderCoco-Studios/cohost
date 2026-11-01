---
parent: high-level-design
prefix: CTX
---

# cortex

Brownfield: this document describes what the code does today, audited against
the code on 2026-11-01. A rationale cell marked `[inferred]` is read from the
code and not confirmed by the owner; any other rationale cell cites the code
comment or commit message that states it.

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
  cortex is busy once it fires (`cortex.ts:115` comment).
- Degrade rather than block: a silent memory region costs `recall_timeout_ms`, a
  failing LLM or critic goes back to `idle`, a down model backend is waited for at
  startup and reported `degraded`.
- All logic lives in the `Cortex` class (`cortex.ts`) with the bus, LLM, critic,
  logger and personality loader injected (`CortexDeps`, `cortex.ts:10-17`);
  `index.ts` is only wiring.

## Event wiring

Subscription (`index.ts:39-49`): group `cortex`, `fromNow: true`, types
`chat.message, speech.heard, vision.summary, brain.say, voice.done, attention.focus,
memory.recall.reply, memory.viewer, affect.state, control`. The service publishes
`brain.status`, `brain.say` and `memory.recall.request`.

Subscribing happens only after the model backend answered `ping()` (`index.ts:36`).
In the bus, `fromNow` only sets where a group starts when the subscription creates
it; a group that already exists resumes after its last delivered entry
(`packages/bus/src/index.ts:17-22`, `126-131`). So:

- events published during the wait are lost only when the `cortex` group does not
  exist yet: on the very first start, or after a control-plane `fresh` start, which
  resets the group to `$` and is cortex's default start mode
  (`packages/control/src/manifest.ts:43`);
- a plain process restart (crash, container restart, a `resume` start) replays
  everything published while the cortex was down, including stale
  `attention.focus` events, each of which can trigger an LLM call.

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
   `speaking` (`cortex.ts:121`). The last two publishes are not guarded (Open
   Questions, item 3).
2. Set `thinking = true` (cleared in `finally`, `cortex.ts:158`), publish
   `thinking` with `focus.reason` as detail.
3. Recall (`cortex.ts:127-128`, `174-186`): the query is `focus.focus?.text ??
   ctx.lastVision`, so the last vision summary is used only when the focus has no
   `focus` object; an empty query (including an empty focus text) skips recall. If
   `brain.memory.recall_k <= 0` no request is made. Otherwise publish
   `memory.recall.request {id: uuid, query, k: recall_k}` and wait up to
   `brain.cortex.recall_timeout_ms` (default 2500) for the reply; timeout logs
   `memory region did not answer in time` and continues with `[]`; a failed publish
   resolves `[]` immediately.
4. Viewer note: look up `focus.focus.who` lowercased and delete it (one-shot,
   `cortex.ts:130-132`); the note is consumed even if the reply is later vetoed or
   fails.
5. `buildMessages` (below), then `llm.chat(messages)` with no per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. The raw model
   text, elapsed ms, reason and memory count are logged at `info` (`cortex.ts:138`).
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
has elapsed (`cortex.ts:168-171`): a stuck voice sink releases the cortex, but no
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
chosen by `reason` and focus kind (`describeFocus`, `prompt.ts:61-70`).

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
`critic.ts:34-43`) and `http` (POST the `CriticInput`). `validate` requires boolean
`ok`, trims `text` and drops blank text, drops unknown `emotion`, keeps `note` only
if a string (`critic.ts:16-24`). Anything unusable, a thrown error or a timeout falls
back to the rules result (pass-through) inside `Module.run`
(`packages/modules/src/index.ts:53-64`), so the critic can never block speech by
failing at run time. A critic configuration the `Module` constructor rejects (for
example `kind: http` with an empty `url`, `packages/modules/src/index.ts:41-48`)
throws while `index.ts:29` builds the critic, before `main()` runs.

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts:162-164`; schema `packages/bus/src/events.ts:59-62`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts:94` |
| `pause` | `paused = true`, publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts:96` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts:97` |
| `mute` / `unmute` | `muted` flag; `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts:99-100` |
| `forget_context` | clear the `Context` event window and viewer notes; `ctx.lastVision`, the mood and pending recalls are kept | `cortex.ts:102`, `packages/working-memory/src/index.ts:81-83` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts:104` |
| `say` with `text` | `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; overwrites `speakingId` | `cortex.ts:106`, `cortex.ts:189-195` |

These are all seven `control` commands in the bus schema
(`packages/bus/src/events.ts:160`). State summary: the cortex reports `muted` for
both mute and pause so salience stops waiting on it. After a successful `say` it
stays `speaking` until the matching `voice.done` returns it to `idle`/`muted`; if no
sink ever reports done, no `idle` status is published (only the internal busy flag
expires).

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
3. Publish `brain.status idle`, start the subscription (not awaited),
   `heartbeat.ready()`, log `cortex online` (`index.ts:38-51`).

Health (`health.ts:5-7`): service `cortex`, mode `mock` if the provider is `mock`
else `live`, deps `{llm: ok|down}` read from `llmOk`. `llmOk` is assigned only inside
`waitForLlm`, so after `ready()` it is constantly `true`; a model outage during
operation surfaces only as `think failed` log lines, not in the heartbeat.

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
| Re-check busy and mute after the LLM | drop the reply if something else started speaking | speak anyway | Comment `cortex.ts:147`: "A reflex or operator line may have started while we were thinking; don't talk over it."; test `cortex.region.test.ts:183` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()` | rely on `voice.done` only | Comment `cortex.ts:167` ("stuck-sink safety valve"), `packages/config/src/schema.ts:147` ("Give up on a stuck utterance / voice sink after this long") |
| Operator `say` bypasses gates | no mute, pause or busy check | route through `think` | `[inferred]` operator override; `cortex.ts:106` |
| Viewer notes one-shot, capped | delete on use, 50 entries FIFO | persistent per-viewer notes | Per-viewer keying: comment `cortex.ts:30` ("so one viewer's framing never lands on another's reply"). Delete-on-use and the 50 cap: `[inferred]` bounded memory |
| Pause reported as `muted` | reuse existing status | add a `paused` state | Comment `cortex.ts:24`: "Reported as \"muted\" so salience stops waiting." |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | Commit `969f6d7`: regions "expose their judgement as a Module"; "cortex.critic: inhibition; can veto or rewrite a reply before it's spoken"; "Any failure falls back to rules". `critic.ts:27-30` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | Comment `startup.ts:15-19` ("Never silent and never fatal ... a supervisor sees `degraded` instead of a service that just hangs"); commit `51d5a9c` ("cortex (LLM down) now idle and report `degraded` instead of exiting or blocking silently") |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | Comment `packages/llm/src/mock.ts:7`: "`[happy] mock: <last user message>`, in the tag format the cortex parses"; tested in `mock.test.ts:23` |

## Open Questions & Future Decisions

### Resolved
1. None authored. Rationale cells that cite a comment or commit are settled by that
   source; everything marked `[inferred]` is unconfirmed.

### Deferred (observed, unexplained, or technical debt)
1. **`deps.llm` is never re-evaluated after ready.** `health.ts:4` comment says it
   follows the last `ping()` result, but `ping()` runs only in `waitForLlm`
   (`startup.ts:23`); LLM failures in `think` are only logged (`cortex.ts:155`).
   Known when the heartbeat landed: commit `691b079` review notes say "cortex `llm`
   dep reflects the startup ping only". OpenSpec `add-service-health` says `ping()`
   failure gives `down`/`degraded`. `CTX-HEALTH-003`.
2. **Raw LLM text is logged at info on every reply** (`cortex.ts:138`, field `raw`),
   which can carry whatever the model emits (chat content echoes, unfiltered text
   before the critic).
3. **Unguarded status publishes can reject an unawaited promise.**
   `await this.status("muted")` and `await this.status("speaking")` on the early gate
   paths (`cortex.ts:119-121`) are outside the `try`, while `think` is invoked as
   `void this.think(...)` (`cortex.ts:65`). A failing publish there is an unhandled
   rejection, which Node's default policy turns into a process exit; no
   `unhandledRejection` handler exists in the repository. The branch at
   `cortex.ts:117` alone has `.catch`. Comment at `cortex.ts:115` claims every path
   reports a status. `CTX-GATE-008`.
4. **Speaking release is silent.** When `speaking_timeout_ms` expires with no
   `voice.done`, the cortex re-opens internally but `brain.status` stays `speaking`
   until its next think publishes something (`cortex.ts:168-171`).
5. **Two reply-length rules.** The cortex prompt asks for "ONE short spoken line"
   (`prompt.ts:37`) while the llm critic blocks lines "longer than two sentences"
   (`critic.ts:38`).
6. **Viewer note consumed before success** (`cortex.ts:130-132`): a vetoed, errored or
   dropped reply loses that viewer's note.
7. **Operator `say` ignores mute, pause and busy** and overwrites `speakingId`
   (`cortex.ts:106`, `cortex.ts:189-195`); it also has no `voice.done`
   reconciliation if it interrupts a pending line. Intent unclear.
8. **Restarts replay the backlog.** `CTX-EVT-001` describes `fromNow` as the bus
   implements it: only a first start or a `fresh` start skips events published while
   the cortex was not subscribed; a plain restart replays them, so stale
   `attention.focus` events can each produce an LLM call and a `brain.say`. The
   earlier wording ("from new events only") may describe the intended behaviour.
9. **Cast and mutability smells.** `emotion` is a `string` from `parseReply` cast to
   `Emotion` (`cortex.ts:143,153`); `let { text, emotion, gesture }` never reassigns
   `gesture`; `viewerNotes.keys().next().value!` uses a non-null assertion
   (`cortex.ts:84`); the 25-message "regular" threshold is a literal (`cortex.ts:78`).
10. **`forget_context` keeps `ctx.lastVision`, `mood` and `pendingRecall`**
    (`cortex.ts:102`; `Context.clear` empties only the event array,
    `packages/working-memory/src/index.ts:81-83`). The kept vision summary still
    appears as the "On screen right now" prompt line and as the recall fallback
    query. `CTX-CTRL-004` now says so; the earlier wording ("clear its working-memory
    window") may have meant the vision summary too.
11. **Recall query fallback.** `CTX-RECALL-001` describes the `??` in
    `cortex.ts:127`: a focus with an empty `text` skips recall instead of falling back
    to the vision summary. The earlier wording ("falling back to the last vision
    summary ... skip the request when both are empty") also reads as falling back on
    empty text.
12. **Critic misconfiguration fails outside `main()`.** A rejected critic config
    throws while the module is constructed (`index.ts:29`,
    `packages/modules/src/index.ts:41-48`), so it surfaces as an uncaught exception at
    import rather than through `CTX-START-004`'s `fatal` log; no spec line covers it.
13. **Test coverage.** `index.ts` is untested (wiring, subscription list, heartbeat
    readiness ordering); `cortex.test.ts` only covers `parseReply`; the 50-entry cap,
    the post-think `muted` path with pause, the `recall_k <= 0` skip, the llm critic
    prompt and the operator-`say` gate bypass have no direct assertion.

## References

- Code: `services/cortex/src/{index,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,critic,health,mock,prompt}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (`Bus`, event schemas for the ten subscribed types and
  `brain.status`, `brain.say`, `memory.recall.request`, `fromNow` group semantics),
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
