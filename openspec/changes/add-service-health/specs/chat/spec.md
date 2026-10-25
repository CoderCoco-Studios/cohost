## ADDED Requirements

### Requirement: Heartbeat
The chat service SHALL publish `service.heartbeat` with `service: "chat"` via `startHeartbeat`: `starting` at boot, `ready` once its Twitch client is connected, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{twitch}`. With no `chat.twitch.channel` (env `TWITCH_CHANNEL`) it MUST report `mode: "off"` and `twitch: "n/a"`, otherwise `mode: "live"`; when add-isolated-backends lands it idles in that state rather than exiting.

#### Scenario: Ready
- **WHEN** chat has finished starting
- **THEN** a heartbeat with `service: "chat"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Unconfigured channel
- **WHEN** no Twitch channel is configured
- **THEN** `mode` is `off`, `deps.twitch` is `n/a` and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** chat receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
