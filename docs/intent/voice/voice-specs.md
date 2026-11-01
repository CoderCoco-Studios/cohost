# voice specs

## Synthesis

- [x] **VOICE-SYN-001**: When the voice service starts, it shall subscribe with consumer group `voice` (from now) to `brain.say` and `voice.playing`, handling events one at a time. <!-- openspec: voice § Synthesis -->
- [x] **VOICE-SYN-002**: When `voice.engine` is `kokoro` and a `brain.say` arrives, the voice service shall POST JSON `{model: "kokoro", input: <text>, voice: voice.voice, speed: voice.speed, response_format: "wav"}` to `<TTS_URL>/v1/audio/speech` and use the response body as the utterance WAV. <!-- openspec: voice § Synthesis --> <!-- test: services/voice/test/voice.test.ts:105 -->
- [x] **VOICE-SYN-003**: If the TTS server returns a non-2xx status, then the voice service shall raise the error "tts <status>: <body>", which is handled as a synthesis failure. <!-- openspec: voice § Synthesis --> <!-- test: services/voice/test/voice.test.ts:105 -->
- [x] **VOICE-SYN-004**: When a `brain.say` has been synthesized, the voice service shall store the WAV under the event `id` before publishing `voice.utterance`. <!-- test: services/voice/test/voice.test.ts:71 -->

## Stub engine

- [x] **VOICE-STUB-001**: Where `voice.engine` is `stub`, the voice service shall make no HTTP request to the TTS service and shall synthesize a zero-filled mono 16-bit WAV at `voice.sample_rate` lasting `max(400, 60 * text.length)` milliseconds. <!-- openspec: voice § Stub engine --> <!-- test: services/voice/test/stub.test.ts:11 -->
- [x] **VOICE-STUB-002**: Where `voice.engine` is `stub`, when a `brain.say` arrives, the voice service shall publish a real `voice.utterance` with `durationMs`, `sampleRate`, an all-zero 30 Hz `envelope` and a fetchable `audioUrl`. <!-- openspec: voice § Stub engine --> <!-- test: services/voice/test/stub.test.ts:30 -->
- [x] **VOICE-STUB-003**: Where `voice.engine` is `stub`, the voice service shall log a startup warning that utterances are silent. <!-- openspec: voice § Isolation preset and mode -->

## Utterance publication

- [x] **VOICE-UTT-001**: When a `brain.say` is synthesized, the voice service shall publish `voice.utterance` carrying `id`, `text`, `emotion`, `gesture`, `durationMs` (rounded from the WAV), `envelopeHz` 30, `envelope`, `audioUrl` and `sampleRate` (from the WAV). <!-- openspec: voice § voice.utterance publication --> <!-- test: services/voice/test/voice.test.ts:21 -->
- [x] **VOICE-UTT-002**: The voice service shall set `audioUrl` to `<urls.voice()>/audio/<id>.wav`, where `urls.voice()` is `VOICE_URL` or else `http://127.0.0.1:<VOICE_PORT>` (default port 8700). <!-- openspec: voice § voice.utterance publication --> <!-- test: services/voice/test/voice.test.ts:21 --> <!-- note: OpenSpec baseline says the default is http://voice:<VOICE_PORT>; code and packages/config/test/config.test.ts:207 default to loopback and compose overrides with VOICE_URL=http://voice:8700 -->
- [x] **VOICE-UTT-003**: If synthesis, WAV parsing, envelope extraction or publishing of `voice.utterance` fails for a `brain.say`, then the voice service shall log the error "tts failed", publish `voice.done` with that `id` and `sink` `error`, and publish no `voice.utterance`. <!-- openspec: voice § Failure handling --> <!-- test: services/voice/test/voice.test.ts:61 -->

## WAV and lip-sync envelope

- [x] **VOICE-ENV-001**: When parsing a WAV, the voice service shall require a `RIFF`/`WAVE` header, skip unknown and odd-sized chunks, read channels, sample rate and bit depth from `fmt `, clamp the data length to the bytes present, and compute duration in milliseconds from the frame count. <!-- test: services/voice/test/wav.test.ts:26 --> <!-- test: services/voice/test/wav.test.ts:43 -->
- [x] **VOICE-ENV-002**: If a buffer is not RIFF/WAVE or has no data chunk, then `parseWav` shall throw "not a RIFF/WAVE file" or "no data chunk" respectively. <!-- openspec: voice § Envelope extraction --> <!-- test: services/voice/test/wav.test.ts:49 -->
- [x] **VOICE-ENV-003**: When computing a lip-sync envelope, the voice service shall emit one value per window of `floor(sampleRate / 30)` frames of the first channel (including a partial last window), each `min(1, (rms / 0.22) ^ 0.8)`, smoothed so each value is at least 0.6 times the previous one, rounded to 2 decimals. <!-- openspec: voice § Envelope extraction --> <!-- test: services/voice/test/wav.test.ts:55 --> <!-- test: services/voice/test/wav.test.ts:69 -->
- [x] **VOICE-ENV-004**: If a WAV is not 16-bit, then envelope extraction shall throw "unsupported bit depth <n>". <!-- openspec: voice § Envelope extraction --> <!-- test: services/voice/test/wav.test.ts:89 -->

## Sink arbitration

- [x] **VOICE-SINK-001**: When the voice service reads a `voice.playing` whose `sink` is not `virtual`, it shall record the event `id` as claimed by a real sink. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts:51 -->
- [x] **VOICE-SINK-002**: When 1500 ms have passed since the voice service published a `voice.utterance` and its `id` has not been claimed, the voice service shall publish `voice.playing` with that `id` and `sink` `virtual`. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts:37 -->
- [x] **VOICE-SINK-003**: When the voice service has published a virtual `voice.playing`, it shall publish `voice.done` with the same `id` and `sink` `virtual` after the utterance `durationMs`. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts:37 -->
- [x] **VOICE-SINK-004**: While an utterance `id` has been claimed by a non-virtual sink, the voice service shall publish no virtual `voice.playing` or `voice.done` for it. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts:51 -->
- [x] **VOICE-SINK-005**: The voice service shall not treat its own `sink: "virtual"` `voice.playing` as a claim. <!-- test: services/voice/test/voice.test.ts:51 -->
- [x] **VOICE-SINK-006**: If synthesis fails for an utterance, then the voice service shall publish `voice.done` with `sink` `error` and shall arm no virtual-sink timers, so that cortex is released without any audio. <!-- openspec: voice § Failure handling --> <!-- test: services/voice/test/voice.test.ts:61 -->
- [ ] **VOICE-SINK-007**: While the voice service is running, it shall bound the set of claimed utterance ids (for example by dropping a claim when its audio is evicted from the store). <!-- gap: voice.ts:70,84 add to claimed and never remove, while the audio store is capped at 50 (voice.ts:77) -->
- [ ] **VOICE-SINK-008**: When a real sink's `voice.playing` for an utterance `id` arrives after the voice service has already published its virtual `voice.playing` for that `id`, the arbitration protocol shall still yield a single `voice.playing` / `voice.done` lifecycle for the `id`. <!-- gap: voice.ts:106-111 has no way to retract the virtual pair; the claim window is a fixed 1.5 s (openspec: voice § Virtual sink) while ears queues behind earlier audio (services/ears/src/playback.ts:38-45), so late real sinks produce duplicates -->

## Audio store and HTTP

- [x] **VOICE-HTTP-001**: The voice service shall keep at most the newest 50 synthesized WAVs in memory, evicting the oldest first. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts:91 -->
- [x] **VOICE-HTTP-002**: When `GET /audio/<id>.wav` is requested for a stored id, the voice service shall respond 200 with `content-type: audio/wav`, the WAV length and `access-control-allow-origin: *`. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts:71 -->
- [x] **VOICE-HTTP-003**: If `GET /audio/<id>.wav` names an unknown or evicted id (ids are limited to word characters and hyphens), then the voice service shall respond 404 with body `gone`, and for any other path it shall respond 404 with an empty body. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts:71 -->
- [x] **VOICE-HTTP-004**: When `GET /health` is requested, the voice service shall respond 200 with body `ok`. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts:71 -->
- [x] **VOICE-HTTP-005**: The voice service shall listen for HTTP on `VOICE_PORT` (default 8700). <!-- openspec: voice § voice.utterance publication -->

## Health

- [x] **VOICE-HLTH-001**: When the voice service's HTTP server is listening, it shall report heartbeat state `ready` with `service` `voice` and `deps` `{kokoro}`; with the `kokoro` engine, mode shall be `live`. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts:6 -->
- [x] **VOICE-HLTH-002**: When a Kokoro synthesis fails, the voice service shall set `deps.kokoro` to `down` (heartbeat `degraded`) and set it back to `ok` when the next synthesis succeeds. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts:13 -->
- [x] **VOICE-HLTH-003**: Where `voice.engine` is `stub`, the voice service shall report heartbeat mode `mock` with `deps.kokoro` `n/a` and state `ready`. <!-- openspec: voice § Isolation preset and mode --> <!-- test: services/voice/test/stub.test.ts:52 -->
- [x] **VOICE-HLTH-004**: When the voice service receives SIGINT or SIGTERM, it shall publish one `stopping` heartbeat, close its HTTP server, stop the bus and exit with code 0. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts:6 -->
