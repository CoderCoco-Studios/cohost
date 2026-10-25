# chat Specification

## Purpose
The chat service (services/chat) ingests Twitch chat via twurple and publishes `chat.message` events to the bus, filtering out noise.

## Requirements

### Requirement: Channel configuration
The system SHALL read the channel from `chat.twitch.channel` (env TWITCH_CHANNEL, default empty), normalized by stripping a leading `#` and lowercasing.

#### Scenario: Normalization
- **WHEN** the channel is `#SomeChannel`
- **THEN** it joins `somechannel`

#### Scenario: No channel
- **WHEN** the channel is empty
- **THEN** the service logs an error and exits with code 1

### Requirement: Authentication
The system SHALL connect anonymously (read-only) unless TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_ACCESS_TOKEN are all set, in which case it SHALL use a RefreshingAuthProvider with scope `chat` and optional TWITCH_REFRESH_TOKEN.

#### Scenario: Anonymous
- **WHEN** any of the three required variables is missing
- **THEN** no auth provider is created and the connect log shows authenticated=false

#### Scenario: Token refresh
- **WHEN** the provider refreshes the token
- **THEN** an info log with expiresIn is written

### Requirement: Message filtering
The system SHALL drop messages from `chat.ignore_users` (case-insensitive), messages starting with any `chat.ignore_prefixes` (default `["!"]`), and messages that are blank after whitespace collapse.

#### Scenario: Ignored user
- **WHEN** the sender is in ignore_users in any letter case
- **THEN** no event is published

#### Scenario: Command prefix
- **WHEN** text starts with `!`
- **THEN** no event is published

#### Scenario: Whitespace
- **WHEN** text is only whitespace, or contains runs of whitespace
- **THEN** blank text is dropped; otherwise whitespace is collapsed to single spaces and trimmed

### Requirement: chat.message payload
The system SHALL publish `chat.message` with `platform: "twitch"`, `user` (display name, falling back to login), `userId`, cleaned `text`, `isMod`, `isSub` and `mentionsCohost`.

#### Scenario: Mod flag
- **WHEN** the sender is a moderator or the broadcaster
- **THEN** isMod is true

#### Scenario: Mention detection
- **WHEN** the text contains `cohost.name` case-insensitively
- **THEN** mentionsCohost is true

### Requirement: Connection lifecycle
The service SHALL log connect and disconnect events and quit the client on shutdown.

#### Scenario: Disconnect
- **WHEN** the chat client disconnects
- **THEN** a warning with `manually` and `reason` is logged
