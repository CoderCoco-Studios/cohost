# dashboard Specification

## Purpose
The dashboard service (services/dashboard) serves a web UI on `dashboard.port` (default 3000, override env PORT): live bus feed, controls, personality editor, and a browser audio sink.

## Requirements

### Requirement: Page and health
The system SHALL serve `public/index.html` at `GET /` with `__COHOST_NAME__` replaced by `cohost.name`, and SHALL answer `GET /health` with 200 `ok`.

#### Scenario: Index
- **WHEN** `GET /` is requested
- **THEN** 200 text/html is returned with the cohost name substituted

#### Scenario: Unknown route
- **WHEN** any other path is requested
- **THEN** 404 `not found` is returned

### Requirement: Live event feed
The system SHALL expose a WebSocket at `/ws` that sends the 60 most recent bus events on connect and then every new bus event as JSON.

#### Scenario: New client
- **WHEN** a client connects to `/ws`
- **THEN** it receives `bus.recent(60)` events, then live events from `bus.tail`

#### Scenario: Closed client
- **WHEN** a client socket is not OPEN
- **THEN** it is skipped when broadcasting

### Requirement: Control commands
The system SHALL accept `POST /control` with JSON `{cmd, text?}` and publish it as a `control` event (cmd one of `mute`, `unmute`, `say`, `forget_context`, `reload_personality`), responding 204.

#### Scenario: Say
- **WHEN** `{"cmd":"say","text":"hi"}` is posted
- **THEN** `control` is published with that cmd and text

### Requirement: Personality editing
The system SHALL return the personality text from `GET /personality` (text/plain) and on `PUT /personality` SHALL save the body and publish `control {cmd: "reload_personality"}`, responding 204.

#### Scenario: Save
- **WHEN** a body is PUT
- **THEN** savePersonality receives it and the reload control event is published

### Requirement: Audio sink
The system SHALL proxy `GET /audio/*` to `VOICE_URL` (default `http://voice:8700`) with `cache-control: no-store`, and `POST /sink` with `{event: "playing"|"done", id}` SHALL publish `voice.playing` or `voice.done` with `sink: "dashboard"`.

#### Scenario: Audio proxy
- **WHEN** `/audio/<id>.wav` is requested
- **THEN** the upstream status and content-type (default audio/wav) are returned with the body

#### Scenario: Sink report
- **WHEN** `{event:"playing", id}` is posted
- **THEN** `voice.playing {id, sink:"dashboard"}` is published and 204 returned

### Requirement: Error handling
The system SHALL respond 500 with the error text when a handler throws, and log the failure.

#### Scenario: Bad JSON
- **WHEN** `/control` receives invalid JSON
- **THEN** 500 is returned
