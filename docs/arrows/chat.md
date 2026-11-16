# Arrow: chat

Twitch chat sense: Twitch IRC (or a fake source) in, filtered `chat.message` events out, plus service-level test injection and a heartbeat.

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): the Twitch channel and credentials come from `chat.twitch.*` keys and `secrets.yaml`. Total 45 specs: 45 `[x]`, 0 `[ ]`, 0 `[D]`.

**AUDITED**: 45 specs: 45 implemented, 0 deferred, 0 gaps.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (45 specs: 45 `[x]`, 0 `[ ]`, 0 `[D]`; prefix `CHAT`)

### Tests
Files with `@spec CHAT-` annotations:
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts
- services/chat/test/service.test.ts
- services/chat/test/twitch.test.ts

Also in the segment: services/chat/test/contract.test.ts (no `@spec` annotation).

### Code
Files with `@spec CHAT-` annotations:
- services/chat/src/index.ts
- services/chat/src/service.ts
- services/chat/src/filter.ts
- services/chat/src/fake.ts
- services/chat/src/inject.ts
- services/chat/src/health.ts
- services/chat/src/twitch.ts
- services/chat/src/token-store.ts

Also: services/chat/package.json, services/chat/tsconfig.json. `subscribeInject` lives in packages/shared/src/inject.ts.

## Architecture

**Purpose:** Turn Twitch chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts`: hands `chatService` to the shared `runService` bootstrap.
   `service.ts`: `chatService`: wiring: picks a plan (`fake` / `twitch` / `idle`), builds optional Twitch auth, connects `ChatClient`, starts the heartbeat. Establishes the `inject.request` subscription (`subscribeInject` from `@cohost/shared`) before any plan signals `ready`. Tested by `service.test.ts` through injected dependencies.
2. `filter.ts`: pure `createChatFilter`, `channelName`, `chatPlan`; ignore lists, whitespace cleanup, mention flag, payload shape.
3. `fake.ts`: `startFakeSource`: stdin lines or a cycled 6-line script through the same filter.
4. `twitch.ts`: `createMessageHandler` (filter, publish, log a failed publish) and `registerUserToken` (awaited token registration) for the Twitch path.
5. `token-store.ts`: persists and reloads the refreshed Twitch token (`<dataDir()>/chat/twitch-token.json`).
6. `inject.ts`: `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
7. `health.ts`: `chatHealth` heartbeat spec (mode `mock`/`live`, dep `twitch`).

Depends on `event-bus`, `config`, `control-plane` (heartbeat), `shared-runtime`. Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Source selection | CHAT-PLAN-001 to CHAT-PLAN-006 | 6 | 0 | 0 | 6 |
| Twitch connection | CHAT-TW-001 to CHAT-TW-012 | 12 | 0 | 0 | 12 |
| Filtering and payload | CHAT-FILT-001 to CHAT-FILT-007 | 7 | 0 | 0 | 7 |
| Fake source | CHAT-FAKE-001 to CHAT-FAKE-006 | 6 | 0 | 0 | 6 |
| Test injection | CHAT-INJ-001, CHAT-INJ-004 to CHAT-INJ-010 | 8 | 0 | 0 | 8 |
| Health | CHAT-HEALTH-001 to CHAT-HEALTH-006 | 6 | 0 | 0 | 6 |

**Summary:** 45 of 45 specs implemented; 0 deferred; 0 open. 45 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **CHAT-HEALTH-006 states the shipped `live` / `down` heartbeat** for a missing channel (`services/chat/src/health.ts`, test `services/chat/test/health.test.ts`).
2. **CHAT-TW-008** covers the Twitch `onMessage` to filter to publish path (`createMessageHandler`, `services/chat/src/twitch.ts`).
3. **Auth registration is awaited.** `registerUserToken` (`twitch.ts`) finishes `addUserForToken` before `buildAuth` returns, and a failure surfaces as `fatal`. A refreshed token is persisted and preferred over `.env` while its recorded `.env` refresh token is current (CHAT-TW-006, CHAT-TW-011, CHAT-TW-012).
4. **A failed publish on the live path is logged and the next message is handled** (CHAT-TW-007). The `inject.request` subscription is created before any plan runs, with start mode `latest` (CHAT-INJ-009); read failures are retried inside the bus.
5. **Reconnect is the library default.** `onDisconnect` only flips `connected` and logs; `@twurple/chat` reconnects and `onConnect` re-signals `ready` (CHAT-TW-009, tested in `service.test.ts`).
6. **Filter.** Substring mention match is deliberate (`services/chat/test/filter.test.ts`); `ignore_prefixes` is matched after trimming (CHAT-FILT-003); platform is hard-coded `"twitch"` also for fake chat.
7. **Credentials serve a deferred goal.** The `service.ts` header says credentials are for typing in chat later; nothing calls `say` and the scope is read-only `["chat"]`. The path stays.

## Work Required

### Must Fix
None.

### Nice to Have
None.
