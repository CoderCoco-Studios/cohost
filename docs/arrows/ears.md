# Arrow: ears

Discord voice in (per-speaker capture, STT, `speech.heard`), audio-upload injection, and the `off` / no-token idle modes. ears only listens: Discord voice out (the `discord` audio sink and the spoken fallback line) is [mouth](mouth.md).

## Status

**AUDITED**, 2026-11-11 (git SHA `ae84c73` plus the listen-only change): the listening and speaking split is built (build chunk 4 of [mouth.md](mouth.md)). 40 specs: 40 implemented, 0 deferred, 0 gaps. Before the split the segment held 66 specs; the 29 that moved to mouth are retired and their numbers are not reused. Audited 2026-11-02 (`1b57790`), mapped 2026-10-31 (`686cc8f`); the owner's audit decisions of 2026-11-01 are applied below.

## Listening and speaking split: built

Design: LLD (Context, Startup Plans, Decisions), [decision doc](../intent/ears/decisions/listen-speak-split.md); build order and edge audit in [mouth.md](mouth.md). ears keeps listening and injection and logs in with a bot of its own (`EARS_DISCORD_TOKEN`); mouth speaks through the co-host's existing bot (`DISCORD_TOKEN`).

- Reworded and implemented: EARS-START-002 (token variable), EARS-START-003 (reads `inject.request` only, every plan), EARS-START-004 (`hasToken` excludes mouth's token), EARS-SESS-002 (self-muted), EARS-SESS-004 (no audio player), EARS-HEAR-001 (ignore every bot account).
- New and implemented: EARS-START-007 (same token as mouth idles ears), EARS-SESS-009 (logs in with `EARS_DISCORD_TOKEN`), EARS-HEAR-009 (no `control`, the listening half of the retired EARS-PLAY-008).
- Retired, numbers not reused: EARS-AUD-002, EARS-PLAY-001 to 009, EARS-FALL-001 to 019, now SHARED-AUDIO-006, MOUTH-PLAY-*, MOUTH-FALL-*. `playback.ts`, `fallback.ts`, `wavToDiscordPcm` and their tests are deleted from `services/ears`.
- Config: `ears.fallback` is gone from the schema and `config.example.yaml` (CFG-SCH-018 `[x]`); the storm limit is `mouth.fallback.min_interval_ms`. An old `ears.fallback` key draws the unknown-key warning (CFG-LOAD-006).
- Upgrade for an existing install: create the listening bot, set `EARS_DISCORD_TOKEN` and add `mouth` to `COMPOSE_PROFILES` (README upgrade note, DEPLOY-README-005). Until `EARS_DISCORD_TOKEN` is set, ears idles `degraded` with `EARS_DISCORD_TOKEN is not set`; an install that copies its `DISCORD_TOKEN` into `EARS_DISCORD_TOKEN` idles with the conflict detail (EARS-START-007).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping). Items that concerned the playback sink moved with it to [mouth.md](mouth.md).

1. **B12** Failed voice join -> log, report `degraded` / `discord: down`, keep the subscription, retry with increasing delay (also for rejoins). Specs: SHARED-DVS-004 (`[x]`, reworded).
2. **B13** Injection before the Discord join -> subscribe before joining. Specs: EARS-INJ-007 (`[x]`, reworded).
3. **B19** `ears.discord.guild_id` / `voice_channel_id` -> read the config keys. Specs: EARS-SESS-007 (`[x]`, reworded).
4. **R2** Shutdown in the `discord` plan -> one sequence: destroy connection and client, then stop the bus. Specs: EARS-SESS-008 (`[x]`, reworded).
5. **S16** Injected `speech.heard` in the `off` plan -> confirmed as the exception. Specs: EARS-START-001 (unchanged, `[x]`).
6. **P7** Mute and pause -> ears stays unaware; cortex and salience enforce them. Specs: EARS-HEAR-009 (`[x]`; formerly EARS-PLAY-008).
7. **P8** Restart replay -> the `ears` group uses start mode `latest`. Specs: EARS-START-006 (`[x]`).

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (40 specs: 40 `[x]`, 0 `[ ]`, 0 `[D]`; 29 retired to mouth)
- docs/intent/ears/decisions/listen-speak-split.md

### Tests
- services/ears/test/audio.test.ts
- services/ears/test/ears.test.ts (hearing, STT client)
- services/ears/test/health.test.ts (plans, token reading, the shared-token refusal, heartbeat)
- services/ears/test/inject.test.ts
- services/ears/test/session.test.ts (config target, inject-only loop, self-muted join, bot filtering, subscription, shutdown)
- packages/shared/test/join.test.ts (the `createJoiner` retry loop behind SHARED-DVS-004)
- packages/config/test/config.test.ts (CFG-SCH-018: no `ears.fallback`)

34 `@spec` annotations in the ears tests, citing 31 distinct spec IDs. The 7 specs with no test of their own are discord.js and plan glue: EARS-SESS-001 (login failure exits), EARS-SESS-003 (not a voice channel), SHARED-DVS-003 (disconnect and rejoin), EARS-HEAR-002 and 003 (decode), SHARED-INJ-003 (wrong kind) and EARS-INJ-009 (inject in the idle plans).

### Code
- services/ears/src/index.ts
- services/ears/src/discord.ts
- services/ears/src/session.ts
- services/ears/src/hearing.ts
- services/ears/src/audio.ts
- services/ears/src/inject.ts
- services/ears/src/health.ts
- services/ears/package.json, services/ears/tsconfig.json

31 `@spec` annotations in code, citing all 40 spec IDs (EARS-SESS-004 and EARS-SESS-002 at `EARS_JOIN_OPTIONS`, EARS-HEAR-009 at `EARS_LOOP_TYPES`). No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

## Architecture

**Purpose:** Be the co-host's ears. Turns each human Discord speaker's audio into `speech.heard` and transcribes uploaded audio on request. It plays nothing and never reads `voice.*` or `control`.

**Key Components:**
1. `index.ts`: reads the token (`readEarsToken`), picks a startup plan (`off` / `no-token` / `discord`) with `earsPlan`, wires the heartbeat and inject handler, lazy-loads `discord.ts`, registers the one shutdown (`stopEars`).
2. `discord.ts`: Discord client (ears' own bot), voice join/rejoin self-muted (with the shared `createJoiner` retry from `@cohost/shared`), per-speaker Opus capture for non-bot speakers; establishes the single `ears` bus loop for `inject.request` before logging in.
3. `session.ts`: testable session logic: `voiceTarget` (config keys), `EARS_LOOP_TYPES`, `EARS_JOIN_OPTIONS`, `createEarsHandler` (inject only), `isHumanSpeaker` (the bot filter), `subscribeEars` (group created first, start mode `latest`), `stopEars` (single shutdown sequence).
4. `hearing.ts`: min-length gate, 48k-to-16k conversion, STT HTTP client, `speech.heard` publish.
5. `audio.ts`: PCM downsampling; the WAV writer `wavWrap` and parser `parseWav` come from `@cohost/shared`, and `readWavHeader` is a thin adapter over `parseWav`.
6. `inject.ts`: `inject.request` (audio) handler with dashboard-origin URL guard.
7. `health.ts`: `readEarsToken`, `idleDetail`, the startup plan decision and the `EarsHealth` heartbeat spec.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Startup plans | EARS-START-001 to 007 | 7 | 0 | 0 |
| Discord session | EARS-SESS-001 to 009 | 9 | 0 | 0 |
| Listening and transcription | EARS-HEAR-001 to 009 | 9 | 0 | 0 |
| Audio conversion | SHARED-AUDIO-005, 003, 004 (002 retired) | 3 | 0 | 0 |
| Audio injection | SHARED-INJ-001 to 009 | 9 | 0 | 0 |
| Health | EARS-HLTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 40 specs, 40 implemented, 0 gaps. 33 have a test citing them; the other 7 are the glue listed under Tests. SHARED-INJ-004's redirect and non-2xx paths are untested in ears.

## Key Findings

1. **EARS-START-001** excludes only non-injected `speech.heard` in the `off` plan, consistent with EARS-INJ-009 (S16). EARS-START-005 `[x]` covers shutdown in the idle plans.
2. **A failed voice join does not end the process.** `createJoiner` (`@cohost/shared`, `packages/shared/src/join.ts`) retries the join (initial and rejoin) with a delay doubling from 5 s to a 60 s cap, `onFailure` marks `deps.discord` down and the heartbeat `degraded`, and the bus subscription is independent of the join. (SHARED-DVS-004, B12)
3. **Injection works before Discord is joined in the `discord` plan.** `startDiscord` establishes the `ears` loop before login; the loop reads `inject.request` only. The shared loop awaits the inject handler, so a slow STT call delays the next `inject.request` (nothing else waits behind it now that speaking is in mouth). (EARS-INJ-007, B13)
4. **Shutdown in the `discord` plan is one sequence.** `index.ts` registers a single `onShutdown` running `stopEars`: Discord teardown, then `bus.stop()`. (EARS-SESS-008, R2)
5. **ears never logs in as the speaking bot.** `readEarsToken` reads `EARS_DISCORD_TOKEN` alone and reads `DISCORD_TOKEN` only to refuse a token that equals it; the refusal is an idle `degraded` heartbeat with a detail naming the conflict (EARS-START-004, EARS-START-007, EARS-SESS-009).
6. **Bot accounts are never transcribed.** `isHumanSpeaker` checks the user's `bot` flag (cache, else one fetch) before a stream is opened; a speaker whose account cannot be fetched is skipped (EARS-HEAR-001). Her own lines through mouth's bot therefore never become `speech.heard`.
7. **Guild/channel come from config.** `voiceTarget` reads `ears.discord.guild_id` / `voice_channel_id`; the env vars are no longer read by ears. (EARS-SESS-007, B19)
8. **`mute` / `pause` are ignored by ears by design.** It never subscribes to `control`; cortex and salience enforce muting (EARS-HEAR-009, P7).
9. **WAV parser and writer shared.** `readWavHeader` (`services/ears/src/audio.ts`) wraps the `parseWav` shared with voice (`packages/shared/src/wav.ts`); `wavWrap` (SHARED-AUDIO-004) is the one WAV writer, also used by voice's stub engine.

## Work Required

### Must Fix
None: all 40 specs are implemented.

### Should Fix
1. Add tests for the remaining `discord.ts` glue (login failure, rejoin on disconnect, per-speaker capture) behind a fake client.

### Nice to Have
2. Make the transcript filter Unicode-aware (`services/ears/src/hearing.ts`).
