# affect Specification

## Purpose
The affect region keeps a running valence/arousal mood that decays toward a baseline and publishes it as `affect.state`. It consumes senses from the bus and never calls a database.

## Requirements
### Requirement: Event subscriptions and nudges
The system SHALL subscribe (group `affect`, `fromNow`) to `chat.message`, `speech.heard`, `vision.summary`, `brain.say` and `control`, and nudge mood per event type.

#### Scenario: Subscriber chat
- **WHEN** a `chat.message` with `isSub` true arrives
- **THEN** mood is nudged by valence +0.05, arousal +0.05 with cause `sub: <user>`

#### Scenario: Screen change
- **WHEN** a `vision.summary` with `changed` true arrives
- **THEN** arousal is nudged +0.08 with cause `screen changed`

#### Scenario: Own emotional speech
- **WHEN** a `brain.say` arrives with emotion happy, laugh or smug
- **THEN** valence is nudged +0.08 (sad or angry: -0.08, others 0) and arousal +0.05

#### Scenario: Forget context
- **WHEN** `control` with `cmd` `forget_context` arrives
- **THEN** valence returns to `baseline_valence` and arousal to 0.1 with cause `reset`

### Requirement: Mood model and decay
The system SHALL clamp valence to [-1,1] and arousal to [0,1], and decay both exponentially toward baseline (valence to `brain.affect.baseline_valence`, arousal to 0.1) with half-life `brain.affect.half_life_ms`.

#### Scenario: Half-life decay
- **WHEN** one `half_life_ms` elapses with no events
- **THEN** the distance from baseline is halved

#### Scenario: Clamping
- **WHEN** a nudge would push valence above 1 or arousal below 0
- **THEN** the value is clamped to the range bound

### Requirement: Mood label
The system SHALL map valence/arousal to an Emotion via `label`: arousal > 0.6 gives laugh (v > 0.3), angry (v < -0.3) or surprised; arousal > 0.3 gives happy (v > 0.2), confused (v < -0.2) or think; otherwise smug (v > 0.35), sad (v < -0.3) or neutral.

#### Scenario: High-arousal positive
- **WHEN** valence is 0.5 and arousal 0.8
- **THEN** the label is `laugh`

#### Scenario: Calm
- **WHEN** valence is 0 and arousal 0.1
- **THEN** the label is `neutral`

### Requirement: Rule-based appraisal
The system SHALL appraise chat and speech lines with `appraiseRules`: base arousal delta 0.03 (chat) or 0.15 (speech), +0.2 on mention, positive words +0.12 valence/+0.05 arousal, negative words -0.15 valence/+0.08 arousal, `!!` or 5+ capitals +0.05 arousal, `?` +0.03 arousal.

#### Scenario: Positive chat
- **WHEN** a non-mention chat line "lol nice" is appraised by rules
- **THEN** valence_delta is 0.12 and arousal_delta is 0.08

#### Scenario: Negative mention
- **WHEN** a chat line mentioning the co-host contains "trash"
- **THEN** valence_delta is -0.15 and arousal_delta is 0.31

### Requirement: Appraiser module kinds and queueing
The system SHALL build the appraiser as module `affect.appraiser` from `brain.affect.module` (rules, llm or http), clamping llm/http deltas to +-0.5 and falling back to rules on invalid output. Non-rules appraisers SHALL run on a queue of at most 8 jobs, dropping the oldest, and lines under 4 characters without a mention SHALL be appraised by rules inline.

#### Scenario: Rules kind is inline
- **WHEN** the appraiser kind is `rules`
- **THEN** the appraisal is applied immediately without queueing

#### Scenario: Backlog overflow
- **WHEN** more than 8 llm appraisals are waiting
- **THEN** the oldest waiting lines are discarded

#### Scenario: Out-of-range delta
- **WHEN** an llm returns valence_delta 2
- **THEN** it is clamped to 0.5

### Requirement: Publishing affect.state
The system SHALL publish `affect.state` `{valence, arousal, mood, cause}` (values rounded to 3 decimals) every `brain.affect.publish_ms` (default 2000), but only when the rounded state key changed or 15 seconds have passed since the last publish.

#### Scenario: Unchanged state
- **WHEN** the timer fires and the state key equals the last one published less than 15 s ago
- **THEN** nothing is published

#### Scenario: Heartbeat
- **WHEN** the state is unchanged but 15 s have passed
- **THEN** `affect.state` is published again
