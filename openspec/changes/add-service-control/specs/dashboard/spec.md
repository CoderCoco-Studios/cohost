## ADDED Requirements

### Requirement: Service lifecycle routes
When `CONTROL_ENABLED=1` the system SHALL accept `POST /services/:id/start`, `/stop` and `/restart` with optional JSON `{mode?: "resume"|"fresh"}`, delegate to the service controller, publish `service.lifecycle`, and respond 200 with `{ok, detail?}`. When control is disabled these routes SHALL respond 404.

#### Scenario: Restart
- **WHEN** an authorized `POST /services/cortex/restart` arrives
- **THEN** the controller restarts cortex and 200 `{ok:true}` is returned

#### Scenario: Unknown service
- **WHEN** `POST /services/nope/start` arrives
- **THEN** 404 is returned and nothing is executed

#### Scenario: Self stop
- **WHEN** `POST /services/dashboard/stop` arrives
- **THEN** 409 is returned

#### Scenario: Control disabled
- **WHEN** `CONTROL_ENABLED` is not `1`
- **THEN** `POST /services/cortex/stop` returns 404

### Requirement: Bearer token on mutating routes
When `CONTROL_ENABLED=1` the system SHALL require `Authorization: Bearer <CONTROL_TOKEN>` (constant-time comparison) on the service routes, `POST /control` and `PUT /personality`, responding 401 otherwise.

#### Scenario: Missing token
- **WHEN** `POST /control` arrives without an Authorization header while control is enabled
- **THEN** 401 is returned and no `control` event is published

#### Scenario: Wrong token
- **WHEN** a wrong bearer token is sent to `POST /services/voice/stop`
- **THEN** 401 is returned

### Requirement: Service control UI
The web UI SHALL show Start, Stop and Restart controls (with a resume/fresh choice) per service only when control is enabled, and SHALL ask for confirmation before sending any request.

#### Scenario: Confirmation
- **WHEN** the operator clicks Stop on a service
- **THEN** a confirmation dialog is shown and the request is sent only if confirmed

#### Scenario: Disabled
- **WHEN** `GET /services/control` reports `{enabled:false}`
- **THEN** no lifecycle controls are rendered

## MODIFIED Requirements

### Requirement: Control commands
The system SHALL accept `POST /control` with JSON `{cmd, text?, target?}` and publish it as a `control` event (cmd one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`, `pause`, `resume`), responding 204. When `CONTROL_ENABLED=1` the request MUST carry the bearer token; otherwise it remains unauthenticated as before.

#### Scenario: Say
- **WHEN** `{"cmd":"say","text":"hi"}` is posted
- **THEN** `control` is published with that cmd and text

#### Scenario: Targeted pause
- **WHEN** `{"cmd":"pause","target":"affect"}` is posted
- **THEN** `control {cmd:"pause", target:"affect"}` is published

#### Scenario: Token required when enabled
- **WHEN** control is enabled and the request has no valid bearer token
- **THEN** 401 is returned and nothing is published
