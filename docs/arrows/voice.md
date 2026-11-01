# Arrow: voice

`brain.say` to audio: TTS (Kokoro or silent stub), WAV parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, and the audio-sink arbitration protocol shared with ears and dashboard.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 29 of 31 specs observed in code and unit tests; 2 gaps, both in sink arbitration. Boot wiring (`index.ts`) is untested.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (31 specs, prefix `VOICE`)

### Tests
- services/voice/test/voice.test.ts (pipeline, virtual sink, HTTP, store, Kokoro client)
- services/voice/test/stub.test.ts
- services/voice/test/wav.test.ts
- services/voice/test/health.test.ts

### Code
- services/voice/src/index.ts
- services/voice/src/voice.ts
- services/voice/src/wav.ts
- services/voice/src/health.ts
- services/voice/package.json, services/voice/tsconfig.json

### OpenSpec
- openspec/specs/voice/spec.md
- openspec/changes/add-service-health/specs/voice/spec.md
- openspec/changes/add-isolated-backends/specs/voice/spec.md

## Architecture

**Purpose:** Convert the brain's lines into audio the body can play, and guarantee the brain is released whether or not any sink plays it.

**Key Components:**
1. `index.ts` — boot: config, heartbeat, HTTP server on `VOICE_PORT` (8700), one bus loop on `brain.say` + `voice.playing`.
2. `voice.ts` — `Voice` class: synth, store (50 newest), `voice.utterance`, claimed set, 1.5 s virtual sink, error release, HTTP handler; plus `kokoroSynth` and `stubSynth`.
3. `wav.ts` — `parseWav` and the 30 Hz mouth envelope.
4. `health.ts` — `VoiceHealth` (`kokoro` dep, modes `live` / `mock`).
5. Consumers/peers of the protocol: ears (`discord` sink), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Synthesis | VOICE-SYN-001 to 004 | 4 | 0 | 0 |
| Stub engine | VOICE-STUB-001 to 003 | 3 | 0 | 0 |
| Utterance publication | VOICE-UTT-001 to 003 | 3 | 0 | 0 |
| WAV and envelope | VOICE-ENV-001 to 004 | 4 | 0 | 0 |
| Sink arbitration | VOICE-SINK-001 to 008 | 6 | 0 | 2 |
| Audio store and HTTP | VOICE-HTTP-001 to 005 | 5 | 0 | 0 |
| Health | VOICE-HLTH-001 to 004 | 4 | 0 | 0 |

**Summary:** 29 of 31 specs implemented; 0 deferred; 2 gaps (VOICE-SINK-007, VOICE-SINK-008).

## Key Findings

1. **A real sink slower than 1.5 s is double-timed.** The claim window is fixed at 1.5 s from `voice.utterance` (`services/voice/src/voice.ts:106-111`); ears queues lines behind the one playing and then fetches and converts before publishing `voice.playing` (`services/ears/src/playback.ts:38-45`), so any second line behind a long first one is timed by the virtual sink first and then reported again by ears. Cortex is released by the first `voice.done` of either sink (`services/cortex/src/cortex.ts:53-57`). (VOICE-SINK-008)
2. **Claims are read by the same loop that runs TTS.** One sequential subscription handles `brain.say` (seconds of synthesis) and `voice.playing` claims (`services/voice/src/index.ts:30`, `packages/bus/src/index.ts:151-159`), so a claim for line A can be stuck behind synthesis of line B and the virtual timer for A may fire anyway. `[inferred]` not reproduced in tests.
3. **`claimed` is never pruned** while the audio store is capped at 50 (`voice.ts:70,77,84`). Also no sink exclusivity: Discord and a dashboard page both play and both report. (VOICE-SINK-007)
4. **Two near-duplicate WAV parsers and a cross-service test import.** `services/voice/src/wav.ts:12-34` vs `services/ears/src/audio.ts:41-52`; `services/voice/test/voice.test.ts:5` imports `../../ears/src/audio.js`.
5. **Port 8700 is not published by compose and the baseline OpenSpec is stale on the `VOICE_URL` default.** Compose sets `VOICE_URL=http://voice:8700` (`docker-compose.yml:18`) and never publishes the port (`docker-compose.yml:129-134`); `urls.voice()` defaults to loopback (`packages/config/src/index.ts:163`, tested at `packages/config/test/config.test.ts:207`) while `openspec/specs/voice/spec.md` says `http://voice:<VOICE_PORT>`.
6. **WAV handling is narrow.** Only 16-bit PCM; envelope reads the first channel only; `parseWav` ignores the format tag and a missing `fmt ` gives a non-finite duration (`wav.ts:17-29,41`). Kokoro returns mono 16-bit today so nothing trips.
7. **Store eviction counts duplicates.** Re-using an id pushes it into `order` twice (`voice.ts:74-78`); and a failed `voice.utterance` publish is reported as `tts failed` because the whole path shares one `try` (`voice.ts:92-116`).

## Work Required

### Must Fix
1. Decide and implement a protocol fix for late real sinks: widen/extend the claim window, or let sinks and voice tolerate a second lifecycle (VOICE-SINK-008). Document the chosen rule in the voice LLD.

### Should Fix
2. Prune `claimed` alongside store eviction (VOICE-SINK-007).
3. Move synthesis off the shared loop (or use a second group for claims) so claims are not delayed by TTS.
4. Share one WAV reader/writer between voice and ears and remove the cross-service import in `voice.test.ts`.
5. Update `openspec/specs/voice/spec.md` (or the code) to agree on the `VOICE_URL` default; decide whether to publish 8700 in compose for host-side sinks.

### Nice to Have
6. Tighten `parseWav` (format tag, `fmt ` ordering) and handle stereo envelopes by mixing channels.
7. Add a test for boot wiring and for a real sink claiming after the virtual pair has fired; clear virtual timers on shutdown.
8. Align `voice.speed` default (schema 1 vs example YAML 1.05) and OpenSpec.
