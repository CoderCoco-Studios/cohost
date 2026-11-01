# Arrow: ears

Discord voice in (per-speaker capture, STT, `speech.heard`), Discord voice out (the `discord` audio sink), audio-upload injection, and the `off` / no-token idle modes.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **EARS-SESS-006: what should ears do when the first voice join fails?** `join()` is awaited bare in the client `ready` listener and the bus subscription comes after it (`services/ears/src/discord.ts:108-113`); a throw is an unhandled rejection, no handler exists in the workspace, and Node ends the process (a compose restart loop, heartbeat stuck at `starting`). A failed rejoin is logged once and never retried (`discord.ts:97`). The intent in the spec line is `[inferred]`. Recommended: log, mark `discord` down, start the subscription, and retry the join with backoff.
2. **EARS-INJ-007: must injection work before the Discord join in the `discord` plan?** add-test-injection says injection MUST work "when Discord is not connected"; today the `discord`-plan subscription starts only after `join()` resolves (`services/ears/src/discord.ts:110-117`). Recommended: yes; subscribe before joining.
3. **EARS-PLAY-005 vs EARS-PLAY-006: should a line ears cannot play be reported, or skipped silently?** The code publishes neither `voice.playing` nor `voice.done` for it (`services/ears/src/playback.ts:47-51`) and a test pins "no done for it" (`services/ears/test/ears.test.ts:51`); voice's 1.5 s virtual sink then times the line. EARS-PLAY-006 (`[ ]`, `[inferred]`) asks for a report. Recommended: keep the silent skip and mark EARS-PLAY-006 `[D]`.
4. **EARS-SESS-007: should `ears.discord.guild_id` / `voice_channel_id` be read, or removed?** They are in the schema (`packages/config/src/schema.ts:176-179`) and the example YAML, but ears reads `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` with `env()` (`services/ears/src/discord.ts:63-64`), so editing the keys does nothing. Recommended: read the config keys (the example YAML already fills them from the same env vars).
5. **EARS-SESS-008: should shutdown in the `discord` plan destroy the voice connection and client?** The teardown handler (`services/ears/src/discord.ts:122`) and the bus-stop handler (`services/ears/src/index.ts:39`) both end in `process.exit(0)`; the bus-stop one gets there first, so the teardown is not reached and the `stopping` heartbeat races exit (`packages/bus/src/index.ts:230-246`). Found by reading, no test. Recommended: yes; one handler that destroys, then stops the bus.
6. **EARS-START-001: are injected `speech.heard` events the intended exception in the `off` plan?** The line used to say the `off` plan publishes no `speech.heard`, which contradicted EARS-INJ-009; it now excludes injected ones (`services/ears/src/index.ts:43`). Recommended: confirm.
7. **Should ears react to `control` mute or pause?** It never subscribes to `control` (`services/ears/src/discord.ts:113`), so a muted co-host still plays queued utterances and still publishes `speech.heard`. No spec covers it. Recommended: leave muting to cortex and record that in the HLD.

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (43 specs: 38 `[x]`, 5 `[ ]`, 0 `[D]`)

### Tests
- services/ears/test/audio.test.ts
- services/ears/test/ears.test.ts (playback queue, hearing, STT client)
- services/ears/test/health.test.ts
- services/ears/test/inject.test.ts

28 `@spec` annotations in tests, citing 24 distinct spec IDs.

### Code
- services/ears/src/index.ts
- services/ears/src/discord.ts
- services/ears/src/hearing.ts
- services/ears/src/playback.ts
- services/ears/src/audio.ts
- services/ears/src/inject.ts
- services/ears/src/health.ts
- services/ears/package.json, services/ears/tsconfig.json

25 `@spec` annotations in code, citing all 38 `[x]` spec IDs. No annotation cites a missing or non-`[x]` ID.

### OpenSpec (frozen, historical)
- openspec/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

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
| Startup plans | EARS-START-001 to 005 | 5 | 0 | 0 |
| Discord session | EARS-SESS-001 to 008 | 5 | 0 | 3 |
| Listening and transcription | EARS-HEAR-001 to 008 | 8 | 0 | 0 |
| Audio conversion | EARS-AUD-001 to 003 | 3 | 0 | 0 |
| Playback sink | EARS-PLAY-001 to 007 | 6 | 0 | 1 |
| Audio injection | EARS-INJ-001 to 009 | 8 | 0 | 1 |
| Health | EARS-HLTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 38 of 43 specs implemented; 5 gaps (EARS-SESS-006, EARS-SESS-007, EARS-SESS-008, EARS-PLAY-006, EARS-INJ-007); 0 deferred. 24 of the 38 implemented specs have a test citing them. The 14 without a test are the Discord and plan glue in `discord.ts` / `index.ts` (EARS-START-003, EARS-START-005, EARS-SESS-001 to 005, EARS-HEAR-001 to 003, EARS-PLAY-001, EARS-PLAY-007, EARS-INJ-009) plus EARS-INJ-003 (wrong kind). EARS-INJ-004's redirect and non-2xx paths are untested in ears.

## Key Findings

1. **Spec changes** — EARS-START-001 rewritten: it said the `off` plan publishes no `speech.heard`, contradicting EARS-INJ-009; it now excludes only non-injected events (Question 6). Added EARS-START-005 `[x]` (shutdown stops the bus and exits 0) and EARS-SESS-008 `[ ]` (Discord teardown on shutdown is not reached). No existing marker flipped.
2. **A failed initial voice join kills the subscription and the process.** `join()` is awaited bare in the client `ready` listener and `bus.subscribe` comes after it (`services/ears/src/discord.ts:108-113`); the rejection is unhandled and no `unhandledRejection` handler exists in `packages/` or `services/`, so Node exits. A failed rejoin logs and is never retried (`discord.ts:97`). (EARS-SESS-006; Question 1)
3. **Injection does not work before Discord is joined in the `discord` plan.** It works for `off` / `no-token` (`services/ears/src/index.ts:43`) but the `discord`-plan subscription starts after `join()` (`discord.ts:110-117`). The shared loop also awaits the inject handler, so a slow STT call delays `voice.utterance` pickup (`discord.ts:114`). (EARS-INJ-007; Question 2)
4. **Shutdown in the `discord` plan skips the Discord teardown.** Two `onShutdown` registrations (`index.ts:39`, `discord.ts:122`) each end in `process.exit(0)` (`packages/bus/src/index.ts:230-246`); the bus-stop one exits first. Found by reading. (EARS-SESS-008; Question 5)
5. **Playback failure sends no `voice.done`, and the queue has no timeout.** Recovery depends on voice's virtual sink (`services/ears/src/playback.ts:47-51`, pinned by `services/ears/test/ears.test.ts:51`); a hung `httpAudio` fetch (no timeout, `playback.ts:14-18`) blocks every later utterance. (EARS-PLAY-006; Question 3)
6. **Guild/channel config keys are dead.** `ears.discord.guild_id` / `voice_channel_id` are in the schema and example YAML but the code reads env vars directly (`discord.ts:63-64`). (EARS-SESS-007; Question 4)
7. **`mute` / `pause` are ignored by ears.** It never subscribes to `control` (`discord.ts:113`). (Question 7)
8. **Decisions evidenced; duplicate WAV code** — ten of fourteen LLD Decisions rows now cite a comment, test, commit or archived OpenSpec design (add-isolated-backends D7, add-test-injection D2/D8) instead of `[inferred]`; utterance boundary, resampling, STT language and playback format stay `[inferred]`. `readWavHeader` (`services/ears/src/audio.ts:44-55`) still duplicates voice's `parseWav` (`services/voice/src/wav.ts:12-34`).
9. **Stale references outside this segment** — `docs/TESTING.md:119` still says ears exits without a token. The `@spec` lines shift ears source lines cited by `docs/intent/voice/voice-design.md:123,153,158`, `docs/intent/voice/voice-specs.md:38`, `docs/arrows/voice.md:65,68`, `docs/intent/config/config-design.md:98,141`, `docs/intent/config/config-specs.md:64`, `docs/arrows/config.md:64`, `docs/intent/deployment/deployment-design.md:120` and `docs/intent/event-bus/event-bus-design.md:159`; their owners need to refresh them.

## Work Required

### Must Fix
1. Handle `join()` failure in the `discord` plan: log, mark `discord` down, start the bus subscription or retry (EARS-SESS-006); retry failed rejoins (EARS-SESS-005 follow-up).
2. Make audio injection independent of the Discord join (EARS-INJ-007), e.g. start the shared loop before joining, or give inject its own consumer group (two loops with different type filters in the *same* group lose events, per the comment at `discord.ts:111`).

### Should Fix
3. Decide what the discord sink does when it cannot play a line (EARS-PLAY-006); add a fetch timeout / stuck-playback guard.
4. Either read `ears.discord.*` config or remove the keys (EARS-SESS-007).
5. Merge the two shutdown handlers so the Discord teardown runs (EARS-SESS-008).
6. Add tests for `discord.ts` wiring (plan selection, join failure, rejoin, shutdown) behind a fake client.
7. Correct `docs/TESTING.md:119`.

### Nice to Have
8. Share one WAV parser/writer between ears and voice (e.g. in a package) and stop `voice/test/voice.test.ts` importing from ears.
9. Make the transcript filter Unicode-aware (`services/ears/src/hearing.ts:44`).
