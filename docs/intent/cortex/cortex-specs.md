# cortex specs

## Event handling

- [x] **CTX-EVT-001**: The cortex shall subscribe to the bus in consumer group `cortex`, from new events only, for `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `voice.done`, `attention.focus`, `memory.recall.reply`, `memory.viewer`, `affect.state` and `control`. <!-- openspec: cortex § Inputs and context --> <!-- test: none (services/cortex/src/index.ts:36-46 is untested) -->
- [x] **CTX-EVT-002**: When a `chat.message`, `speech.heard` or `vision.summary` arrives, the cortex shall add it to its working-memory window of `brain.working_memory_events` events. <!-- openspec: cortex § Inputs and context --> <!-- test: services/cortex/test/cortex.region.test.ts:34 -->
- [x] **CTX-EVT-003**: When a `brain.say` arrives from any source, the cortex shall add it to its working memory as a self line with its text and emotion. <!-- openspec: cortex § Inputs and context --> <!-- test: services/cortex/test/cortex.region.test.ts:142 -->
- [x] **CTX-EVT-004**: When a `brain.say` arrives whose bus source is not `cortex`, the cortex shall record its `id` as the speaking id so that thinking is deferred while it plays. <!-- openspec: cortex § Inputs and context (Foreign line) --> <!-- test: services/cortex/test/cortex.region.test.ts:128 -->
- [x] **CTX-EVT-005**: When a `voice.done` arrives whose `id` equals the speaking id, the cortex shall clear the speaking id and publish `brain.status` `idle`, or `muted` if the cortex is muted or paused; a `voice.done` with any other `id` shall be ignored. <!-- openspec: cortex § Inputs and context (voice.done) --> <!-- test: services/cortex/test/cortex.region.test.ts:128 -->
- [x] **CTX-EVT-006**: When an `attention.focus` arrives, the cortex shall start thinking without awaiting the result, so the subscription loop can still deliver the `memory.recall.reply` it is waiting for. <!-- openspec: cortex § Think gating --> <!-- test: services/cortex/test/cortex.region.test.ts:91 -->
- [x] **CTX-EVT-007**: When an `affect.state` arrives, the cortex shall keep it as the current mood for later prompts. <!-- openspec: cortex § Viewer notes and mood --> <!-- test: services/cortex/test/cortex.region.test.ts:255 -->

## Think gating

- [x] **CTX-GATE-001**: When a focus arrives while a think is already in flight, the cortex shall publish `brain.status` `thinking` with the new focus reason and shall not call the LLM. <!-- openspec: cortex § Think gating (Overlapping focus) --> <!-- test: services/cortex/test/cortex.region.test.ts:99 -->
- [x] **CTX-GATE-002**: While the cortex is muted or paused, a focus shall publish `brain.status` `muted` and make no LLM call. <!-- openspec: cortex § Think gating (Muted); add-service-control § Targeted pause and resume --> <!-- test: services/cortex/test/cortex.region.test.ts:117, services/cortex/test/cortex.region.test.ts:283 -->
- [x] **CTX-GATE-003**: While another line (or its own) is still playing, a focus shall publish `brain.status` `speaking` and make no LLM call. <!-- openspec: cortex § Think gating --> <!-- test: services/cortex/test/cortex.region.test.ts:128, services/cortex/test/cortex.region.test.ts:160 -->
- [x] **CTX-GATE-004**: When `brain.cortex.speaking_timeout_ms` (default 20000) has elapsed since a line began without a matching `voice.done`, the cortex shall treat the voice as free and think again. <!-- openspec: cortex § Think gating --> <!-- test: services/cortex/test/cortex.region.test.ts:150 -->
- [x] **CTX-GATE-005**: When the LLM call returns while the cortex has become muted or paused, the cortex shall drop its reply and publish `brain.status` `muted`. <!-- openspec: cortex § Saying and control --> <!-- test: services/cortex/test/cortex.region.test.ts:181 -->
- [x] **CTX-GATE-006**: When the LLM call returns after another line started speaking, the cortex shall drop its reply and publish `brain.status` `speaking`. <!-- openspec: cortex § Saying and control (Spoken over while thinking) --> <!-- test: services/cortex/test/cortex.region.test.ts:170 -->
- [x] **CTX-GATE-007**: The cortex shall clear its thinking flag on every exit from a think, including errors, so a later focus can run. <!-- test: services/cortex/test/cortex.region.test.ts:199 -->
- [ ] **CTX-GATE-008**: If publishing `brain.status` fails on a gated early-return path (muted, paused or speaking), the cortex shall absorb the failure instead of raising an unhandled promise rejection from the unawaited think. <!-- gap [inferred]: cortex.ts:103-104 await this.status(...) outside try/catch, think called as void at cortex.ts:61; only cortex.ts:102 has .catch; comment cortex.ts:101 says every path reports a status -->

## Memory recall

- [x] **CTX-RECALL-001**: Before calling the LLM, the cortex shall publish `memory.recall.request` with a fresh `id`, `k = brain.memory.recall_k` and the focus text as the query, falling back to the last vision summary, and shall skip the request when both are empty. <!-- openspec: cortex § Memory recall --> <!-- test: services/cortex/test/cortex.region.test.ts:46, services/cortex/test/cortex.region.test.ts:60 -->
- [x] **CTX-RECALL-002**: Where `brain.memory.recall_k` is 0 or less, the cortex shall not publish a recall request. <!-- openspec: cortex § Memory recall (Disabled recall) --> <!-- test: services/cortex/test/cortex.region.test.ts:24 (default setup relies on it) -->
- [x] **CTX-RECALL-003**: When no matching `memory.recall.reply` arrives within `brain.cortex.recall_timeout_ms` (default 2500), the cortex shall log a warning and continue with no memories. <!-- openspec: cortex § Memory recall (Timeout); add-isolated-backends § Isolation preset and closure --> <!-- test: services/cortex/test/cortex.region.test.ts:72, services/cortex/test/mock.test.ts:30 -->
- [x] **CTX-RECALL-004**: If publishing the recall request fails, the cortex shall continue with no memories immediately. <!-- openspec: cortex § Memory recall --> <!-- test: services/cortex/test/cortex.region.test.ts:82 -->
- [x] **CTX-RECALL-005**: When a `memory.recall.reply` arrives, the cortex shall resolve only the recall with the same `id` and ignore replies for other ids. <!-- test: services/cortex/test/cortex.region.test.ts:46 -->

## Viewer notes

- [x] **CTX-VIEWER-001**: When a `memory.viewer` arrives, the cortex shall store the note `"<user> is new here (first message)."` if `isNew`, `"<user> is a regular (N messages)."` plus any notes if `msgCount` is above 25, and no note otherwise. <!-- openspec: cortex § Viewer notes and mood --> <!-- test: services/cortex/test/cortex.region.test.ts:226 -->
- [x] **CTX-VIEWER-002**: The cortex shall key viewer notes by lowercased user, let a later `memory.viewer` replace or clear the earlier note, and keep at most 50 notes by evicting the oldest. <!-- openspec: cortex § Viewer notes and mood --> <!-- test: services/cortex/test/cortex.region.test.ts:247 (cap untested) -->
- [x] **CTX-VIEWER-003**: When a think's focus names a viewer who has a note, the cortex shall put the note in that reply's prompt and delete it, so it is used once and never in another viewer's reply. <!-- openspec: cortex § Viewer notes and mood (One-shot use) --> <!-- test: services/cortex/test/cortex.region.test.ts:226 -->

## Prompt and reply

- [x] **CTX-PROMPT-001**: The cortex shall build a two-message prompt: a system message with the trimmed personality, local time in `cohost.timezone`, streamer, co-host name, the emotion-tag output instruction, and a user message with the recent transcript (or `(quiet)`) and a closing nudge. <!-- openspec: cortex § Prompt and reply parsing --> <!-- test: services/cortex/test/prompt.test.ts:24, services/cortex/test/prompt.test.ts:57 -->
- [x] **CTX-PROMPT-002**: The cortex shall include the on-screen line, mood line, viewer note and remembered-memories block in the system message only when each has content, rendering memories as `- (YYYY-MM-DD) who: text`. <!-- openspec: cortex § Prompt and reply parsing --> <!-- test: services/cortex/test/prompt.test.ts:32, services/cortex/test/prompt.test.ts:52 -->
- [x] **CTX-PROMPT-003**: The cortex shall describe the current mood to the model in words derived from valence and arousal thresholds, not raw numbers. <!-- openspec: cortex § Viewer notes and mood --> <!-- test: services/cortex/test/prompt.test.ts:43 -->
- [x] **CTX-PROMPT-004**: The cortex shall choose the closing nudge from the focus reason and kind (idle chatter, mention, speech, unmentioned chat, vision, none). <!-- openspec: cortex § Prompt and reply parsing --> <!-- test: services/cortex/test/prompt.test.ts:64 -->
- [x] **CTX-PROMPT-005**: When parsing a model reply, the cortex shall use only the first line, read a leading `[emotion]` and optional `[gesture:name]`, strip other bracketed text, quotes and `Name:` prefixes, and map an unknown emotion to `neutral`. <!-- openspec: cortex § Prompt and reply parsing --> <!-- test: services/cortex/test/cortex.test.ts:5 -->
- [x] **CTX-PROMPT-006**: When the parsed reply text is shorter than two characters, the cortex shall publish no `brain.say` and publish `brain.status` `idle`. <!-- openspec: cortex § Critic inhibition (text >= 2 chars) --> <!-- test: services/cortex/test/cortex.region.test.ts:189 -->
- [x] **CTX-PROMPT-007**: When the LLM replies, the cortex shall log the elapsed time, focus reason, memory count and the raw reply text at info level. <!-- code: services/cortex/src/cortex.ts:118; no OpenSpec statement; raw text logging is a privacy question --> <!-- test: none -->

## Critic

- [x] **CTX-CRITIC-001**: When a reply has two or more characters, the cortex shall pass `{text, emotion, reason, transcript}` through the `cortex.critic` module configured by `brain.cortex.critic`. <!-- openspec: cortex § Critic inhibition --> <!-- test: services/cortex/test/cortex.region.test.ts:210 -->
- [x] **CTX-CRITIC-002**: When the critic returns `ok: false`, the cortex shall log the note, publish no `brain.say` and publish `brain.status` `idle`. <!-- openspec: cortex § Critic inhibition (Veto) --> <!-- test: services/cortex/test/cortex.region.test.ts:210 -->
- [x] **CTX-CRITIC-003**: When the critic returns `text` or a valid `emotion`, the cortex shall speak the replacement text and use the replacement emotion. <!-- openspec: cortex § Critic inhibition (Rewrite) --> <!-- test: services/cortex/test/cortex.region.test.ts:210 -->
- [x] **CTX-CRITIC-004**: Where the critic kind is `rules`, the cortex shall pass every line through unchanged. <!-- openspec: cortex § Critic inhibition --> <!-- test: services/cortex/test/critic.test.ts:33 -->
- [x] **CTX-CRITIC-005**: When an `llm` or `http` critic output is unusable (no boolean `ok`), the cortex shall fall back to pass-through, and shall drop a blank `text` or an unknown `emotion` from a usable output. <!-- openspec: cortex § Critic inhibition --> <!-- test: services/cortex/test/critic.test.ts:48, services/cortex/test/critic.test.ts:54 -->

## Saying

- [x] **CTX-SAY-001**: When the cortex has a final line, it shall publish `brain.say` with a fresh `id`, text, emotion, gesture and the focus reason, and then publish `brain.status` `speaking` with the text as detail. <!-- openspec: cortex § Saying and control --> <!-- test: services/cortex/test/cortex.region.test.ts:34 -->
- [x] **CTX-SAY-002**: When a think starts and passes the gates, the cortex shall publish `brain.status` `thinking` with the focus reason before recalling memories. <!-- test: services/cortex/test/cortex.region.test.ts:34 -->
- [x] **CTX-SAY-003**: If a think throws, the cortex shall log `think failed`, publish `brain.status` `idle` and remain able to think again. <!-- openspec: cortex § Saying and control --> <!-- test: services/cortex/test/cortex.region.test.ts:199 -->
- [x] **CTX-SAY-004**: While waiting for `voice.done` for its own line, the cortex shall not start another think. <!-- openspec: cortex § Think gating --> <!-- test: services/cortex/test/cortex.region.test.ts:160 -->

## Control

- [x] **CTX-CTRL-001**: When a `control` event has a `target` other than `cortex`, the cortex shall ignore it; an event with no target applies to the cortex. <!-- openspec: add-service-control § Targeted pause and resume --> <!-- test: services/cortex/test/cortex.region.test.ts:283, services/cortex/test/cortex.region.test.ts:299 -->
- [x] **CTX-CTRL-002**: When `control` `pause` is addressed to the cortex, the cortex shall stop starting LLM calls, publish `brain.status` `muted` with detail `paused`, and keep ingesting events; `resume` shall return it to `idle` (or `muted` if also muted). <!-- openspec: add-service-control § Targeted pause and resume --> <!-- test: services/cortex/test/cortex.region.test.ts:283 -->
- [x] **CTX-CTRL-003**: When `control` `mute` or `unmute` is addressed to the cortex, the cortex shall publish `brain.status` `muted`, or `idle` (`muted` if still paused) respectively, and make no LLM call while muted. <!-- openspec: cortex § Think gating (Muted) --> <!-- test: services/cortex/test/cortex.region.test.ts:117 -->
- [x] **CTX-CTRL-004**: When `control` `forget_context` is addressed to the cortex, the cortex shall clear its working-memory window and its viewer notes. <!-- openspec: cortex § Saying and control --> <!-- test: services/cortex/test/cortex.region.test.ts:262 -->
- [x] **CTX-CTRL-005**: When `control` `reload_personality` is addressed to the cortex, the cortex shall re-read the personality file for later prompts. <!-- openspec: cortex § Saying and control --> <!-- test: services/cortex/test/cortex.region.test.ts:262 -->
- [x] **CTX-CTRL-006**: When `control` `say` with text is addressed to the cortex, the cortex shall publish `brain.say` with that text, emotion `neutral` and reason `operator` without checking mute, pause or voice busy; `say` without text shall do nothing. <!-- openspec: cortex § Saying and control (Operator say) --> <!-- test: services/cortex/test/cortex.region.test.ts:262 (gate bypass not asserted) -->

## Test injection

- [x] **CTX-INJ-001**: When the cortex answers an `attention.focus` with `injected` true, it shall publish `brain.say` with `injected: true` and the focus's `remember` value unchanged. <!-- openspec: add-test-injection § Injection flag propagation --> <!-- test: services/cortex/test/cortex.region.test.ts:308 -->
- [x] **CTX-INJ-002**: When the cortex answers a real focus, or handles `control` `say`, it shall publish `brain.say` carrying neither `injected` nor `remember`. <!-- openspec: add-test-injection § Injection flag propagation --> <!-- test: services/cortex/test/cortex.region.test.ts:318 -->

## Startup and shutdown

- [x] **CTX-START-001**: Before subscribing, the cortex shall call `llm.ping()` every 3 seconds until it succeeds, never exiting while the backend is down, and shall log each failure and report a degraded heartbeat with the backend name, model and last error. <!-- openspec: add-isolated-backends § Startup with the mock provider; add-service-health § Heartbeat --> <!-- test: services/cortex/test/mock.test.ts:37 -->
- [x] **CTX-START-002**: Where `llm.provider` is `mock`, the cortex shall start immediately, log a warning that replies are canned, and answer `attention.focus` with a `brain.say` having non-empty text and a valid emotion. <!-- openspec: add-isolated-backends § Startup with the mock provider --> <!-- test: services/cortex/test/mock.test.ts:22 -->
- [x] **CTX-START-003**: When the LLM backend is reachable, the cortex shall publish `brain.status` `idle`, subscribe, then report `ready` in its heartbeat. <!-- openspec: add-service-health § Heartbeat --> <!-- test: none (index.ts:35-47 is untested) -->
- [x] **CTX-START-004**: If startup throws, the cortex shall log a fatal error and exit with code 1; on shutdown it shall stop the bus. <!-- code: index.ts:51-52 --> <!-- test: none -->

## Health

- [x] **CTX-HEALTH-001**: The cortex heartbeat shall report service `cortex` with mode `mock` when `llm.provider` is `mock` and `live` otherwise. <!-- openspec: add-service-health § Heartbeat; add-isolated-backends § Isolation preset and closure --> <!-- test: services/cortex/test/health.test.ts:6, services/cortex/test/health.test.ts:20 -->
- [x] **CTX-HEALTH-002**: The cortex heartbeat shall report `deps.llm` as `ok` or `down` from the latest `ping()` result seen during startup, with state `degraded` while it is `down`. <!-- openspec: add-service-health § Heartbeat (LLM unreachable) --> <!-- test: services/cortex/test/health.test.ts:14 -->
- [ ] **CTX-HEALTH-003**: While running after startup, the cortex shall set `deps.llm` to `down` when the model backend stops answering and back to `ok` when it recovers. <!-- gap [inferred]: llmOk is written only by waitForLlm (index.ts:26,34; startup.ts:23), health.ts:3 comment says it follows the last ping(), think() failures only log (cortex.ts:129-131) -->
