# Arrow: chat

Twitch chat sense: Twitch IRC (or a fake source) in, filtered `chat.message` events out, plus service-level test injection and a heartbeat.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 43 specs: 39 implemented, 0 deferred, 4 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S8** Missing-channel heartbeat → keep `mode: "live"`, `deps.twitch: "down"`. Specs: CHAT-HEALTH-006 (reworded, `[x]`).
2. **S9** Token registration order → await `addUserForToken` before the client asks for credentials. Specs: CHAT-TW-006 (`[ ]`).
3. **R1** Twitch-path publish failure → log and continue. Specs: CHAT-TW-007 (`[ ]`).
4. **B14** `ignore_prefixes` vs leading whitespace → trim first. Specs: CHAT-FILT-003 (`[x]` → `[ ]`), CHAT-FILT-002 (reworded).
5. **S10** Substring mention matching → keep. Specs: CHAT-FILT-007 (reworded).
6. **S11** Twitch reconnect → library default, specified, untested. Specs: CHAT-TW-009 (new, `[x]`).
7. **S12** Fake chat `platform: "twitch"`, injected chat without `userId` → keep both. Specs: CHAT-FILT-005, CHAT-INJ-005 (reworded).
8. **P1** Typing in chat → deferred goal; the credential path stays. LLD Decisions.
9. **P2** Chat platforms → multi-platform is a goal; Twitch is the only implementation. LLD Context.
10. **P8** Restart replay → `inject.request` subscription uses start mode `latest`. Specs: CHAT-INJ-009 (new, `[ ]`), CHAT-INJ-001 (reworded).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (43 specs: 39 `[x]`, 4 `[ ]`, 0 `[D]`)

### Tests
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts

21 `@spec` annotations in tests, citing 27 distinct spec IDs.

### Code
- services/chat/src/index.ts
- services/chat/src/filter.ts
- services/chat/src/fake.ts
- services/chat/src/inject.ts
- services/chat/src/health.ts
- services/chat/package.json, services/chat/tsconfig.json

19 `@spec` annotations in code. They cite 40 IDs: all 39 `[x]` IDs (CHAT-TW-009, the library-driven reconnect, rides the `onConnect` annotation at `services/chat/src/index.ts:89`) and CHAT-FILT-003, which is now a `[ ]` gap whose annotation stays on `filter.ts` until the fix lands. No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/chat/spec.md (rationale: `.../add-isolated-backends/design.md` D6)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/chat/spec.md (rationale: `.../add-test-injection/design.md` D8)

## Architecture

**Purpose:** Turn Twitch chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts` — wiring: picks a plan (`fake` / `twitch` / `idle`), builds optional Twitch auth, connects `ChatClient`, subscribes `inject.request`, starts the heartbeat. Untested glue.
2. `filter.ts` — pure `createChatFilter`, `channelName`, `chatPlan`; ignore lists, whitespace cleanup, mention flag, payload shape.
3. `fake.ts` — `startFakeSource`: stdin lines or a cycled 6-line script through the same filter.
4. `inject.ts` — `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
5. `health.ts` — `chatHealth` heartbeat spec (mode `mock`/`live`, dep `twitch`).

Depends on `event-bus`, `config`, `control-plane` (heartbeat). Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Source selection | CHAT-PLAN-001 to 006 | 6 | 0 | 0 |
| Twitch connection | CHAT-TW-001 to 009 | 7 | 0 | 2 (TW-006, TW-007) |
| Filtering and payload | CHAT-FILT-001 to 007 | 6 | 0 | 1 (FILT-003) |
| Fake source | CHAT-FAKE-001 to 006 | 6 | 0 | 0 |
| Test injection | CHAT-INJ-001 to 009 | 8 | 0 | 1 (INJ-009) |
| Health | CHAT-HEALTH-001 to 006 | 6 | 0 | 0 |

**Summary:** 39 of 43 specs implemented; 4 gaps (CHAT-TW-006, CHAT-TW-007, CHAT-FILT-003, CHAT-INJ-009); 0 deferred. 27 of the 39 implemented specs have a test citing them. The 12 without a test are the `index.ts` wiring (CHAT-PLAN-005, CHAT-PLAN-006, CHAT-TW-001 to 005, CHAT-TW-008, CHAT-TW-009, CHAT-INJ-001) plus CHAT-FAKE-005 and CHAT-FAKE-006. CHAT-PLAN-001 to 003 are tested only through the pure `chatPlan`, not the branch wiring.

## Key Findings

1. **CHAT-HEALTH-006 states the shipped `live` / `down` heartbeat** for a missing channel (`services/chat/src/health.ts:10-14`, test `services/chat/test/health.test.ts:23`), backed by add-isolated-backends design D6 and confirmed by the owner (S8).
2. **CHAT-TW-008** covers the Twitch `onMessage` → filter → publish path (`services/chat/src/index.ts:102-105`); `[x]`, untested.
3. **Auth registration is fire-and-forget** — `void provider.addUserForToken(...)` (`services/chat/src/index.ts:71`) with `expiresIn: 0, obtainmentTimestamp: 0`; `ChatClient` is built immediately after (`:87`). Refreshed tokens are only logged (`:70`), never persisted. (CHAT-TW-006)
4. **No error handling around publish in the live path** — `onMessage` awaits `bus.publish` bare (`index.ts:102-105`). (CHAT-TW-007) The `inject.request` subscription is `void` with no `.catch` (`index.ts:30`); read failures are to be retried inside the bus (event-bus, R1).
5. **Reconnect is the library default** — `onDisconnect` only flips `connected` and logs (`index.ts:96-99`); `@twurple/chat` 8.2.0 runs an `ircv3` 0.33.1 client whose `reconnect` option defaults to `true`, and `ChatClient` does not override it. Now specified as CHAT-TW-009, untested.
6. **Filter** — substring mention match is deliberate (`test/filter.test.ts:36`, S10); `ignore_prefixes` is checked on untrimmed text (`filter.ts:36`, CHAT-FILT-003 gap); platform is hard-coded `"twitch"` (`filter.ts:40`) also for fake chat (S12).
7. **Credentials for a deferred goal** — the header says credentials are for typing in chat later (`index.ts:5-6`); nothing calls `say` and the scope is read-only `["chat"]` (`index.ts:78`). Typing in chat is a deferred project goal (P1), so the path stays.
8. **Decisions evidenced** — LLD Decisions rows cite a comment, test, commit (51d5a9c), archived OpenSpec design or the owner decision of 2026-11-01; zero-expiry token registration and the EventSub alternative stay `[inferred]`.

## Work Required

### Must Fix
1. Wrap the Twitch `onMessage` publish in try/catch with a warn log (CHAT-TW-007, R1).
2. Trim the text before matching `ignore_prefixes` and add a test for `" !cmd"` (CHAT-FILT-003, B14).
3. Subscribe `inject.request` with start mode `latest` once the bus offers it (CHAT-INJ-009, P8).

### Should Fix
4. Await (and log a failure of) `addUserForToken` before creating `ChatClient` (CHAT-TW-006, S9).

### Nice to Have
5. Add tests for the `index.ts` wiring: idle plan degraded heartbeat, auth selection, message publish, reconnect re-signalling `ready` (CHAT-PLAN-003, CHAT-TW-001, CHAT-TW-002, CHAT-TW-008, CHAT-TW-009).
6. Persist refreshed Twitch tokens, or document that restarts re-use the env token (CHAT-TW-002).
