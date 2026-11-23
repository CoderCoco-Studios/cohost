# Arrow: chat

Chat sense: a list of sources (Twitch IRC, YouTube live chat, a fake source) in, filtered `chat.message` and `chat.removed` events out, plus service-level test injection and a heartbeat.

## Status

Built: the Twitch source (channel and credentials from `chat.twitch.*` keys and `secrets.yaml`), the fake source and test injection. Specified and not built: the source list `chat.sources` and its plan, the YouTube source, the shared source contract and state vocabulary, platform and user id on `chat.message`, and forgetting removed messages (`chat.removed`). Total 163 specs: 20 `[x]`, 143 `[ ]`, 0 `[D]`.

**PARTIAL**: 163 specs: 20 implemented, 0 deferred, 143 gaps (YouTube chat and forgetting, chat safety, below).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (163 specs: 20 `[x]`, 143 `[ ]`, 0 `[D]`; prefix `CHAT`; facets `PLAN`, `SRC`, `TW`, `FILT`, `FAKE`, `INJ`, `HEALTH`, `YT` and `FORGET`)

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

**Purpose:** Turn Twitch chat, YouTube live chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, report platform removals as `chat.removed`, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts`: hands `chatService` to the shared `runService` bootstrap.
   `service.ts`: `chatService`: wiring: computes the plan for `chat.sources` (each source runnable or a gap; `off`; idle when none runs), starts each source behind the `ChatSource` contract, starts the heartbeat. Establishes the `inject.request` subscription (`subscribeInject` from `@cohost/shared`) before any source starts. Tested by `service.test.ts` through injected dependencies.
2. `filter.ts`: pure `createChatFilter`, `channelName`, `sourcePlan`; ignore lists, whitespace cleanup, mention flag, payload shape, platform from the source.
2a. (designed, not built) `source.ts`, `youtube.ts`, `youtube-video.ts`, `youtube-map.ts` and the YouTube transport module.
3. `fake.ts`: `startFakeSource`: stdin lines or a cycled 6-line script through the same filter.
4. `twitch.ts`: `createMessageHandler` (filter, publish, log a failed publish) and `registerUserToken` (awaited token registration) for the Twitch path.
5. `token-store.ts`: persists and reloads the refreshed Twitch token (`<dataDir()>/chat/twitch-token.json`).
6. `inject.ts`: `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
7. `health.ts`: `chatHealth` heartbeat spec (mode `off`/`mock`/`live`, one dependency per source: `twitch`, `youtube`).

Depends on `event-bus`, `config`, `control-plane` (heartbeat), `shared-runtime`. Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Source selection | CHAT-PLAN-001 to CHAT-PLAN-015 | 1 | 0 | 14 | 5 |
| Source contract | CHAT-SRC-001 to CHAT-SRC-009 | 0 | 0 | 9 | 0 |
| Twitch connection | CHAT-TW-001 to CHAT-TW-018 | 8 | 0 | 10 | 10 |
| Filtering and payload | CHAT-FILT-001 to CHAT-FILT-014 (CHAT-FILT-010 no longer exists) | 1 | 0 | 12 | 7 |
| Fake source | CHAT-FAKE-001 to CHAT-FAKE-009 | 5 | 0 | 4 | 6 |
| Test injection | CHAT-INJ-001, CHAT-INJ-004 to CHAT-INJ-012, CHAT-INJ-014 (CHAT-INJ-013 no longer exists) | 4 | 0 | 7 | 8 |
| Health | CHAT-HEALTH-001 to CHAT-HEALTH-012 | 1 | 0 | 11 | 6 |
| YouTube source | CHAT-YT-001 to CHAT-YT-068 | 0 | 0 | 68 | 0 |
| Forgetting a removed message | CHAT-FORGET-001 to CHAT-FORGET-008 | 0 | 0 | 8 | 0 |

**Summary:** 20 of 163 specs implemented; 0 deferred; 143 open. 42 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **CHAT-HEALTH-006 states the `live` / `down` heartbeat** for a missing Twitch channel, revised for the source list (the shipped `services/chat/src/health.ts` still reports `twitch` only).
2. **CHAT-TW-008** covers the Twitch `onMessage` to filter to publish path (`createMessageHandler`, `services/chat/src/twitch.ts`).
3. **Auth registration is awaited.** `registerUserToken` (`twitch.ts`) finishes `addUserForToken` before `buildAuth` returns, and a failure surfaces as `fatal`. A refreshed token is persisted and preferred over `.env` while its recorded `.env` refresh token is current (CHAT-TW-006, CHAT-TW-011, CHAT-TW-012).
4. **A failed publish on the live path is logged and the next message is handled** (CHAT-TW-007). The `inject.request` subscription is created before any plan runs, with start mode `latest` (CHAT-INJ-009); read failures are retried inside the bus.
5. **Reconnect is the library default.** `onDisconnect` only flips `connected` and logs; `@twurple/chat` reconnects and `onConnect` re-signals `ready` (CHAT-TW-009, tested in `service.test.ts`).
6. **Filter.** Substring mention match is deliberate (`services/chat/test/filter.test.ts`); `ignore_prefixes` is matched after trimming (CHAT-FILT-003); the shipped filter still hard-codes `"twitch"` also for fake chat; the design carries the platform from the source (CHAT-FILT-005).
7. **Credentials serve a deferred goal.** The `service.ts` header says credentials are for typing in chat later; nothing calls `say` and the scope is read-only `["chat"]`. The path stays.

## Work Required

### Must Fix
- The source list and plan, the source contract and its state vocabulary, the 30 s ready bound (CHAT-PLAN-001 to CHAT-PLAN-015, CHAT-SRC-001 to CHAT-SRC-009, CHAT-HEALTH-002 to CHAT-HEALTH-011).
- The YouTube source: settings, video value, lookup, stream and polling, history, errors, mapping, quota (CHAT-YT-001 to CHAT-YT-067).
- Platform, `userId` and `messageId` on `chat.message`, and `chat.removed` from Twitch and YouTube (CHAT-TW-013 to CHAT-TW-018, CHAT-FILT-012 to CHAT-FILT-014, CHAT-FORGET-001 to CHAT-FORGET-008).
- Chat safety: bounded message text and name, the login and `unknown` name fallback, the mention test on bounded text, and the same bound for injected chat (CHAT-FILT-004, CHAT-FILT-005, CHAT-FILT-007 to CHAT-FILT-009, CHAT-FILT-011, CHAT-INJ-004, CHAT-INJ-005, CHAT-INJ-007, CHAT-INJ-011, CHAT-INJ-012).

### Nice to Have
None.
