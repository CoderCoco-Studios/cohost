## MODIFIED Requirements

### Requirement: Known event catalogue
The system SHALL define exactly these event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`, `voice.utterance`, `voice.playing`, `voice.done`, `avatar.state`, `control`, `service.heartbeat`, `service.lifecycle`, `inject.request`, `inject.result`, and SHALL export them as `EVENT_TYPES`.

#### Scenario: Control commands
- **WHEN** a `control` event is validated
- **THEN** `cmd` MUST be one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`

#### Scenario: Chat platforms
- **WHEN** a `chat.message` is validated
- **THEN** `platform` MUST be `twitch`, `youtube` or `discord`

#### Scenario: Injection events registered
- **WHEN** `EVENT_TYPES` is read
- **THEN** it contains `inject.request` and `inject.result`

## ADDED Requirements

### Requirement: Injection flags on perception events
`chat.message`, `vision.summary` and `speech.heard` SHALL accept optional `injected` (boolean) and `remember` (boolean) fields with no default, so that events without them validate and are stored unchanged. `remember` is only meaningful when `injected` is true.

#### Scenario: Real event unchanged
- **WHEN** a `chat.message` without `injected` or `remember` is published
- **THEN** the stored data contains neither field

#### Scenario: Injected event
- **WHEN** a `vision.summary` `{text, changed: true, injected: true, remember: false}` is published
- **THEN** it validates and the stored data keeps both flags

#### Scenario: Non-boolean flag
- **WHEN** `injected` is the string `"yes"`
- **THEN** `publish` throws and nothing is written

### Requirement: Injection request and result events
The system SHALL define `inject.request` `{id: string, target: "eyes"|"ears"|"chat", kind: "image"|"audio"|"text", url?: string, text?: string, meta?: {user?: string, platform?: "twitch"|"youtube"|"discord", isMod?: boolean, isSub?: boolean}, remember: boolean}` and `inject.result` `{id: string, ok: boolean, detail?: string}`. Binary content MUST NOT be carried on the bus; `url` references it.

#### Scenario: Valid image request
- **WHEN** `{id, target:"eyes", kind:"image", url:"http://dashboard:3000/uploads/abc", remember:false}` is published
- **THEN** it validates

#### Scenario: Unknown target
- **WHEN** `target` is `"voice"`
- **THEN** `publish` throws and nothing is written

#### Scenario: Missing remember
- **WHEN** `remember` is omitted from an `inject.request`
- **THEN** `publish` throws

#### Scenario: Result
- **WHEN** `{id, ok:false, detail:"stt 503"}` is published as `inject.result`
- **THEN** it validates
