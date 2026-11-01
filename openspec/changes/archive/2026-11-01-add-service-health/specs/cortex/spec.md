## ADDED Requirements

### Requirement: Heartbeat
The cortex service SHALL publish `service.heartbeat` with `service: "cortex"` via `startHeartbeat`: `starting` at boot, `ready` once the chat LLM backend answered `llm.ping()`, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{llm}`. It MUST report `mode: "live"` while a real backend is used.

#### Scenario: Ready
- **WHEN** cortex has finished starting
- **THEN** a heartbeat with `service: "cortex"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: LLM unreachable
- **WHEN** `llm.ping()` fails
- **THEN** `deps.llm` is `down` and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** cortex receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0
