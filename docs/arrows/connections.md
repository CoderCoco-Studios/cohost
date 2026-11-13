# Arrow: connections

The connector protocol (registration, heartbeat, capabilities, source and sink tags, `audio.in.<source>` / `audio.out.<sink>` streams, loss policy) and the Discord connector that holds the co-host's one bot login and the one voice connection. ears consumes sources, mouth writes sinks; neither holds a Discord client.

## Status

**PARTIAL** (chunks 1 to 4 of the build order are built; sampled 2026-11-12): 41 specs, 39 implemented, 1 gap (`[ ]`, the desktop helper's registration, CONN-DESK-001), 1 deferred (`[D]`, the desktop helper's move onto frames, CONN-DESK-002). Built: the protocol library (`packages/bus/src/connector.ts`, `registrar.ts`, including the consumer's `ConnectorRegistry` view), the utterance writer (`packages/shared/src/utterance.ts`), `services/connector-discord`, ears' connector source (`services/ears/src/connector-source.ts`) and mouth's connector sink (`services/mouth/src/connector-output.ts`). Open: the desktop helper (CONN-DESK-001; EARS-SRC-014, 015 in ears) and the live verification of chunk 5.

## Cross-segment cascade

| Segment | Change | Specs |
| --- | --- | --- |
| ears | consumes connector sources; holds no Discord client or token | new EARS-CON-001 to 005; amended EARS-START-004, 005, 008, EARS-HEAR-001, 002, 011, EARS-CAP-003, EARS-INJ-009, EARS-HLTH-002, EARS-SRC-001 to 006 |
| mouth | the `discord` output is a connector sink writing `audio.out.discord`; no token, no join | new MOUTH-CONN-001 to 005; amended MOUTH-START-003, 004, 006, MOUTH-PLAY-001, MOUTH-AUD-002, MOUTH-DRY-005, MOUTH-HLTH-002 |
| shared-runtime | the Discord voice session's only user is the connector (text only; SHARED-DVS-* unchanged) | SHARED-DVS-001 to 007 |
| deployment | new Compose service and profile; one bot in `.env.example`, installer and README | DEPLOY-COMPOSE-004, 020 (amended), DEPLOY-COMPOSE-023 (new), DEPLOY-INST-008, DEPLOY-README-004, 005 |
| event-bus | design pointer only: connector streams and keys share the bus prefix | none yet; BUS spec for the audio stream and registry keys depends on open question 3 (LLD) |

Cascaded: config (CFG-SCH-020, CFG-SCH-030, CFG-SCH-032, CFG-USR-011), control-plane (manifest unit `discord`, CTRL-MANIFEST-001 to 003, 005, CTRL-HEALTH-005), dashboard (DASH-HTTP-014), event-bus (BUS-EVT-013, BUS-AUD-001, 002), ears (EARS-SRC-*, EARS-CON-*), README, `.env.example` and `docs/TESTING.md`.

## Build order

Each chunk is one PR, tests first, specs flipped to `[x]` as they land.

| Chunk | Segment(s) | Notes |
|---|---|---|
| 1. Client library | connections (+ bus pointer) | Registration, tag validation, frame encode and decode, paced writer, live `XREAD` reader, with a fake Redis. No service yet. |
| 2. Discord connector | connections, config, control-plane, deployment | `services/connector-discord` reusing `createDiscordVoiceSession` undeafened and unmuted, with a fake Discord session; manifest unit, Compose service and profile, config keys. Runnable beside the old per-service path, which stays until live-verified. |
| 3. ears consumer (built) | ears | Connector source in `earsPlan` and the service, utterance assembler by `spk` gap, per-source health, registry liveness for stream and `http` tags. |
| 4. mouth sink (built) | mouth, deployment, config | Connector-sink output with the registry readiness check and paced frame writer; Compose blanks `DISCORD_TOKEN` for ears and mouth; README, installer and `.env.example` name the one bot. |
| 5. Live verification | ears, mouth, connections | Real guild, one bot, kill and restart the connector. |

## Edge audit (open)

To settle before tests, beyond the LLD's open questions: that `voice.done` timed from the write schedule keeps cortex's `speaking_timeout_ms` and the stuck-playback watchdog (MOUTH-PLAY-011) coherent; that dropping per-service channels loses nothing the owner used (ears and mouth in different channels); that the reserved tags cover every sink name voice's protocol uses; the order of registration and stream creation so a consumer that starts first does not miss early frames (`$` start is live-only by design).

## Barge-in and echo gate: built

Built with tests (barge-in and echo-gate slice); the deferred dynamic-speech ideal stays `[D]`. CONN-AUD-006, CONN-AUD-007, CONN-FLUSH-001 to CONN-FLUSH-004 and CONN-DISC-012 are `[x]`: the flush frame, the `flush` capability flag and the Discord connector consuming it. Spec file totals: 48 specs, 46 `[x]`, 1 `[ ]`, 1 `[D]`. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (Approach: Connectors; Cross-cutting protocols: Connectors; Key Design Decisions: Listening and speaking, Binary payloads)

### LLD
- docs/intent/connections/connections-design.md
- docs/intent/connections/decisions/connector-protocol.md

### EARS
- docs/intent/connections/connections-specs.md (48 specs: 39 `[x]`, 8 `[ ]`, 1 `[D]`)

### Tests
- packages/bus/test/connector.test.ts
- packages/shared/test/utterance.test.ts
- services/connector-discord/test/connector.test.ts
- services/ears/test/connector-source.test.ts, services/ears/test/service.test.ts
- services/mouth/test/connector-output.test.ts, services/mouth/test/mouth.test.ts
- packages/config/test/compose-chat-data.test.ts, packages/config/test/installer.test.ts

### Code
- packages/bus/src/connector.ts, packages/bus/src/registrar.ts
- packages/shared/src/utterance.ts
- services/connector-discord/src/ (service, capture, playout, health)
- services/ears/src/connector-source.ts, services/mouth/src/connector-output.ts

Reuses `packages/shared/src/discord-voice.ts` (`createDiscordVoiceSession`).

## Architecture

**Purpose:** Let external services attach to the stack as audio sources and sinks, and own the one Discord login.

**Key Components:**
1. Connector client library: registration lease, tag validation, frame codec, paced writer, live reader.
2. `services/connector-discord`: login, undeafened voice connection, per-speaker capture to `audio.in.discord`, playback from `audio.out.discord`, heartbeat and registration.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Registration and liveness | CONN-REG-001 to 007 | 7 | 0 | 0 |
| Tags | CONN-TAG-001 to 004 | 4 | 0 | 0 |
| Audio streams and frames | CONN-AUD-001 to 005 | 5 | 0 | 0 |
| Back-pressure and loss | CONN-BP-001 to 006 | 6 | 0 | 0 |
| Discord connector | CONN-DISC-001 to 011 | 11 | 0 | 0 |
| Failure isolation | CONN-ISO-001 to 003 | 3 | 0 | 0 |
| Health | CONN-HLTH-001, 002 | 2 | 0 | 0 |
| Desktop audio helper | CONN-DESK-001 to 003 | 1 | 1 | 1 |
