## MODIFIED Requirements

### Requirement: Known event catalogue
The system SHALL define exactly these event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`, `voice.utterance`, `voice.playing`, `voice.done`, `avatar.state`, `control`, `service.lifecycle`, and SHALL export them as `EVENT_TYPES`. (Events added by other in-flight changes, e.g. `service.heartbeat`, are merged into this list when archived.)

#### Scenario: Control commands
- **WHEN** a `control` event is validated
- **THEN** `cmd` MUST be one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`, `pause`, `resume`
- **AND** `target` MAY be a string; when absent the command applies to all services

#### Scenario: Control without target is unchanged
- **WHEN** `control {cmd: "mute"}` is published with no `target`
- **THEN** it validates and is addressed to all services

#### Scenario: Service lifecycle audit
- **WHEN** a `service.lifecycle` event is validated
- **THEN** `service` and `by` MUST be strings, `action` MUST be `start`, `stop` or `restart`, `ok` MUST be boolean, and `detail` MAY be a string

#### Scenario: Chat platforms
- **WHEN** a `chat.message` is validated
- **THEN** `platform` MUST be `twitch`, `youtube` or `discord`

#### Scenario: Invalid lifecycle action
- **WHEN** `service.lifecycle` is published with `action: "kill"`
- **THEN** `publish` throws and nothing is written
