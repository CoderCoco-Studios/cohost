## MODIFIED Requirements

### Requirement: Channel configuration
With `chat.source` `twitch` (default) the system SHALL read the channel from `chat.twitch.channel` (env TWITCH_CHANNEL, default empty), normalized by stripping a leading `#` and lowercasing.

#### Scenario: Normalization
- **WHEN** the channel is `#SomeChannel`
- **THEN** it joins `somechannel`

#### Scenario: No channel
- **WHEN** the channel is empty and `chat.source` is `twitch`
- **THEN** the service logs an error, does not exit, publishes no messages, and reports `degraded` with `twitch` down in its heartbeat deps (change `add-service-health`)

## ADDED Requirements

### Requirement: Fake source
With `chat.source: fake` the service SHALL need no channel, credentials or network, and publish `chat.message` events generated from stdin lines when stdin provides input, otherwise from a built-in script cycled every `chat.fake.interval_ms` (default 8000) using synthetic viewer names. Messages MUST pass through the normal filtering (`ignore_users`, `ignore_prefixes`, whitespace trimming) and carry the standard `chat.message` payload.

#### Scenario: Scripted
- **WHEN** `chat.source` is `fake` and the interval elapses
- **THEN** a `chat.message` is published with a synthetic user

#### Scenario: Ignored prefix
- **WHEN** a fake line starts with `!`
- **THEN** it is not published

#### Scenario: No Twitch client
- **WHEN** `chat.source` is `fake`
- **THEN** no IRC connection is attempted

### Requirement: Isolation preset and mode
`CHAT_SOURCE=fake` SHALL select the fake source. Heartbeat `mode` (change `add-service-health`) MUST be `mock` for `fake` and `live` for `twitch`.

#### Scenario: Preset
- **WHEN** `CHAT_SOURCE=fake`
- **THEN** the service runs with TWITCH_CHANNEL unset and mode `mock`
