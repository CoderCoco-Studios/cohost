# cortex Specification

## Purpose
The cortex is the only region that calls the chat LLM. It turns `attention.focus` into a spoken line published as `brain.say`, using working memory, recalled memories, mood and viewer notes, and reports `brain.status`.

## Requirements

### Requirement: Inputs and context
The system SHALL subscribe (group `cortex`, `fromNow`) to `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `voice.done`, `attention.focus`, `memory.recall.reply`, `memory.viewer`, `affect.state` and `control`, keeping a `Context` of `brain.working_memory_events` events; every `brain.say` (any source) is added as a self line.

#### Scenario: Foreign line
- **WHEN** a `brain.say` with source other than `cortex` arrives
- **THEN** its `id` becomes the speaking id and think is deferred while it plays

#### Scenario: voice.done
- **WHEN** `voice.done` matches the speaking id
- **THEN** status returns to `idle` (or `muted` if muted)

### Requirement: Think gating
The system SHALL, on `attention.focus` (not awaited), publish `brain.status` and return without calling the LLM when already thinking (`thinking`), muted (`muted`) or the voice is busy (`speaking`); voice busy expires after `brain.cortex.speaking_timeout_ms` (default 20000).

#### Scenario: Muted
- **WHEN** a focus arrives while muted
- **THEN** `brain.status` `muted` is published and no LLM call is made

#### Scenario: Overlapping focus
- **WHEN** a focus arrives during an in-flight think
- **THEN** status `thinking` is republished

### Requirement: Memory recall
The system SHALL, before the LLM call, publish `memory.recall.request` `{id,query,k}` with the focus text (else last vision) and `k = brain.memory.recall_k`, and wait up to `brain.cortex.recall_timeout_ms` (default 2500) for the matching `memory.recall.reply`. It SHALL proceed with no memories on timeout, publish failure, or `recall_k <= 0`.

#### Scenario: Timeout
- **WHEN** no reply arrives in time
- **THEN** the cortex answers with an empty memory list

#### Scenario: Disabled recall
- **WHEN** `recall_k` is 0
- **THEN** no request is published

### Requirement: Viewer notes and mood
The system SHALL keep viewer notes keyed by lowercased user from `memory.viewer`: "is new here" if `isNew`, "is a regular (N messages)" with notes if `msgCount > 25`, otherwise none; capped at 50 entries (oldest evicted), consumed once when that viewer is the focus. The latest `affect.state` SHALL be described in the prompt.

#### Scenario: Regular
- **WHEN** `memory.viewer` has `msgCount` 30
- **THEN** a regular note is stored for that user

#### Scenario: One-shot use
- **WHEN** a focus names that user
- **THEN** the note is included in the prompt and deleted

### Requirement: Prompt and reply parsing
The system SHALL build a system+user message pair (personality, local time in `cohost.timezone`, streamer, name, screen, mood, viewer note, memories, emotion-tag instruction, transcript, focus nudge) and parse the first reply line with `parseReply` into `{text, emotion, gesture}`: leading `[emotion]` and optional `[gesture:name]`, other brackets/quotes/`Name:` prefixes stripped, unknown emotion becomes `neutral`.

#### Scenario: Tagged reply
- **WHEN** the model returns `[happy] [gesture:wave] hi there`
- **THEN** emotion is `happy`, gesture `wave`, text `hi there`

#### Scenario: Unknown emotion
- **WHEN** the tag is not in `EMOTIONS`
- **THEN** emotion is `neutral`

### Requirement: Critic inhibition
The system SHALL pass each line (text >= 2 chars) through the `cortex.critic` module (`brain.cortex.critic`; rules kind is pass-through). `ok=false` SHALL drop the line and set status `idle`; a returned `text` or valid `emotion` SHALL replace the originals.

#### Scenario: Veto
- **WHEN** the critic returns `ok: false`
- **THEN** no `brain.say` is published and status is `idle`

#### Scenario: Rewrite
- **WHEN** the critic returns `ok: true` with `text`
- **THEN** the rewritten text is spoken

### Requirement: Saying and control
The system SHALL publish `brain.say` `{id,text,emotion,gesture,reason}` followed by status `speaking`, re-checking mute and voice-busy after the LLM returns, and SHALL handle `control`: `mute`, `unmute`, `forget_context` (clears context and viewer notes), `reload_personality`, and `say` (speaks given text as neutral, reason `operator`). Errors in think SHALL log and set status `idle`.

#### Scenario: Spoken over while thinking
- **WHEN** another line starts speaking during the LLM call
- **THEN** the cortex's line is dropped and status `speaking` is published

#### Scenario: Operator say
- **WHEN** `control` `say` with text arrives
- **THEN** `brain.say` is published with reason `operator`

### Requirement: Heartbeat
The cortex service SHALL publish `service.heartbeat` with `service: "cortex"` via `startHeartbeat`: `starting` at boot, `ready` once the chat LLM backend answered `llm.ping()`, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{llm}`. It MUST report `mode: "live"` while a real backend is used.

#### Scenario: Ready
- **WHEN** cortex has finished starting
- **THEN** a heartbeat with `service: "cortex"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: LLM unreachable
- **WHEN** `llm.ping()` fails
- **THEN** `deps.llm` is `down` and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** cortex receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0

### Requirement: Startup with the mock provider
The cortex SHALL start and subscribe once `llm.ping()` is true; with `llm.provider: mock` this is immediate, and it MUST then answer `attention.focus` with `brain.say` using the mock reply through the normal parsing, critic and inhibition paths. With a real provider it SHALL keep waiting for `ping()` as before, while reporting `degraded` with the model backend down (heartbeat from change `add-service-health`) rather than silently blocking.

#### Scenario: Mock answers
- **WHEN** `llm.provider` is `mock` and `attention.focus` arrives
- **THEN** a `brain.say` is published with non-empty text and a valid emotion

#### Scenario: Real backend down
- **WHEN** `llm.provider` is `ollama` and Ollama is unreachable
- **THEN** the cortex keeps retrying and reports degraded; it does not exit

### Requirement: Isolation preset and closure
`LLM_PROVIDER=mock` SHALL be the cortex isolation preset (heartbeat `mode` `mock`). An isolated cortex run MUST include its bus-level requirements salience and affect (the supervisor change `add-service-control` computes the closure); memory is optional because the cortex answers without recall after `brain.cortex.recall_timeout_ms`.

#### Scenario: Closure without memory
- **WHEN** only cortex, salience and affect run with the mock provider
- **THEN** a recall times out after `recall_timeout_ms` and the cortex still publishes `brain.say`

### Requirement: Targeted pause and resume
The cortex service SHALL treat `control` events with a `target` other than `cortex` as not addressed to it, and SHALL handle `pause` and `resume` (target `cortex` or undefined) by idling and resuming in-process without exiting.

#### Scenario: Pause addressed to this service
- **WHEN** `control {cmd:"pause", target:"cortex"}` arrives
- **THEN** the service enters the paused state and no LLM call is started while paused

#### Scenario: Pause for another service
- **WHEN** `control {cmd:"pause", target:"voice"}` arrives
- **THEN** the cortex service state is unchanged

#### Scenario: Resume
- **WHEN** `control {cmd:"resume"}` (no target) arrives while paused
- **THEN** normal processing resumes

### Requirement: Injection flag propagation
When thinking about an `attention.focus` with `injected: true`, the cortex SHALL publish the resulting `brain.say` with `injected: true` and the focus's `remember` unchanged. A `brain.say` produced for a real focus, or by `control` `say`, MUST NOT carry either flag.

#### Scenario: Reply to injected input
- **WHEN** an `attention.focus {injected: true, remember: false}` is answered
- **THEN** `brain.say` has `injected: true, remember: false`

#### Scenario: Remembered injection
- **WHEN** the focus has `injected: true, remember: true`
- **THEN** `brain.say` has `injected: true, remember: true`

#### Scenario: Real input and operator say
- **WHEN** the focus is real, or `control` `say` is handled
- **THEN** `brain.say` carries neither flag
