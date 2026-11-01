# salience specs

Prefix `SAL`. Design: [salience-design.md](salience-design.md). Code: `services/salience/`.

## Intake (IN)

- [x] **SAL-IN-001**: When the salience service starts, it shall subscribe with consumer group `salience`, starting from the stream tail (`fromNow`), to `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state` and `control`. <!-- openspec: salience § Inputs and working memory -->
- [x] **SAL-IN-002**: When salience receives a `chat.message` or `speech.heard` event, it shall push the event into its working-memory `Context` (sized `brain.working_memory_events`, default 24) and reset the scheduler's idle timer. <!-- openspec: salience § Inputs and working memory --> <!-- test: services/salience/test/salience.region.test.ts:28 -->
- [x] **SAL-IN-003**: When salience receives a `vision.summary` event, it shall push the event into its `Context` without resetting the idle timer. <!-- openspec: salience § Inputs and working memory -->
- [x] **SAL-IN-004**: When salience receives an `affect.state` event, it shall store the event's `arousal` for threshold adjustment and for the scorer input. <!-- openspec: salience § Inputs and working memory --> <!-- test: services/salience/test/salience.region.test.ts:98 -->
- [x] **SAL-IN-005**: When salience receives a `brain.status` event, it shall record the reported state and the time received for busy detection. <!-- openspec: salience § Busy detection --> <!-- test: services/salience/test/salience.region.test.ts:52 -->

## Scoring (SCORE)

- [x] **SAL-SCORE-001**: When salience scores an event with the built-in `rules` scorer, it shall assign speech 0.9; a chat mention 1.0 while `reply_on_mention` is true; chat containing `?` 0.55; chat from a mod or sub 0.35; other chat 0.15; changed vision 0.3; unchanged vision 0. <!-- openspec: salience § Rule-based scoring --> <!-- test: services/salience/test/salience.test.ts:21 -->
- [x] **SAL-SCORE-002**: Where `brain.salience.reply_on_mention` is false, the salience rules scorer shall treat a chat mention as ordinary chat (scored by question mark, mod/sub, then 0.15). <!-- openspec: salience § Rule-based scoring --> <!-- test: services/salience/test/scorer.test.ts:32 -->
- [x] **SAL-SCORE-003**: When salience prepares scorer input, it shall flatten the unseen non-`self` working-memory events in order into `{kind, who, text, mention, isMod, isSub, changed}` entries together with the current arousal. <!-- test: services/salience/test/salience.test.ts:38 -->
- [x] **SAL-SCORE-004**: Where `brain.salience.module.kind` is `llm` or `http`, salience shall accept the module's output only if it is an object whose `scores` is an array of finite numbers with exactly one entry per input event, clamping each score to 0..1. <!-- openspec: salience § Scorer module kinds --> <!-- test: services/salience/test/scorer.test.ts:37 -->
- [x] **SAL-SCORE-005**: If the llm or http scorer fails or returns output that violates the scores contract, then salience shall score the batch with the rules weights (fallback implemented by the `salience.scorer` module in region-hooks). <!-- openspec: salience § Scorer module kinds --> <!-- test: services/salience/test/scorer.test.ts:42 -->
- [x] **SAL-SCORE-006**: When a scheduler decision runs, salience shall send only events not yet scored to the scorer and reuse the cached score for events that remain unseen across ticks. <!-- openspec: salience § Scorer module kinds --> <!-- test: services/salience/test/salience.test.ts:101 -->

## Speak Decision (DECIDE)

- [x] **SAL-DECIDE-001**: When the scheduler decides, it shall return no-speak with reason `muted` if muted, else `cortex busy` if the cortex is busy, else `cooldown` if less than `cooldown_ms` (default 6000) has passed since the last line, else `nothing new` if there are no unseen non-`self` events, in that order. <!-- openspec: salience § Speak decision --> <!-- test: services/salience/test/salience.test.ts:63 -->
- [x] **SAL-DECIDE-002**: When unseen events exist, the scheduler shall compute the total score as the sum of all unseen events' scores and choose the highest-scoring event as the focus. <!-- test: services/salience/test/salience.region.test.ts:28 -->
- [x] **SAL-DECIDE-003**: When the total score is at least `max(0.1, speak_threshold - arousal_bias * arousal)` (defaults 0.6 and 0.2), the scheduler shall decide to speak with reason `mentioned` if the focus is a chat mention, otherwise `engaged`. <!-- openspec: salience § Speak decision --> <!-- test: services/salience/test/salience.test.ts:83 -->
- [x] **SAL-DECIDE-004**: When the total score is below threshold, `idle_chatter_ms` is greater than 0, and more than `idle_chatter_ms` has elapsed since the last chat, speech or spoken line, the scheduler shall decide to speak with reason `idle chatter`. <!-- openspec: salience § Speak decision --> <!-- test: services/salience/test/salience.test.ts:92 -->
- [x] **SAL-DECIDE-005**: If there are no unseen non-`self` events, then the scheduler shall decide not to speak with reason `nothing new` even when `idle_chatter_ms` has elapsed (idle chatter requires at least one unseen event; see design Open Question 1). <!-- openspec: salience § Speak decision --> <!-- test: services/salience/test/salience.test.ts:68 -->
- [x] **SAL-DECIDE-006**: If the total score is below threshold and idle chatter does not apply, then the scheduler shall decide not to speak with reason `score <total> < <threshold>`. <!-- openspec: salience § Speak decision --> <!-- test: services/salience/test/salience.test.ts:70 -->
- [x] **SAL-DECIDE-007**: When a decision to speak is made, the scheduler shall report as `scored` exactly the events it evaluated, so that events arriving while an async scorer runs are not marked seen. <!-- test: services/salience/test/salience.test.ts:117 -->

## Focus Publication (FOCUS)

- [x] **SAL-FOCUS-001**: While the salience service is running and not paused, it shall run a decision every `brain.salience.tick_ms` (default 1500). <!-- openspec: salience § Publishing attention.focus -->
- [x] **SAL-FOCUS-002**: While a previous scheduler decision is still in flight, salience shall skip the next tick without calling the scorer again. <!-- openspec: salience § Publishing attention.focus --> <!-- test: services/salience/test/salience.region.test.ts:108 -->
- [x] **SAL-FOCUS-003**: When a decision is to speak, salience shall publish `attention.focus` with `reason`, `score` and a focus of `{kind:"chat", who, text, mention}`, `{kind:"speech", who, text}`, `{kind:"vision", text}` or none. <!-- openspec: salience § Publishing attention.focus --> <!-- test: services/salience/test/salience.region.test.ts:28 -->
- [x] **SAL-FOCUS-004**: When salience publishes `attention.focus`, it shall mark only the scored events seen and treat the cortex as `thinking` until a new `brain.status` or valve expiry. <!-- openspec: salience § Publishing attention.focus --> <!-- test: services/salience/test/salience.region.test.ts:52 -->

## Busy Gating (BUSY)

- [x] **SAL-BUSY-001**: While the last observed cortex state is `thinking` and was set less than 60 seconds ago, salience shall treat the cortex as busy. <!-- openspec: salience § Busy detection -->
- [x] **SAL-BUSY-002**: While the last observed cortex state is `speaking` and was set less than `brain.cortex.speaking_timeout_ms` (default 20000) ago, salience shall treat the cortex as busy. <!-- openspec: salience § Busy detection --> <!-- test: services/salience/test/salience.region.test.ts:64 -->
- [x] **SAL-BUSY-003**: When salience receives a `brain.say` event from any source (cortex, reflex echo or operator), it shall start the speaking cooldown and set the cortex state to `speaking`. <!-- openspec: salience § Busy detection --> <!-- test: services/salience/test/salience.region.test.ts:75 -->
- [x] **SAL-BUSY-004**: While the last observed cortex state is `idle` or `muted`, salience shall not treat the cortex as busy. <!-- test: services/salience/test/salience.region.test.ts:52 -->

## Reflexes (REFLEX)

- [x] **SAL-REFLEX-001**: When a chat, speech or changed-vision event's text matches a configured reflex rule's case-insensitive regex and the event's sense is listed in the rule's `on`, salience shall publish `brain.say` with a randomly chosen `say` line, the rule's emotion and gesture, and `reason` `reflex: <match>`. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.region.test.ts:121 -->
- [x] **SAL-REFLEX-002**: When salience receives a `vision.summary` with `changed` false, it shall not evaluate reflex rules against it. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.region.test.ts:130 -->
- [x] **SAL-REFLEX-003**: When a reflex rule fires, salience shall not fire that same rule again until its `cooldown_ms` (default 30000) has elapsed, and the first matching rule in config order shall win. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.test.ts:48 -->
- [x] **SAL-REFLEX-004**: When a reflex fires, salience shall mark only the triggering event seen, leaving other unseen events available to the next decision. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.region.test.ts:121 -->
- [x] **SAL-REFLEX-005**: While the cortex is busy or the global `cooldown_ms` since the last line has not elapsed, salience shall not fire reflexes, and shall evaluate this gate before spending any rule's own cooldown. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.region.test.ts:141 -->
- [x] **SAL-REFLEX-006**: While salience is muted or paused, it shall not fire reflexes. <!-- openspec: salience § Reflex fast path --> <!-- test: services/salience/test/salience.region.test.ts:141 -->
- [ ] **SAL-REFLEX-007**: When salience publishes a reflex `brain.say`, it shall immediately start its own cooldown and mark the voice as speaking, rather than waiting for the line to echo back on the bus. Gap: the reflex path calls neither `noteSpoke()` nor sets cortex state (`services/salience/src/salience.ts:98` vs `:59-64`); the echo does it later.

## Control (CTRL)

- [x] **SAL-CTRL-001**: If a `control` event carries a `target` other than `salience`, then salience shall ignore it; an absent target addresses all services. <!-- openspec: salience § Targeted pause and resume --> <!-- test: services/salience/test/salience.region.test.ts:183 -->
- [x] **SAL-CTRL-002**: When salience receives `control` `pause` addressed to it, it shall publish no `attention.focus` and no reflex `brain.say` while continuing to record incoming events in its `Context`. <!-- openspec: salience § Targeted pause and resume --> <!-- test: services/salience/test/salience.region.test.ts:162 -->
- [x] **SAL-CTRL-003**: When salience receives `control` `resume` addressed to it, it shall resume deciding and firing reflexes in-process without restarting. <!-- openspec: salience § Targeted pause and resume --> <!-- test: services/salience/test/salience.region.test.ts:162 -->
- [x] **SAL-CTRL-004**: While salience is muted by `control` `mute` (cleared by `unmute`), the scheduler shall decide no-speak with reason `muted` and publish no `attention.focus`. <!-- openspec: salience § Inputs and working memory --> <!-- test: services/salience/test/salience.region.test.ts:84 -->
- [x] **SAL-CTRL-005**: When salience receives `control` `forget_context`, it shall clear its working-memory `Context`. <!-- openspec: salience § Inputs and working memory --> <!-- test: services/salience/test/salience.region.test.ts:84 -->

## Injection Flags (INJ)

- [x] **SAL-INJ-001**: When the focus event of a speak decision is an injected event, salience shall publish `attention.focus` with `injected: true` and that event's `remember` value. <!-- openspec: salience § Injection flag propagation --> <!-- test: services/salience/test/salience.region.test.ts:193 -->
- [x] **SAL-INJ-002**: When the focus event is a real event (even one carrying a stray `remember`) or there is no focus event, salience shall publish `attention.focus` with neither `injected` nor `remember`. <!-- openspec: salience § Injection flag propagation --> <!-- test: services/salience/test/salience.region.test.ts:202 -->
- [x] **SAL-INJ-003**: When a decision's batch mixes injected and real events, salience shall derive `attention.focus` flags only from the focus event. <!-- openspec: salience § Injection flag propagation --> <!-- test: services/salience/test/salience.region.test.ts:210 -->
- [x] **SAL-INJ-004**: When a reflex is triggered by an injected event, salience shall copy `injected` and `remember` onto the reflex `brain.say`; when triggered by a real event it shall omit both. <!-- openspec: salience § Injection flag propagation --> <!-- test: services/salience/test/salience.region.test.ts:220 -->

## Health and Lifecycle (HEALTH)

- [x] **SAL-HEALTH-001**: The salience service shall publish `service.heartbeat` with `service` `salience`, `mode` `live` and empty `deps` via `startHeartbeat`, emitting `starting` at boot, `ready` once subscription and tick timer are set up, and one `stopping` on graceful shutdown. <!-- openspec: salience § Heartbeat --> <!-- test: services/salience/test/health.test.ts:6 -->
- [ ] **SAL-HEALTH-002**: If a scheduler tick or `attention.focus` publish fails, then the salience service shall log the error and keep running. Gap: `void salience.tick()` (`services/salience/src/index.ts:36`) leaves rejections unhandled, which terminates the process under Node defaults.
- [x] **SAL-HEALTH-003**: If salience fails during startup (`main` rejects), then it shall log a fatal error and exit with code 1.
