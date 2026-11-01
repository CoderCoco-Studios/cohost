# chat Specification

## Purpose
The chat service (services/chat) ingests Twitch chat via twurple and publishes `chat.message` events to the bus, filtering out noise.

## Requirements

### Requirement: Channel configuration
With `chat.source` `twitch` (default) the system SHALL read the channel from `chat.twitch.channel` (env TWITCH_CHANNEL, default empty), normalized by stripping a leading `#` and lowercasing.

#### Scenario: Normalization
- **WHEN** the channel is `#SomeChannel`
- **THEN** it joins `somechannel`

#### Scenario: No channel
- **WHEN** the channel is empty and `chat.source` is `twitch`
- **THEN** the service logs an error, does not exit, publishes no messages, and reports `degraded` with `twitch` down in its heartbeat deps (change `add-service-health`)

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

### Requirement: Heartbeat
The chat service SHALL publish `service.heartbeat` with `service: "chat"` via `startHeartbeat`: `starting` at boot, `ready` once its Twitch client is connected, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{twitch}`. With no `chat.twitch.channel` (env `TWITCH_CHANNEL`) it MUST report `mode: "off"` and `twitch: "n/a"`, otherwise `mode: "live"`; when add-isolated-backends lands it idles in that state rather than exiting.

#### Scenario: Ready
- **WHEN** chat has finished starting
- **THEN** a heartbeat with `service: "chat"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Unconfigured channel
- **WHEN** no Twitch channel is configured
- **THEN** `mode` is `off`, `deps.twitch` is `n/a` and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** chat receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0

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

### Requirement: Injected text messages
The system SHALL subscribe with consumer group `chat` to `inject.request` and, for `target: "chat"` and `kind: "text"`, publish `chat.message` with `injected: true`, `remember` from the request, `text` whitespace-collapsed and trimmed, `user` = `meta.user` or `injected_viewer`, `platform` = `meta.platform` or `twitch`, `isMod`/`isSub` from `meta` (default false) and `mentionsCohost` computed from `cohost.name` as for real messages, then publish `inject.result {id, ok:true}`. The `chat.ignore_users` and `chat.ignore_prefixes` rules MUST NOT be applied. This MUST work regardless of `chat.source` and with no Twitch channel. Requests whose envelope `ts` is more than 60 s old, requests with another target/kind, and blank text SHALL yield `inject.result {ok:false, detail}` (ignored silently when the target is another service).

#### Scenario: Viewer fields
- **WHEN** `{target:"chat", kind:"text", text:"hi", meta:{user:"bob", isMod:true}, remember:false}` arrives
- **THEN** `chat.message {platform:"twitch", user:"bob", text:"hi", isMod:true, isSub:false, injected:true, remember:false}` and `inject.result {ok:true}` are published

#### Scenario: Ignore rules bypassed
- **WHEN** the injected text starts with an ignored prefix such as `!`
- **THEN** it is still published

#### Scenario: Mention
- **WHEN** the text contains `cohost.name` case-insensitively
- **THEN** `mentionsCohost` is true

#### Scenario: Blank text
- **WHEN** the text is whitespace only
- **THEN** no `chat.message` is published and `inject.result {ok:false}` is published

#### Scenario: Isolated chat
- **WHEN** `chat.source` is `fake` or the Twitch channel is empty
- **THEN** injection is still handled

#### Scenario: Stale request
- **WHEN** a request is more than 60 s old at handling time
- **THEN** `inject.result {ok:false, detail:"stale"}` is published and nothing else

#### Scenario: Other target
- **WHEN** `target` is `eyes`
- **THEN** chat publishes nothing
