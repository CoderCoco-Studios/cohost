## ADDED Requirements

### Requirement: Heartbeat
The voice service SHALL publish `service.heartbeat` with `service: "voice"` via `startHeartbeat`: `starting` at boot, `ready` once its HTTP server on port 8700 is listening, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{kokoro}`. It MUST mark `kokoro` `down` after a TTS failure and `ok` after the next success.

#### Scenario: Ready
- **WHEN** voice has finished starting
- **THEN** a heartbeat with `service: "voice"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: TTS failing
- **WHEN** a synthesis call fails
- **THEN** `deps.kokoro` is `down`, `state` is `degraded`, and `voice.done{sink:"error"}` behaviour is unchanged

#### Scenario: Shutdown
- **WHEN** voice receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
