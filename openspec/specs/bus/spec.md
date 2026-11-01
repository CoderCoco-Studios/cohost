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
The system SHALL define exactly these event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`, `voice.utterance`, `voice.playing`, `voice.done`, `avatar.state`, `control`, `service.heartbeat`, `service.lifecycle`, `inject.request`, `inject.result`, and SHALL export them as `EVENT_TYPES`.

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

#### Scenario: Invalid lifecycle action
- **WHEN** `service.lifecycle` is published with `action: "kill"`
- **THEN** `publish` throws and nothing is written

#### Scenario: Heartbeat payload
- **WHEN** a `service.heartbeat` is validated
- **THEN** it MUST have `service`, `instance`, `pid`, `version`, `startedAt` (epoch ms), `state` (`starting`, `ready`, `degraded` or `stopping`), `deps` (record of `ok`, `down` or `n/a`), `mode` (string) and `intervalMs`, and MAY have `detail`

#### Scenario: Chat platforms
- **WHEN** a `chat.message` is validated
- **THEN** `platform` MUST be `twitch`, `youtube` or `discord`

#### Scenario: Injection events registered
- **WHEN** `EVENT_TYPES` is read
- **THEN** it contains `inject.request` and `inject.result`

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

### Requirement: Health stream
The system SHALL carry `service.heartbeat` on a separate Redis Stream `cohost:health` (fields `type`, `ts`, `source`, `data`, as for `cohost:events`), trimmed to approximately 1000 entries, and SHALL NOT write heartbeats to `cohost:events`. It SHALL provide `publishHealth(data)` (validated against the `service.heartbeat` schema), `tailHealth(handler, fromId="$")` as a non-group live read, and `recentHealth(count)` returning the newest heartbeats oldest-first.

#### Scenario: Heartbeat goes to health stream
- **WHEN** a service calls `publishHealth` with a valid heartbeat
- **THEN** an entry is added with `XADD cohost:health MAXLEN ~ 1000` and `cohost:events` is not touched

#### Scenario: Heartbeat via publish is rejected
- **WHEN** `publish("service.heartbeat", ...)` is called
- **THEN** it throws and nothing is written to either stream

#### Scenario: Invalid heartbeat
- **WHEN** `publishHealth` is given `state: "dead"`
- **THEN** it throws and nothing is written

#### Scenario: Recent ordering
- **WHEN** `recentHealth(3)` is called on a stream with more than three heartbeats
- **THEN** the newest three are returned oldest first

### Requirement: Heartbeat helper
The system SHALL export `startHeartbeat(bus, {service, version, mode, deps, intervalMs?})` returning `{ready(), degraded(detail?), stop()}`. It SHALL publish `state: "starting"` immediately, then every `intervalMs` (default 5000), and immediately on `ready()`, `degraded()` and on any change of `deps`. `stop()` SHALL publish one `state: "stopping"` heartbeat and cancel the timer. The helper SHALL run `stop()` as part of `onShutdown` before the bus is stopped, and a failed publish SHALL be logged and MUST NOT throw into the service.

#### Scenario: Startup and steady state
- **WHEN** `startHeartbeat` is called and `ready()` is called 100 ms later
- **THEN** a `starting` heartbeat is published first, a `ready` heartbeat follows, and further `ready` heartbeats are published every `intervalMs`

#### Scenario: Dependency change
- **WHEN** a dep value changes from `ok` to `down` between ticks
- **THEN** a heartbeat with the new `deps` is published within one second without waiting for the next interval

#### Scenario: Graceful shutdown
- **WHEN** the process receives SIGTERM
- **THEN** a `stopping` heartbeat is published before the bus connections close and the process exits 0

#### Scenario: Publish failure
- **WHEN** Redis rejects a heartbeat publish
- **THEN** the error is logged and the service keeps running

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

### Requirement: Injection flags on brain output
`brain.say` and `attention.focus` SHALL accept optional `injected` (boolean) and `remember` (boolean) fields with no default, carrying the flags of the input that caused them. Real traffic MUST NOT carry them.

#### Scenario: Flagged reply
- **WHEN** a `brain.say` with `injected: true, remember: false` is published
- **THEN** it validates and the stored data keeps both flags

#### Scenario: Real reply unchanged
- **WHEN** a `brain.say` without the fields is published
- **THEN** the stored data contains neither field

#### Scenario: Flagged focus
- **WHEN** an `attention.focus` with `injected: true` is published
- **THEN** it validates
