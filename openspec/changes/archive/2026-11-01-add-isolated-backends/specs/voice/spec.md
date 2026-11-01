## MODIFIED Requirements

### Requirement: Synthesis
With `voice.engine` `kokoro` (default) the system SHALL subscribe (group `voice`, from now) to `brain.say` and POST to `<tts>/v1/audio/speech` with model `kokoro`, input text, `voice.voice` (default `af_heart`), `voice.speed` (default 1) and response_format `wav`. With `voice.engine` `stub` it SHALL NOT contact the TTS service.

#### Scenario: Non-OK TTS
- **WHEN** TTS returns a non-OK status
- **THEN** an error "tts <status>" is raised and handled as a failure

#### Scenario: Stub makes no request
- **WHEN** `voice.engine` is `stub` and a `brain.say` arrives
- **THEN** no HTTP request is made to the TTS URL

## ADDED Requirements

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
