# Arrow: mouth

The co-host's speaking module: plays `voice.utterance` on the outputs the owner routes it to (today a Discord voice channel through the co-host's own bot), one sink per output, and says a pre-generated fallback line when a line cannot play.

## Status

**AUDITED**, 2026-11-11: all four build chunks are built: the service exists, all 49 specs are `[x]`, it is wired into the manifest, Compose (profile `mouth`, off by default) and the dashboard's unit list, and ears is listen-only on its own bot (`EARS_DISCORD_TOKEN`). A segment split out of [ears](ears.md) (designed 2026-11-10). Its `dev` script runs it with `pnpm dev` next to ears; the two use different bots, so the `ears` and `mouth` profiles can run together. Design: [LLD](../intent/mouth/mouth-design.md); decision doc [listen-speak-split](../intent/ears/decisions/listen-speak-split.md) (owned by ears, the node being split).

## Listening and speaking split

Owner direction: ears may listen to more than Discord and the co-host's voice may go to more places, so listening and speaking become separate modules the owner tunes and routes separately. The spoken fallback line stays with the playback sink that gives up, so it moves with speaking into mouth.

### Where the specs went

| Old (ears, retired; numbers not reused) | New |
| --- | --- |
| EARS-AUD-002 (WAV to 48 kHz PCM) | MOUTH-AUD-001 |
| EARS-PLAY-001 (one loop, utterance only while ready) | MOUTH-PLAY-001 (loop), MOUTH-ROUTE-003 (per-output readiness) |
| EARS-PLAY-002 to 007, 009 | MOUTH-PLAY-002 to 007, 009 (same numbers, scoped to an output and its sink name) |
| EARS-PLAY-008 (no `control`) | MOUTH-PLAY-008 (speaking half), EARS-HEAR-009 (listening half) |
| EARS-FALL-001 to 019 | MOUTH-FALL-001 to 019 (same numbers; cache under `mouth/`, storm limit and marks per output, claims by any other real sink name) |
| EARS-START-*, EARS-SESS-* (the speaking parts) | MOUTH-START-001 to 005, MOUTH-SESS-001 to 008 |
| — | MOUTH-ROUTE-001 to 005 (routing table, sink names, per-output state, gain), MOUTH-HLTH-001, 002 |

ears keeps its prefix and is reworded to listening only (see [ears.md](ears.md)). Cross-segment lines: config CFG-SCH-018, CFG-ISO-001, CFG-ISO-004, CFG-USR-009 (reworded) and CFG-SCH-020, CFG-USR-011 (new); control-plane CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005 (reworded); deployment DEPLOY-COMPOSE-001, 004, 017, DEPLOY-REPO-001 (reworded) and DEPLOY-COMPOSE-020, DEPLOY-README-004, 005 (new). voice, event-bus, avatar, cortex, working-memory and dashboard change no spec line: the protocol, the events and the `discord` sink name are unchanged; their LLD text now names mouth.

### Build order

Each chunk is one PR, tests first, specs flipped to `[x]` as they land.

| Chunk | Segment(s) | Specs | Notes |
|---|---|---|---|
| 1. Shared join loop (built) | ears (refactor) | none new; EARS-SESS-006 annotations follow `createJoiner` into `@cohost/shared` | No behaviour change. Gives mouth the same retry loop without copying it. |
| 2. mouth service (built) | mouth, config, voice (test only) | MOUTH-*; CFG-SCH-020, CFG-ISO-001, CFG-ISO-004, CFG-USR-009, CFG-USR-011, and the `mouth.fallback.min_interval_ms` half of CFG-SCH-018 | `services/mouth` built from ears' playback, fallback and PCM code plus the routing layer; runnable by hand only, not in Compose or the manifest. `services/voice/test/ears-sync.test.ts` is now `mouth-sync.test.ts`. ears is untouched, so both keys (`ears.fallback`, `mouth.fallback`) exist until chunk 4; CFG-SCH-018 stays `[ ]` until chunk 4 removes `ears.fallback`. |
| 3. Deploy and control (built) | control-plane, deployment, dashboard (page list only) | CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005; DEPLOY-COMPOSE-001, 004, 017, 020, DEPLOY-REPO-001, and the documentation specs DEPLOY-README-004, 005 (written here so the two-bot `.env.example` and README exist when chunk 4 switches ears) | Manifest unit, `KNOWN_SERVICES`, Compose service in profile `mouth`, isolation pass-through, the dashboard page's hard-coded `UNITS` list (DASH-UI-008 needs no rewording). Off by default (profile), so nothing changes for an install that does not name `mouth`. `scripts/install.sh`'s next steps are unchanged until chunk 4. |
| 4. ears listens only (built) | ears, config, deployment (docs) | EARS-START-001 to 004, 006, 007, EARS-SESS-002, 004, 009, EARS-HEAR-001, 009, EARS-INJ-007; retire EARS-AUD-002, EARS-PLAY-*, EARS-FALL-*; CFG-SCH-018 (drop `ears.fallback`), CFG-USR-009; DEPLOY-README-004, 005 | ears switches to `EARS_DISCORD_TOKEN`, ignores bots, joins self-muted and deletes its playback and fallback code and tests. `.env.example`, README, installer next steps. Landed right after chunk 3: the switch is one upgrade step for the owner (second bot, `mouth` in `COMPOSE_PROFILES`). Also: `ears.fallback` removed from the schema and example (CFG-SCH-018 `[x]`), `services/mouth`'s `dev:mouth` script renamed `dev` so `pnpm dev` runs it, installer next steps start the `eyes`, `ears` and `mouth` profiles (DEPLOY-INST-008). |

An ears that still used `DISCORD_TOKEN` next to mouth would put one bot in two processes, and each voice join would displace the other; ears now reads `EARS_DISCORD_TOKEN` only and refuses a token equal to `DISCORD_TOKEN` (EARS-START-007). Nothing enables the `mouth` profile by default; the README upgrade note (DEPLOY-README-005) describes the two-bot setup.

### Edge audit (cross-spec, cross-segment)

Resolved in the specs:

1. **The co-host hearing herself.** With both bots in one channel, ears receives mouth's audio. EARS-HEAR-001 ignores every bot account (by the user's `bot` flag, fetched when not cached), so her own lines never become `speech.heard`. Other bots (music, TTS) are ignored too. Her voice leaking through a human's microphone is still unfiltered, as before.
2. **One bot in two processes.** EARS-SESS-009 and MOUTH-SESS-008 give each service one token variable; EARS-START-004 and EARS-START-007 make ears refuse `DISCORD_TOKEN`, so a copy-pasted token idles ears with a message rather than making both connections flap. mouth does not check ears' token: the refusal lives on the side that is new to the owner.
3. **Sink name continuity.** MOUTH-ROUTE-001 keeps `discord` for the Discord output. No spec in voice, avatar, cortex, working-memory or dashboard names the `discord` sink, and the fallback claim check (MOUTH-FALL-009) now excludes only the giving-up output's own name, which equals the old rule while there is one output.
4. **Two outputs and the early release.** VOICE-SINK-011 releases cortex at the end of the claim window when a `voice.failed` without `fallback` arrives and nothing has claimed. With two mouth outputs, one giving up and the other starting late, cortex can be released while the second still plays, and the next line can then overlap on the first output. This is the existing non-exclusivity between sinks (voice LLD Decisions); it needs two outputs, which do not exist yet.
5. **Per-output state.** MOUTH-ROUTE-004 makes the storm limit, the last phrase and the bad-clip marks per output. MOUTH-FALL-005, 006, 007 and 008 say "for that output" so a reader cannot take them as mouth-wide.
6. **Readiness at intake.** MOUTH-ROUTE-003 judges an output's readiness when the `voice.utterance` is read, not when it would play; a line queued on a ready output that then disconnects stays queued and ends through the player's events (or the open stuck-playback question).
7. **Isolation preset agreement.** CTRL-MANIFEST-003 (`MOUTH_DISCORD_ENABLED=false`), CFG-ISO-004 (the placeholder) and DEPLOY-COMPOSE-017 (the pass-through) name the same variable; an isolated mouth is plan `off`, mode `off`, `ready` (MOUTH-START-001), like every other isolated service.
8. **Launch and profiles.** CTRL-STACK-002 starts mouth only when `COMPOSE_PROFILES` names it; DEPLOY-README-005 tells an upgrading owner to add it. A mouth with no token is `degraded` but its heartbeat is fresh, so the container is healthy (DEPLOY-HC-001) and a launch's readiness wait (CTRL-STACK-003) completes.
9. **Services tab.** CTRL-HEALTH-005 lists mouth among the known services, so an install without the `mouth` profile shows it `unknown`, as it already shows `eyes` and `ears`.
10. **Old config files.** CFG-SCH-020 makes the `mouth` section optional; with no guild or channel, MOUTH-SESS-003 fails the join with a message naming the key and MOUTH-SESS-006 keeps retrying. An old `ears.fallback` key draws the unknown-key warning (CFG-LOAD-006). An unknown output name under `mouth.outputs` draws the same warning (config Decisions: Unknown keys).
11. **Old clip cache.** ears' former cache under `<dataDir()>/ears/fallback-clips` is not migrated: mouth fetches its own from voice. In Compose it disappears with the ears container's next recreate; on a host run it is a leftover directory nothing reads.
12. **Restart replay.** The new `mouth` group starts at the newest entry (MOUTH-START-005), so the first start after the upgrade plays nothing old; ears' group keeps `latest` and now reads only `inject.request` (EARS-START-003, EARS-START-006).
13. **Injection.** `inject.request` keeps target `ears` (BUS-EVT-006); mouth takes no injection, and dashboard injection is unaffected by whether mouth runs.
14. **Gain at zero.** MOUTH-ROUTE-005 applies only when `gain_db` is not 0, so the default path is bit-identical to today's playback.

Blind divergence probe (forks narrowed in the lines): readiness judged at intake (MOUTH-ROUTE-003), "for that output" on the storm, pick and bad-clip lines (MOUTH-FALL-005 to 008), the gain also applying to fallback clips (MOUTH-ROUTE-005, MOUTH-FALL-001), `deps` keys present for disabled outputs as `n/a` (MOUTH-HLTH-001), how a bot is recognised (EARS-HEAR-001), what "has a token" means for ears (EARS-START-004), idle plans subscribing to nothing (MOUTH-START-001, 002).

### Owner decisions

Two Discord bots (`DISCORD_TOKEN` speaks, `EARS_DISCORD_TOKEN` listens); the names `ears` and `mouth`; ears ignores every bot account; per-output `gain_db` (-40 to 12 dB, default 0); one Compose profile each, off by default; the dashboard page outside `mouth.outputs`; per-output queues, storm limit and bad-clip marks; mouth self-deafened and ears self-muted.

## References

### HLD
- docs/high-level-design.md (Approach: the body; Segments table; Audio sink arbitration; Key Design Decisions: Listening and speaking)

### LLD
- docs/intent/mouth/mouth-design.md
- docs/intent/ears/decisions/listen-speak-split.md

### EARS
- docs/intent/mouth/mouth-specs.md (49 specs: 49 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/mouth/test/audio.test.ts (WAV conversion)
- services/mouth/test/fallback.test.ts (clip cache, mirror, refresh against a fake voice HTTP server, claim memory, per-output clip choice, storm limit and bad marks)
- services/mouth/test/playback.test.ts (the per-output queue, give-up, fallback in the queue, sink names, gain, two independent outputs, `httpAudio`)
- services/mouth/test/health.test.ts (`mouthPlan`, `readToken`, `MouthHealth`)
- services/mouth/test/session.test.ts (output target, routing handler, subscription, shutdown, idle plans)
- services/voice/test/mouth-sync.test.ts (voice's real clip service read by mouth's real clip sync)
- packages/shared/test/join.test.ts (the `createJoiner` retry loop behind MOUTH-SESS-006)

69 `@spec` annotations in the mouth tests, citing 44 distinct MOUTH IDs. Specs with no test of their own, all in the discord.js glue that no test reaches (LLD Open Questions 2): MOUTH-SESS-001 (login failure exits), MOUTH-SESS-004 (subscribe the player on Ready), MOUTH-SESS-005 (disconnect and rejoin), MOUTH-SESS-006 (the retry loop is the shared, tested `createJoiner`) and MOUTH-PLAY-007 (player error log).

### Code
- services/mouth/src/index.ts
- services/mouth/src/discord.ts
- services/mouth/src/session.ts
- services/mouth/src/playback.ts
- services/mouth/src/fallback.ts
- services/mouth/src/audio.ts
- services/mouth/src/health.ts
- services/mouth/package.json, services/mouth/tsconfig.json
- `packages/shared/src/join.ts` (`createJoiner`, chunk 1, annotated EARS-SESS-006)
- `packages/config/src/schema.ts` (the `mouth` section: CFG-SCH-020), `config/config.example.yaml` (CFG-USR-011, CFG-ISO-004, CFG-USR-009)

36 `@spec` annotations in code, citing all 49 spec IDs (MOUTH-ROUTE-002 at `mouthPlan`, which leaves a disabled output with no connection); MOUTH-PLAY-008 (no `control` subscription) is carried by the `MOUTH_LOOP_TYPES` list.

The playback, fallback, audio and Discord code was copied from `services/ears`, which deleted its own in chunk 4. The differences from ears' former code: per-output state (a `FallbackLine` per output over one shared `ClipCache` and one `ClaimMemory`), the sink name taken from the output, `applyGain`, a self-deafened join without the `GuildMembers` intent, the `mouth.*` config keys, and the clip mirror under `<dataDir()>/mouth/fallback-clips`.

## Architecture

**Purpose:** Be the co-host's mouth: put her synthesized voice on every output the owner routes it to, report each output as a sink, and cover a failed line with a spoken fallback.

**Key Components:**
1. `index.ts`: `mouthPlan`, heartbeat, lazy discord.js load, one shutdown.
2. `discord.ts`: the Discord output (login, self-deafened join, rejoin, player).
3. `session.ts`: the output target, the `mouth` loop (`voice.utterance`, `voice.playing`) and routing to outputs, the idle plans, shutdown.
4. `playback.ts`: one queue per output; claim, done, give-up.
5. `fallback.ts`: clip cache, mirror, manifest refresh, claim memory, per-output choice, storm limit and bad marks.
6. `audio.ts`: WAV to 48 kHz stereo PCM, gain.
7. `health.ts`: `mouthPlan`, `readToken`, `MouthHealth` (one dep per output).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Startup plans | MOUTH-START-001 to 005 | 5 | 0 | 0 |
| Discord output session | MOUTH-SESS-001 to 008 | 8 | 0 | 0 |
| Routing | MOUTH-ROUTE-001 to 005 | 5 | 0 | 0 |
| Playback | MOUTH-PLAY-001 to 009 | 9 | 0 | 0 |
| Audio conversion | MOUTH-AUD-001 | 1 | 0 | 0 |
| Fallback line | MOUTH-FALL-001 to 019 | 19 | 0 | 0 |
| Health | MOUTH-HLTH-001 to 002 | 2 | 0 | 0 |

**Summary:** 49 specs, 49 implemented, 0 gaps. 44 have a test carrying their `@spec` ID; the other 5 are discord.js glue (see Tests). Nothing is open outside the segment.
