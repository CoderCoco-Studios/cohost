# bus Specification

## Purpose
The bus is the only channel between cohost services: a typed wrapper over a single Redis Stream (`@cohost/bus`). Every event is validated against a zod schema on publish and on read.

## Requirements

### Requirement: Single stream with event envelope
The system SHALL publish every event to the Redis Stream `cohost:events` as fields `type`, `ts` (epoch ms), `source` (the Bus constructor's source name) and `data` (JSON), and SHALL trim the stream to approximately 20000 entries.

#### Scenario: Publish returns stream id
- **WHEN** a service calls `publish("brain.say", {...})`
- **THEN** an entry is added with `XADD cohost:events MAXLEN ~ 20000` and the Redis stream id is returned

### Requirement: Typed payload validation on publish
The system SHALL parse `data` with the schema registered in `EventPayloads` for the event type before publishing, applying schema defaults, and SHALL reject invalid payloads.

#### Scenario: Defaults applied
- **WHEN** `chat.message` is published without `isMod`, `isSub` or `mentionsCohost`
- **THEN** the stored data has all three set to `false`

#### Scenario: Invalid payload
- **WHEN** `affect.state` is published with `valence` outside -1..1
- **THEN** `publish` throws and nothing is written

### Requirement: Known event catalogue
The system SHALL define exactly these event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`, `voice.utterance`, `voice.playing`, `voice.done`, `avatar.state`, `control`, and SHALL export them as `EVENT_TYPES`.

#### Scenario: Control commands
- **WHEN** a `control` event is validated
- **THEN** `cmd` MUST be one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`

#### Scenario: Chat platforms
- **WHEN** a `chat.message` is validated
- **THEN** `platform` MUST be `twitch`, `youtube` or `discord`

### Requirement: Consumer-group subscription
The system SHALL provide `subscribe({group, types?, fromNow?, blockMs?}, handler)` using a Redis consumer group, creating the group (with `MKSTREAM`) if absent and tolerating `BUSYGROUP`. It SHALL drain the consumer's pending entries first, then read new entries, and resolve when `stop()` is called.

#### Scenario: Type filter
- **WHEN** `types` is given and an event of another type arrives
- **THEN** the handler is not called and the entry is acked

#### Scenario: Start position
- **WHEN** the group is created with `fromNow: true`
- **THEN** it starts at `$` (new messages only); otherwise at `0` (full backlog)

#### Scenario: Handler failure
- **WHEN** the handler throws
- **THEN** the error is logged, the entry is still acked, and the loop continues

### Requirement: Malformed entries are dropped
The system SHALL skip stream entries whose `type` is unknown or whose `data` is not JSON or fails the schema, rather than delivering them.

#### Scenario: Unknown type
- **WHEN** an entry has an unregistered `type`
- **THEN** it is not delivered to any handler

### Requirement: Live tail and recent backfill
The system SHALL provide `tail(handler, fromId="$")`, a non-group live read that neither acks nor replays, and `recent(count=100)` returning the latest events in chronological (oldest-first) order.

#### Scenario: Recent ordering
- **WHEN** `recent(3)` is called on a stream with more than three events
- **THEN** the newest three are returned oldest first

### Requirement: Shutdown
The system SHALL stop all loops and disconnect all connections on `stop()` without surfacing the resulting read error, and SHALL export `onShutdown(fn)` which runs `fn` once on SIGINT/SIGTERM then exits with code 0.

#### Scenario: Stop during blocking read
- **WHEN** `stop()` is called while `subscribe` or `tail` is blocked
- **THEN** the pending promise resolves without throwing
