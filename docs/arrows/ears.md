# Arrow: ears

Discord voice in (per-speaker capture, STT, `speech.heard`), Discord voice out (the `discord` audio sink), audio-upload injection, and the `off` / no-token idle modes.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 37 of 41 specs observed in code; 4 gaps recorded. The Discord glue (`discord.ts`, `index.ts`) has no tests.

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (41 specs, prefix `EARS`)

### Tests
- services/ears/test/audio.test.ts
- services/ears/test/ears.test.ts (playback queue, hearing, STT client)
- services/ears/test/health.test.ts
- services/ears/test/inject.test.ts

### Code
- services/ears/src/index.ts
- services/ears/src/discord.ts
- services/ears/src/hearing.ts
- services/ears/src/playback.ts
- services/ears/src/audio.ts
- services/ears/src/inject.ts
- services/ears/src/health.ts
- services/ears/package.json, services/ears/tsconfig.json

### OpenSpec
- openspec/specs/ears/spec.md
- openspec/changes/add-service-health/specs/ears/spec.md
- openspec/changes/add-isolated-backends/specs/ears/spec.md
- openspec/changes/add-test-injection/specs/ears/spec.md

## Architecture

**Purpose:** Be the co-host's ears and one of its mouths. Turns each Discord speaker's audio into `speech.heard`, plays `voice.utterance` audio into the voice channel as the `discord` sink, and transcribes uploaded audio on request.

**Key Components:**
1. `index.ts` — picks a startup plan (`off` / `no-token` / `discord`) with `earsPlan`, wires the heartbeat and inject handler, lazy-loads `discord.ts`.
2. `discord.ts` — Discord client, voice join/rejoin, per-speaker Opus capture, the single `ears` bus loop for `voice.utterance` + `inject.request`.
3. `hearing.ts` — min-length gate, 48k-to-16k conversion, STT HTTP client, `speech.heard` publish.
4. `playback.ts` — FIFO playback queue; publishes `voice.playing` / `voice.done` with `sink: "discord"`.
5. `audio.ts` — PCM resampling and WAV header read/write.
6. `inject.ts` — `inject.request` (audio) handler with dashboard-origin URL guard.
7. `health.ts` — startup plan decision and `EarsHealth` heartbeat spec.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Startup plans | EARS-START-001 to 004 | 4 | 0 | 0 |
| Discord session | EARS-SESS-001 to 007 | 5 | 0 | 2 |
| Listening and transcription | EARS-HEAR-001 to 008 | 8 | 0 | 0 |
| Audio conversion | EARS-AUD-001 to 003 | 3 | 0 | 0 |
| Playback sink | EARS-PLAY-001 to 007 | 6 | 0 | 1 |
| Audio injection | EARS-INJ-001 to 009 | 8 | 0 | 1 |
| Health | EARS-HLTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 37 of 41 specs implemented; 0 deferred; 4 gaps (EARS-SESS-006, EARS-SESS-007, EARS-PLAY-006, EARS-INJ-007).

## Key Findings

1. **A failed initial voice join kills the subscription (and the process).** `join()` is awaited bare in the client `ready` listener and `bus.subscribe` comes after it (`services/ears/src/discord.ts:102-106`); the rejection is unhandled and no handler exists anywhere in the workspace, so Node exits. Under compose it becomes a restart loop; the heartbeat never leaves `starting`. A failed *re*join logs and is never retried (`discord.ts:93`). (EARS-SESS-006)
2. **Injection does not work before Discord is joined in the `discord` plan.** The OpenSpec requires it to work when Discord is not connected; it does for `off` / `no-token` (`services/ears/src/index.ts:40`) but the `discord`-plan subscription starts after `join()` (`discord.ts:104-110`). The shared loop also awaits the inject handler, so a slow STT call delays `voice.utterance` pickup (`discord.ts:107`). (EARS-INJ-007)
3. **Playback failure sends no `voice.done`, and the queue has no timeout.** Recovery depends on voice's virtual sink (`services/ears/src/playback.ts:46-50`, pinned by `services/ears/test/ears.test.ts:49`); a hung `httpAudio` fetch (no timeout, `playback.ts:14-18`) blocks every later utterance. A queued second line is also claimed later than voice's 1.5 s window, so it is double-timed (see the voice arrow). (EARS-PLAY-006)
4. **Guild/channel config keys are dead.** `ears.discord.guild_id` / `voice_channel_id` are in the schema and example YAML but the code reads env vars directly (`discord.ts:61-62`). (EARS-SESS-007)
5. **`mute` / `pause` are ignored by ears.** It never subscribes to `control` (`discord.ts:106`); `[inferred]` mute is meant to be enforced upstream in cortex, but nothing documents that.
6. **Untested glue and a shutdown race.** `discord.ts` and `index.ts` have no tests; two `onShutdown` registrations (`index.ts:37`, `discord.ts:114`) each `process.exit(0)` (`packages/bus/src/index.ts:230-246`).
7. **Near-duplicate WAV parser and stale docs.** `readWavHeader` (`services/ears/src/audio.ts:41-52`) duplicates voice's `parseWav` (`services/voice/src/wav.ts:12-34`); `docs/TESTING.md:119` still says ears exits without a token.

## Work Required

### Must Fix
1. Handle `join()` failure in the `discord` plan: log, mark `discord` down, start the bus subscription or retry (EARS-SESS-006); retry failed rejoins (EARS-SESS-005 follow-up).
2. Make audio injection independent of the Discord join (EARS-INJ-007), e.g. start the shared loop before joining, or give inject its own consumer group (two loops with different type filters in the *same* group lose events, per the comment at `discord.ts:105`).

### Should Fix
3. Decide and implement what the discord sink does when it cannot play a line (EARS-PLAY-006); add a fetch timeout / stuck-playback guard.
4. Either read `ears.discord.*` config or remove the keys (EARS-SESS-007).
5. Add tests for `discord.ts` wiring (plan selection, join failure, rejoin) behind a fake client.
6. Correct `docs/TESTING.md:119`.

### Nice to Have
7. Share one WAV parser/writer between ears and voice (e.g. in a package) and stop `voice/test/voice.test.ts` importing from ears.
8. Unify the two shutdown handlers; make the transcript filter Unicode-aware (`services/ears/src/hearing.ts:42`).
