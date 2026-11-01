## ADDED Requirements

### Requirement: Heartbeat
The ears service SHALL publish `service.heartbeat` with `service: "ears"` via `startHeartbeat`: `starting` at boot, `ready` once its Discord session is connected, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{discord, stt}`. With no `DISCORD_TOKEN` it MUST report `mode: "off"` and `discord: "n/a"`; otherwise `mode: "live"`.

#### Scenario: Ready
- **WHEN** ears has finished starting
- **THEN** a heartbeat with `service: "ears"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Missing token
- **WHEN** no `DISCORD_TOKEN` is set
- **THEN** `mode` is `off`, `deps.discord` is `n/a`, and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** ears receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
