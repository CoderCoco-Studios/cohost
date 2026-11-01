## ADDED Requirements

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
