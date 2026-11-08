# Arrow: chat

Twitch chat sense: Twitch IRC (or a fake source) in, filtered `chat.message` events out, plus service-level test injection and a heartbeat.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 44 specs: 44 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and every scheduled gap fix has landed.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S8** Missing-channel heartbeat → keep `mode: "live"`, `deps.twitch: "down"`. Specs: CHAT-HEALTH-006 (reworded, `[x]`).
2. **S9** Token registration order → await `addUserForToken` before the client asks for credentials. Specs: CHAT-TW-006 (`[x]`).
3. **R1** Twitch-path publish failure → log and continue. Specs: CHAT-TW-007 (`[x]`).
4. **B14** `ignore_prefixes` vs leading whitespace → trim first. Specs: CHAT-FILT-003 (`[x]`), CHAT-FILT-002 (reworded).
5. **S10** Substring mention matching → keep. Specs: CHAT-FILT-007 (reworded).
6. **S11** Twitch reconnect → library default, specified, untested. Specs: CHAT-TW-009 (new, `[x]`).
7. **S12** Fake chat `platform: "twitch"`, injected chat without `userId` → keep both. Specs: CHAT-FILT-005, CHAT-INJ-005 (reworded).
8. **P1** Typing in chat → deferred goal; the credential path stays. LLD Decisions.
9. **P2** Chat platforms → multi-platform is a goal; Twitch is the only implementation. LLD Context.
10. **P8** Restart replay → `inject.request` subscription uses start mode `latest`. Specs: CHAT-INJ-009 (new, `[x]`), CHAT-INJ-001 (reworded).

11. **Owner 2026-11-08** `TWITCH_REFRESH_TOKEN` required on the authenticated Twitch path. Specs: CHAT-TW-002 (reworded), CHAT-TW-010 (new, `[x]`).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (44 specs: 44 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts
- services/chat/test/twitch.test.ts

26 `@spec` annotations in tests, citing 32 distinct spec IDs.

### Code
- services/chat/src/index.ts
- services/chat/src/filter.ts
- services/chat/src/fake.ts
- services/chat/src/inject.ts
- services/chat/src/health.ts
- services/chat/src/subscribe.ts
- services/chat/src/twitch.ts
- services/chat/package.json, services/chat/tsconfig.json

24 `@spec` annotations in code, citing all 44 IDs (CHAT-TW-009, the library-driven reconnect, rides the `onConnect` annotation in `services/chat/src/index.ts`). No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/chat/spec.md (rationale: `.../add-isolated-backends/design.md` D6)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/chat/spec.md (rationale: `.../add-test-injection/design.md` D8)

## Architecture

**Purpose:** Turn Twitch chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts` — wiring: picks a plan (`fake` / `twitch` / `idle`), builds optional Twitch auth, connects `ChatClient`, starts the heartbeat. Establishes the `inject.request` subscription before any plan signals `ready`. Untested glue.
2. `filter.ts` — pure `createChatFilter`, `channelName`, `chatPlan`; ignore lists, whitespace cleanup, mention flag, payload shape.
3. `fake.ts` — `startFakeSource`: stdin lines or a cycled 6-line script through the same filter.
4. `subscribe.ts` — `subscribeInject`: creates the `chat` consumer group, then starts the `inject.request` loop with start mode `latest`.
5. `twitch.ts` — `createMessageHandler` (filter, publish, log a failed publish) and `registerUserToken` (awaited token registration) for the Twitch path.
6. `inject.ts` — `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
7. `health.ts` — `chatHealth` heartbeat spec (mode `mock`/`live`, dep `twitch`).

Depends on `event-bus`, `config`, `control-plane` (heartbeat). Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Source selection | CHAT-PLAN-001 to 006 | 6 | 0 | 0 |
| Twitch connection | CHAT-TW-001 to 009 | 9 | 0 | 0 |
| Filtering and payload | CHAT-FILT-001 to 007 | 7 | 0 | 0 |
| Fake source | CHAT-FAKE-001 to 006 | 6 | 0 | 0 |
| Test injection | CHAT-INJ-001 to 009 | 9 | 0 | 0 |
| Health | CHAT-HEALTH-001 to 006 | 6 | 0 | 0 |

**Summary:** 44 of 44 specs implemented; 0 gaps; 0 deferred. 33 of the 44 have a test citing them. The 11 without a test are the `index.ts` wiring (CHAT-PLAN-005, CHAT-PLAN-006, CHAT-TW-001 to 005, CHAT-TW-009, CHAT-INJ-001) plus CHAT-FAKE-005 and CHAT-FAKE-006. CHAT-PLAN-001 to 003 are tested only through the pure `chatPlan`, not the branch wiring.

## Key Findings

1. **CHAT-HEALTH-006 states the shipped `live` / `down` heartbeat** for a missing channel (`services/chat/src/health.ts:10-14`, test `services/chat/test/health.test.ts:23`), backed by add-isolated-backends design D6 and confirmed by the owner (S8).
2. **CHAT-TW-008** covers the Twitch `onMessage` → filter → publish path (`createMessageHandler`, `services/chat/src/twitch.ts`); tested.
3. **Auth registration is awaited** — `registerUserToken` (`twitch.ts`) finishes `addUserForToken` (with `expiresIn: 0, obtainmentTimestamp: 0`) before `buildAuth` returns, and a failure surfaces as `fatal`. Refreshed tokens are only logged, never persisted. (CHAT-TW-006)
4. **A failed publish on the live path is logged and the next message is handled** (CHAT-TW-007). The `inject.request` subscription is created before any plan runs (`subscribeInject`), with start mode `latest` (CHAT-INJ-009); read failures are retried inside the bus (event-bus, R1).
5. **Reconnect is the library default** — `onDisconnect` only flips `connected` and logs; `@twurple/chat` 8.2.0 runs an `ircv3` 0.33.1 client whose `reconnect` option defaults to `true`, and `ChatClient` does not override it. Specified as CHAT-TW-009, untested.
6. **Filter** — substring mention match is deliberate (`test/filter.test.ts`, S10); `ignore_prefixes` is matched after trimming (CHAT-FILT-003); platform is hard-coded `"twitch"` also for fake chat (S12).
7. **Credentials for a deferred goal** — the header says credentials are for typing in chat later (`index.ts:5-6`); nothing calls `say` and the scope is read-only `["chat"]` (`index.ts:78`). Typing in chat is a deferred project goal (P1), so the path stays.
8. **Decisions evidenced** — LLD Decisions rows cite a comment, test, commit (51d5a9c), archived OpenSpec design or the owner decision of 2026-11-01; zero-expiry token registration and the EventSub alternative stay `[inferred]`.

## Work Required

### Must Fix
None: CHAT-TW-006, CHAT-TW-007, CHAT-FILT-003 and CHAT-INJ-009 are implemented.

### Nice to Have
1. Add tests for the `index.ts` wiring: idle plan degraded heartbeat, auth selection, reconnect re-signalling `ready` (CHAT-PLAN-003, CHAT-TW-001, CHAT-TW-002, CHAT-TW-009).
2. Persist refreshed Twitch tokens, or document that restarts re-use the env token (CHAT-TW-002).
