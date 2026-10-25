## ADDED Requirements

### Requirement: Runtime interface and adapters
The system SHALL provide in `packages/control` a `Runtime` interface with `start`, `stop` and `restart` operations per service id, each resolving to `{ok, detail?}`, and SHALL ship two adapters: `compose` and `process`, selected by `CONTROL_RUNTIME` (`compose` default, or `process`).

#### Scenario: Compose argv
- **WHEN** the compose runtime starts `cortex`
- **THEN** it executes `docker compose up -d cortex` via an argv array without a shell

#### Scenario: Process argv
- **WHEN** the process runtime starts `cortex` in dev mode
- **THEN** it spawns `pnpm --filter @cohost/cortex dev` with a fixed argv and no shell, and records the pid

#### Scenario: Process stop
- **WHEN** the process runtime stops a service it started
- **THEN** it sends SIGTERM and escalates to SIGKILL if the process has not exited within the timeout

### Requirement: Manifest-only service ids
The system SHALL act only on service ids present in the registry manifest, which SHALL carry per-service runtime info (compose service name, pnpm filter, consumer groups, default start mode, `infra` and `self` flags), and SHALL build runtime commands solely from those manifest fields.

#### Scenario: Unknown id
- **WHEN** an action is requested for an id not in the manifest
- **THEN** it is rejected without spawning anything

#### Scenario: Request input never reaches argv
- **WHEN** a request supplies extra fields or a crafted id such as `cortex; rm -rf /`
- **THEN** no process is spawned with that text

### Requirement: Start modes (resume vs fresh)
The system SHALL support start mode `resume` (keep the Redis consumer group, replaying backlog) and `fresh` (run `XGROUP SETID cohost:events <group> $` for each of the service's groups after the service is stopped and before it is started). Defaults SHALL be `fresh` for salience, affect, cortex, voice and avatar and `resume` for memory; the caller MAY override per request.

#### Scenario: Fresh restart of cortex
- **WHEN** cortex is restarted with default mode
- **THEN** the service is stopped, group `cortex` is set to `$`, then the service is started

#### Scenario: Memory resumes
- **WHEN** memory is restarted with default mode
- **THEN** its groups `memory` and `memory-recall` are not reset

#### Scenario: Explicit override
- **WHEN** a restart of memory requests `mode: "fresh"`
- **THEN** both memory groups are reset to `$`

### Requirement: Protected services
The system SHALL refuse stop and restart of the dashboard (marked `self`), and SHALL treat `redis` and `postgres` (marked `infra`) as read-only unless `CONTROL_ADVANCED=1`.

#### Scenario: Dashboard cannot stop itself
- **WHEN** stop is requested for `dashboard`
- **THEN** the controller rejects it with a conflict and nothing is executed

#### Scenario: Infra read-only
- **WHEN** stop is requested for `redis` and `CONTROL_ADVANCED` is not set
- **THEN** it is rejected as forbidden

#### Scenario: Infra with advanced flag
- **WHEN** `CONTROL_ADVANCED=1` and stop is requested for `postgres`
- **THEN** the action is executed

### Requirement: Enablement gating
The system SHALL keep control disabled unless `CONTROL_ENABLED=1`, SHALL refuse to start with control enabled when `CONTROL_TOKEN` is unset or empty, and SHALL bind the dashboard to `127.0.0.1` when control is enabled unless `CONTROL_BIND` is set.

#### Scenario: Missing token
- **WHEN** `CONTROL_ENABLED=1` and `CONTROL_TOKEN` is empty
- **THEN** startup fails with an error naming `CONTROL_TOKEN`

#### Scenario: Loopback default
- **WHEN** control is enabled and `CONTROL_BIND` is unset
- **THEN** the server listens on `127.0.0.1`

#### Scenario: Bind override
- **WHEN** `CONTROL_BIND=0.0.0.0`
- **THEN** the server listens on that address and logs a warning

### Requirement: Lifecycle audit event
The system SHALL publish `service.lifecycle {service, action, by, ok, detail?}` after every start, stop or restart attempt, with `ok: false` and `detail` when it fails.

#### Scenario: Successful stop
- **WHEN** voice is stopped via the dashboard
- **THEN** `service.lifecycle {service:"voice", action:"stop", by:"dashboard", ok:true}` is published

#### Scenario: Failed start
- **WHEN** the runtime command exits non-zero
- **THEN** the event is published with `ok:false` and the error in `detail`

### Requirement: Optional cohostctl CLI
The system SHALL offer a `cohostctl` CLI that uses the same `packages/control` core to run `status`, `start`, `stop` and `restart`, applying the same manifest, protection and mode rules and publishing `service.lifecycle` with `by: "cohostctl"`.

#### Scenario: CLI stop
- **WHEN** `cohostctl stop memory` runs
- **THEN** memory is stopped via the configured runtime and a lifecycle event is published

#### Scenario: CLI respects protections
- **WHEN** `cohostctl stop dashboard` runs
- **THEN** it exits non-zero without acting
