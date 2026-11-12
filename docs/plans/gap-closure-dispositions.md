# Gap-closure dispositions

Status: approved by the owner on 2026-11-11, including every disposition that changes behaviour. Every item under "Open Questions & Future Decisions" in the 18 existing LLDs gets one disposition: implemented in a chunk, dropped with a reason, or already resolved. The LLDs' own open-question sections are updated only when a chunk lands (each chunk walks the arrow: LLD, EARS, tests, code).

Item numbers follow each LLD's subsection numbering (R = Resolved, O = Observed/debt or the unlabelled list, D = Deferred, Op = Open). 143 items in all: 9 already marked resolved in their LLD, 10 deferred decisions, 124 others.

## Chunks

| Chunk | Scope | Design source |
|---|---|---|
| C1 | Shared foundation: `@cohost/shared` modules (bootstrap, lifecycle, retry, idle plan, `controlFor`, inject handler, audio, Discord voice session, hash embedding); bus transport fixes | [shared-runtime](../intent/shared-runtime/shared-runtime-design.md), event-bus |
| C2 | Control plane and deployment: manifest descriptor fields, derived service lists, dependents degraded, CLI and healthcheck fixes, Compose and image hygiene | [module-contract](../intent/module-contract/module-contract-design.md), control-plane, deployment |
| C3 | Config and the generic settings editor: schema export, secret marking, section read/write, loader fixes | module-contract, config |
| C4 | Independence and test injection: test drawer, `POST /inject/event`, pause/resume UI, per-unit inputs | module-contract, dashboard |
| C5 | voice | voice |
| C6 | mouth | mouth |
| C7 | ears | ears |
| C8 | memory | memory |
| C8b | Voice speakers get viewer notes (Discord id to viewer identity; `link_discord` / `unlink_discord`; Viewers page links) | memory, ears, dashboard, event-bus |
| C9 | chat and eyes | chat, eyes |
| C10 | avatar, cortex, salience, affect, working-memory | those LLDs |
| C11 | region-hooks and model-backends | those LLDs |
| C12 | Documentation and run readiness: `.env.example`, README, stale plans, LID CI check, first real run against Docker, Discord, Twitch and OBS | deployment, all |

Each service chunk (C5 to C11) also moves that service onto `runService` and the other shared modules built in C1.

Specs written for the module contract land as follows: SHARED-* in C1; MOD-MAN-*, MOD-LIFE-*, CTRL-MANIFEST-003, CTRL-RUNTIME-009 and DEPLOY-COMPOSE-017 in C2; MOD-CFG-*, MOD-UI-001 to 006, CFG-SCH-021 to 023 and CFG-ISO-004 in C3; MOD-TEST-*, MOD-PAUSE-* in C4; VOICE-ENV-005 in C5; MOUTH-SESS-009, MOUTH-AUD-002, MOUTH-DRY-*, MOUTH-START-002/003/005 in C6; EARS-SESS-010, EARS-AUD-005, EARS-INJ-010, EARS-STUB-* in C7; MEM-BACKEND-004 in C8; EYES-INJ-016, EYES-STUB-* in C9. Adopting `startIdle` changes two existing lines in their service chunks: EYES-ENAB-002 (a warning every 60 s while vision is disabled) becomes one warning (SHARED-IDLE-001) in C9, and chat's CHAT-INJ-002/003 retire in favour of SHARED-INJ-001/002 when chat moves onto the inject handler in C9. The dashboard's inject lines (DASH-INJ-*) gain the not-running refusal (MOD-TEST-005) in C4.

## Dispositions

| Segment | Item | Disposition | Owning chunk |
|---|---|---|---|
| affect | O1 Hard-coded constants (15 s republish, nudge sizes, `MAX_QUEUED`, 4-char cutoff, emotion lists) | Implement: republish interval, nudge sizes and short-line cutoff become `brain.affect` keys with today's values as defaults, editable in the settings editor; `MAX_QUEUED` stays a code bound (resource limit, not behaviour) | C10 |
| affect | O2 Docblock misplaced | Implement (move the comment to the class) | C10 |
| affect | O3 Publish key coarser than the state | Drop: the 2-decimal key deliberately suppresses imperceptible moves, and the 15 s republish bounds how stale a cause-only change can be | — |
| affect | O4 Test gaps (restart state, boundaries, exact sizes, http-kind monkey-patch) | Implement | C10 |
| avatar | O1 `known` eviction by insertion order | Implement: re-preparing an id moves it to newest | C10 |
| avatar | O2 Neutral handling differs by path | Implement one meaning for neutral across drivers (owner picks clear vs toggle at EARS) | C10 |
| avatar | O3 Interrupted utterance replaced without `done` | Drop: avatar follows the newest playing line by design; overlap between sinks is voice's documented non-exclusivity | — |
| avatar | O4 Tests not type-checked | Implement (tests in `tsc -b`) | C10 |
| avatar | O5 Untested boot paths; VTS reconnect, timeout, no handshake timeout | Implement: VTS reconnect on `retryWithBackoff`, a handshake timeout, tests for the listed specs | C10 |
| chat | O1 Refreshed tokens never persisted | Implement: persist refreshed tokens under `<dataDir()>/chat/` and prefer them over `.env` on start | C9 |
| chat | O2 Staleness compares publisher `ts` with local clock | Drop: every container runs on the one host and shares its clock; the window is 60 s | — |
| chat | O3 `index.ts` untested | Implement: `runService` makes `main` injectable; tests for CHAT-TW-008/009 | C9 |
| chat | O4 Idle error every 60 s forever | Implement: `startIdle` (one error, reminder at most every 60 s, owner direction) | C9 |
| chat | O5 OpenSpec "exit 1" divergence | Already resolved: OpenSpec removed; CHAT-PLAN-003 governs | — |
| config | R1 VTube Studio token location | Already resolved | — |
| config | R2 OpenSpec divergence | Already resolved | — |
| config | O1 Silent empties in plain string keys | Implement: blank-to-default for string keys that have a default; the editor shows the effective value | C3 |
| config | O2 Partially dead keys (`voice.sample_rate`, `dashboard.port`) | Implement: describe `voice.sample_rate` as stub-only in the schema (the editor shows it); the `dashboard.port` Compose half is resolved (the dashboard left Compose) | C3 |
| config | O3 `vision.model` required when vision is disabled | Implement: required only when `vision.enabled` | C3 |
| config | O4 `.env` path assumption; `/.dockerenv` makes a test environment-dependent | Implement: `.env` beside the workspace root; the container check injectable | C3 |
| config | O5 `loadExpressions` error shape; non-atomic `savePersonality`; caching unknown | Implement: formatted errors, atomic writes shared with the settings editor's writer; uncached reads stated as intent | C3 |
| config | O6 Diagnostics via `console.warn` | Implement: the pino logger | C3 |
| config | O7 Duplicate `ModuleConfig` type | Implement: one exported type from config | C11 |
| config | O8 Test hygiene | Implement | C3 |
| config | O9 `.env.example` incompleteness | Implement | C12 |
| config | O10 Specs realized by example files carry no `@spec` | Drop: the examples are copied into the owner's files, which should not carry spec comments; the tests carry the annotations | — |
| control-plane | R1 Separate health stream | Already resolved | — |
| control-plane | R2 Runtimes | Already resolved | — |
| control-plane | R3 Code comments point at specs | Already resolved | — |
| control-plane | O1 CLI opens a Bus before parsing | Implement | C2 |
| control-plane | O2 Seeding uses publisher timestamps | Implement: clamp seeded receive times to now (WSL2 and Docker Desktop VM clocks can drift after sleep) | C2 |
| control-plane | O3 Healthcheck clock skew | Implement: compare against Redis `TIME` rather than the container clock | C2 |
| control-plane | O4 `stopping` only on clean shutdown; crash-loop after 3 starts | Drop: a crash cannot publish; staleness (3x, 10x) is the designed path, and 3 starts is the defined crash-loop threshold | — |
| control-plane | O5 `@cohost/config` declared but unused | Already resolved: the stack controller's workspace-root `cwd` uses it, and the manifest's `config` field will too | — |
| control-plane | O6 Circular import bus/heartbeat | Implement: lifecycle helpers move to `@cohost/shared` | C1 |
| control-plane | O7 Duplicate service lists | Implement: the manifest is the one source (module-contract) | C2 |
| control-plane | O8 Test coverage gaps | Implement | C2 |
| control-plane | O9 Tracker's dep-down rule redundant for helper users | Drop: the rule covers hand-published heartbeats and costs nothing | — |
| control-plane | O10 CTRL-CHECK-003 in Compose, untested | Implement: a Compose-file test for the healthcheck wiring | C2 |
| control-plane | D1 Docker Engine API instead of the CLI | Drop: module-contract keeps the CLI (Compose's project model lives there) | — |
| control-plane | D2 Compose restart counts | Implement: show restart counts from Compose so a service that dies before its first heartbeat still shows crash-looping | C2 |
| control-plane | D3 Dashboard and concurrent `cohostctl` stack commands | Drop: one operator; Compose tolerates overlap and the page shows the resulting state | — |
| cortex | R1 Owner decisions of 2026-11-01 | Already resolved | — |
| cortex | D1 Operator `say` overwrites `speakingId` | Implement: an interrupted line's `voice.done` is still reconciled | C10 |
| cortex | D2 Cast and mutability smells | Implement (the 25-message literal is already replaced by CTX-VIEWER-001) | C10 |
| cortex | D3 Critic misconfiguration fails outside `main()` | Implement: construction inside `runService`'s `main`, so it takes the `fatal` path | C10 |
| cortex | D4 Test coverage | Implement | C10 |
| dashboard | O1 Autoplay block drops the queue with no `done` | Implement: post `done` for the dropped utterance and keep the queue for when audio is re-enabled | C12 |
| dashboard | O2 Bus-level injection id uncorrelatable | Implement: `POST /inject/event` returns the published event's bus id (module-contract) | C4 |
| dashboard | O3 Raw text at service level vs collapsed at bus level | Drop: chat normalises whitespace on its own path, so the outcome is the same | — |
| dashboard | O4 Duplicated CSS comment; pause/resume only by raw POST | Implement: pause/resume buttons (module-contract); comment removed | C4 |
| dashboard | O5 Visual design to be revisited | Drop: an owner-deferred redesign, not a gap | — |
| dashboard | O6 Heartbeat warnings while the stack is down | Implement: heartbeat publish failures warn at most once per 60 s (shared lifecycle) | C1 |
| dashboard | O7 Images after a code update; no Rebuild | Implement: a Rebuild stack action (`docker compose up -d --build`) | C2 |
| deployment | O1 Unpinned images | Implement: pin to the registry's current tags at implementation time | C2 |
| deployment | O2 `data/` directory unreferenced | Already resolved: `dataDir()` defaults to `data/` under the workspace root (CFG-DIR-006) | — |
| deployment | O3 Image size and duplication | Drop: not a gap on one box; revisit with per-service installs | — |
| deployment | O4 pnpm version in three places | Implement: the installer and Dockerfile read `packageManager` | C2 |
| deployment | O5 Stale `docs/plans/control-plane.md` | Implement: mark it superseded by the control-plane LLD | C12 |
| deployment | O6 LID unenforced in CI | Implement: a CI check that every `@spec` ID exists in a spec file and every `[x]` spec is cited | C12 |
| deployment | O7 Unverifiable here (LICENSE text, Compose behaviours, installer, CLA workflow) | Implement: verified during the first real run on the single-PC checklist | C12 |
| deployment | O8 No end-to-end Launch check | Implement: the smoke job runs `cohostctl launch` | C2 |
| ears | O1 Loop awaits the inject handler | Implement: the shared inject queue | C7 |
| ears | O2 Transcript filter ASCII-only | Implement: Unicode letter and number classes | C7 |
| ears | O3 `readWavHeader` ignores bit depth | Implement: shared `parseWav` rejects non-16-bit input | C1 |
| ears | O4 Untested glue | Implement: `runService` plus a faked Discord voice session | C7 |
| ears | O5 Native dependencies of unclear role | Implement: verified on the first real Discord run | C12 |
| ears | O6 Hallucinated transcripts | Implement: an `ears.drop_phrases` list with Whisper's common silence phrases as the example | C7 |
| ears | O7 Untested `[x]` specs | Implement | C7 |
| ears | D1 More listening sources | Drop: an owner-deferred goal (HLD Deferred goals), not a gap | — |
| ears | D2 Tuning the co-host's voice | Drop here: owned by voice D1 | — |
| event-bus | R1 OpenSpec divergence | Already resolved | — |
| event-bus | O1 Pending drain reads one batch | Implement: drain until no pending entries remain | C1 |
| event-bus | O2 `stopped` instance-wide; `XACK` after stop | Implement: no ack after stop; a `Bus` stays single-use by design | C1 |
| event-bus | O3 Lifecycle helpers in the bus package | Implement: move to `@cohost/shared` | C1 |
| event-bus | O4 Consumer side of BUS-EVT-004 | Implement: the target filter lives once in `controlFor` | C1 |
| event-bus | O5 Test hygiene | Implement: tests use their own stream and group names and clean up | C1 |
| event-bus | O6 Schema looseness | Implement: ranges on `avatar.state`; one shared shape for `voice.playing` / `voice.done` | C1 |
| event-bus | O7 `decode` swallows parse errors silently | Drop: the HLD transport decision drops poison events without logging; recorded as a Decisions row in the event-bus LLD | — |
| event-bus | O8 Hostname in a comment | Implement | C1 |
| event-bus | O9 `FakeBus` ids differ from Redis ids | Implement: time-ordered ids in the fake | C1 |
| eyes | O1 OBS connect has no backoff | Implement: `retryWithBackoff` 10 s doubling to 60 s | C9 |
| eyes | O2 `fatal` only on setup failures | Drop: this is the failure posture as designed | — |
| eyes | O3 `SAME` prefix rule | Drop: intended; the test pins the boundary cases | — |
| eyes | O4 Hard-coded prompt, sampling, JPEG quality | Implement: `vision.*` keys with today's values as defaults, editable in the settings editor | C9 |
| eyes | O5 Config comment and OpenSpec | Already resolved | — |
| eyes | O6 `index.ts` untested; 15 specs without tests | Implement via `runService` | C9 |
| eyes | O7 EYES-INJ-004 and redirect untested | Implement: covered by the shared inject handler's tests | C1 |
| memory | R1 Owner decisions of 2026-11-01 | Already resolved | — |
| memory | R2 Viewer notes design | Already resolved | — |
| memory | Op1 Voice speakers get no notes | Implement: owner decision (final) reversed the earlier Drop: a Discord user id maps to a viewer identity (an unlinked id is its own voice viewer, linkable to a chat viewer from the Viewers page) so a voice speaker accrues notes like a chat viewer | C8b |
| memory | D1 Migrating to a new vector dimension | Implement: an operator path (re-embed one-shot through `cohostctl`), designed at C8's LLD step | C8 |
| memory | D2 Reflection needs a reachable embedder; no lock | Implement: no embed probe for reflection; an advisory lock against the live service | C8 |
| memory | D3 Two hash embedders | Implement: the in-memory store embeds with `@cohost/llm`'s `HashEmbedder` (MEM-BACKEND-004); recall test fixtures chosen to clear `min_similarity` | C8 |
| memory | D4 Kind `note` never written | Implement: remove the unused kind | C8 |
| memory | D5 Recall `k` validation | Drop: the bus schema already rejects `k <= 0` (the memory LLD records it as decided, not open, so C8b adds nothing) | — |
| memory | D6 Test gaps; no real Postgres | Implement: a Postgres-backed integration test in CI | C8 |
| memory | D7 Consumer-group readiness hook missing | Implement: the bus resolves a subscription-ready signal | C1 |
| model-backends | O1 Claude/Bedrock surface not exercised; newer SDKs | Implement: upgrade after a registry check; an opt-in live smoke test when a key is present | C11 |
| model-backends | O2 Heartbeat `mode` under mock for salience and affect | Implement: report `mock` when a hook inherits the mock provider | C11 |
| model-backends | O3 `maxTokens` a floor on Claude | Implement: honour the hook's `maxTokens` within the API's minimum | C11 |
| model-backends | O4 `json` is only "no stops" | Implement: request structured JSON where the provider supports it | C11 |
| model-backends | O5 Style debt | Implement | C11 |
| model-backends | O6 Test coverage gaps (incl. LLM-STOP-006) | Implement | C11 |
| model-backends | O7 `@spec` placement as trailing comments | Drop: deliberate, keeps other segments' line citations valid | — |
| mouth | O1 No stuck-playback guard | Implement: a fetch timeout and a playback watchdog that end in the give-up path | C6 |
| mouth | O2 Untested glue | Implement: `runService` plus a faked Discord voice session | C6 |
| mouth | O3 Native dependencies unverified | Implement: verified on the first real Discord run | C12 |
| mouth | O4 Avatar during a fallback clip | Already resolved: accepted (owner decision) | — |
| mouth | O5 Memory keeps the intended line | Already resolved: accepted (owner decision) | — |
| mouth | D1 More output kinds | Drop: owner-deferred goal; the test-only `dryrun` output is built separately (MOUTH-DRY-*, chunk C6) | — |
| mouth | D2 Routing per line | Drop: deferred until an output kind needs it | — |
| mouth | D3 Re-routing without a restart | Already resolved: restart-to-apply through the settings editor (module-contract) | — |
| region-hooks | O1 Timeout vs slow models; no stop after repeated failures | Implement: a hook that fails N times in a row is skipped for a cool-off period, reported in the heartbeat | C11 |
| region-hooks | O2 `ModuleConfig` defined twice | Implement (with config O7) | C11 |
| region-hooks | O3 Hook providers not pinged | Implement: ping at startup, report as heartbeat deps | C11 |
| region-hooks | O4 `withTimeout` leaks the losing request | Drop: the abort signal fires at the same timeout; a provider that ignores it cannot be cancelled | — |
| region-hooks | O5 Reference server limits | Implement: threaded server, parsed paths, case-insensitive check, critic `emotion` | C11 |
| region-hooks | O6 Prompts and contracts split across segments | Implement: hook reply JSON Schemas generated from the validators, cited by the README | C11 |
| region-hooks | O7 Untested spec lines | Implement | C11 |
| salience | O1 Pause silent; stale burst on resume | Implement: pause reported in the heartbeat (module-contract); events that arrived while paused are marked seen on resume | C10 |
| salience | O2 Implicit ordering in `reflex()` | Implement: pass the triggering event explicitly | C10 |
| salience | O3 Duplicated cooldown check | Implement | C10 |
| salience | O4 Vision handling | Drop: as designed; only changed screens are worth scoring | — |
| salience | O5 Test gaps | Implement | C10 |
| voice | O1 One loop for TTS and claims | Implement: synthesis on an internal serial queue (shared-runtime boundary decision) | C5 |
| voice | O2 Tests not type-checked | Implement | C5 |
| voice | O3 `parseWav` robustness | Implement: shared `parseWav` checks the format tag and chunk order | C1 |
| voice | O4 HTTP method and query strings | Implement: GET/HEAD only; match the path, not the raw URL | C5 |
| voice | O5 Id reuse in `order` | Implement | C5 |
| voice | O6 `voice.speed` default 1 vs example 1.05 | Drop: the example ships the owner's tuned value over a neutral schema default | — |
| voice | O7 Shutdown untested; 1.5 s timer not cleared | Implement via `runService`; clear the timer on stop | C5 |
| voice | O8 Avatar and fallback clips | Already resolved: accepted (owner decision) | — |
| voice | D1 Tuning the co-host's voice | Drop: owner-deferred; the settings editor exposes whatever knobs `voice` gains | — |
| voice | D2 More outputs | Drop: owned by mouth's deferred decisions | — |
| working-memory | O1 Truthy, not `true` | Drop: the bus schema already rejects non-boolean flags | — |
| working-memory | O2 `markSeenEvents` identity semantics | Implement: mark by event id | C10 |
| working-memory | O3 Over-broad dependencies | Implement: type-only imports, not runtime dependencies | C10 |
| working-memory | O4 Duplicate windows in salience and cortex | Implement (reopened): one window implementation in `@cohost/working-memory` serves both regions (sizing, aging, seen-marking, the hold that salience applies while paused); each region still holds its own instance | C10 |
| working-memory | O5 Timestamp clocks differ by kind | Implement: `self` entries use the `brain.say` event's bus `ts` | C10 |
| working-memory | O6 Redundant casts | Implement | C10 |
| working-memory | O7 Vision entry placed last | Drop: the transcript shows the current screen most recently, which is what the prompt needs | — |
| working-memory | O8 Untested spec lines | Implement | C10 |
