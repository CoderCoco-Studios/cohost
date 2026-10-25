# ears Specification

## Purpose
The ears service (services/ears) is a Discord bot in a voice channel. It transcribes each speaker via an STT container into `speech.heard`, and plays `voice.utterance` audio into the channel.

## Requirements

### Requirement: Discord session
The system SHALL log in with env DISCORD_TOKEN, join the voice channel DISCORD_VOICE_CHANNEL_ID in guild DISCORD_GUILD_ID (not self-muted or deafened), and rejoin after 5 s if the connection does not recover within 5 s of disconnect.

#### Scenario: Not a voice channel
- **WHEN** the configured channel is not voice-based
- **THEN** join fails with "DISCORD_VOICE_CHANNEL_ID is not a voice channel"

#### Scenario: Login failure
- **WHEN** Discord login fails
- **THEN** the error is logged and the process exits with code 1

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
