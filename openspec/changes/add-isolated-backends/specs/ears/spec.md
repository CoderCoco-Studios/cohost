## MODIFIED Requirements

### Requirement: Discord session
With `ears.source` `discord` (default) and DISCORD_TOKEN set the system SHALL log in with env DISCORD_TOKEN, join the voice channel DISCORD_VOICE_CHANNEL_ID in guild DISCORD_GUILD_ID (not self-muted or deafened), and rejoin after 5 s if the connection does not recover within 5 s of disconnect. With `discord` and DISCORD_TOKEN unset it MUST NOT exit: it SHALL stay running idle and report `degraded` with `discord` down (heartbeat from change `add-service-health`).

#### Scenario: Not a voice channel
- **WHEN** the configured channel is not voice-based
- **THEN** join fails with "DISCORD_VOICE_CHANNEL_ID is not a voice channel"

#### Scenario: Login failure
- **WHEN** Discord login with a configured token fails
- **THEN** the error is logged and the process exits with code 1

#### Scenario: No token
- **WHEN** `ears.source` is `discord` and DISCORD_TOKEN is unset
- **THEN** the process stays up, creates no Discord client, and reports degraded

## ADDED Requirements

### Requirement: Off source
With `ears.source: off` the service SHALL create no Discord client, require no Discord env vars, publish no `speech.heard`, ignore `voice.utterance` without publishing `voice.playing`/`voice.done`, and stay running idle.

#### Scenario: Off
- **WHEN** `ears.source` is `off`
- **THEN** the service idles with no Discord login and a `voice.utterance` produces no ears events

### Requirement: Isolation preset and mode
`EARS_SOURCE=off` SHALL select the off source. Heartbeat `mode` (change `add-service-health`) MUST be `off` for `off` and `live` for `discord`.

#### Scenario: Preset
- **WHEN** `EARS_SOURCE=off`
- **THEN** mode is `off`
