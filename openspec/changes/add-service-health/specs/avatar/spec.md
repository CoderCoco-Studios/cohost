## ADDED Requirements

### Requirement: Heartbeat
The avatar service SHALL publish `service.heartbeat` with `service: "avatar"` via `startHeartbeat`: `starting` at boot, `ready` once its driver is selected, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{driver}`. With `AVATAR_DRIVER=null` it MUST report `mode: "off"` and `driver: "n/a"`; with a real driver (`vts` or `vmc`) it MUST report `mode: "live"` and `driver` `ok` iff the driver is connected.

#### Scenario: Ready
- **WHEN** avatar has finished starting
- **THEN** a heartbeat with `service: "avatar"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Null driver
- **WHEN** the null driver is selected
- **THEN** `mode` is `off` and `deps.driver` is `n/a`

#### Scenario: Shutdown
- **WHEN** avatar receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
