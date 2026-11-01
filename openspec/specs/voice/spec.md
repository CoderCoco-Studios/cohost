# voice Specification

## Purpose
The voice service (services/voice) turns `brain.say` into audio via a TTS container, computes a lip-sync envelope, stores the WAV and serves it over HTTP to sinks.

## Requirements

### Requirement: Synthesis
With `voice.engine` `kokoro` (default) the system SHALL subscribe (group `voice`, from now) to `brain.say` and POST to `<tts>/v1/audio/speech` with model `kokoro`, input text, `voice.voice` (default `af_heart`), `voice.speed` (default 1) and response_format `wav`. With `voice.engine` `stub` it SHALL NOT contact the TTS service.

#### Scenario: Non-OK TTS
- **WHEN** TTS returns a non-OK status
- **THEN** an error "tts <status>" is raised and handled as a failure

#### Scenario: Stub makes no request
- **WHEN** `voice.engine` is `stub` and a `brain.say` arrives
- **THEN** no HTTP request is made to the TTS URL

### Requirement: voice.utterance publication
The system SHALL publish `voice.utterance` with `id`, `text`, `emotion`, `gesture`, `durationMs` (rounded), `envelopeHz` 30, `envelope`, `audioUrl` `<VOICE_URL>/audio/<id>.wav` and `sampleRate`.

#### Scenario: Successful synthesis
- **WHEN** `brain.say` is synthesized
- **THEN** the event carries values parsed from the WAV, and VOICE_URL defaults to `http://voice:<VOICE_PORT>` (port default 8700)

### Requirement: Envelope extraction
The system SHALL compute a 16-bit PCM RMS envelope at 30 Hz normalized to 0..1 via (rms/0.22)^0.8, smoothed with decay 0.6 and rounded to 2 decimals.

#### Scenario: Unsupported depth
- **WHEN** the WAV is not 16-bit
- **THEN** envelope throws "unsupported bit depth"

#### Scenario: Invalid WAV
- **WHEN** the buffer is not RIFF/WAVE or has no data chunk
- **THEN** parseWav throws "not a RIFF/WAVE file" or "no data chunk"

### Requirement: Failure handling
The system SHALL publish `voice.done {id, sink: "error"}` when synthesis fails so the brain can continue.

#### Scenario: TTS down
- **WHEN** synthesis throws
- **THEN** an error is logged and `voice.done` with sink `error` is published with no utterance

### Requirement: Virtual sink
The system SHALL, 1500 ms after publishing an utterance, publish `voice.playing {sink:"virtual"}` and then `voice.done` after durationMs, unless a `voice.playing` with a non-virtual sink claimed that id.

#### Scenario: Unclaimed
- **WHEN** no real sink reports playing within 1.5 s
- **THEN** the virtual sink times the utterance

#### Scenario: Claimed
- **WHEN** a dashboard or discord sink reported `voice.playing` for the id
- **THEN** no virtual events are published

### Requirement: Audio store and HTTP
The system SHALL keep at most 50 WAVs in memory (oldest evicted) and serve `GET /audio/<id>.wav` with `audio/wav` and CORS `*`, and `GET /health` with `ok`.

#### Scenario: Evicted or unknown
- **WHEN** an id is not in the store
- **THEN** 404 `gone` is returned

#### Scenario: Other paths
- **WHEN** another path is requested
- **THEN** 404 is returned

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

### Requirement: Stub engine
The `stub` engine SHALL return a valid mono 16-bit WAV at `voice.sample_rate` containing silence whose duration scales with text length (60 ms per character, minimum 400 ms), so `voice.utterance` carries real `durationMs`, `sampleRate`, an all-zero `envelope` at 30 Hz, and a fetchable `audioUrl`. The virtual sink, audio store and failure handling behave as with Kokoro.

#### Scenario: Duration from text
- **WHEN** the text is 100 characters
- **THEN** `durationMs` is about 6000 and the envelope has one zero per 1/30 s

#### Scenario: Short text
- **WHEN** the text is "hi"
- **THEN** `durationMs` is at least 400

### Requirement: Isolation preset and mode
`VOICE_ENGINE=stub` SHALL select the stub engine without editing `config.yaml`. The heartbeat `mode` (change `add-service-health`) MUST be `mock` for `stub` and `live` for `kokoro`, and startup SHALL log a warning when `stub` is active.

#### Scenario: Preset
- **WHEN** `VOICE_ENGINE=stub`
- **THEN** `voice.engine` is `stub` and mode is `mock`
