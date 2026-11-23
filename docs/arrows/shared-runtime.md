# Arrow: shared-runtime

The `@cohost/shared` package as a segment: the one implementation of each runtime concern more than one service needs (bootstrap, shutdown and heartbeat publisher, retry with backoff, missing-credentials idle plan, `control` handling, `inject.request` handling (uploads read from Redis, SHARED-INJ-004 to SHARED-INJ-013), WAV and resampling, the Discord voice session).

## Status

**AUDITED** for the specs marked `[x]`; the head-rotation module is open work. Spec file: 110 specs, 107 `[x]`, 3 `[ ]`, 0 `[D]`. `@cohost/shared` holds the bootstrap (`runService`), lifecycle (`onShutdown`, `beforeShutdown`, `startHeartbeat`, `tracked`), `retryWithBackoff` and `singleFlight`, `startIdle`, `controlFor`, the inject handler and `subscribeInject`, `parseWav` / `wavWrap` / `resample`, (at the `discord-voice` subpath) `createDiscordVoiceSession`, (at the `untrusted` subpath) the untrusted text guard's `boundText`, `quoteUntrusted`, `speakerLabel`, `untrustedNotice`, `normalizeKey`, `createOnceCounter` and `untrustedToolNotice`, and (at the package root) `parseVideoValue`. Every service starts through `runService`; salience, cortex, affect and mouth read `control` through `controlFor`; eyes, ears and chat take injection through the shared handler; the Discord connector holds its voice connection through the session.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service bootstrap | SHARED-BOOT-001 to SHARED-BOOT-008 | 8 | 0 | 0 | 8 |
| Lifecycle: shutdown and heartbeat | SHARED-LIFE-001 to SHARED-LIFE-015 | 15 | 0 | 0 | 15 |
| Retry with backoff | SHARED-RETRY-001 to SHARED-RETRY-007 | 7 | 0 | 0 | 7 |
| Missing-credentials idle plan | SHARED-IDLE-001 to SHARED-IDLE-006 | 6 | 0 | 0 | 6 |
| Control handling | SHARED-CTRL-001 to SHARED-CTRL-008 | 8 | 0 | 0 | 8 |
| Test injection | SHARED-INJ-001 to SHARED-INJ-013 | 13 | 0 | 0 | 13 |
| Audio | SHARED-AUDIO-001 to SHARED-AUDIO-008 | 8 | 0 | 0 | 8 |
| Discord voice session | SHARED-DVS-001 to SHARED-DVS-007 | 7 | 0 | 0 | 7 |
| Behaviour that stays in a service | SHARED-BOUND-001 to SHARED-BOUND-002 | 2 | 0 | 0 | 2 |
| Untrusted text guard | SHARED-GUARD-001 to SHARED-GUARD-031 | 31 | 0 | 0 | 31 |
| Video value | SHARED-VID-001 to SHARED-VID-002 | 2 | 0 | 0 | 2 |
| Head rotation | SHARED-ROT-001 to SHARED-ROT-003 | 0 | 0 | 3 | 0 |

**Summary:** 107 of 110 specs `[x]`; 3 `[ ]` (the head-rotation module, SHARED-ROT-001 to -003); 0 `[D]`. `node scripts/lid-check.mjs`: 0 problems.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract, Shared runtime; Segments table)

### LLD
- docs/intent/shared-runtime/shared-runtime-design.md

### EARS
- docs/intent/shared-runtime/shared-runtime-specs.md (110 specs: 107 `[x]`, 3 `[ ]`, 0 `[D]`)

### Tests (files carrying `@spec SHARED-` annotations)
- packages/shared/test/: audio, boot, boundary, control-routing, control, discord-voice, idle, inject-handler, lifecycle, retry, shutdown, untrusted, wav (`*.test.ts`)
- packages/shared/test/youtube-video.test.ts (SHARED-VID-001, -002)
- services/chat/test/inject.test.ts, services/ears/test/audio.test.ts, services/ears/test/inject.test.ts, services/eyes/test/inject.test.ts

### Code (files carrying `@spec SHARED-` annotations)
- packages/shared/src/: audio.ts, boot.ts, control.ts, discord-voice.ts, idle.ts, inject.ts, lifecycle.ts, retry.ts, untrusted.ts
- packages/shared/src/utterance.ts (`writeUtterance`, owned by shared-runtime and specified by the connections specs CONN-AUD-005 and CONN-BP-004; tested in packages/shared/test/utterance.test.ts)

## Work Required

- Untrusted guard totality and tool notice: the totality rule (SHARED-GUARD-003) and `untrustedToolNotice` (SHARED-GUARD-028 to SHARED-GUARD-030) belong to #202.

### Must Fix
None outstanding for the untrusted text guard's built surface (SHARED-GUARD-001, 002, 004 to 027).
