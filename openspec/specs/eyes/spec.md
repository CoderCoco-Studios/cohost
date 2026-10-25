# eyes Specification

## Purpose
The eyes service (services/eyes) screenshots a game source in OBS, asks an Ollama vision model what changed, and publishes one-line `vision.summary` events.

## Requirements

### Requirement: Enablement
The system SHALL act only when `vision.enabled` (default false) is true.

#### Scenario: Disabled
- **WHEN** vision.enabled is false
- **THEN** a warning is logged at startup and the loop never calls look()

### Requirement: OBS connection
The system SHALL connect via obs-websocket to `ws://vision.obs.host:port` (defaults `host.docker.internal`, 4455, empty password treated as none) and retry every 10 s until connected.

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
