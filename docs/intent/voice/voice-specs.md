# voice specs

Design: [voice-design.md](voice-design.md). Prefix `VOICE`. `[x]` = implemented, `[ ]` = intended but not yet implemented (gap), `[D]` = deferred. A `<!-- test: ... -->` pointer names the test file; paths are relative to the repo root.

## Synthesis

- [ ] **VOICE-SYN-001**: When the voice service starts, it shall subscribe with consumer group `voice` and the event-bus `latest` start mode (BUS-SUB-010) to `brain.say`, `brain.clause`, `voice.playing`, `voice.failed` and `voice.stop`, reading events one at a time in stream order, so that the group is moved to the newest stream entry on every start and no `brain.say` published while voice was down is spoken. <!-- openspec: voice § Synthesis --> <!-- test: services/voice/test/boot.test.ts -->
- [x] **VOICE-SYN-002**: When `voice.engine` is `kokoro` and a `brain.say` arrives, the voice service shall POST JSON `{model: "kokoro", input: <text>, voice: voice.voice, speed: voice.speed, response_format: "wav"}` to `<TTS_URL>/v1/audio/speech` and use the PCM that the shared WAV reader (VOICE-WAV-001 to VOICE-WAV-008) reads from the response body as the utterance audio. <!-- openspec: voice § Synthesis --> <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-SYN-003**: If the TTS server returns a non-2xx status, then the voice service shall raise the error "tts <status>: <body>", which is handled as a synthesis failure. <!-- openspec: voice § Synthesis --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SYN-004**: When a clause (a `brain.say`, which is clause 0, or a `brain.clause`) has been synthesized, the voice service shall store the WAV under the key `<id>-<seq>` before publishing `voice.utterance`. <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-SYN-005**: The voice service shall synthesize every `brain.say` it reads, whatever its `reason`, `injected` or `remember` fields, and shall not subscribe to `control`: mute and pause are applied upstream by cortex and salience. <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/boot.test.ts (the subscribed types exclude `control`) -->
- [x] **VOICE-SYN-006**: If any voice service startup step after the configuration loads fails (binding the HTTP port, positioning the consumer group) or the voice service's bus subscription rejects (a failure the bus's own retry, BUS-SUB-009, does not absorb), then the voice service shall log the error with message `fatal` and exit with a non-zero status instead of leaving an unhandled rejection; a configuration that does not load is reported by the shared bootstrap (SHARED-BOOT-002), which logs the loader's message and exits with status 1. <!-- test: services/voice/test/boot.test.ts --> <!-- test: services/voice/test/boot.test.ts -->

- [x] **VOICE-SYN-007**: When the voice service reads a `brain.say`, it shall put the line on an internal queue and return to reading the bus at once, and shall synthesize queued lines one at a time in arrival order, so that a `voice.playing` or `voice.failed` that follows is read and applied while a line is still being synthesized; if handling a queued line throws past its own `tts failed` handling, then the voice service shall log `synthesis failed` and go on with the next line. <!-- test: services/voice/test/queue.test.ts -->
- [ ] **VOICE-SYN-008**: When the voice service stops, it shall drop every queued `brain.say` and `brain.clause`, publish nothing for a clause that was being synthesized, and take no `brain.say` or `brain.clause` read afterwards. <!-- test: services/voice/test/queue.test.ts -->
- [x] **VOICE-SYN-009**: When `voice.lang_code`, `voice.volume_multiplier` or any `voice.normalization.*` key is set, the Kokoro synthesizer shall add it to the request body as `lang_code`, `volume_multiplier` and `normalization_options` (holding only the keys set), and shall leave each unset one out; every field it sends shall be one the pinned Kokoro-FastAPI tag's `/v1/audio/speech` request schema defines. <!-- test: services/voice/test/kokoro-request.test.ts -->

## Stub engine

- [x] **VOICE-STUB-001**: Where `voice.engine` is `stub`, the voice service shall make no HTTP request to the TTS service and shall synthesize a zero-filled mono 16-bit WAV at `voice.sample_rate` lasting `max(400, 60 * text.length)` milliseconds. <!-- openspec: voice § Stub engine --> <!-- test: services/voice/test/stub.test.ts --> <!-- test: services/voice/test/stub.test.ts --> <!-- test: services/voice/test/stub.test.ts -->
- [x] **VOICE-STUB-002**: Where `voice.engine` is `stub`, when a `brain.say` arrives, the voice service shall publish a real `voice.utterance` with `durationMs`, `sampleRate`, an all-zero 30 Hz `envelope` and a fetchable `audioUrl`. <!-- openspec: voice § Stub engine --> <!-- test: services/voice/test/stub.test.ts -->
- [x] **VOICE-STUB-003**: Where `voice.engine` is `stub`, the voice service shall log a startup warning that utterances are silent. <!-- openspec: voice § Isolation preset and mode --> <!-- test: services/voice/test/boot.test.ts -->

## Utterance publication

- [ ] **VOICE-UTT-001**: When a clause (a `brain.say`, which is clause 0, or a `brain.clause`) is synthesized, the voice service shall publish `voice.utterance` carrying `id`, `seq`, `text`, `emotion`, `gesture` (clause 0 only), `durationMs` (rounded from the WAV), `envelopeHz` 30, `envelope`, `audioUrl` and `sampleRate` (from the WAV). <!-- openspec: voice § voice.utterance publication --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-UTT-002**: The voice service shall set `audioUrl` to `<urls.voice()>/audio/<id>-<seq>.wav`, where `urls.voice()` is `VOICE_URL` or else `http://127.0.0.1:<VOICE_PORT>` (default port 8700). <!-- openspec: voice § voice.utterance publication --> <!-- test: services/voice/test/voice.test.ts --> <!-- note: the loopback default is deliberate (commit e53badc, tested in packages/config/test/config.test.ts); compose sets VOICE_URL=http://voice:8700. -->
- [ ] **VOICE-UTT-003**: If synthesis, WAV parsing, envelope extraction or publishing of `voice.utterance` fails for a clause, then the voice service shall log the error "tts failed", publish `voice.done` with that `id`, `seq`, `sink` `error` and `final` true, and publish no `voice.utterance`. <!-- openspec: voice § Failure handling --> <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-UTT-004**: Where a `brain.say` carries a `route`, the voice service shall publish its `voice.utterance` with the same `route`, unchanged and uninterpreted; where it carries none, the `voice.utterance` shall carry none. <!-- test: services/voice/test/voice.test.ts -->

## WAV and lip-sync envelope

Retired, numbers not reused: VOICE-ENV-001 and VOICE-ENV-002 (now shared-runtime SHARED-AUDIO-001 and SHARED-AUDIO-002).

- [x] **VOICE-ENV-005**: If an engine's server answers with audio the engine adapter rejects (VOICE-WAV-002 to VOICE-WAV-008), then the voice service shall fail the line on the `tts failed` path (VOICE-UTT-003); the voice service shall parse the WAV it assembles from an engine's audio with the shared `parseWav` (SHARED-AUDIO-001 to SHARED-AUDIO-003). <!-- test: services/voice/test/queue.test.ts -->
- [x] **VOICE-ENV-003**: When computing a lip-sync envelope, the voice service shall emit one value per window of `floor(sampleRate / 30)` frames of the first channel (including a partial last window), each `min(1, (rms / 0.22) ^ 0.8)`, smoothed so each value is at least 0.6 times the previous one, rounded to 2 decimals. <!-- openspec: voice § Envelope extraction --> <!-- test: services/voice/test/wav.test.ts --> <!-- test: services/voice/test/wav.test.ts -->
- [x] **VOICE-ENV-004**: If a WAV is not 16-bit, then envelope extraction shall throw "unsupported bit depth <n>". <!-- openspec: voice § Envelope extraction --> <!-- test: services/voice/test/wav.test.ts -->

## Sink arbitration

- [ ] **VOICE-SINK-001**: When the voice service reads a `voice.playing` whose `sink` is not `virtual` for a clause whose audio is stored, it shall record the clause (its `id` and `seq`) as claimed by a real sink and its line as claimed. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-002**: When 1500 ms have passed since the voice service published the `voice.utterance` of a line's first clause (`seq` 0) and the line has not been claimed, the voice service shall publish `voice.playing` for that clause with `sink` `virtual`. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-003**: When the voice service has published a virtual `voice.playing`, it shall publish `voice.done` with the same `id`, `seq` and `sink` `virtual` after the clause's `durationMs`, counted from when the `voice.playing` publish resolved (or failed), so a slow publish never puts the two events back-to-back. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-004**: If a line has been claimed by a non-virtual sink when its 1500 ms claim window ends, then the voice service shall publish no virtual `voice.playing` or `voice.done` for it. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-SINK-005**: The voice service shall not treat its own `sink: "virtual"` `voice.playing` as a claim. <!-- test: services/voice/test/voice.test.ts (observable only with a re-used id, because the virtual voice.playing is published only after the claim check) -->
- [ ] **VOICE-SINK-006**: If synthesis fails for a clause, then the voice service shall publish `voice.done` with `id`, `seq`, `sink` `error` and `final` true and shall arm no virtual-sink timers for it, so that cortex is released without any audio. <!-- openspec: voice § Failure handling --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-007**: While the voice service is running, it shall bound the set of claimed clauses by dropping a claim when its audio is evicted from the store, and shall record a claim only for a clause whose audio is stored. <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-008**: When a non-virtual sink's `voice.playing` for a line without `more` arrives after the voice service has published its virtual `voice.playing` for that line and before the virtual `voice.done`, the voice service shall cancel the pending virtual `voice.done`, so that the only `voice.done` published for the line afterwards is the real sink's own; a claim that arrives while the virtual `voice.playing` publish is still pending shall mean no virtual `voice.done` is published at all; a claim that arrives after the virtual `voice.done` has been published shall change nothing, and a claim for one line shall not affect another; a streamed line follows VOICE-CLAUSE-021. <!-- openspec: voice § Virtual sink --> <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-SINK-009**: If publishing a virtual `voice.playing` or `voice.done` fails, then the voice service shall log the failure (`virtual sink publish failed`) and keep running. <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-SINK-010**: The voice service shall also read `voice.failed` on its one `voice` loop (VOICE-SYN-001), in stream order with `brain.say` and `voice.playing`. <!-- test: services/voice/test/boot.test.ts -->
- [ ] **VOICE-SINK-011**: When the voice service reads a `voice.failed` without `fallback` for a stored clause of a line that no real sink has claimed and whose 1500 ms claim window has not ended, and that window then ends with the line still unclaimed, or for a clause of a virtual line that has no clause playing once the window has ended, the voice service shall, in place of VOICE-SINK-002 and VOICE-SINK-003, publish `voice.done` with that `id`, `seq`, `sink` `virtual` and `final` true at once, publish no virtual `voice.playing`, and end the line. <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-012**: When the voice service reads a `voice.failed` without `fallback` for a clause whose virtual `voice.playing` has been published and whose virtual `voice.done` is still pending, the voice service shall cancel the pending timer and publish that virtual `voice.done` at once with `final` true, in place of VOICE-SINK-003's wait for `durationMs`, and end the line. <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-SINK-013**: When the voice service reads a `voice.failed` that carries `fallback`, or names a line already claimed by a real sink, or names a clause whose audio voice does not hold, the voice service shall change no claim, timer or published event because of it (a fallback's `voice.playing` claim is handled by VOICE-SINK-001 and VOICE-SINK-008). <!-- test: services/voice/test/voice.test.ts -->

## Stopping a line (STOP)

Design: LLD Sink Arbitration Protocol, rule 9. `voice.stop` is defined by BUS-EVT-030; a sink's own stop is MOUTH-STOP-*.

- [x] **VOICE-STOP-001**: The voice service shall read `voice.stop` on its one `voice` loop (VOICE-SYN-001), in stream order with `brain.say`, `voice.playing` and `voice.failed`. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-002**: When the voice service reads a `voice.stop` without `ids`, it shall apply VOICE-STOP-003 to VOICE-STOP-006, VOICE-STOP-009 and VOICE-STOP-010 to every line it holds; when it carries `ids`, only to the lines whose `brain.say` id is listed. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-003**: When the voice service applies a `voice.stop` to a `brain.say` that is on its synthesis queue and has not started synthesis, it shall remove it from the queue and publish no event for it. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-004**: When the voice service applies a `voice.stop` to a line whose synthesis is in progress, it shall discard the result when synthesis ends: it shall store no WAV for it, publish no `voice.utterance` and no `voice.done` for it, and arm no timer for it. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-005**: When the voice service applies a `voice.stop` to a line whose claim window is open, it shall clear the window's timer, so that no virtual `voice.playing` or `voice.done` is published for it. <!-- test: services/voice/test/stop.test.ts -->
- [ ] **VOICE-STOP-006**: When the voice service applies a `voice.stop` to a line whose virtual `voice.playing` has been published and whose virtual `voice.done` is pending, it shall clear that timer and publish `voice.done` with that `id`, the `seq` of the clause that was playing, `sink` `virtual`, `interrupted` `true`, and `spokenText` and `unsaidText` as VOICE-CLAUSE-025 says. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-007**: If a `voice.stop` names no line the voice service holds (every line finished, or an `ids` entry it does not know), then the voice service shall publish nothing and change no claim, timer or stored audio because of it, and a line a real sink has claimed shall be left to that sink. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-008**: The voice service shall synthesize every `brain.say` it reads after a `voice.stop` as VOICE-SYN-005 says, and a `voice.stop` shall set no state that affects a later line. <!-- test: services/voice/test/stop.test.ts -->
- [x] **VOICE-STOP-009**: When the voice service applies a `voice.stop` to a line whose `voice.utterance` publish is in flight, it shall, as soon as that publish settles, treat the line as stopped under VOICE-STOP-005: it shall arm no claim-window timer for it and publish no `voice.done` for it. <!-- test: services/voice/test/stop.test.ts -->
- [ ] **VOICE-STOP-010**: When the voice service applies a `voice.stop` to a line whose virtual `voice.playing` publish is in flight, it shall, as soon as that publish settles, publish `voice.done` as VOICE-STOP-006 says and arm no `voice.done` timer for it. <!-- test: services/voice/test/stop.test.ts -->

## Clause-chunked synthesis (CHUNK)

Design: LLD Lines and clauses, Decisions & Alternatives "Clause-chunked synthesis and streaming input". Nothing in this section is deferred. Re-planning at clause boundaries stays deferred in CTX-REPLAN-001, with MOUTH-POS-001 and WM-STACK-001.

- [ ] **VOICE-CHUNK-001**: The voice service shall synthesize a line clause by clause, one engine request per `brain.say` or `brain.clause`, and publish each clause's `voice.utterance` as soon as that clause's audio is ready, so that a sink can start the first clause before the rest of the line exists.
- [ ] **VOICE-CHUNK-002**: The voice service shall accept the text of a line incrementally, as a `brain.say` carrying `more` followed by `brain.clause` events, and begin synthesizing the first clause before the later clauses exist.

## TTS engine contract (ENG)

Design: LLD § The TTS engine contract.

- [x] **VOICE-ENG-001**: The voice service shall obtain the audio of every line and every fallback clip phrase from the engine `voice.engine` names (`kokoro`, `openai`, `pocket` or `stub`) through one contract that states the audio's sample rate and delivers 16-bit mono PCM in order.
- [x] **VOICE-ENG-002**: When the voice service takes an engine's audio whole, it shall gather the PCM chunks in order and wrap them as a 16-bit mono WAV at the engine's stated sample rate, with size fields computed from the bytes gathered.
- [x] **VOICE-ENG-003**: If an engine's audio holds zero frames, then the voice service shall fail the line on the `tts failed` path (VOICE-UTT-003).
- [x] **VOICE-ENG-004**: Where a response chunk splits a 16-bit frame, the engine adapter shall deliver only whole frames, in order.
- [ ] **VOICE-ENG-005**: If a connection ends before an engine's audio ends, then the voice service shall fail the clause and shall use none of the audio received.
- [x] **VOICE-ENG-006**: If no audio byte has arrived within `voice.timeout_ms` (default 15000) of the voice service sending a TTS request, then the voice service shall abort the request, close its connection, free its place in the concurrency gate (VOICE-ENG-013) and fail the line with a timeout.
- [x] **VOICE-ENG-007**: If the gap between one audio chunk and the next exceeds `voice.timeout_ms`, then the voice service shall abort the request, close its connection, free its place in the concurrency gate (VOICE-ENG-013) and fail the line with a timeout.
- [x] **VOICE-ENG-008**: The voice service shall not count time spent waiting for the concurrency gate (VOICE-ENG-011) toward `voice.timeout_ms`.
- [x] **VOICE-ENG-009**: The voice service shall not count the bytes of a WAV header as audio when measuring the first-byte bound of VOICE-ENG-006.
- [x] **VOICE-ENG-010**: While audio chunks keep arriving within `voice.timeout_ms` of one another, the voice service shall not cut a response for its total length.
- [x] **VOICE-ENG-011**: The voice service shall send no more simultaneous TTS requests than the engine's concurrency, counting live lines and fallback clip phrases together: 2 for `kokoro`, 2 for `openai`, 1 for `pocket`.
- [x] **VOICE-ENG-012**: When live lines and fallback clip phrases wait for the concurrency gate, the voice service shall let a waiting line go before a waiting clip phrase.
- [x] **VOICE-ENG-013**: The voice service shall free a request's place in the concurrency gate only when its response has ended or its connection has closed, not at the moment it aborts the request; a request aborted by a timeout (VOICE-ENG-006, VOICE-ENG-007) frees its place when its connection has closed.
- [x] **VOICE-ENG-014**: When the voice service applies a `voice.stop` to a line whose synthesis is in progress, it shall not abort that line's TTS request, and the request shall hold its place in the concurrency gate until its response has ended.
- [x] **VOICE-ENG-015**: The voice service shall abort an engine request only when the voice service stops or the request times out (VOICE-ENG-006, VOICE-ENG-007), and shall not abort the request of a line that `voice.stop` ended.
- [x] **VOICE-ENG-016**: Where `voice.engine` is `kokoro`, `openai` or `pocket`, the voice service shall read the response body with the shared WAV reader (VOICE-WAV-001 to VOICE-WAV-008).
- [D] **VOICE-ENG-017**: Where a maintained Qwen3-TTS server with a stable API exists, the voice service shall provide an engine for it; the prerequisite is such a server, and a server that speaks the OpenAI speech route is already served by the `openai` engine.

## Shared WAV reader (WAV)

Design: LLD § The TTS engine contract, Reading a WAV.

- [x] **VOICE-WAV-001**: When an engine adapter reads a WAV response, it shall walk the chunks from the `RIFF` header to the `data` chunk, reading the size of each chunk before `data` rounded up to an even number (the RIFF pad byte) and never reading the `RIFF` size or the `data` size.
- [x] **VOICE-WAV-002**: If the `fmt ` chunk's format tag is not 1 (PCM), then the engine adapter shall fail the line with `tts audio: unsupported format tag <n>`.
- [x] **VOICE-WAV-003**: If the `fmt ` chunk's bit depth is not 16, then the engine adapter shall fail the line with `tts audio: unsupported bit depth <n>`.
- [x] **VOICE-WAV-004**: If the `fmt ` chunk's channel count is not 1, then the engine adapter shall fail the line with `tts audio: unsupported channel count <n>`.
- [x] **VOICE-WAV-005**: If the `fmt ` chunk's sample rate is below 8000 or above 48000, then the engine adapter shall fail the line with `tts audio: unsupported sample rate <n>`.
- [x] **VOICE-WAV-006**: When the engine adapter reaches the `data` chunk header, it shall take every byte after it to the end of the response body as PCM and drop a trailing partial frame.
- [x] **VOICE-WAV-007**: If a response body is not a WAV file, then the engine adapter shall fail the line with `tts audio: not a WAV file`.
- [x] **VOICE-WAV-008**: If a WAV response has no `data` chunk, then the engine adapter shall fail the line with `tts audio: no data chunk`.

## Engines (KOK, OAI, POC)

Design: LLD § The TTS engine contract, the engine table.

- [x] **VOICE-KOK-001**: Where `voice.engine` is `kokoro` and `voice.voice` is blank, the voice service shall send the voice `af_heart`.
- [x] **VOICE-OAI-001**: Where `voice.engine` is `openai`, when a `brain.say` arrives, the voice service shall POST JSON `{model: voice.openai.model, input: <text>, voice: voice.voice, speed: voice.speed, response_format: "wav"}` to `<voice.openai.base_url>/audio/speech`.
- [x] **VOICE-OAI-002**: Where `voice.engine` is `openai` and `voice.openai.api_key` is set, the voice service shall send `Authorization: Bearer <key>` with the request; where it is not set, the voice service shall send no `Authorization` header.
- [x] **VOICE-OAI-003**: Where `voice.engine` is `openai`, the voice service shall send TTS requests to no address other than `voice.openai.base_url`.
- [x] **VOICE-POC-001**: Where `voice.engine` is `pocket`, when a `brain.say` arrives, the voice service shall POST `multipart/form-data` with the fields `text` and `voice_url` (= `voice.voice`) to `<voice.pocket.url>/tts`, and shall send no `voice_wav` field.
- [x] **VOICE-POC-002**: Where `voice.engine` is `pocket` and `voice.voice` is blank, the voice service shall send the voice `alba`.
- [x] **VOICE-POC-003**: Where `voice.engine` is `pocket`, the voice service shall not send `voice.speed`.
- [x] **VOICE-POC-004**: Where `voice.engine` is `pocket`, the voice service shall keep every byte of audio after the WAV header, including silence the server appends, so that the utterance `durationMs` counts it.
- [x] **VOICE-POC-005**: Where `voice.engine` is `pocket`, the voice service shall compute the lip-sync envelope from the audio received and shall not trim its trailing silence.
- [x] **VOICE-POC-006**: Where `voice.engine` is `pocket`, if the server answers a line with a JSON body `{"detail": ...}` and a non-2xx status, then the voice service shall raise `tts <status>: <body>` with that body.

## Errors, outages and configuration gaps (ERR, GAP)

Design: LLD § The TTS engine contract, Errors and Incomplete configuration.

- [x] **VOICE-ERR-001**: If a synthesis fails with a refused or dropped connection, a timeout, a 5xx, a 401, 403, 404 or 429, any other non-2xx status except 400 and 422, audio the engine adapter rejects, or incomplete engine configuration, then the voice service shall treat the failure as an outage.
- [x] **VOICE-ERR-002**: If a synthesis fails with a 400 or 422 for one line, then the voice service shall fail that line on the `tts failed` path and leave `deps.tts` unchanged.
- [x] **VOICE-ERR-003**: When a line that `voice.stop` ended fails or succeeds in synthesis, the voice service shall discard the result and leave `deps.tts` unchanged.
- [x] **VOICE-GAP-001**: Where `voice.engine` is `openai` and `voice.openai.base_url`, `voice.openai.model` or `voice.voice` is blank, the voice service shall start and reject every synthesis at once with `tts not configured: <key> is not set`, naming the blank key.
- [x] **VOICE-GAP-002**: Where `voice.engine` is `pocket` and `voice.pocket.url` is blank, the voice service shall start and reject every synthesis at once with `tts not configured: voice.pocket.url is not set`.
- [x] **VOICE-GAP-003**: While an engine's configuration is incomplete, the voice service shall report `deps.tts` `down` with the reason in the heartbeat detail.
- [x] **VOICE-GAP-004**: While an engine's configuration is incomplete, the voice service shall fail each line on the `tts failed` path (VOICE-UTT-003).
- [x] **VOICE-GAP-005**: While an engine's configuration is incomplete, the voice service shall still report `ready` once the HTTP server is listening and the consumer group is positioned.

## Egress (EGR)

Design: LLD § Egress.

- [x] **VOICE-EGR-001**: Where the host of the engine's server is off the LAN by the egress rule (config, Egress destinations), the voice service shall log one warning at start naming the engine and the host.
- [x] **VOICE-EGR-002**: Where `voice.engine` is not `stub`, the voice service shall name the engine and the host it talks to in its heartbeat detail.

## Audio store and HTTP

- [ ] **VOICE-HTTP-001**: The voice service shall keep at most the newest 100 synthesized clause WAVs in memory, evicting the oldest first. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-HTTP-002**: When `GET /audio/<id>-<seq>.wav` is requested for a stored clause, the voice service shall respond 200 with `content-type: audio/wav`, the WAV length and `access-control-allow-origin: *`. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts -->
- [ ] **VOICE-HTTP-003**: If `GET /audio/<id>-<seq>.wav` names an unknown or evicted clause (the name is limited to word characters and hyphens), then the voice service shall respond 404 with body `gone`, and for any other path it shall respond 404 with an empty body. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts --> <!-- test: services/voice/test/voice.test.ts (status codes only; no test reads the 404 bodies) -->
- [x] **VOICE-HTTP-004**: When `GET /health` is requested, the voice service shall respond 200 with body `ok`. <!-- openspec: voice § Audio store and HTTP --> <!-- test: services/voice/test/voice.test.ts -->
- [x] **VOICE-HTTP-005**: The voice service shall listen for HTTP on `VOICE_PORT` (default 8700). <!-- openspec: voice § voice.utterance publication --> <!-- test: services/voice/test/boot.test.ts -->
- [x] **VOICE-HTTP-006**: When the voice service's HTTP server receives a request whose method is neither `GET` nor `HEAD`, it shall respond 405 with `allow: GET, HEAD` whatever the path, and for `HEAD` on a path that `GET` serves it shall respond with the same status and headers and no body. <!-- test: services/voice/test/queue.test.ts -->
- [ ] **VOICE-HTTP-007**: The voice service shall match `/audio/<id>-<seq>.wav`, `/fallback/manifest.json`, `/fallback/<name>` and `/health` against the request's path without its query string. <!-- test: services/voice/test/queue.test.ts -->
- [ ] **VOICE-HTTP-008**: When the voice service stores a WAV under a key it already holds, it shall replace the stored WAV and make the key the newest entry, so the store holds each key once and evicts the oldest distinct key first. <!-- test: services/voice/test/queue.test.ts -->

## Fallback clips

Design: LLD § Fallback Clips. "The clip store" is voice's own directory `<dataDir()>/voice/fallback-clips` (CFG-DIR-006, CFG-DIR-007). "The phrase list" is `voice.fallback.lines` (CFG-SCH-017). "The committed set" is the set the store's `manifest.json` names.

- [x] **VOICE-CLIP-001**: Where `voice.engine` is not `stub`, when the voice service starts it shall compute the clip fingerprint as the SHA-256 of a canonical JSON of the phrase list (in order, each phrase trimmed), `voice.engine`, the engine's fingerprint object (VOICE-CLIP-013) and a clip-format version number. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-002**: If the computed fingerprint equals the `fingerprint` in the clip store's `manifest.json` and every clip file the manifest lists exists and is not empty, then the voice service shall make no TTS request for fallback clips and leave the clip store unchanged. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-003**: When the computed fingerprint differs from the manifest's, or the clip store has no readable manifest, the voice service shall regenerate the clips after reporting `ready` and without awaiting the regeneration on its bus loop, synthesizing one phrase at a time in list order with the same engine call as an utterance, through the same concurrency gate (VOICE-ENG-011), and shall run at most one regeneration at a time. <!-- test: services/voice/test/clips.test.ts --><!-- test: services/voice/test/boot.test.ts -->
- [x] **VOICE-CLIP-004**: When a regeneration has synthesized every phrase it keeps, the voice service shall write the clips into a new temporary directory inside the clip store, rename it to a new set directory `sets/<generatedAt>-<random suffix>` that no other regeneration uses, and then replace `manifest.json` by renaming a fully written temporary file over it, so that the committed set is always complete. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-005**: If a phrase's synthesis fails with an outage-class failure (VOICE-ERR-001), or writing the clip store fails, during a regeneration, then the voice service shall commit nothing, abandon that regeneration, leave `manifest.json` and the committed set unchanged, log a warning, and retry the regeneration after a delay starting at 60 s and doubling to a 15 min cap until one succeeds or voice stops. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-006**: If one phrase's synthesis fails with a 400 or 422, or the clip is shorter than 100 ms, then the voice service shall leave that phrase out of the set, log a warning naming the phrase's index, and continue with the remaining phrases; the committed manifest carries the computed fingerprint, so the skipped phrase is not retried until the fingerprint changes. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-007**: When the voice service has committed a new manifest, it shall delete every set directory other than the committed set, and every temporary directory in the clip store older than one hour. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-008**: Where `voice.engine` is `stub`, the voice service shall neither generate fallback clips nor create, modify or delete anything in the clip store, and shall answer `GET /fallback/manifest.json` and every `GET /fallback/<name>` with 404. <!-- test: services/voice/test/clips.test.ts --><!-- test: services/voice/test/boot.test.ts -->
- [x] **VOICE-CLIP-009**: The voice service shall write `manifest.json` as JSON holding `version`, `fingerprint`, `generatedAt` (epoch ms), `set` (the set directory relative to the clip store) and `clips`, a list in phrase order of `{name, text, durationMs, bytes, sha256}`, where `name` is `<index>-<first 8 hex characters of sha256>.wav` and `<index>` is the phrase's zero-based list index, zero-padded to at least two digits (more digits when the list has more than 100 phrases). <!-- test: services/voice/test/clips.test.ts --><!-- test: services/voice/test/mouth-sync.test.ts -->
- [x] **VOICE-CLIP-010**: When the phrase list is empty, the voice service shall commit a manifest whose `clips` list is empty, making no TTS request. <!-- test: services/voice/test/clips.test.ts -->
- [x] **VOICE-CLIP-011**: When `GET /fallback/manifest.json` is requested and a set is committed and `voice.engine` is not `stub`, the voice service shall respond 200 with `content-type: application/json` and the committed manifest without its `set` field; when no set is committed, it shall respond 404. <!-- test: services/voice/test/clips.test.ts --><!-- test: services/voice/test/mouth-sync.test.ts -->
- [x] **VOICE-CLIP-012**: When `GET /fallback/<name>` is requested for a clip `name` listed in the committed manifest and `voice.engine` is not `stub`, the voice service shall respond 200 with `content-type: audio/wav`, `content-length` and the clip's bytes; for any other name it shall respond 404. <!-- test: services/voice/test/clips.test.ts --><!-- test: services/voice/test/mouth-sync.test.ts -->
- [x] **VOICE-CLIP-013**: The voice service shall build the engine's fingerprint object from the engine name, the server URL, the resolved voice (the engine's default where `voice.voice` is blank), the model where the engine has one, and every request setting the engine sends with its default resolved.
- [x] **VOICE-CLIP-014**: The voice service shall not put a credential in the engine's fingerprint object.
- [x] **VOICE-CLIP-015**: Where a Kokoro tuning knob is unset, the voice service shall leave it out of the engine's fingerprint object, as it leaves it out of the request.
- [x] **VOICE-CLIP-016**: If a phrase's synthesis fails with a 401, 403, 404 or 429, a timeout, a connection failure, a 5xx or an audio-format rejection, then the voice service shall not mark that phrase unspeakable.

## Health

- [x] **VOICE-HLTH-001**: When the voice service's HTTP server is listening and its consumer group has been positioned (so it can receive `brain.say`), it shall report heartbeat state `ready` with `service` `voice` and `deps` `{tts}` (mode `live` with every engine but `stub`), and shall not report `ready` before both conditions hold. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts --> <!-- test: services/voice/test/boot.test.ts -->
- [x] **VOICE-HLTH-002**: When a line or fallback-clip-phrase synthesis fails with an outage-class failure (VOICE-ERR-001), the voice service shall set `deps.tts` to `down` (heartbeat `degraded`) and set it back to `ok` when the next line or fallback-clip-phrase synthesis succeeds. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts -->
- [x] **VOICE-HLTH-003**: Where `voice.engine` is `stub`, the voice service shall report heartbeat mode `mock` with `deps.tts` `n/a` and state `ready`. <!-- openspec: voice § Isolation preset and mode --> <!-- test: services/voice/test/stub.test.ts -->
- [x] **VOICE-HLTH-004**: When the voice service receives SIGINT or SIGTERM, it shall publish one `stopping` heartbeat, close its HTTP server, stop the bus and exit with code 0. <!-- openspec: voice § Heartbeat (add-service-health) --> <!-- test: services/voice/test/health.test.ts (the single stopping heartbeat) --> <!-- test: services/voice/test/boot.test.ts (server close and bus stop; signal handling and exit are injected) -->
- [x] **VOICE-HLTH-005**: When the voice service stops, it shall clear every pending claim-window timer and virtual `voice.done` timer, so that no virtual `voice.playing` or `voice.done` is published afterwards. <!-- test: services/voice/test/queue.test.ts -->
- [x] **VOICE-HLTH-006**: If a synthesis fails with a 400 or 422 for one line, or the engine's audio holds zero frames (VOICE-ENG-003), or a line that `voice.stop` ended fails, or a fallback clip phrase is unspeakable, then the voice service shall leave `deps.tts` unchanged.
- [x] **VOICE-HLTH-007**: Where an engine has a readiness probe (`pocket`: `GET /health`), the voice service shall report `deps.tts` `down` from start until its first probe succeeds, probing at start and every 10 s while `deps.tts` is `down`.
- [x] **VOICE-HLTH-008**: When a probe succeeds while `deps.tts` is `down`, the voice service shall set `deps.tts` to `ok`.
- [x] **VOICE-HLTH-009**: Where an engine has no readiness probe and its configuration is complete, the voice service shall report `deps.tts` `ok` from start and judge it by the outcome of the last synthesis.
- [x] **VOICE-HLTH-010**: While `deps.tts` is `down`, the voice service shall still report `ready` once its HTTP server is listening and its consumer group is positioned.

## Lines and clauses (CLAUSE)

Design: LLD Lines and clauses, Synthesis Pipeline, Sink Arbitration Protocol. A line is a reply with the id of its `brain.say`; a clause is one `voice.utterance` of it (event-bus Streamed lines).

- [ ] **VOICE-CLAUSE-001**: When the voice service reads a `brain.say` carrying `more`, it shall open a line record keyed by its `id` holding the line's `emotion`, `gesture` and `route`, the `seq` of the last clause accepted (0), and whether the line is closed or ended, and shall keep the newest 50 line records.
- [ ] **VOICE-CLAUSE-002**: When the voice service reads a `brain.clause`, it shall put the clause on the same internal queue as `brain.say` and return to reading the bus at once, and shall synthesize queued clauses one at a time in arrival order across all lines.
- [ ] **VOICE-CLAUSE-003**: When the voice service synthesizes a clause, it shall make one engine request for it and store, measure and publish its audio on its own, with its own `durationMs` and `envelope`.
- [ ] **VOICE-CLAUSE-004**: The `voice.utterance` of a clause shall carry `seq`, the clause's number in its line (0 for a `brain.say`), and `text` equal to the clause.
- [ ] **VOICE-CLAUSE-005**: The `voice.utterance` of clause 0 of a line whose `brain.say` carried `more` shall carry `more` true, and no other `voice.utterance` shall carry `more`.
- [ ] **VOICE-CLAUSE-006**: The `voice.utterance` of every clause of a line shall carry the `emotion` of the line's `brain.say` and the line's `route` when it has one, and only the utterance of clause 0 shall carry the line's `gesture`.
- [ ] **VOICE-CLAUSE-007**: When the voice service reads a `brain.clause` with `last` true and empty `text`, it shall mark the line's record closed and publish no event for it.
- [ ] **VOICE-CLAUSE-008**: When the voice service reads a `brain.clause` with `last` true and non-empty `text`, it shall synthesize it as a clause and mark the line closed after it.
- [ ] **VOICE-CLAUSE-009**: When the voice service reads a closing `brain.clause`, it shall drop the line's clauses above `through` that are still queued for synthesis, and, for a virtual line, shall play no virtual clause above `through`.
- [ ] **VOICE-CLAUSE-010**: When the voice service reads a `brain.clause` for a line it holds no record of (voice restarted in the middle of the line, or the record was evicted), it shall drop the clause, log a warning and publish no event.
- [ ] **VOICE-CLAUSE-011**: When a clause arrives, or is taken from the queue, for a line that has ended, the voice service shall drop it and publish no event for it.
- [ ] **VOICE-CLAUSE-012**: The voice service shall end a line when a `voice.stop` names it, when a clause fails to synthesize, when the line is closed and its virtual player has finished clause `through` (a later `voice.stop` then publishes nothing for it), when VOICE-SINK-011 or VOICE-SINK-012 applies, and when 300 seconds pass with no clause activity for it.
- [ ] **VOICE-CLAUSE-013**: When the voice service reads a `brain.clause` whose `seq` is not exactly one more than the last it accepted for the line, or that follows the line's closing event, it shall drop it and log a warning.
- [ ] **VOICE-CLAUSE-014**: If a clause fails to synthesize, then the voice service shall publish `voice.done` with its `id`, its `seq`, `sink` `error` and `final` true, publish no `voice.utterance` for it and end the line.
- [ ] **VOICE-CLAUSE-015**: When a clause fails to synthesize, the voice service shall leave the earlier clauses of the line as they are: those already published shall be neither recalled nor stopped.
- [ ] **VOICE-CLAUSE-016**: When a clause fails to synthesize, the voice service shall arm no virtual-sink timer for it or for a later clause of its line.
- [ ] **VOICE-CLAUSE-017**: The voice service shall open the 1500 ms claim window only with the first clause of a line, and shall arm no timer of its own for a later clause.
- [ ] **VOICE-CLAUSE-018**: When the claim window of a line ends with the line unclaimed, the voice service shall treat the line as virtual and publish virtual `voice.playing` for its first clause that has not played, carrying that clause's `seq`.
- [ ] **VOICE-CLAUSE-019**: When a virtual clause's `voice.done` has been published, the voice service shall publish the virtual `voice.playing` of the line's next published clause at once, or when that clause's utterance is published if later, with no new claim window.
- [ ] **VOICE-CLAUSE-020**: The virtual `voice.playing` and `voice.done` of a clause shall carry that clause's `seq`.
- [ ] **VOICE-CLAUSE-021**: When a non-virtual `voice.playing` for a streamed line arrives while the line is virtual, the voice service shall publish `voice.done` with `sink` `virtual` and `interrupted` true for the virtual clause that is playing, or, with none playing, for the last clause the virtual player played, cancel the line's remaining virtual clauses, and publish no further virtual event for the line.
- [ ] **VOICE-CLAUSE-024**: When a `voice.stop` names a line, it shall cover every clause of the line that is queued or being synthesized, as VOICE-STOP-003 and VOICE-STOP-004 state for a `brain.say`, and shall make the line ended.
- [ ] **VOICE-CLAUSE-025**: When the voice service estimates the split for an interrupted virtual line, it shall take as `spokenText` the text of the clauses played followed by the part of the playing clause that the elapsed time over its `durationMs` allows, cut at a word boundary, and as `unsaidText` the rest of the playing clause followed by the text of every clause of the line that has not played, published or still queued for synthesis, with clause texts joined by one space.
- [ ] **VOICE-CLAUSE-026**: When the voice service applies a `voice.stop` to a virtual line that is open (it has played a clause and has not ended) and has no virtual clause playing, it shall publish `voice.done` with the `seq` of the last clause played, `sink` `virtual`, `interrupted` true, and `spokenText` and `unsaidText` as VOICE-CLAUSE-025 says; it shall publish nothing for a line that has ended.
