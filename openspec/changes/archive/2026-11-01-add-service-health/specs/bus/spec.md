## MODIFIED Requirements

### Requirement: Known event catalogue
The system SHALL define exactly these event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`, `voice.utterance`, `voice.playing`, `voice.done`, `avatar.state`, `control`, `service.heartbeat`, and SHALL export them as `EVENT_TYPES`.

#### Scenario: Control commands
- **WHEN** a `control` event is validated
- **THEN** `cmd` MUST be one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`

#### Scenario: Chat platforms
- **WHEN** a `chat.message` is validated
- **THEN** `platform` MUST be `twitch`, `youtube` or `discord`

#### Scenario: Heartbeat payload
- **WHEN** a `service.heartbeat` is validated
- **THEN** it MUST have `service`, `instance`, `pid`, `version`, `startedAt` (epoch ms), `state` (`starting`, `ready`, `degraded` or `stopping`), `deps` (record of `ok`, `down` or `n/a`), `mode` (string) and `intervalMs`, and MAY have `detail`

## ADDED Requirements

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
