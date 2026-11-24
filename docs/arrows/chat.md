# Arrow: chat

Chat sense: a list of sources (Twitch IRC, YouTube live chat, a fake source) in, filtered `chat.message` and `chat.removed` events out, plus service-level test injection and a heartbeat.

## Status

Built: the source list `chat.sources` and its plan (`sourcePlan`: runnable or gap, with reasons), the `ChatSource` contract and its five-state vocabulary, several sources running at once with per-source state, the 30 s ready bound, per-source health (`mock`, `off`, `live`), the Twitch source (channel and credentials from `chat.twitch.*` and `secrets.yaml`), the fake source as a `ChatSource` (two platform shapes), test injection, the bounded chat sense, and `parseVideoValue` in `@cohost/shared` (the YouTube video value parser). Also built (#178): the Twitch path carries message id and user id to `chat.message` (`ChatSender` and the filter in `filter.ts`). The Twitch handlers for message removal, ban, timeout and clear (`twitch.ts`) are built and tested against the client library, and the service publishes them as `chat.removed`; CHAT-TW-014 to CHAT-TW-017 stay `[ ]` until the live check on #330 settles that Twitch sends them to an anonymous client. Also built (#179): the YouTube reader. `youtube-transport.ts` makes the API calls (REST `videos.list` and `liveChatMessages.list` through `fetch` to `www.googleapis.com`; `StreamList` through `@grpc/grpc-js` with the vendored `services/chat/proto/stream_list.proto` to `youtube.googleapis.com:443`, key as `x-goog-api-key` metadata). `youtube-map.ts` maps each API item to a sender and text, a removal, a notice or nothing. `youtube.ts` is the state machine: lookup and its six states, stream with the start-only polling fallback, polling with the floor, the error table, quota tally and hourly re-lookup, history and duplicate rules, the 60 s rule after a break, and removal markers. The YouTube sender builder lists display name, channel id and `youtube:<channelId>` as ignore identifiers (CHAT-FILT-013). Consumers of `chat.removed` (forgetting) arrive with #180–#183. Total 161 specs: 155 `[x]`, 6 `[ ]`, 0 `[D]`.

**PARTIAL**: 161 specs: 155 implemented, 0 deferred, 6 gaps (the Twitch removals CHAT-TW-014 to 017 held for the live check, #330; the open source-contract line CHAT-SRC-001; CHAT-HEALTH-011 (a quiet YouTube chat keeps `reading`, now testable with the reader, not yet live-checked)).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (161 specs: 155 `[x]`, 6 `[ ]`, 0 `[D]`; prefix `CHAT`; facets `PLAN`, `SRC`, `TW`, `FILT`, `FAKE`, `INJ`, `HEALTH`, `YT` and `FORGET`)

### Tests
Files with `@spec CHAT-` annotations:
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts
- services/chat/test/plan.test.ts
- services/chat/test/service.test.ts
- services/chat/test/sources.test.ts
- services/chat/test/twitch.test.ts
- services/chat/test/youtube.test.ts, youtube-map.test.ts, youtube-transport.test.ts (the YouTube source, mapper and transport)
- packages/shared/test/youtube-video.test.ts (CHAT-YT-004 to CHAT-YT-006 through `parseVideoValue`)

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
- services/chat/src/plan.ts
- services/chat/src/source.ts
- services/chat/src/youtube.ts
- services/chat/src/youtube-map.ts
- services/chat/src/youtube-transport.ts
- packages/shared/src/video.ts (`parseVideoValue`)

Also: services/chat/package.json, services/chat/tsconfig.json. `subscribeInject` lives in packages/shared/src/inject.ts.

## Architecture

**Purpose:** Turn Twitch chat, YouTube live chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, report platform removals as `chat.removed`, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts`: hands `chatService` to the shared `runService` bootstrap.
   `service.ts`: `chatService`: computes the plan (`plan.ts`), starts each runnable source behind the `ChatSource` contract, tracks each listed source's state for the heartbeat, signals `ready` once every listed source has a first outcome or at 30 s (injected clock), runs the idle plan when every listed source is a gap, and stops every built source on shutdown. Establishes the `inject.request` subscription (`subscribeInject` from `@cohost/shared`) before any source starts. Tested by `service.test.ts` and `sources.test.ts` through injected dependencies.
2. `filter.ts`: pure `createChatFilter(cfg, platform)`, `channelName`; ignore lists, whitespace cleanup, mention flag, payload shape. `plan.ts`: pure `sourcePlan`, the one place the YouTube settings are checked (api key, video through `parseVideoValue`).
2a. the YouTube reader: `youtube.ts` (state machine), `youtube-transport.ts` (the one API surface, `lookup`, `openStream`, `poll`; REST and gRPC), `youtube-map.ts` (pure item mapping). The proto header records its source and licence (CC0-1.0 upstream copy).
3. `fake.ts`: `FakeSource`, a `ChatSource`: stdin lines or a cycled 6-line script through the same filter; `fake_viewer2` is on `youtube`, the rest on `twitch`.
4. `twitch.ts`: `createMessageHandler` (filter, publish, log a failed publish) and `registerUserToken` (awaited token registration) for the Twitch path.
5. `token-store.ts`: persists and reloads the refreshed Twitch token (`<dataDir()>/chat/twitch-token.json`).
6. `inject.ts`: `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
7. `health.ts`: `chatHealth(listed, states)` heartbeat spec: mode `off`/`mock`/`live` fixed by the listed sources; `twitch` and `youtube` dependencies `ok` only while that source is `reading`, `n/a` when not listed.

Depends on `event-bus`, `config`, `control-plane` (heartbeat), `shared-runtime`. Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Source selection | CHAT-PLAN-001 to CHAT-PLAN-015 | 15 | 0 | 0 | 15 |
| Source contract | CHAT-SRC-001 to CHAT-SRC-009 | 8 | 0 | 1 | 8 |
| Twitch connection | CHAT-TW-001 to CHAT-TW-018 | 14 | 0 | 4 | 18 |
| Filtering and payload | CHAT-FILT-001 to CHAT-FILT-014 (CHAT-FILT-010 no longer exists) | 13 | 0 | 0 | 13 |
| Fake source | CHAT-FAKE-001 to CHAT-FAKE-009 | 9 | 0 | 0 | 9 |
| Test injection | CHAT-INJ-001, CHAT-INJ-004 to CHAT-INJ-012, CHAT-INJ-014 (CHAT-INJ-013 no longer exists) | 11 | 0 | 0 | 11 |
| Health | CHAT-HEALTH-001 to CHAT-HEALTH-012 | 11 | 0 | 1 | 12 |
| YouTube source | CHAT-YT-001 to CHAT-YT-068 (CHAT-YT-024 and 025 dropped) | 66 | 0 | 0 | 66 |
| Forgetting a removed message | CHAT-FORGET-001 to CHAT-FORGET-008 | 8 | 0 | 0 | 8 |

**Summary:** 155 of 161 specs implemented; 0 deferred; 6 open. CHAT-TW-014 to CHAT-TW-017 are held for the live check on #330 (the Twitch removal events reaching an anonymous client are unverified live). CHAT-SRC-001 (the five states are typed in `source.ts`; the first issue that drives all five from real sources owns the flip). CHAT-HEALTH-011 (a quiet YouTube chat keeps `reading`) needs a live check of the YouTube reader. The YouTube reader's unverified fields (`superChatDetails.userComment`, `messageDeletedDetails.deletedMessageId`, `userBannedDetails.bannedUserDetails.channelId`, `banType`, `publishedAt` presence, stream batching) are checked live in the #179 manual check. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **CHAT-HEALTH-006 is implemented.** `chatHealth` reports `twitch` down when the channel is not set, and `live` mode when `fake` is not listed (`services/chat/src/health.ts`).
2. **CHAT-TW-008** covers the Twitch `onMessage` to filter to publish path (`createMessageHandler`, `services/chat/src/twitch.ts`); the Twitch source (`TwitchSource`) emits each line through the same handler.
3. **Auth registration is awaited.** `registerUserToken` (`twitch.ts`) finishes `addUserForToken` before the client is built. A missing refresh token rejects the Twitch start (CHAT-TW-010): only the Twitch source stops, with the error as its reason, and the process keeps running. A refreshed token is persisted and the refresh is logged.
4. **A failed publish on the live path is logged and the next message is handled** (CHAT-TW-007, CHAT-SRC-008). The `inject.request` subscription is created before any plan runs, with start mode `latest` (CHAT-INJ-009, CHAT-PLAN-015).
5. **Reconnect is the library default.** `TwitchSource` reports `retrying` on disconnect and `reading` on connect; a change to a ready service publishes at once (CHAT-TW-009, `sources.test.ts`).
6. **Filter.** Substring mention match is deliberate (`services/chat/test/filter.test.ts`); `ignore_prefixes` is matched against the bounded text (CHAT-FILT-003). The filter matches `ignore_users` against every identifier the source supplies (`ChatSender.ignoreIdentifiers`: a Twitch login, a YouTube display name, channel id and `youtube:<channelId>`; CHAT-FILT-012, CHAT-FILT-013).
7. **Credentials serve a deferred goal.** The credential path is kept for typing in chat later (`chat-design.md`, Decisions: anonymous vs authenticated IRC); nothing calls `say` and the scope is read-only `["chat"]`. The path stays.

## Work Required

### Must Fix
- CHAT-SRC-001 (the five states driven from real sources) and the quiet-chat health line (CHAT-HEALTH-011): live checks of the YouTube reader (#179 manual list).
- CHAT-TW-014 to CHAT-TW-017: the Twitch removal events to an anonymous client (#330).

### Nice to Have
None.
