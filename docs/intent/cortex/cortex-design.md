---
parent: high-level-design
prefix: CTX
---

# cortex

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01.

## Context and Design Philosophy

cortex is the language region (`services/cortex/src/index.ts:2`): the only region
that generates the main reply (salience and affect `llm` hooks and the cortex critic
hook may also call a model, per the HLD). It does not decide whether to speak
(salience does) and it does not remember beyond a rolling window (memory does).
It waits for `attention.focus`, assembles a prompt from personality, mood, viewer
notes, recalled memories and a working-memory transcript, calls the model, runs the
reply past the `cortex.critic` hook, and publishes `brain.say`.

Observed principles:

- Single-threaded thinking: at most one LLM call in flight, and nothing is spoken
  over someone else's line.
- Every exit from `think()` reports a `brain.status`, because salience assumes the
  cortex is busy once it fires (`cortex.ts:117` comment); a failed status publish is
  logged, never left as an unhandled rejection (`CTX-GATE-008`).
- Turn-taking is owned upstream of the body: cortex and salience are the only
  services that read `mute` and `pause`; voice, mouth and ears stay unaware of them. The
  operator's `say` is an override that bypasses mute, pause and busy.
- Degrade rather than block: a silent memory region costs `recall_timeout_ms`, a
  failing LLM or critic goes back to `idle`, a down model backend is waited for at
  startup and reported `degraded`.
- All logic lives in the `Cortex` class (`cortex.ts`) with the bus, LLM, critic,
  logger and personality loader injected (`CortexDeps`, `cortex.ts:10-17`);
  `index.ts` and `main.ts` are only wiring.

## Event wiring

Subscription (`startup.ts:36-39`, `startup.ts:55-60`): group `cortex`, start mode `latest`, types
`chat.message, speech.heard, vision.summary, brain.say, voice.done, attention.focus,
memory.recall.reply, memory.viewer, affect.state, control`, plus `memory.notes.reply` (never `speech.partial`: an interim transcript is not speech to the cortex, CTX-EVT-009)
once viewer notes land (`CTX-EVT-001`), and `voice.failed` for the spoken fallback
line (`CTX-EVT-008`). The service publishes `brain.status`,
`brain.say`, `memory.recall.request` and `memory.notes.request`.

Subscribing happens only after the model backend answered `ping()` (`main.ts`).
Start mode `latest` resets the `cortex` group to the stream's newest entry on every
start (`CTX-EVT-001`), so nothing published while the cortex was down or waiting
for its backend is delivered: a stale `attention.focus` must never trigger an LLM
call and a late `brain.say`. Delivery across a restart is at-most-once (event-bus).
The control plane's `fresh` start, cortex's default manifest mode
(`packages/control/src/manifest.ts:44`), resets the group as well; `latest` makes a
plain crash or container restart behave the same.

`ready` is reported once the `cortex` group exists (`CTX-START-003`): `startCortex`
(`startup.ts:55-60`) awaits `bus.resetGroup("cortex")`, which creates the group at
the stream's newest entry if it is missing, before it starts the subscription and
calls `heartbeat.ready()`. `Bus.subscribe` creates its group asynchronously and gives
the caller no signal when it has, so readiness cannot hang off it.

| Event in | Handling | Evidence |
|----------|----------|----------|
| `chat.message`, `speech.heard`, `vision.summary` | `ctx.push(ev)` into the `Context` window (`brain.working_memory_events`, default 24) | `cortex.ts:43-47`, `cortex.ts:37` |
| `brain.say` (any source) | `ctx.pushSelf(text, emotion)`; if `ev.source !== "cortex"` also add `d.id` to the pending lines with the time and arm its speaking-timeout release (`startSpeaking`) | `cortex.ts:49-55`, `cortex.ts:184-197` |
| `voice.done` | if `d.id` is a pending line: end it; once no line is pending, publish `brain.status` `muted` (muted or paused) else `idle` | `cortex.ts:57-61` |
| `voice.failed` | with `fallback`: mark the line's transcript entry and keep a pending glitch for the next reply (see Fallback acknowledgement); without `fallback`: nothing | `CTX-FALL-002`, `CTX-FALL-003`, `CTX-FALL-007` |
| `attention.focus` | `this.think(...)` not awaited, so the recall reply can be delivered; a rejection is logged | `cortex.ts:63-68` |
| `memory.recall.reply` | resolve the pending recall with the same `id`; unknown or late ids ignored | `cortex.ts:69-74` |
| `memory.notes.reply` | resolve the pending notes request with the same `id`; unknown or late ids ignored (`CTX-NOTES-003`) | `cortex.ts` |
| `memory.viewer` | build or clear a one-line note for that user | `cortex.ts:75-88` |
| `affect.state` | store as the latest `Mood` | `cortex.ts:89-92` |
| `control` | see Control commands | `cortex.ts:93-110` |

Own versus other lines are distinguished purely by the bus source string:
`ev.source !== "cortex"` (`cortex.ts:54`) depends on `new Bus("cortex", ...)`
(`main.ts`). The cortex's own line is added to the pending lines inside `say()` before
it publishes; lines from salience reflexes or the operator are added on arrival. Pending
lines are a map by `brain.say` id, not a single id: a line stays pending until its own
`voice.done` or its valve, so an operator `say` over a playing line does not forget it
(`CTX-SAY-005`).

## The think pipeline

`think(focus)` (`cortex.ts:115-165`):

1. Gates, in order, each publishing a status and returning without an LLM call:
   already `thinking` → `thinking` with the new reason (`cortex.ts:119`);
   `muted || paused` → `muted` (`cortex.ts:121`); `voiceBusy()` → `speaking`
   (`cortex.ts:123`). A failed publish on these paths is logged and the think
   returns (`CTX-GATE-008`; `statusLogged`, `cortex.ts:168-170`).
2. Set `thinking = true` (cleared in `finally`, `cortex.ts:163`), publish
   `thinking` with `focus.reason` as detail.
3. Recall (`cortex.ts:129-130`, `207-218`): the query is the focus text when it is
   non-empty, else the last vision summary; when both are empty recall is skipped
   (`CTX-RECALL-001`). If
   `brain.memory.recall_k <= 0` no request is made. Otherwise publish
   `memory.recall.request {id: uuid, query, k: recall_k}` and wait up to
   `brain.cortex.recall_timeout_ms` (default 2500) for the reply; timeout logs
   `memory region did not answer in time` and continues with `[]`; a failed publish
   resolves `[]` immediately.
   In parallel, publish `memory.notes.request` for the viewers in the focus and the
   window and wait for its reply under the same deadline (`CTX-NOTES-001`,
   `CTX-NOTES-002`; see Viewer notes).
4. Viewer note: look up `focus.focus.who` lowercased and put it in the prompt; it
   is deleted only once the reply's `brain.say` is published, so a vetoed, dropped
   or failed reply keeps it for the next one (`CTX-VIEWER-003`; looked up at
   `cortex.ts:132-133`, deleted by the `onPublished` callback of `say()`,
   `cortex.ts:156-158`, and only if a newer note has not replaced it meanwhile).
5. `buildMessages` (below), then `llm.chat(messages)` with no per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. Elapsed ms,
   reason and memory count are logged at `info`; the raw model text, which can echo
   chat and is unfiltered by the critic, only at `debug` (`CTX-PROMPT-007`, `cortex.ts:139-140`). Each `llm.chat`
   outcome also feeds `deps.llm` (`CTX-HEALTH-003`; the provider is wrapped by
   `trackLlm`, `startup.ts:64-73`).
6. `parseReply`; if the text is shorter than 2 characters publish `idle` and stop
   (`cortex.ts:142`).
7. Critic (`cortex.critic` module): `ok:false` → log, publish `idle`, stop; a returned
   `text` or `emotion` replaces the originals (`cortex.ts:145-148`).
8. Re-check after the slow work: muted/paused → publish `muted`; `voiceBusy()` (a
   reflex or operator line began) → log `dropped`, publish `speaking`
   (`cortex.ts:151-153`).
9. `say(text, emotion, gesture, focus.reason, propagatedFlags(focus))` publishes
   `brain.say {id, text, emotion, gesture, reason, ...flags}` then `brain.status`
   `speaking` with the text as detail. Flags `injected` and `remember` are copied
   only from an injected focus (`@cohost/working-memory` `propagatedFlags`).
10. Any thrown error is logged `think failed` and publishes `idle` (publish failure
    swallowed, `cortex.ts:159-161`).

`voiceBusy()` also ends every pending line once `speaking_timeout_ms` (default 20000)
has elapsed since it began (`cortex.ts`): a stuck voice sink releases the cortex. The
elapsed time is measured on the monotonic clock (`performance.now`), so a wall
clock stepped forward by NTP or VM time sync does not release a playing line early.
A timer
armed per line when it starts (`startSpeaking`; cleared by that line's `voice.done`)
publishes `idle` (or `muted` when muted or paused) when the timeout elapses and no other
line is pending, so salience and the dashboard see the release (`CTX-GATE-009`); it
stays silent while a think is in flight, which ends with a status of its own, and it
schedules no think.

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
checks it against the provider's stop list (`CTX-PROMPT-008`). `TRANSCRIPT_STOPS`
(`packages/llm/src/index.ts:47`) is not exported, so the test captures the stop list
the real Ollama and OpenAI-compatible providers put on the wire and compares it with
`TRANSCRIPT_TAGS` (`packages/working-memory/src/index.ts:111-113`).

`parseReply` (`prompt.ts:75-89`): first line only; strip a leading `Name:` before a
tag; parse `[emotion]` and optional `[gesture:x]`; strip all remaining bracketed
text, surrounding quotes and a leading `word:`; unknown emotion becomes `neutral`;
gestures are not validated.

### Viewer notes

Two things reach the prompt about viewers.

**The familiarity line** (the `viewerNotes` map in code). `memory.viewer` → note
text: `isNew` gives "`<user>` is new here (first message)."; `regular` true gives
"`<user>` is a regular (N messages)."; otherwise no note (`CTX-VIEWER-001`). Memory
decides who is a regular (the owner's flag or the configured message threshold,
memory `MEM-REG-001`); the cortex holds no threshold of its own and the event
carries no notes text. Notes are keyed by lowercased user, a new event replaces or clears
the old one, and the map is capped at 50 with oldest-first eviction
(`cortex.ts:83-86`).

**Viewer notes from memory** (`CTX-NOTES-*`). The co-host's short notes about
viewers (core: who they are; recent: what they are up to lately) are fetched for
each reply, for the viewer being replied to and for the other viewers in the
working-memory window, whatever their message count. Step 3 of the think pipeline
publishes `memory.notes.request {id, users}` alongside the recall request; `users`
is the focus's `who` followed by the distinct chat users in the window, newest
first (`CTX-NOTES-001`). Both replies share one
`recall_timeout_ms` deadline, and a missing reply means no notes, never a stalled
reply (`CTX-NOTES-002`, HLD tenet 3). Memory has already capped, ordered and
filtered the notes (strongest first, a per-viewer and a total cap, sensitive
notes only for the replied-to viewer and rarely; memory `MEM-SURF-*`).

The notes are rendered in a `### Fallback acknowledgement

When one of the co-host's lines fails to play and a fallback line is said in its place ([mouth](../mouth/mouth-design.md) Fallback Line), she should know she glitched and may joke about it. Owner decisions: the transcript records the fallback as her line with a note that the intended line failed; her next reply gets a prompt hint about the failed line that states a base chance of 1 in 4 (`brain.cortex.fallback_ack_chance`, default 0.25) as a nudge; the model decides in character whether to acknowledge. The cortex does not enforce the chance: there is no random draw, no per-personality number and no check of the reply (`CTX-FALL-006`). A shy personality will mostly shrug it off and a goofy one will milk it, so the real acknowledgement rate drifts with the personality, the model and the moment, and it is not expected to match the configured number. The hint wording, expiry and the handling of several glitches are.

- Every `brain.say` goes into working memory with its id (`CTX-FALL-001`, working-memory `WM-PUSH-007`).
- A `voice.failed` carrying `fallback` marks that line's transcript entry with the fallback text (`CTX-FALL-002`, `WM-PUSH-008`), so every later prompt and the critic's transcript show what was heard and that the intended line failed. It applies to any line, including reflexes and operator lines, because each is in the transcript.
- The same event sets a **pending glitch** (intended text, fallback text), replacing an older one (`CTX-FALL-003`).
- The next think that builds a prompt while a glitch is pending and its line is still in the window (`WM-WIN-007`) adds one line to the `## Now` block (`CTX-FALL-004`): `- Your voice glitched: your line "<intended>" failed to play and everyone heard "<fallback>" instead. You may react to it in character if that fits you; as a rough guide, about <N>% of the time. If it does not fit, let it go.` where `<N>` is the chance as a whole percentage.
- The glitch is consumed once that think's reply is published as `brain.say`; a vetoed, empty or failed reply keeps it for the next think. `forget_context` drops it, and so does its line leaving the window (`CTX-FALL-005`). One reply is the window in which a reaction still reads as one.
- With `fallback_ack_chance` 0 there is no hint line at all; the transcript note stays (`CTX-FALL-004`).
- A `voice.failed` without `fallback` (nothing played) changes nothing in the cortex (`CTX-FALL-007`): the line may still have been heard on another sink, and voice already releases the speaking state through the arbitration protocol.

## People here` block of the system message
(`CTX-NOTES-004`):

```
## People here
- alice: got a new puppy named Biscuit; speedrunning Celeste lately
  - handle gently: check in warmly and gently; never name or quote it
- bob: new to the channel's Minecraft server
```

A viewer's regular status reaches the prompt only through the familiarity line, never as a marker in this block. `general` notes are plain facts. For `health` and `family` notes the model receives
only the handling hint, never the note text: memory leaves the text out of the
reply (memory `MEM-SURF-004`), and a sympathetic check-in works from the hint
alone (`CTX-NOTES-005`). Subscriber status, though memory stores it, never appears
in the prompt, nor does any other money-related detail (`CTX-NOTES-006`). Notes live only
for the think that asked for them, so a note the owner deletes is gone from the
next reply and `forget_context` has nothing to clear (`CTX-NOTES-007`). Note text
never appears in `info` logs or `brain.status` details (`CTX-NOTES-008`).

### Critic (`critic.ts`)

`createCritic` wraps `Module("cortex.critic", cfg.brain.cortex.critic, ...)`
(`critic.ts:46`) from `@cohost/modules`. Kinds: `rules` (default, always
`{ok:true}`), `llm` (an "inner editor" system prompt, JSON reply, 160 tokens,
`critic.ts:34-43`) and `http` (POST the `CriticInput`). The llm critic applies the
reply prompt's length rule, one short spoken line (`CTX-CRITIC-006`,
`critic.ts:38`). `validate` requires boolean
`ok`, trims `text` and drops blank text, drops unknown `emotion`, keeps `note` only
if a string (`critic.ts:16-24`). Anything unusable, a thrown error or a timeout falls
back to the rules result (pass-through) inside `Module.run`
(`packages/modules/src/index.ts:53-63`), so the critic can never block speech by
failing at run time. A critic configuration the `Module` constructor rejects (for
example `kind: http` with an empty `url`, `packages/modules/src/index.ts:41-48`)
throws while `cortexMain` builds the critic, inside the bootstrap's handler, so it
takes the `fatal` path and exits 1 (`CTX-START-005`).

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts:172-174`; schema `packages/bus/src/events.ts:66-69`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts:96` |
| `pause` | `paused = true`, publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts:98` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts:99` |
| `mute` / `unmute` | `muted` flag; `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts:101-102` |
| `forget_context` | clear the `Context` event window, the last vision summary and viewer notes; the mood and pending recalls are kept (`CTX-CTRL-004`; the cortex resets `ctx.lastVision` itself rather than relying on `Context.clear`) | `cortex.ts:104`, `packages/working-memory/src/index.ts:81-84` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts:106` |
| `say` with `text` | operator override: `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; leaves any pending line pending (`CTX-SAY-005`) | `cortex.ts:108`, `cortex.ts:221-227` |

These are all seven `control` commands in the bus schema
(`packages/bus/src/events.ts:177`). State summary: the cortex reports `muted` for
both mute and pause so salience stops waiting on it. After a successful `say` it
stays `speaking` until the matching `voice.done` returns it to `idle`/`muted`, or
until `speaking_timeout_ms` releases it (`CTX-GATE-009`).

## Startup, health and shutdown

`index.ts` calls `runCortex()` (`main.ts`), which runs `cortexMain` on the shared
bootstrap `runService`: logger, configuration, `Bus("cortex")` and the heartbeat in
`starting` come from the bootstrap, whose `health` reads the model backend state
`cortexMain` keeps current (`cortexHealth(() => llmOk, cfg.llm.provider, () => llmProbed)`).
`cortexMain` then builds the chat provider (`createChatProvider(cfg.llm)`), wrapped by
`trackLlm`, the critic and the `Cortex`, and:

1. Warns if the provider is `mock` (`main.ts`).
2. `waitForLlm` (`startup.ts`): loop `llm.ping()`; every result goes to
   `setOk` (so `llmOk`); each miss logs a warning and calls
   `heartbeat.degraded("model backend unreachable (name/model): lastError")`; sleep 3 s
   (`retryMs`); never throws, never gives up. The mock provider answers at once.
3. `startCortex` (`startup.ts`): publish `brain.status idle`, await
   `bus.resetGroup("cortex")`, start the subscription, `heartbeat.ready()`
   (`CTX-START-003`); then log `cortex online`.

Health (`health.ts:9-15`): service `cortex`, mode `mock` if the provider is `mock`
else `live`, deps `{llm: ok|down|n/a}` read from `llmOk` and `llmProbed`. After
startup every `llm.chat` outcome feeds `llmOk` through `tracked()` (`trackLlm`,
`startup.ts:64-73`), so a model outage during operation shows as `degraded` and a
recovered backend as `ok` again (`CTX-HEALTH-003`). Bedrock has no cheap probe and
its `ping()` always answers true (`pingIsNominal`, `packages/llm/src/index.ts:263`);
with that provider `llm` reads `n/a` (not probed) until the first reply outcome. The
intended marker is a standing heartbeat `detail` (`CTX-HEALTH-004`); the heartbeat
API clears `detail` on `ready()` and `HeartbeatSpec` has no `detail`
(`packages/bus/src/heartbeat.ts`), so the text waits on a bus change.

Shutdown: the bootstrap runs the teardown steps (`Cortex.stop` releases the line timers),
then stops the bus; the `stopping` heartbeat is the heartbeat module's job. A pause also
shows as the heartbeat `detail` `paused` (`CTX-HEALTH-005`). Errors thrown inside
`cortexMain` log `fatal` and exit 1; a configuration that does not load logs the
loader's message and exits 1 (`CTX-START-004`).

Config keys read: `brain.working_memory_events`, `brain.memory.recall_k`,
`brain.cortex.{recall_timeout_ms, speaking_timeout_ms, critic.*}`, `cohost.{name,
streamer, timezone}`, `llm.*`. Env: `LLM_PROVIDER` selects the mock preset
(`add-isolated-backends`), `HEARTBEAT_INTERVAL_MS`.

## Latency stamps

A `brain.say` the cortex publishes for an `attention.focus` carries `timing` (CTX-SAY-006, CTX-SAY-007): the focus's own `timing` (`audioEndedAt`, `heardAt`) copied unchanged, `focusedAt` (the `attention.focus` envelope `ts`), `llmStartedAt` (just before the think's first LLM request) and `llmEndedAt` (after the reply call returns), and, when the `cortex.critic` hook ran, `criticEndedAt` when its call returns (CTX-SAY-008). The time between `focusedAt` and `llmStartedAt` is recall and viewer-note lookups; the time after the last of these stamps up to the `brain.say` envelope `ts` is the publish itself. A critic that is off, or not asked because the reply is a single character, leaves `criticEndedAt` absent. A think whose reply is vetoed, empty or failed publishes no `brain.say` and so no sample. An operator `say` and a salience reflex are not thinks and carry no `llm` stamps.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Do not await `attention.focus` | `void this.think()` | await inside the handler | Comment `cortex.ts:65-66`: "the LLM call must not block the subscription loop, or the memory reply we're waiting on could never be delivered"; test `cortex.region.test.ts:97` |
| Pending lines | A map of lines by id, each with its own valve and timer; idle is published when the map empties | A single speaking id that a newer line overwrites | Owner decision 2026-11-11: an operator `say` over a playing line must not make the cortex forget it, so each line's `voice.done` is reconciled and the cortex reports idle only when nothing is playing. Overlap itself is voice's documented non-exclusivity. |
| Service construction | Provider, critic and `Cortex` are built inside `cortexMain` under `runService` | Build them at module load | A critic configuration the hook rejects must fail through the `fatal` path with the other startup errors, not as an uncaught exception at import (`CTX-START-005`). |
| Reply emotion type | `parseReply` returns an `Emotion`, narrowing the model's tag against the emotion list | A string cast to `Emotion` at each use | The cast hid the one place where the value is checked. |
| Recall over the bus with timeout | request/reply with `recall_timeout_ms`, proceed with `[]` | call Postgres directly; no timeout | Only memory touches Postgres and the cortex answers without recall when memory is down or slow: comment `index.ts:11-13`, `config/config.example.yaml:115`, commit `969f6d7` ("cortex: ... answers without recall if memory doesn't reply in time") |
| One thought at a time | `thinking` flag plus status echo | queue focuses; cancel in-flight | Status echo: comment `cortex.ts:117` ("Salience assumes we're busy once it fires, so every path out of here reports a status"). Single flight instead of a queue: a queued focus would be answered after the conversation had moved on, and salience re-decides on fresh context every tick once the cortex reports idle, so a dropped focus costs nothing; cancelling the in-flight call would waste the model work already spent. Test `cortex.region.test.ts:106` |
| Own vs other `brain.say` | compare `ev.source` to `"cortex"` | tag lines with an origin field | The bus stamps every event with the publishing service's name (`new Bus("cortex")`), so no extra field is needed. Cortex marks its own lines speaking at publish time (`say()`), so only another source's line (for example a salience reflex) starts the speaking state from the echo. This relies on each service using its own name as the bus source; `cortex.ts:54` |
| Restart start mode | `latest`: reset the `cortex` group to `$` on every start | `resume` (replay the backlog); drop old focuses by age | owner decision 2026-11-01: a stale `attention.focus` must not produce an LLM call and a late line; only memory keeps its backlog; `CTX-EVT-001` |
| Who sees mute and pause | cortex and salience only | voice, mouth and ears also gate on mute | owner decision 2026-11-01: the services that decide to speak own the gate; the body plays what it is given |
| Status publish failures | log and continue on every think exit | let the unawaited think reject | owner decision 2026-11-01: an unhandled rejection ends the process; `CTX-GATE-008` |
| Speaking-timeout release | publish `idle`/`muted` when the timeout fires | release silently on the next think | owner decision 2026-11-01: salience and the dashboard see the release; `CTX-GATE-009` |
| Raw reply logging | raw model text at `debug`, timings and counts at `info` | raw text at `info` | owner decision 2026-11-01: the raw reply can echo chat and is unfiltered; `CTX-PROMPT-007` |
| Reply length | one short spoken line in both the prompt and the llm critic | critic allows two sentences | owner decision 2026-11-01: the critic enforces the prompt's rule; `CTX-CRITIC-006` |
| Transcript tags and stops | working-memory owns the tags; provider stops are a token saver; the self line is not a stop; a cortex test pins tags against stops | model-backends owns the list; stops as a correctness guard | owner decision 2026-11-01: `parseReply` keeps only the first line, so stops only save tokens; `CTX-PROMPT-008` |
| Runtime model health | every `llm.chat` outcome feeds `deps.llm`; Bedrock flagged as unprobed (`detail` intended; `deps.llm: n/a` until the first reply) | startup ping only | owner decision 2026-11-01: the heartbeat reflects runtime dependency state; `CTX-HEALTH-003`, `CTX-HEALTH-004` |
| Readiness | `ready` after `resetGroup("cortex")` resolves, then the subscription starts | `ready` straight after `void subscribe`; a bus hook announcing group creation | `Bus.subscribe` creates its group inside the long-running call and signals nothing; `resetGroup` is awaitable, creates a missing group at `$` and is the same start-mode `latest` move; `CTX-START-003`, test `startup.test.ts:22` |
| Re-check busy and mute after the LLM | drop the reply if something else started speaking | speak anyway | Comment `cortex.ts:149`: "A reflex or operator line may have started while we were thinking; don't talk over it."; test `cortex.region.test.ts:183` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()`, plus a timer that publishes the release (`CTX-GATE-009`) | rely on `voice.done` only | Comment `cortex.ts:177` ("stuck-sink safety valve"), `packages/config/src/schema.ts:153` ("Give up on a stuck utterance / voice sink after this long") |
| Operator `say` bypasses gates | no mute, pause or busy check | route through `think` | owner decision 2026-11-01: `say` is the operator's override; `cortex.ts:108`, `CTX-CTRL-006` |
| Acknowledging a fallback line | A one-shot hint stating the base chance; the model decides in character; no enforcement | A random draw in code that adds the hint only on a hit; a per-personality chance; always acknowledge | Owner decision: the co-host's character should decide, so a shy personality shrugs a glitch off and a goofy one milks it. The cost is that the real rate drifts from the configured value; the configured value is a nudge, not a guarantee. `CTX-FALL-004`, `CTX-FALL-006` |
| Glitch lifetime | Consumed by the next published reply; dropped by `forget_context` or when its line leaves the window | A time limit; keep until the model acknowledges | The next reply is where a reaction makes sense; tying expiry to the window needs no new setting. `CTX-FALL-005` |
| Viewer notes one-shot, capped | delete after the reply is published, 50 entries FIFO | delete before the LLM call; persistent per-viewer notes | Per-viewer keying: comment `cortex.ts:32` ("so one viewer's framing never lands on another's reply"). Delete after success: owner decision 2026-11-01, so a vetoed or failed reply does not lose the note (`CTX-VIEWER-003`). The 50 cap bounds memory on a long stream: a note is replaced on each `memory.viewer` for that viewer and used once, so evicting the oldest only loses a note for a viewer not replied to since 50 newer viewer notes arrived |
| Who gets viewer notes in the prompt | The replied-to viewer and every other chat user in the working-memory window, regardless of message count | replied-to viewer only; regulars only (the earlier `msgCount > 25` gate) | Owner decision: the co-host should know the people in the conversation it is answering, and notes are kept for everyone from their first message. `CTX-NOTES-001`, `CTX-NOTES-007` |
| Fetching notes | Request/reply per think, in parallel with recall, one shared deadline | cache notes pushed by memory |. Current notes on every reply (owner deletions take effect at once) and no added latency beyond the recall wait the cortex already accepts; memory's design records the alternatives. `CTX-NOTES-002` |
| Rendering sensitive notes | Handling hint only; the note text never reaches the model | plain facts like any note; hint plus the text as private background | Owner decision (the safest option): sensitive notes shape behaviour rather than being quoted, and a model that never sees the text cannot repeat it on stream. The cost is a vaguer check-in than the text would allow. `CTX-NOTES-005` |
| Subscriber status in the prompt | Never rendered | `(subscriber)` marker | Owner decision (the safest option): memory may remember it, but no money-related detail reaches the prompt, so the co-host cannot call anyone out by it. `CTX-NOTES-006` |
| `forget_context` scope | clear the window, the vision summary and viewer notes; keep mood and pending recalls | keep the vision summary | owner decision 2026-11-01: a forgotten screen must not keep feeding the prompt and the recall fallback; `CTX-CTRL-004` |
| Recall query | focus text, else the vision summary when the text is empty | fall back only when there is no focus object | owner decision 2026-11-01; `CTX-RECALL-001` |
| Pause reported as `muted` | reuse existing status | add a `paused` state | Comment `cortex.ts:24`: "Reported as \"muted\" so salience stops waiting." |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | Commit `969f6d7`: regions "expose their judgement as a Module"; "cortex.critic: inhibition; can veto or rewrite a reply before it's spoken"; "Any failure falls back to rules". `critic.ts:27-30` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | Comment `startup.ts:17-21` ("Never silent and never fatal ... a supervisor sees `degraded` instead of a service that just hangs"); commit `51d5a9c` ("cortex (LLM down) now idle and report `degraded` instead of exiting or blocking silently") |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | Comment `packages/llm/src/mock.ts:7`: "`[happy] mock: <last user message>`, in the tag format the cortex parses"; tested in `mock.test.ts:23` |
| Critic stamped separately | `llmEndedAt` ends at the reply call; the critic has its own `criticEndedAt` | Fold the critic into `llm`; stamp only the reply call | The critic is an optional hook whose model call can be as long as the reply; its own stage shows what turning it on costs, and a think without a critic simply has no critic sample. |

## Open Questions & Future Decisions

None.

## References

- Code: `services/cortex/src/{index,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,critic,health,mock,prompt,startup,transcript-stops}.test.ts`
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
