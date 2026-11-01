## ADDED Requirements

### Requirement: Heartbeat
The eyes service SHALL publish `service.heartbeat` with `service: "eyes"` via `startHeartbeat`: `starting` at boot, `ready` once it is polling or deliberately disabled, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{obs, ollama}`. With `vision.enabled=false` it MUST report `mode: "off"` and both deps `n/a`.

#### Scenario: Ready
- **WHEN** eyes has finished starting
- **THEN** a heartbeat with `service: "eyes"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Vision disabled
- **WHEN** `vision.enabled` is false
- **THEN** `mode` is `off` and `deps` are `n/a`

#### Scenario: Shutdown
- **WHEN** eyes receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
