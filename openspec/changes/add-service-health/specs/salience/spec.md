## ADDED Requirements

### Requirement: Heartbeat
The salience service SHALL publish `service.heartbeat` with `service: "salience"` via `startHeartbeat`: `starting` at boot, `ready` once its subscriptions are running, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{}` (it has no external dependencies). It MUST report `mode: "live"`.

#### Scenario: Ready
- **WHEN** salience has finished starting
- **THEN** a heartbeat with `service: "salience"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: No external deps
- **WHEN** Redis is the only dependency
- **THEN** `deps` is empty and `state` is `ready`

#### Scenario: Shutdown
- **WHEN** salience receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
