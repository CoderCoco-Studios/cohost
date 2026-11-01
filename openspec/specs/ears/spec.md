# ears Specification

## Purpose
The ears service (services/ears) is a Discord bot in a voice channel. It transcribes each speaker via an STT container into `speech.heard`, and plays `voice.utterance` audio into the channel.

## Requirements

### Requirement: Discord session
With `ears.source` `discord` (default) and DISCORD_TOKEN set the system SHALL log in with env DISCORD_TOKEN, join the voice channel DISCORD_VOICE_CHANNEL_ID in guild DISCORD_GUILD_ID (not self-muted or deafened), and rejoin after 5 s if the connection does not recover within 5 s of disconnect. With `discord` and DISCORD_TOKEN unset it MUST NOT exit: it SHALL stay running idle and report `degraded` with `discord` down (heartbeat from change `add-service-health`).

#### Scenario: Not a voice channel
- **WHEN** the configured channel is not voice-based
- **THEN** join fails with "DISCORD_VOICE_CHANNEL_ID is not a voice channel"

#### Scenario: Login failure
- **WHEN** Discord login with a configured token fails
- **THEN** the error is logged and the process exits with code 1

#### Scenario: No token
- **WHEN** `ears.source` is `discord` and DISCORD_TOKEN is unset
- **THEN** the process stays up, creates no Discord client, and reports degraded

### Requirement: Per-speaker capture
The system SHALL capture each speaking user separately (ignoring the bot itself), ending capture after `ears.silence_ms` (default 700) of silence, decoding Opus to 48 kHz stereo PCM.

#### Scenario: Already listening
- **WHEN** a user starts speaking while their stream is being captured
- **THEN** no second subscription is made

#### Scenario: Decoder error
- **WHEN** the decoder errors
- **THEN** the user is removed from the listening set and a warning is logged

### Requirement: Transcription and speech.heard
The system SHALL drop utterances shorter than `ears.min_speech_ms` (default 400), convert PCM to 16 kHz mono WAV, POST it to `<stt>/v1/audio/transcriptions` with `ears.stt_model` (default `Systran/faster-whisper-small`), language `en`, and publish `speech.heard {speaker, speakerId, text, durationMs}`.

#### Scenario: Too short
- **WHEN** the utterance is under min_speech_ms
- **THEN** nothing is transcribed or published

#### Scenario: Empty transcript
- **WHEN** the text is empty or only non-word characters
- **THEN** nothing is published

#### Scenario: STT failure
- **WHEN** the STT call returns non-OK
- **THEN** a "transcription failed" warning is logged and no event is published

### Requirement: Audio conversion
The system SHALL downsample 48k stereo to 16k mono by averaging 3 frames and channels, and convert any-rate mono/stereo 16-bit WAV to 48k stereo by linear interpolation.

#### Scenario: Invalid WAV
- **WHEN** a WAV has no data chunk
- **THEN** readWavHeader throws "bad wav"

### Requirement: Utterance playback
The system SHALL subscribe (group `ears`, from now) to `voice.utterance`, fetch `audioUrl`, play utterances one at a time, and publish `voice.playing` and `voice.done` with `sink: "discord"`.

#### Scenario: Queueing
- **WHEN** a second utterance arrives while one plays
- **THEN** it waits until the player goes idle, at which point `voice.done` is published for the first

#### Scenario: Fetch failure
- **WHEN** fetching or converting audio fails
- **THEN** a warning is logged and the next queued utterance is played, with no `voice.playing` for the failed one

### Requirement: Heartbeat
The ears service SHALL publish `service.heartbeat` with `service: "ears"` via `startHeartbeat`: `starting` at boot, `ready` once its Discord session is connected, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{discord, stt}`. With no `DISCORD_TOKEN` it MUST report `mode: "off"` and `discord: "n/a"`; otherwise `mode: "live"`.

#### Scenario: Ready
- **WHEN** ears has finished starting
- **THEN** a heartbeat with `service: "ears"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Missing token
- **WHEN** no `DISCORD_TOKEN` is set
- **THEN** `mode` is `off`, `deps.discord` is `n/a`, and `state` is `degraded`

#### Scenario: Shutdown
- **WHEN** ears receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0

### Requirement: Off source
With `ears.source: off` the service SHALL create no Discord client, require no Discord env vars, publish no `speech.heard`, ignore `voice.utterance` without publishing `voice.playing`/`voice.done`, and stay running idle.

#### Scenario: Off
- **WHEN** `ears.source` is `off`
- **THEN** the service idles with no Discord login and a `voice.utterance` produces no ears events

### Requirement: Isolation preset and mode
`EARS_SOURCE=off` SHALL select the off source. Heartbeat `mode` (change `add-service-health`) MUST be `off` for `off` and `live` for `discord`.

#### Scenario: Preset
- **WHEN** `EARS_SOURCE=off`
- **THEN** mode is `off`

### Requirement: Injected audio
The system SHALL subscribe with consumer group `ears` to `inject.request` and, for `target: "ears"` and `kind: "audio"`, fetch `url`, send the bytes unchanged to the STT service (`<stt>/v1/audio/transcriptions` with `ears.stt_model`), and publish `speech.heard {speaker, text, durationMs, injected: true, remember}` followed by `inject.result {id, ok:true, detail:text}`. `speaker` SHALL be `meta.user` or `injected`; `durationMs` SHALL come from the WAV header when the file is WAV, else 0. `ears.min_speech_ms` MUST NOT apply. An empty or non-word transcript, an STT error, a fetch failure, a URL outside `urls.dashboard()` + `/uploads/`, or a request older than 60 s SHALL yield `inject.result {ok:false, detail}` and no `speech.heard`. This MUST work when `ears.source` is `off` or Discord is not connected.

#### Scenario: Transcribed
- **WHEN** a WAV upload transcribes to "hello there" with `meta.user:"alice"`
- **THEN** `speech.heard {speaker:"alice", text:"hello there", injected:true, remember:false}` and `inject.result {ok:true}` are published

#### Scenario: STT down
- **WHEN** the STT call returns non-OK
- **THEN** `inject.result {ok:false, detail}` is published and no `speech.heard`

#### Scenario: Empty transcript
- **WHEN** the transcript is empty or only non-word characters
- **THEN** `inject.result {ok:false}` is published and no `speech.heard`

#### Scenario: Short clip
- **WHEN** the clip is shorter than `ears.min_speech_ms`
- **THEN** it is still transcribed

#### Scenario: Isolated ears
- **WHEN** `ears.source` is `off` and no `DISCORD_TOKEN` is set
- **THEN** injection is still handled

#### Scenario: Foreign URL
- **WHEN** `url` is outside `<DASHBOARD_URL>/uploads/`
- **THEN** nothing is fetched and `inject.result {ok:false}` is published
