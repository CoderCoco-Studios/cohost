## ADDED Requirements

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
