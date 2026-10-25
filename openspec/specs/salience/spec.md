# salience Specification

## Purpose
The salience region decides when the co-host should speak. It scores incoming senses, publishes `attention.focus` when worth a reply, and runs a reflex fast path that publishes `brain.say` directly. It never calls the chat LLM.

## Requirements
### Requirement: Inputs and working memory
The system SHALL subscribe (group `salience`, `fromNow`) to `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state` and `control`, keeping a `Context` of `brain.working_memory_events` (default 24) events.

#### Scenario: Senses are recorded
- **WHEN** a chat, speech or vision event arrives
- **THEN** it is pushed to the context; chat and speech also reset the idle timer

#### Scenario: Arousal tracked
- **WHEN** `affect.state` arrives
- **THEN** its `arousal` is stored for threshold adjustment

#### Scenario: Control commands
- **WHEN** `control` `mute` / `unmute` / `forget_context` arrives
- **THEN** salience sets muted, clears muted, or clears the context respectively

### Requirement: Rule-based scoring
The system SHALL score each unseen event with `scoreRules`: speech 0.9; chat mention 1.0 when `reply_on_mention` else falls through; chat containing `?` 0.55; mod or sub 0.35; other chat 0.15; vision 0.3 if `changed` else 0.

#### Scenario: Mention
- **WHEN** a chat event mentions the co-host and `reply_on_mention` is true
- **THEN** its score is 1.0

#### Scenario: Plain chat
- **WHEN** a non-mention, non-mod chat line has no question mark
- **THEN** its score is 0.15

### Requirement: Scorer module kinds
The system SHALL build the scorer as module `salience.scorer` from `brain.salience.module` (rules, llm, http); llm/http output SHALL be accepted only if `scores` is a numeric array with exactly one entry per event, clamped to 0..1.

#### Scenario: Wrong length
- **WHEN** an llm returns fewer scores than events
- **THEN** the output is invalid and the module falls back to rules

#### Scenario: Cached scores
- **WHEN** an event stays unseen across ticks
- **THEN** it is not re-scored

### Requirement: Speak decision
The system SHALL decide in `Scheduler.decide`, in order: muted gives no speak ("muted"); busy ("cortex busy"); within `cooldown_ms` (default 6000) ("cooldown"); no unseen non-self events ("nothing new"); summed score >= `max(0.1, speak_threshold - arousal_bias * arousal)` (defaults 0.6, 0.2) speaks with reason "mentioned" (focus is a mention) or "engaged"; else idle chatter when `idle_chatter_ms` > 0 (default 90000) elapsed since activity.

#### Scenario: Threshold lowered by arousal
- **WHEN** arousal is 1 with defaults
- **THEN** the threshold is 0.4

#### Scenario: Idle chatter
- **WHEN** score is below threshold and no activity for more than `idle_chatter_ms`
- **THEN** it speaks with reason "idle chatter"

#### Scenario: Below threshold
- **WHEN** the score is under the threshold and not idle
- **THEN** it does not speak, with reason `score X < Y`

### Requirement: Publishing attention.focus
The system SHALL tick every `brain.salience.tick_ms` (default 1500), skipping if a prior decision is still running; on speak it SHALL mark only the scored events seen, treat the cortex as `thinking`, and publish `attention.focus` `{reason, score, focus}` where focus is `{kind:"chat",who,text,mention}`, `{kind:"speech",who,text}`, `{kind:"vision",text}` or undefined.

#### Scenario: Focus published
- **WHEN** a decision says speak with a chat focus
- **THEN** `attention.focus` carries the focus with `who` set to the chat user

#### Scenario: Overlapping tick
- **WHEN** a scorer call outlasts the tick interval
- **THEN** the next tick is skipped

### Requirement: Busy detection
The system SHALL treat the cortex as busy while `brain.status` is `thinking` for under 60 s, or `speaking` (also set by any `brain.say`) for under `brain.cortex.speaking_timeout_ms`.

#### Scenario: Stuck cortex
- **WHEN** state has been `thinking` for 60 s or more
- **THEN** salience no longer treats it as busy

### Requirement: Reflex fast path
The system SHALL match chat, speech and changed-vision text against `brain.salience.reflexes` (case-insensitive regex `match`, `on` senses, per-rule `cooldown_ms` default 30000), and on a hit publish `brain.say` `{id,text,emotion,gesture,reason:"reflex: <match>"}` with a random `say` entry. Reflexes SHALL be skipped when muted, when the cortex is busy, or inside the global cooldown, before the rule's cooldown is spent.

#### Scenario: Reflex hit
- **WHEN** a chat line matches an idle rule
- **THEN** `brain.say` is published and only the triggering event is marked seen

#### Scenario: Rule cooldown
- **WHEN** the same rule matches again within its `cooldown_ms`
- **THEN** it does not fire

#### Scenario: Busy cortex
- **WHEN** the cortex is speaking
- **THEN** no reflex fires
