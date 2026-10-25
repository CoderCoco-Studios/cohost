## Purpose
Defines the heartbeat contract semantics every cohost service follows and the derived per-service health states computed by a `HealthTracker` in `packages/control`. It is the monitoring foundation for the control plane.

## ADDED Requirements

### Requirement: Heartbeat contract
Every service SHALL publish `service.heartbeat` on `cohost:health` with `service` equal to its name, `instance` unique per process, `pid`, `version`, `startedAt` constant for the process lifetime, `state`, `deps`, `mode` and `intervalMs`. The default `intervalMs` SHALL be 5000. A service SHALL publish `starting` at boot, `ready` once it is serving, `degraded` when it is running but a required capability is unavailable, and `stopping` once on graceful shutdown. `mode` SHALL be `live` when using real backends, `mock` when using a stand-in, and `off` when the capability is disabled or unconfigured.

#### Scenario: Normal lifecycle
- **WHEN** a service boots, becomes ready and is later sent SIGTERM
- **THEN** its heartbeats are `starting`, `ready` (repeating every `intervalMs`), then a single `stopping`

#### Scenario: Unreachable dependency
- **WHEN** a service cannot reach an external dependency but keeps running
- **THEN** its heartbeat has `state: "degraded"`, that dependency in `deps` is `down`, and the process does not need to exit for this to be reported

#### Scenario: Disabled capability
- **WHEN** a service's capability is disabled or unconfigured (for example no `TWITCH_CHANNEL`)
- **THEN** its heartbeat reports `mode: "off"` and the relevant dep as `n/a` or `down`

### Requirement: Derived health states
The `HealthTracker` SHALL derive one state per service from received heartbeats using its own receive-time clock and the latest heartbeat's `intervalMs`: `unknown` if none has ever been seen; `down` if the last heartbeat is `stopping` or its age exceeds 10 x `intervalMs`; `stale` if its age exceeds 3 x `intervalMs`; `degraded` if fresh and `state` is `degraded` or `starting` or any dep is `down`; `up` if fresh, `state` is `ready` and no dep is `down`. Derived states SHALL NOT be published to the bus.

#### Scenario: Fresh ready service
- **WHEN** the last heartbeat is `ready`, all deps `ok` or `n/a`, and 1 s old with `intervalMs` 5000
- **THEN** the state is `up`

#### Scenario: Stale
- **WHEN** the last heartbeat is 16 s old with `intervalMs` 5000
- **THEN** the state is `stale`

#### Scenario: Down by silence
- **WHEN** the last heartbeat is 51 s old with `intervalMs` 5000
- **THEN** the state is `down`

#### Scenario: Down by stopping
- **WHEN** the last heartbeat has `state: "stopping"`
- **THEN** the state is `down` immediately regardless of age

#### Scenario: Never seen
- **WHEN** a known service name has never sent a heartbeat
- **THEN** its state is `unknown`, not `down`

#### Scenario: Degraded by dependency
- **WHEN** the last heartbeat is fresh `ready` but `deps.ollama` is `down`
- **THEN** the state is `degraded`

### Requirement: Crash-loop detection
The `HealthTracker` SHALL report `crash-looping` for a service when at least 3 distinct `startedAt` values were observed within the last 60 seconds, and this state SHALL take precedence over `up`, `degraded`, `stale` and `down`. It SHALL clear once fewer than 3 distinct `startedAt` values remain within the window.

#### Scenario: Restart storm
- **WHEN** heartbeats with three different `startedAt` values arrive within 60 s for `chat`
- **THEN** `chat` is `crash-looping`

#### Scenario: Recovery
- **WHEN** the service then stays on one `startedAt` and 60 s pass since the third restart
- **THEN** the state returns to the ordinary derived state

#### Scenario: Repeated heartbeats are not restarts
- **WHEN** 12 heartbeats with the same `startedAt` arrive in 60 s
- **THEN** the service is not `crash-looping`

### Requirement: Tracker snapshot
The `HealthTracker` SHALL expose a snapshot listing, for every known service name (the 10 cohost services plus any other that sent a heartbeat), its derived state, last heartbeat (if any), last-seen age, and `restarts` (count of distinct `startedAt` within the 60 s window).

#### Scenario: Snapshot includes unknown services
- **WHEN** only `cortex` has sent a heartbeat
- **THEN** the snapshot has an entry for each of the other 9 services with state `unknown` and no heartbeat

### Requirement: Compose healthcheck
Each app service in `docker-compose.yml` (chat, salience, affect, memory, cortex, voice, avatar, dashboard, and the profile-gated eyes and ears) SHALL define a healthcheck that succeeds only when the newest `service.heartbeat` for that service on `cohost:health` is younger than 3 x its `intervalMs` and is not `stopping`.

#### Scenario: Healthy container
- **WHEN** a service published a `ready` heartbeat 2 s ago
- **THEN** its healthcheck exits 0

#### Scenario: Silent container
- **WHEN** no heartbeat for the service has been published for 20 s with `intervalMs` 5000
- **THEN** its healthcheck exits non-zero
