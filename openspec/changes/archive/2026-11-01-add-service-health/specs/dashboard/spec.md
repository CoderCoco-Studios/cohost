## ADDED Requirements

### Requirement: Heartbeat
The dashboard service SHALL publish `service.heartbeat` with `service: "dashboard"` via `startHeartbeat`: `starting` at boot, `ready` once its HTTP server on `dashboard.port` is listening, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{}` (it has no external dependencies). It MUST report `mode: "live"`, and its own entry appears in `GET /services` like any other service.

#### Scenario: Ready
- **WHEN** dashboard has finished starting
- **THEN** a heartbeat with `service: "dashboard"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Self listed
- **WHEN** the dashboard lists services
- **THEN** the dashboard appears with its own heartbeat state

#### Scenario: Shutdown
- **WHEN** dashboard receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
