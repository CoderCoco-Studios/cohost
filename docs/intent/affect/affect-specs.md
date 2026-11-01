# affect specs

Prefix `AFF`. Design: [affect-design.md](affect-design.md). Code: `services/affect/`.

## Event Intake (IN)

- [x] **AFF-IN-001**: When the affect service starts, it shall subscribe with consumer group `affect`, starting from the stream tail (`fromNow`), to `chat.message`, `speech.heard`, `vision.summary`, `brain.say` and `control`. <!-- openspec: affect § Event subscriptions and nudges -->
- [x] **AFF-IN-002**: When affect receives a `chat.message`, it shall appraise the line as source `chat` (passing `mentionsCohost`) and set the mood cause to `chat: <user>`. <!-- openspec: affect § Event subscriptions and nudges --> <!-- test: services/affect/test/affect.region.test.ts:34 -->
- [x] **AFF-IN-003**: When affect receives a `speech.heard` event, it shall appraise the line as source `speech` with `mention` false and set the mood cause to `voice: <speaker>`. <!-- test: services/affect/test/affect.region.test.ts:34 -->
- [x] **AFF-IN-004**: When affect receives a `chat.message` with `isSub` true, it shall additionally nudge valence by +0.05 and arousal by +0.05 with cause `sub: <user>`. <!-- openspec: affect § Event subscriptions and nudges --> <!-- test: services/affect/test/affect.region.test.ts:45 -->
- [x] **AFF-IN-005**: When affect receives a `vision.summary` with `changed` true, it shall nudge arousal by +0.08 with cause `screen changed`; when `changed` is false it shall not change the mood. <!-- openspec: affect § Event subscriptions and nudges --> <!-- test: services/affect/test/affect.region.test.ts:45 -->
- [x] **AFF-IN-006**: When affect receives a `brain.say`, it shall nudge valence by +0.08 for emotion `happy`, `laugh` or `smug`, by -0.08 for `sad` or `angry`, by 0 for any other emotion, and arousal by +0.05, with cause `said: <emotion>`. <!-- openspec: affect § Event subscriptions and nudges --> <!-- test: services/affect/test/affect.region.test.ts:45 -->
- [x] **AFF-IN-007**: When affect receives `control` `forget_context` addressed to it, it shall set valence to `baseline_valence` and arousal to 0.1 with cause `reset`. <!-- openspec: affect § Event subscriptions and nudges --> <!-- test: services/affect/test/affect.region.test.ts:68 -->

## Mood Model (MOOD)

- [x] **AFF-MOOD-001**: The affect mood shall start at valence `brain.affect.baseline_valence` (default 0.15) and arousal 0.1. <!-- openspec: affect § Mood model and decay --> <!-- test: services/affect/test/affect.test.ts:34 -->
- [x] **AFF-MOOD-002**: When the mood is nudged, affect shall clamp valence to [-1, 1] and arousal to [0, 1]. <!-- openspec: affect § Mood model and decay --> <!-- test: services/affect/test/affect.test.ts:34 -->
- [x] **AFF-MOOD-003**: When time elapses, affect shall decay valence toward `baseline_valence` and arousal toward a fixed resting value of 0.1 exponentially, halving the distance every `brain.affect.half_life_ms` (default 45000), applying the decay lazily whenever the mood is nudged, appraised or published. <!-- openspec: affect § Mood model and decay --> <!-- test: services/affect/test/affect.test.ts:34 -->
- [x] **AFF-MOOD-004**: When affect labels a mood, it shall map arousal above 0.6 to `laugh` (valence above 0.3), `angry` (valence below -0.3) or `surprised`; arousal above 0.3 to `happy` (valence above 0.2), `confused` (valence below -0.2) or `think`; otherwise to `smug` (valence above 0.35), `sad` (valence below -0.3) or `neutral`. <!-- openspec: affect § Mood label --> <!-- test: services/affect/test/affect.test.ts:22 -->
- [x] **AFF-MOOD-005**: When affect reports its state, it shall round valence and arousal to 3 decimals and include the label and the most recent cause. <!-- openspec: affect § Publishing affect.state --> <!-- test: services/affect/test/affect.test.ts:49 -->

## Rule Appraisal (APPR)

- [x] **AFF-APPR-001**: When the rules appraiser appraises a line, it shall start from an arousal delta of +0.15 for speech or +0.03 for chat, and add +0.2 arousal when the line mentions the co-host. <!-- openspec: affect § Rule-based appraisal --> <!-- test: services/affect/test/affect.test.ts:11 -->
- [x] **AFF-APPR-002**: When a line contains a word from the positive list (or a positive emoji), the rules appraiser shall add +0.12 valence and +0.05 arousal; when it contains a word from the negative list (or a negative emoji), it shall add -0.15 valence and +0.08 arousal; when both match the deltas net together. <!-- openspec: affect § Rule-based appraisal --> <!-- test: services/affect/test/appraiser.test.ts:47 -->
- [x] **AFF-APPR-003**: When a line contains two or more consecutive `!` or five or more consecutive capital letters, the rules appraiser shall add +0.05 arousal; when it contains `?` it shall add +0.03 arousal. <!-- openspec: affect § Rule-based appraisal --> <!-- test: services/affect/test/affect.test.ts:11 -->
- [x] **AFF-APPR-004**: When a line contains a single emoji, the rules appraiser shall match it against exactly one of the positive or negative lists, and a bare variation selector shall match neither. <!-- test: services/affect/test/affect.test.ts:58 -->

## Appraiser Hook and Queue (HOOK)

- [x] **AFF-HOOK-001**: The affect service shall build its appraiser as module `affect.appraiser` from `brain.affect.module` with kind `rules`, `llm` or `http`. <!-- openspec: affect § Appraiser module kinds and queueing -->
- [x] **AFF-HOOK-002**: Where the appraiser kind is `llm` or `http`, affect shall accept the module output only if both `valence_delta` and `arousal_delta` are finite numbers, clamping each to [-0.5, 0.5]. <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/appraiser.test.ts:31 -->
- [x] **AFF-HOOK-003**: If the llm or http appraiser fails or returns output that violates the deltas contract, then affect shall appraise the line with the rules (fallback implemented by the module in region-hooks). <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/appraiser.test.ts:39 -->
- [x] **AFF-HOOK-004**: Where the appraiser kind is `rules`, affect shall apply the appraisal inline in the event handler without queueing. <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/affect.region.test.ts:34 -->
- [x] **AFF-HOOK-005**: Where the appraiser kind is `llm` or `http`, affect shall queue each line to a single worker that appraises one line at a time, so the bus handler never waits on the module, and shall appraise a queued line against the mood current when the job runs. <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/affect.region.test.ts:97 -->
- [x] **AFF-HOOK-006**: While more than 8 appraisal jobs are waiting for an llm or http appraiser, affect shall discard the oldest waiting jobs. <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/affect.region.test.ts:124 -->
- [x] **AFF-HOOK-007**: Where the appraiser kind is `llm` or `http`, affect shall appraise a line shorter than 4 characters (after trimming) that does not mention the co-host with the rules inline, and shall always send a mention to the module. <!-- openspec: affect § Appraiser module kinds and queueing --> <!-- test: services/affect/test/affect.region.test.ts:113 -->
- [ ] **AFF-HOOK-008**: When `control` `pause` or `forget_context` is handled, affect shall discard queued llm/http appraisal jobs so a stale job cannot change the mood afterwards. Gap: the queue is neither cleared nor checked against `paused` (`services/affect/src/affect.ts:36-38,68,94-99`); OpenSpec requires that the mood is not nudged while paused. <!-- openspec: affect § Targeted pause and resume -->

## Publishing (PUB)

- [x] **AFF-PUB-001**: While the affect service is running, it shall evaluate whether to publish `affect.state` every `brain.affect.publish_ms` (default 2000); the first evaluation after start shall publish. <!-- openspec: affect § Publishing affect.state --> <!-- test: services/affect/test/affect.region.test.ts:77 -->
- [x] **AFF-PUB-002**: When the publish interval fires and the key of mood label plus 2-decimal valence and arousal equals the last published key and less than 15 seconds have passed, affect shall not publish. <!-- openspec: affect § Publishing affect.state --> <!-- test: services/affect/test/affect.region.test.ts:77 -->
- [x] **AFF-PUB-003**: When the state key has changed, or 15 seconds have passed since the last publish, affect shall publish `affect.state` with `valence`, `arousal`, `mood` and `cause`. <!-- openspec: affect § Publishing affect.state --> <!-- test: services/affect/test/affect.region.test.ts:77 -->
- [ ] **AFF-PUB-004**: If publishing `affect.state` fails, then the affect service shall log the failure and continue. Gap: `void this.d.bus.publish(...)` has no catch (`services/affect/src/affect.ts:110`), so a rejection is unhandled and terminates the process under Node defaults.

## Control (CTRL)

- [x] **AFF-CTRL-001**: If a `control` event carries a `target` other than `affect`, then affect shall ignore it; an absent target addresses all services. <!-- openspec: affect § Targeted pause and resume --> <!-- test: services/affect/test/affect.region.test.ts:133 -->
- [x] **AFF-CTRL-002**: While affect is paused by `control` `pause`, it shall not nudge the mood from any non-control event. <!-- openspec: affect § Targeted pause and resume --> <!-- test: services/affect/test/affect.region.test.ts:133 -->
- [x] **AFF-CTRL-003**: While affect is paused, it shall continue to decay the mood and publish `affect.state`. <!-- openspec: affect § Targeted pause and resume --> <!-- test: services/affect/test/affect.region.test.ts:150 -->
- [x] **AFF-CTRL-004**: When affect receives `control` `resume` addressed to it, it shall resume nudging the mood in-process without restarting. <!-- openspec: affect § Targeted pause and resume --> <!-- test: services/affect/test/affect.region.test.ts:133 -->

## Health and Lifecycle (HEALTH)

- [x] **AFF-HEALTH-001**: The affect service shall publish `service.heartbeat` with `service` `affect`, `mode` `live` and empty `deps` via `startHeartbeat`, emitting `starting` at boot, `ready` once subscription and publish timer are set up, and one `stopping` on graceful shutdown. <!-- openspec: affect § Heartbeat --> <!-- test: services/affect/test/health.test.ts:6 -->
- [x] **AFF-HEALTH-002**: If affect fails during startup (`main` rejects), then it shall log a fatal error and exit with code 1.
