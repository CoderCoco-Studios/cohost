# Arrow: shared-runtime

The `@cohost/shared` package as a segment: the one implementation of each runtime concern more than one service needs (bootstrap, shutdown and heartbeat publisher, retry with backoff, missing-credentials idle plan, `control` handling, `inject.request` handling, WAV and resampling, the Discord voice session, hash embedding).

## Status

**MAPPED**, 2026-11-11: LLD drafted ([shared-runtime-design.md](../intent/shared-runtime/shared-runtime-design.md)); EARS specs written, all `[ ]`. The package exists today with three helpers (`uploadUrl` / `INJECT_STALE_MS`, `createJoiner`, `parseWav` / `wavWrap`), each specified by another segment (EYES-INJ-015, EARS-SESS-006, VOICE-ENV-001/002, EARS-AUD-003/004). The rest of the designed modules are still copies inside the services.

## Work required

1. Owner review of the LLD (phase 2 stop).
2. EARS specs per facet: SHARED-BOOT, SHARED-LIFE, SHARED-RETRY, SHARED-IDLE, SHARED-CTRL, SHARED-INJ, SHARED-AUDIO, SHARED-DVS, SHARED-EMB.
3. Cross-segment spec moves (LLD, Spec ownership): event-bus shutdown lines, control-plane heartbeat publisher mechanics, ears join loop, eyes upload guard, voice/ears/mouth WAV and resampling lines. Each moved line retires in its old segment; numbers are not reused.
4. Gap-closure chunk C1 builds the package; later chunks move each service onto it ([gap-closure dispositions](../plans/gap-closure-dispositions.md)).

## References

### HLD
- docs/high-level-design.md (System Design: Module contract, Shared runtime; Segments table)

### LLD
- docs/intent/shared-runtime/shared-runtime-design.md

### EARS
- docs/intent/shared-runtime/shared-runtime-specs.md (72 specs: 0 `[x]`, 72 `[ ]`, 0 `[D]`)

### Code
- packages/shared/src/{index,inject,join,wav}.ts (today)
- packages/bus/src/{index,heartbeat}.ts (lifecycle helpers to move)
