# eyes Specification

## Purpose
The eyes service (services/eyes) screenshots a game source in OBS, asks an Ollama vision model what changed, and publishes one-line `vision.summary` events.

## Requirements

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

### Requirement: Screenshot capture
The system SHALL call GetSourceScreenshot for `vision.obs.source` (default `Game Capture`) as jpg at `vision.obs.width` (default 896), quality 70, and strip any `data:image/...;base64,` prefix.

#### Scenario: Data URL
- **WHEN** OBS returns `data:image/jpeg;base64,AAA`
- **THEN** the model receives `AAA`

### Requirement: Vision description
The system SHALL POST to `<ollama>/api/chat` with `vision.model`, stream false, keep_alive 24h, temperature 0.2, num_predict 60, passing the previous description, and use only the first line of the reply.

#### Scenario: Model error
- **WHEN** the model returns non-OK
- **THEN** an error "vision model <status>" is thrown

### Requirement: Change-only publication
The system SHALL publish `vision.summary {text, changed: true}` only when the description is non-empty and does not start with `SAME` (case-insensitive), and SHALL remember it as the next previous description.

#### Scenario: No change
- **WHEN** the model replies `SAME` or empty
- **THEN** nothing is published, the previous description is kept, and look() returns false

#### Scenario: New description
- **WHEN** the model returns a new sentence
- **THEN** `vision.summary` is published and look() returns true

### Requirement: Polling cadence
The system SHALL poll every `vision.interval_ms` (default 8000), net of look duration, never sleeping less than 500 ms.

#### Scenario: Slow look
- **WHEN** a look takes longer than the interval
- **THEN** the next sleep is 500 ms

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

### Requirement: Isolation preset and mode
`VISION_ENABLED=false` (the default) SHALL be the eyes isolation preset. Heartbeat `mode` (change `add-service-health`) MUST be `off` while vision is disabled and `live` when enabled; while enabled but OBS is unreachable it SHOULD report `degraded` with `obs` down.

#### Scenario: Off mode
- **WHEN** vision.enabled is false
- **THEN** mode is `off` and no `vision.summary` is published

### Requirement: Injected images
The system SHALL subscribe with consumer group `eyes` to `inject.request` and, for `target: "eyes"` and `kind: "image"`, fetch `url`, base64-encode the bytes, call the vision model through the same describer as `look()` with an empty previous description, and publish `vision.summary {text, changed: true, injected: true, remember}` followed by `inject.result {id, ok:true, detail:text}`. A reply that is empty or `SAME` SHALL yield `inject.result {ok:false}` and no `vision.summary`. Injection MUST NOT read or modify the previous description used by `look()`, MUST NOT require OBS, and MUST work when `vision.enabled` is false provided the vision model backend is reachable; otherwise it SHALL publish `inject.result {ok:false, detail}` with the error. The service MUST only fetch URLs beginning with `urls.dashboard()` + `/uploads/`; any other URL, a fetch failure or a request older than 60 s SHALL yield `inject.result {ok:false}` without calling the model.

#### Scenario: Image described
- **WHEN** an image request arrives and the model returns "a menu screen"
- **THEN** `vision.summary {text:"a menu screen", changed:true, injected:true, remember:false}` and `inject.result {ok:true}` are published

#### Scenario: Vision disabled, model reachable
- **WHEN** `vision.enabled` is false and the vision model answers
- **THEN** the summary is published and no OBS connection is attempted

#### Scenario: Model unreachable
- **WHEN** the vision model call throws "vision model 503"
- **THEN** `inject.result {ok:false, detail}` mentions the error and no `vision.summary` is published

#### Scenario: No change tracking side effect
- **WHEN** an image is injected between two `look()` calls
- **THEN** the second `look()` still receives the description from the first `look()` as previous

#### Scenario: Foreign URL
- **WHEN** `url` points outside `<DASHBOARD_URL>/uploads/`
- **THEN** nothing is fetched and `inject.result {ok:false}` is published

#### Scenario: Not for eyes
- **WHEN** `target` is `ears`
- **THEN** eyes publishes nothing
