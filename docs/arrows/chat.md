# Arrow: chat

Chat sense: a list of sources (Twitch IRC, YouTube live chat, a fake source) in, filtered `chat.message` and `chat.removed` events out, plus service-level test injection and a heartbeat.

## Status

Built: the source list `chat.sources` and its plan (`sourcePlan`: runnable or gap, with reasons), the `ChatSource` contract and its five-state vocabulary, several sources running at once with per-source state, the 30 s ready bound, per-source health (`mock`, `off`, `live`), the Twitch source (channel and credentials from `chat.twitch.*` and `secrets.yaml`), the fake source as a `ChatSource` (two platform shapes), test injection, the bounded chat sense, and `parseVideoValue` in `@cohost/shared` (the YouTube video value parser). Also built (#178): the Twitch path carries message id and user id to `chat.message` (`ChatSender` and the filter in `filter.ts`). The Twitch handlers for message removal, ban, timeout and clear (`twitch.ts`) are built and tested against the client library, and the service publishes them as `chat.removed`; CHAT-TW-014 to CHAT-TW-017 stay `[ ]` until the live check on #239 settles that Twitch sends them to an anonymous client. Specified and not built: the YouTube reader (a placeholder source that fails at start with `not in this build yet`, until #179), the YouTube removals (CHAT-FORGET-002 to 005) and the YouTube identifier list (CHAT-FILT-013), all #179. Consumers of `chat.removed` (forgetting) arrive with #180–#183. Total 163 specs: 87 `[x]`, 76 `[ ]`, 0 `[D]`.

**PARTIAL**: 163 specs: 87 implemented, 0 deferred, 76 gaps (YouTube chat and its removals and identifiers, #179; the Twitch removals held for the live check, #239; the open source-contract lines, below).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (163 specs: 87 `[x]`, 76 `[ ]`, 0 `[D]`; prefix `CHAT`; facets `PLAN`, `SRC`, `TW`, `FILT`, `FAKE`, `INJ`, `HEALTH`, `YT` and `FORGET`)

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
- packages/shared/src/video.ts (`parseVideoValue`)

Also: services/chat/package.json, services/chat/tsconfig.json. `subscribeInject` lives in packages/shared/src/inject.ts.

## Architecture

**Purpose:** Turn Twitch chat, YouTube live chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, report platform removals as `chat.removed`, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts`: hands `chatService` to the shared `runService` bootstrap.
   `service.ts`: `chatService`: computes the plan (`plan.ts`), starts each runnable source behind the `ChatSource` contract, tracks each listed source's state for the heartbeat, signals `ready` once every listed source has a first outcome or at 30 s (injected clock), runs the idle plan when every listed source is a gap, and stops every built source on shutdown. Establishes the `inject.request` subscription (`subscribeInject` from `@cohost/shared`) before any source starts. Tested by `service.test.ts` and `sources.test.ts` through injected dependencies.
2. `filter.ts`: pure `createChatFilter(cfg, platform)`, `channelName`; ignore lists, whitespace cleanup, mention flag, payload shape. `plan.ts`: pure `sourcePlan`, the one place the YouTube settings are checked (api key, video through `parseVideoValue`).
2a. (designed, not built) the YouTube reader: `youtube-map.ts` and the YouTube transport module. `youtube.ts` is the placeholder source until then.
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
| Source contract | CHAT-SRC-001 to CHAT-SRC-009 | 7 | 0 | 2 | 8 |
| Twitch connection | CHAT-TW-001 to CHAT-TW-018 | 8 | 0 | 10 | 12 |
| Filtering and payload | CHAT-FILT-001 to CHAT-FILT-014 (CHAT-FILT-010 no longer exists) | 8 | 0 | 5 | 10 |
| Fake source | CHAT-FAKE-001 to CHAT-FAKE-009 | 9 | 0 | 0 | 9 |
| Test injection | CHAT-INJ-001, CHAT-INJ-004 to CHAT-INJ-012, CHAT-INJ-014 (CHAT-INJ-013 no longer exists) | 11 | 0 | 0 | 11 |
| Health | CHAT-HEALTH-001 to CHAT-HEALTH-012 | 11 | 0 | 1 | 12 |
| YouTube source | CHAT-YT-001 to CHAT-YT-068 | 4 | 0 | 64 | 4 |
| Forgetting a removed message | CHAT-FORGET-001 to CHAT-FORGET-008 | 0 | 0 | 8 | 0 |

**Summary:** 87 of 163 specs implemented; 0 deferred; 76 open. CHAT-TW-014 to CHAT-TW-017 are held for the live check on #239, and CHAT-FILT-013 for #179. Open and not yet provable here (the Twitch removal events reaching an anonymous client are unverified live, #239 manual list): CHAT-SRC-001 (the five states are typed in `source.ts`; not in #177's list, and the first issue that drives all five states from real sources owns the flip, #179), CHAT-SRC-005 (per-source stop cancels every timer and call: the fake proves it, the Twitch stop guard covers the start path, the YouTube reader is #179), CHAT-HEALTH-011 (a quiet YouTube chat keeps `reading`: needs the reader, #179). CHAT-YT-003..006 are implemented in the plan and the parser, not in a YouTube reader. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **CHAT-HEALTH-006 is implemented.** `chatHealth` reports `twitch` down when the channel is not set, and `live` mode when `fake` is not listed (`services/chat/src/health.ts`).
2. **CHAT-TW-008** covers the Twitch `onMessage` to filter to publish path (`createMessageHandler`, `services/chat/src/twitch.ts`); the Twitch source (`TwitchSource`) emits each line through the same handler.
3. **Auth registration is awaited.** `registerUserToken` (`twitch.ts`) finishes `addUserForToken` before the client is built. A missing refresh token rejects the Twitch start (CHAT-TW-010): only the Twitch source stops, with the error as its reason, and the process keeps running. A refreshed token is persisted and the refresh is logged.
4. **A failed publish on the live path is logged and the next message is handled** (CHAT-TW-007, CHAT-SRC-008). The `inject.request` subscription is created before any plan runs, with start mode `latest` (CHAT-INJ-009, CHAT-PLAN-015).
5. **Reconnect is the library default.** `TwitchSource` reports `retrying` on disconnect and `reading` on connect; a change to a ready service publishes at once (CHAT-TW-009, `sources.test.ts`).
6. **Filter.** Substring mention match is deliberate (`services/chat/test/filter.test.ts`); `ignore_prefixes` is matched against the bounded text (CHAT-FILT-003). The shipped filter still matches `ignore_users` against the login only (CHAT-FILT-012, CHAT-FILT-013).
7. **Credentials serve a deferred goal.** The credential path is kept for typing in chat later (`chat-design.md`, Decisions: anonymous vs authenticated IRC); nothing calls `say` and the scope is read-only `["chat"]`. The path stays.

## Work Required

### Must Fix
- The source contract's open lines (CHAT-SRC-001, CHAT-SRC-005) and the quiet-chat health line (CHAT-HEALTH-011), which need the YouTube reader (#179) and the Twitch wrapper's stop guarantee.
- The YouTube source: API key and settings (CHAT-YT-001, CHAT-YT-002), lookup, stream and polling, history, errors, mapping, quota (CHAT-YT-007 to CHAT-YT-068).
- Platform, `userId` and `messageId` on `chat.message`, and `chat.removed` from Twitch and YouTube (CHAT-TW-013 to CHAT-TW-018, CHAT-FILT-012 to CHAT-FILT-014, CHAT-FORGET-001 to CHAT-FORGET-008).

### Nice to Have
None.
