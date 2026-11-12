# Arrow: connections

The connector protocol (registration, heartbeat, capabilities, source and sink tags, `audio.in.<source>` / `audio.out.<sink>` streams, loss policy) and the Discord connector that holds the co-host's one bot login and the one voice connection. ears consumes sources, mouth writes sinks; neither holds a Discord client.

## Status

**MAPPED** (designed 2026-11-12, not built): 41 specs, 0 implemented, 40 gaps (`[ ]`), 1 deferred (`[D]`, the desktop helper's move onto frames, CONN-DESK-002). Nothing under `services/connector-discord` exists. LID phases done: HLD (Connectors), LLD, EARS specs; next is the edge audit, then failing tests. Design: [LLD](../intent/connections/connections-design.md); decision record [connector-protocol](../intent/connections/decisions/connector-protocol.md), which supersedes [listen-speak-split](../intent/ears/decisions/listen-speak-split.md).

## Cross-segment cascade

| Segment | Change | Specs |
| --- | --- | --- |
| ears | consumes connector sources; holds no Discord client or token; the two-token guard is retired | new EARS-CON-001 to 005; amended EARS-START-004, 005, 008, EARS-HEAR-001, 002, 011, EARS-CAP-003, EARS-INJ-009, EARS-HLTH-002, EARS-SRC-001 to 006; superseded `[D]`: EARS-START-002, 007, EARS-SESS-001 to 004, 007 to 010, EARS-HEAR-003, EARS-AUD-005, EARS-INJ-007 |
| mouth | the `discord` output is a connector sink writing `audio.out.discord`; no token, no join | new MOUTH-CONN-001 to 005; amended MOUTH-START-003, 004, 006, MOUTH-PLAY-001, MOUTH-AUD-002, MOUTH-DRY-005, MOUTH-HLTH-002; superseded `[D]`: MOUTH-START-002, MOUTH-SESS-001 to 004, 007 to 009 |
| shared-runtime | the Discord voice session's only user is the connector (text only; SHARED-DVS-* unchanged) | SHARED-DVS-001 to 007 |
| deployment | new Compose service and profile; one bot in `.env.example`, installer and README | DEPLOY-COMPOSE-004, 020 (amended), DEPLOY-COMPOSE-023 (new), DEPLOY-INST-008, DEPLOY-README-004, 005 |
| event-bus | design pointer only: connector streams and keys share the bus prefix | none yet; BUS spec for the audio stream and registry keys depends on open question 3 (LLD) |

Cascaded (owner defaults accepted 2026-11-12): config (CFG-SCH-020, CFG-SCH-030, CFG-SCH-032, CFG-USR-005, CFG-USR-011), control-plane (manifest unit `discord`, CTRL-MANIFEST-001 to 003, 005, CTRL-HEALTH-005), dashboard (DASH-HTTP-014), event-bus (BUS-EVT-013, BUS-AUD-001, 002), ears (EARS-SRC-*, EARS-CON-*), README, `.env.example` and `docs/TESTING.md`. The `docs/arrows/ears.md` / `mouth.md` historical sections stay as written.

## Build order

Each chunk is one PR, tests first, specs flipped to `[x]` as they land.

| Chunk | Segment(s) | Notes |
|---|---|---|
| 1. Client library | connections (+ bus pointer) | Registration, tag validation, frame encode and decode, paced writer, live `XREAD` reader, with a fake Redis. No service yet. |
| 2. Discord connector | connections, config, control-plane, deployment | `services/connector-discord` reusing `createDiscordVoiceSession` undeafened and unmuted, with a fake Discord session; manifest unit, Compose service and profile, config keys. Runnable beside the old per-service path, which stays until live-verified. |
| 3. ears consumer | ears | Connector source in `earsPlan` and the service, utterance assembler by `spk` gap, per-source health. |
| 4. mouth sink | mouth | Connector-sink output with the registry readiness check and paced frame writer. |
| 5. Live verification, then removal | ears, mouth, shared-runtime, config, deployment | Real guild, one bot, kill and restart the connector; then delete the per-service Discord clients, `EARS_DISCORD_TOKEN`, the `[D]` superseded lines and their tests; README and installer updated. |

## Edge audit (open)

To settle before tests, beyond the LLD's open questions: that `voice.done` timed from the write schedule keeps cortex's `speaking_timeout_ms` and the stuck-playback watchdog (MOUTH-PLAY-011) coherent; that dropping per-service channels loses nothing the owner used (ears and mouth in different channels); that the reserved tags cover every sink name voice's protocol uses; the order of registration and stream creation so a consumer that starts first does not miss early frames (`$` start is live-only by design).

## References

### HLD
- docs/high-level-design.md (Approach: Connectors; Cross-cutting protocols: Connectors; Key Design Decisions: Listening and speaking, Binary payloads)

### LLD
- docs/intent/connections/connections-design.md
- docs/intent/connections/decisions/connector-protocol.md

### EARS
- docs/intent/connections/connections-specs.md (40 specs: 0 `[x]`, 38 `[ ]`, 2 `[D]`)

### Tests
None yet.

### Code
None yet. Reuses `packages/shared/src/discord-voice.ts` (`createDiscordVoiceSession`).

## Architecture

**Purpose:** Let external services attach to the stack as audio sources and sinks, and own the one Discord login.

**Key Components (planned):**
1. Connector client library: registration lease, tag validation, frame codec, paced writer, live reader.
2. `services/connector-discord`: login, undeafened voice connection, per-speaker capture to `audio.in.discord`, playback from `audio.out.discord`, heartbeat and registration.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Registration and liveness | CONN-REG-001 to 007 | 0 | 0 | 7 |
| Tags | CONN-TAG-001 to 004 | 0 | 0 | 4 |
| Audio streams and frames | CONN-AUD-001 to 005 | 0 | 0 | 5 |
| Back-pressure and loss | CONN-BP-001 to 006 | 0 | 0 | 6 |
| Discord connector | CONN-DISC-001 to 011 | 0 | 0 | 11 |
| Failure isolation | CONN-ISO-001 to 003 | 0 | 0 | 3 |
| Health | CONN-HLTH-001, 002 | 0 | 0 | 2 |
| Desktop audio helper | CONN-DESK-001 to 003 | 0 | 1 | 2 |
