## MODIFIED Requirements

### Requirement: Enablement
The system SHALL act only when `vision.enabled` (default false) is true. When false the service MUST stay running idle, MUST NOT open or retry an OBS connection, and MUST NOT call the vision model.

#### Scenario: Disabled
- **WHEN** vision.enabled is false
- **THEN** a warning is logged at startup, no OBS connection attempt is made, and look() is never called

### Requirement: OBS connection
When enabled, the system SHALL connect via obs-websocket to `ws://vision.obs.host:port` (defaults `host.docker.internal`, 4455, empty password treated as none) and retry every 10 s until connected.

#### Scenario: OBS unreachable
- **WHEN** connect fails
- **THEN** a warning is logged and it retries after 10 s

#### Scenario: Look failure
- **WHEN** look throws and OBS is no longer identified
- **THEN** the service reconnects to OBS

## ADDED Requirements

### Requirement: Isolation preset and mode
`VISION_ENABLED=false` (the default) SHALL be the eyes isolation preset. Heartbeat `mode` (change `add-service-health`) MUST be `off` while vision is disabled and `live` when enabled; while enabled but OBS is unreachable it SHOULD report `degraded` with `obs` down.

#### Scenario: Off mode
- **WHEN** vision.enabled is false
- **THEN** mode is `off` and no `vision.summary` is published
