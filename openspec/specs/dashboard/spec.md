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

### Requirement: Heartbeat
The dashboard service SHALL publish `service.heartbeat` with `service: "dashboard"` via `startHeartbeat`: `starting` at boot, `ready` once its HTTP server on `dashboard.port` is listening, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{}` (it has no external dependencies). It MUST report `mode: "live"`, and its own entry appears in `GET /services` like any other service.

#### Scenario: Ready
- **WHEN** dashboard has finished starting
- **THEN** a heartbeat with `service: "dashboard"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Self listed
- **WHEN** the dashboard lists services
- **THEN** the dashboard appears with its own heartbeat state

#### Scenario: Shutdown
- **WHEN** dashboard receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0

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

### Requirement: Upload store and serving
The system SHALL keep injected image and audio uploads in a bounded in-memory store and serve them at `GET /uploads/:id` with the upload's content type. Ids MUST be unguessable (at least 128 random bits). Entries SHALL expire after `INJECT_TTL_MS` (default 600000), each upload SHALL be capped by `INJECT_MAX_IMAGE_BYTES` (default 8388608) or `INJECT_MAX_AUDIO_BYTES` (default 26214400), and the store SHALL hold at most 16 entries and 64 MiB, evicting the oldest first. `GET /uploads/:id` MUST NOT require the bearer token.

#### Scenario: Fetch
- **WHEN** `GET /uploads/<id>` is requested for a live upload
- **THEN** 200 is returned with the stored bytes and content type

#### Scenario: Expired or unknown
- **WHEN** the id is unknown or past its TTL
- **THEN** 404 is returned

#### Scenario: Eviction
- **WHEN** a 17th upload is stored
- **THEN** the oldest is evicted and its URL returns 404

### Requirement: Inject text route
The system SHALL accept `POST /inject/text` with JSON `{level: "service"|"bus", as?: "chat"|"speech"|"vision", text, remember?: boolean, user?, platform?, isMod?, isSub?}` (`as` default `chat`, `remember` default false). With `level: "bus"` it SHALL publish the matching perception event directly (`chat.message`, `speech.heard` with `speaker` = `user` or `injected` and `durationMs` 0, or `vision.summary`) with `injected: true`, `remember`, and bus source `dashboard`. With `level: "service"` and `as: "chat"` it SHALL publish `inject.request {target:"chat", kind:"text", text, meta, remember}`. It SHALL respond 202 `{id}` on success, and 400 for blank text, an unknown level/`as`, or `level: "service"` with `as` other than `chat`.

#### Scenario: Bus-level chat
- **WHEN** `{"level":"bus","text":"hi","user":"bob","isMod":true}` is posted
- **THEN** `chat.message` is published with `user:"bob"`, `isMod:true`, `injected:true`, `remember:false` and 202 is returned

#### Scenario: Bus-level vision
- **WHEN** `{"level":"bus","as":"vision","text":"a boss fight","remember":true}` is posted
- **THEN** `vision.summary {text, changed:true, injected:true, remember:true}` is published

#### Scenario: Service-level chat
- **WHEN** `{"level":"service","text":"hello"}` is posted
- **THEN** `inject.request {target:"chat", kind:"text", remember:false}` is published and 202 `{id}` is returned with that id

#### Scenario: Unsupported combination
- **WHEN** `{"level":"service","as":"speech","text":"x"}` is posted
- **THEN** 400 is returned and nothing is published

#### Scenario: Blank text
- **WHEN** `text` is whitespace only
- **THEN** 400 is returned and nothing is published

### Requirement: Inject binary routes
The system SHALL accept `POST /inject/image` (content types `image/png`, `image/jpeg`, `image/webp`) and `POST /inject/audio` (`audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/ogg`, `audio/webm`, `audio/mp4`) with the file as the raw request body and options in the query string (`level`, default `service`; `remember`, `1`/`true`; `user` for audio speaker label). It SHALL store the upload, publish `inject.request {target:"eyes"|"ears", kind:"image"|"audio", url:"<urls.dashboard()>/uploads/<id>", meta, remember}` and respond 202 `{id}`. It SHALL respond 415 for other content types, 413 when over the size cap, 400 for an empty body, and 400 for `level=bus` (bus-level uses `POST /inject/text`). Binary data MUST NOT be published on the bus.

#### Scenario: Image upload
- **WHEN** a PNG body is posted to `/inject/image?remember=1` with `Content-Type: image/png`
- **THEN** it is stored, `inject.request` with `target:"eyes"`, `kind:"image"`, `remember:true` and a `/uploads/` URL is published, and 202 is returned

#### Scenario: Audio upload with speaker
- **WHEN** a WAV body is posted to `/inject/audio?user=alice`
- **THEN** `inject.request` has `target:"ears"`, `kind:"audio"`, `meta.user:"alice"`

#### Scenario: Too large
- **WHEN** an image body exceeds `INJECT_MAX_IMAGE_BYTES`
- **THEN** 413 is returned and nothing is stored or published

#### Scenario: Wrong type
- **WHEN** the content type is `text/html`
- **THEN** 415 is returned

#### Scenario: Bus level binary
- **WHEN** `level=bus` is requested on `/inject/image`
- **THEN** 400 is returned and nothing is published

### Requirement: Injection gating
When `CONTROL_ENABLED=1` (change `add-service-control`) the system SHALL require `Authorization: Bearer <CONTROL_TOKEN>` on `POST /inject/text`, `/inject/image` and `/inject/audio`, responding 401 otherwise. When control is not enabled these routes SHALL be unauthenticated, as `POST /control` is today.

#### Scenario: Missing token
- **WHEN** control is enabled and `POST /inject/text` has no bearer token
- **THEN** 401 is returned and nothing is published or stored

#### Scenario: Control disabled
- **WHEN** `CONTROL_ENABLED` is not `1`
- **THEN** `POST /inject/text` is accepted without a token

### Requirement: Test inputs panel
The web UI SHALL provide a "Test inputs" panel with a text box and viewer fields (user, platform, mod, sub), an image file picker, an audio file picker, a level toggle (service/bus), a `remember` toggle defaulting to off, and a status line. The status line SHALL show the matching `inject.result` (by `id`) from the live feed, or report no response when none arrives within 10 s. When control is enabled the panel SHALL send the bearer token. Recording audio from the microphone with `MediaRecorder` MAY be offered where the browser supports it.

#### Scenario: Result shown
- **WHEN** an inject request returns `{id}` and an `inject.result` with that id and `ok:false, detail:"stt 503"` arrives on `/ws`
- **THEN** the status line shows the failure and detail

#### Scenario: No response
- **WHEN** no `inject.result` with that id arrives within 10 s
- **THEN** the status line says the target did not respond

#### Scenario: Bus level
- **WHEN** the level toggle is `bus`
- **THEN** the image and audio pickers are disabled and the text box offers chat, speech and vision

### Requirement: Injected badge
The web UI feed SHALL show an "injected" badge on any event whose data has `injected: true`, and a "remembered" marker when `remember` is also true.

#### Scenario: Injected row
- **WHEN** a `chat.message` with `injected: true` arrives on `/ws`
- **THEN** its feed row shows the injected badge

#### Scenario: Real row
- **WHEN** a `chat.message` without `injected` arrives
- **THEN** no badge is shown
