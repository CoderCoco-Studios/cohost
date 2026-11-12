# Arrow: shared-runtime

The `@cohost/shared` package as a segment: the one implementation of each runtime concern more than one service needs (bootstrap, shutdown and heartbeat publisher, retry with backoff, missing-credentials idle plan, `control` handling, `inject.request` handling (uploads read from Redis, SHARED-INJ-004 to SHARED-INJ-013), WAV and resampling, the Discord voice session, hash embedding).

## Status

**BUILT**, 2026-11-11 (gap-closure chunk C1): every spec is `[x]`. `@cohost/shared` holds the bootstrap (`runService`), lifecycle (`onShutdown`, `beforeShutdown`, `startHeartbeat`, `tracked`), `retryWithBackoff` and `singleFlight`, `startIdle`, `controlFor`, the inject handler and `subscribeInject`, `parseWav` / `wavWrap` / `resample`, and (at the `discord-voice` subpath) `createDiscordVoiceSession`. The lifecycle helpers left the bus package; salience, cortex and affect read `control` through `controlFor`; eyes, ears and chat take injection through the shared handler; ears and mouth hold their voice connection through the session. Not yet adopted, left to the service chunks: `runService` and `startIdle` in each service's entry file.

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

**Summary:** 74 of 74 specs implemented; 0 deferred; 0 open. 74 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

1. Service chunks (C5 to C11) move each service's entry onto `runService` and `startIdle` ([gap-closure dispositions](../plans/gap-closure-dispositions.md)).

## References

### HLD
- docs/high-level-design.md (System Design: Module contract, Shared runtime; Segments table)

### LLD
- docs/intent/shared-runtime/shared-runtime-design.md

### EARS
- docs/intent/shared-runtime/shared-runtime-specs.md (72 specs: 72 `[x]`, 0 `[ ]`, 0 `[D]`)

### Code
- packages/shared/src/{index,boot,lifecycle,retry,idle,control,inject,audio,discord-voice}.ts
