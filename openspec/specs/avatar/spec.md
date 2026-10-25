# avatar Specification

## Purpose
The avatar service (services/avatar) animates an avatar app from bus events. An Engine owns timing, smoothing, idle motion and lip-sync; pluggable drivers only translate canonical state to an app.

## Requirements

### Requirement: Bus events consumed
The system SHALL subscribe (group `avatar`, from now) to `voice.utterance`, `voice.playing`, `voice.done`, `brain.say` and `affect.state` and route each to the Engine.

#### Scenario: Brain decides to speak
- **WHEN** `brain.say` arrives
- **THEN** the Engine sets the event's emotion immediately with a 6000 ms hold, before audio exists

#### Scenario: Utterance lifecycle
- **WHEN** `voice.utterance` arrives, then `voice.playing` and `voice.done` with the same id
- **THEN** the utterance is prepared, lip-sync playback starts on playing (emotion held for durationMs + 4000 ms, gesture triggered if set), and playback ends on done

#### Scenario: Unknown utterance id
- **WHEN** `voice.playing` carries an id that was never prepared
- **THEN** it is ignored; at most 20 prepared utterances are remembered (oldest evicted)

### Requirement: Lip-sync and mood
The Engine SHALL derive `mouthOpen` from the utterance envelope at `envelopeHz` relative to playback start, and SHALL treat `affect.state` mood as the resting face.

#### Scenario: Envelope playback
- **WHEN** an utterance is playing
- **THEN** mouthOpen follows envelope[floor(elapsed * envelopeHz)], and playback is cleared once elapsed exceeds durationMs + 500 ms

#### Scenario: Emotion decay
- **WHEN** the emotion hold expires and the emotion differs from the mood
- **THEN** the expression returns to the mood (intensity 0 for neutral, else 0.5)

#### Scenario: Mood change while an utterance holds the face
- **WHEN** `affect.state` changes the mood while the emotion hold is active
- **THEN** the mood is stored but the expression is not changed until the hold expires

### Requirement: Animation loop
The Engine SHALL run at `avatar.fps` (default 30), smoothing parameters toward targets by `avatar.smoothing` (default 0.25), with idle motion when `avatar.idle_motion` (default true) is on.

#### Scenario: Smoothing rates
- **WHEN** a frame is computed
- **THEN** mouthOpen uses min(1, smoothing * 3), blink uses 1, other params use smoothing

#### Scenario: Blinking and smile
- **WHEN** frames run
- **THEN** blink fires for 120 ms every 2.5-6 s, and mouthSmile targets 0.7 for happy/laugh/smug, else 0.15

### Requirement: Driver contract and selection
The system SHALL select a driver from `avatar.driver` (`vtube-studio`, `vmc`, `null`; default `null`) and drivers MUST implement connect, disconnect, connected, setParams, setExpression, trigger and capabilities.

#### Scenario: Null driver
- **WHEN** driver is `null` or unrecognized
- **THEN** a NullDriver is used, reports connected, and only logs expressions and gestures

#### Scenario: Expression maps
- **WHEN** the service starts
- **THEN** expressions.yaml is loaded for the chosen driver name; `gestures` is split out from the canonical-emotion to app-expression map, defaulting to empty

### Requirement: VTube Studio driver
The VTube Studio driver SHALL connect over WebSocket to `vtube_studio.host:port` (plugin name/developer default `cohost`), authenticate with a token persisted at `<config dir>/.vts-token`, and reconnect after 5 s on close.

#### Scenario: First connection
- **WHEN** no saved token exists
- **THEN** it sends AuthenticationTokenRequest (60 s timeout) awaiting user approval, saves the token, then sends AuthenticationRequest

#### Scenario: Token rejected
- **WHEN** authentication returns authenticated=false
- **THEN** the token file is blanked and an error is raised so the next attempt re-requests a token

#### Scenario: Request timeout
- **WHEN** VTS does not reply within 5 s (default)
- **THEN** the request rejects with a "timed out" error

### Requirement: VMC driver
The VMC driver SHALL send OSC over UDP fire-and-forget to `vmc.host:port` (VMC receiver default 39539).

#### Scenario: Params sent
- **WHEN** setParams is called
- **THEN** OSC messages are sent, with mouth sent as both "A" and "aa" and blink as both "Blink" and "blink"

### Requirement: State publication
The service SHALL publish `avatar.state` carrying all AvatarParams plus `emotion`, `intensity`, `driver` and `connected`, at most once per 200 ms.

#### Scenario: Throttled preview
- **WHEN** the Engine emits frames at 30 fps
- **THEN** `avatar.state` is published at no more than ~5 Hz; intensity is 0 for neutral, 1 while held, else 0.5
