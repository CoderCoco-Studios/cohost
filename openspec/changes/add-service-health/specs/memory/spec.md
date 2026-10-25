## ADDED Requirements

### Requirement: Heartbeat
The memory service SHALL publish `service.heartbeat` with `service: "memory"` via `startHeartbeat`: `starting` at boot, `ready` once its Postgres schema is initialised, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{postgres, ollama}`. Each MUST be `ok` or `down` according to the last successful connection or embedding call.

#### Scenario: Ready
- **WHEN** memory has finished starting
- **THEN** a heartbeat with `service: "memory"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Ollama down
- **WHEN** embeddings are unavailable
- **THEN** `deps.ollama` is `down`, `state` is `degraded` and the service keeps heartbeating (whether it waits or idles is governed by add-isolated-backends)

#### Scenario: Shutdown
- **WHEN** memory receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
