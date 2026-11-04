# chat specs

Segment `chat` (prefix `CHAT`). Mapped 2026-10-31 at git `686cc8f`; verified against the code in the audit pass of 2026-11-01. Owner decisions of 2026-11-01 applied at git `1b57790`. LLD: [chat-design.md](chat-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred.

## Source selection

- [x] **CHAT-PLAN-001**: Where `chat.source` is `fake`, the chat service shall publish scripted or stdin chat and shall not attempt any IRC connection regardless of `chat.twitch.channel`. <!-- test: services/chat/test/fake.test.ts:64 --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-PLAN-002**: Where `chat.source` is `twitch` and `chat.twitch.channel` is non-empty after normalisation, the chat service shall connect to Twitch IRC and join that channel. <!-- test: services/chat/test/fake.test.ts:64 -->
- [x] **CHAT-PLAN-003**: If `chat.source` is `twitch` and `chat.twitch.channel` is empty, the chat service shall stay running, log an error at startup and every 60 seconds, publish no `chat.message` from Twitch, and not exit. <!-- test: services/chat/test/fake.test.ts:64 --> <!-- openspec: chat § Channel configuration -->
- [x] **CHAT-PLAN-004**: The chat service shall normalise the configured channel by removing one leading `#` and lowercasing it. <!-- test: services/chat/test/filter.test.ts:12 --> <!-- openspec: chat § Channel configuration -->
- [x] **CHAT-PLAN-005**: Where the plan is `fake` or `idle`, the chat service shall not load `@twurple/chat` or `@twurple/auth` (both are loaded by dynamic import only on the Twitch path).
- [x] **CHAT-PLAN-006**: When the process receives a shutdown signal, the chat service shall stop its source (fake source, idle timer or Twitch client) and stop the bus.

## Twitch connection

- [x] **CHAT-TW-001**: Unless `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_ACCESS_TOKEN` are all set, the chat service shall connect to Twitch anonymously (read-only) without creating an auth provider. <!-- openspec: chat § Authentication -->
- [x] **CHAT-TW-002**: Where `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_ACCESS_TOKEN` are all set, the chat service shall authenticate with a `RefreshingAuthProvider` holding the access token (and `TWITCH_REFRESH_TOKEN` when set) for intent `chat`. <!-- openspec: chat § Authentication -->
- [x] **CHAT-TW-003**: When the Twitch auth provider refreshes a token, the chat service shall write an info log containing `expiresIn`. <!-- openspec: chat § Authentication -->
- [x] **CHAT-TW-004**: When the Twitch client connects, the chat service shall mark Twitch connected, signal heartbeat `ready`, and log the channel and whether it is authenticated. <!-- openspec: chat § Connection lifecycle -->
- [x] **CHAT-TW-005**: When the Twitch client disconnects, the chat service shall mark Twitch disconnected and log a warning with `manually` and `reason`. <!-- openspec: chat § Connection lifecycle -->
- [x] **CHAT-TW-006**: When authenticating with a user token, the chat service shall finish registering the token with the auth provider (and surface a failure) before the chat client first requests credentials. <!-- test: services/chat/test/twitch.test.ts:32 -->
- [x] **CHAT-TW-007**: If publishing a `chat.message` for a Twitch message fails, the chat service shall log the failure and keep handling later messages. <!-- test: services/chat/test/twitch.test.ts:12 -->
- [x] **CHAT-TW-008**: When a message arrives in the joined Twitch channel, the chat service shall pass the sender's login, the message text and the sender's user info through the chat filter and publish the resulting `chat.message`, if the filter returns one. Untested.
- [x] **CHAT-TW-009**: When the Twitch IRC connection drops without a manual quit, the chat service shall rely on the `@twurple/chat` client's built-in reconnect (the `ircv3` `reconnect` option left at its default `true`) and, when the client connects again, shall mark Twitch connected and signal heartbeat `ready` again (CHAT-TW-004). Untested.

## Filtering and payload

- [x] **CHAT-FILT-001**: When the sender's name matches an entry of `chat.ignore_users` in any letter case, the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts:25 --> <!-- openspec: chat § Message filtering -->
- [x] **CHAT-FILT-002**: When the message text starts with any entry of `chat.ignore_prefixes`, the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts:25 --> <!-- openspec: chat § Message filtering -->
- [x] **CHAT-FILT-003**: The chat service shall trim leading and trailing whitespace from the message text before matching `chat.ignore_prefixes`, so a line with leading whitespace before a prefix (such as `" !cmd"`) is dropped as a command. <!-- test: services/chat/test/filter.test.ts:34 -->
- [x] **CHAT-FILT-004**: When a message is empty after collapsing whitespace, the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts:25 --> <!-- openspec: chat § Message filtering -->
- [x] **CHAT-FILT-005**: The chat service shall publish `chat.message` with whitespace runs collapsed to single spaces, trimmed, `platform` `twitch`, `user` the display name (falling back to the login), `userId`, and `isSub` from the subscriber flag. <!-- test: services/chat/test/filter.test.ts:18,41 --> <!-- openspec: chat § chat.message payload -->
- [x] **CHAT-FILT-006**: When the sender is a moderator or the broadcaster, the chat service shall set `isMod` to true. <!-- test: services/chat/test/filter.test.ts:41 --> <!-- openspec: chat § chat.message payload -->
- [x] **CHAT-FILT-007**: When the cleaned text contains `cohost.name` as a case-insensitive substring (not necessarily a whole word, so `cocoa` and `@coco_fan` both mention `Coco`), the chat service shall set `mentionsCohost` to true. <!-- test: services/chat/test/filter.test.ts:34 --> <!-- openspec: chat § chat.message payload -->

## Fake source

- [x] **CHAT-FAKE-001**: Where the plan is `fake` and stdin is not a TTY, the chat service shall publish the next line of a built-in script every `chat.fake.interval_ms` (default 8000) from a synthetic viewer name. <!-- test: services/chat/test/fake.test.ts:23 --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-002**: When a fake-source line arrives on stdin, the chat service shall publish it as a message from `fake_viewer1`. <!-- test: services/chat/test/fake.test.ts:42 --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-003**: The chat service shall pass every fake-source message through the normal chat filter, so ignored users, ignored prefixes and blank lines are dropped. <!-- test: services/chat/test/fake.test.ts:23,42 --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-004**: Where stdin is a TTY, the fake source shall not run the built-in script and shall publish only typed lines. <!-- test: services/chat/test/fake.test.ts:52 -->
- [x] **CHAT-FAKE-005**: While at least one stdin line has been received, the fake source shall stop publishing the built-in script. <!-- untested; services/chat/src/fake.ts:57 -->
- [x] **CHAT-FAKE-006**: If publishing a fake-source message fails, the chat service shall log a warning and continue. <!-- untested; services/chat/src/fake.ts:43, services/chat/src/index.ts:46 -->

## Test injection

- [x] **CHAT-INJ-001**: The chat service shall subscribe with consumer group `chat` to `inject.request` in every plan (`twitch`, `fake` and `idle`), without needing a channel or connection. <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-002**: When an `inject.request` targets a service other than `chat`, the chat service shall ignore it and publish nothing. <!-- test: services/chat/test/inject.test.ts:68 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-003**: If an `inject.request` envelope is more than 60 seconds old when handled, the chat service shall publish `inject.result {ok:false, detail:"stale"}` and nothing else. <!-- test: services/chat/test/inject.test.ts:60 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-004**: If an `inject.request` for chat has a kind other than `text`, or its text is blank after whitespace collapse, the chat service shall publish `inject.result {ok:false}` with a detail and no `chat.message`. <!-- test: services/chat/test/inject.test.ts:52,68 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-005**: When a valid text `inject.request` for chat arrives, the chat service shall publish `chat.message` with `injected: true`, `remember` from the request, whitespace-collapsed text, `user` from `meta.user` or `injected_viewer`, `platform` from `meta.platform` or `twitch`, `isMod`/`isSub` from `meta` (default false) and no `userId`, then publish `inject.result {ok:true}`. <!-- test: services/chat/test/inject.test.ts:16,24,44 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-006**: The chat service shall not apply `chat.ignore_users` or `chat.ignore_prefixes` to injected messages. <!-- test: services/chat/test/inject.test.ts:36 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-007**: When an injected message contains `cohost.name` case-insensitively, the chat service shall set `mentionsCohost` true. <!-- test: services/chat/test/inject.test.ts:44 --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-008**: If publishing the injected `chat.message` fails, the chat service shall publish `inject.result {ok:false, detail}` when the bus can still answer, and otherwise swallow the error. <!-- test: services/chat/test/inject.test.ts:77 -->
- [x] **CHAT-INJ-009**: The chat service shall subscribe its `inject.request` consumer group `chat` with start mode `latest`, so the group is reset to the newest entry on every start and no request published while chat was down is handled. <!-- test: services/chat/test/twitch.test.ts:53 -->

## Health

- [x] **CHAT-HEALTH-001**: The chat service shall publish a heartbeat with `service: "chat"` via `startHeartbeat` from boot, including a `stopping` heartbeat on graceful shutdown. <!-- test: services/chat/test/health.test.ts:7 --> <!-- openspec: chat § Heartbeat -->
- [x] **CHAT-HEALTH-002**: Where `chat.source` is `fake`, the chat service shall report `mode: "mock"` and `deps.twitch: "n/a"` and signal `ready` immediately after the source starts. <!-- test: services/chat/test/health.test.ts:31 --> <!-- openspec: chat § Isolation preset and mode -->
- [x] **CHAT-HEALTH-003**: Where `chat.source` is `twitch`, the chat service shall report `mode: "live"` and `deps.twitch` `ok` only while a channel is configured and the IRC client is connected, otherwise `down`. <!-- test: services/chat/test/health.test.ts:7,16 --> <!-- openspec: chat § Heartbeat -->
- [x] **CHAT-HEALTH-004**: While the chat service has signalled ready and the Twitch connection is down, its heartbeat state shall be `degraded`. <!-- test: services/chat/test/health.test.ts:16 -->
- [x] **CHAT-HEALTH-005**: In the idle plan (no channel), the chat service shall publish a `degraded` heartbeat with detail `TWITCH_CHANNEL is not set`. <!-- test: services/chat/test/health.test.ts:23 --> <!-- openspec: chat § Heartbeat -->
- [x] **CHAT-HEALTH-006**: Where `chat.source` is `twitch` and no Twitch channel is configured, the chat service shall report `mode: "live"` and `deps.twitch: "down"`. <!-- test: services/chat/test/health.test.ts:23 --> <!-- openspec: chat § Heartbeat (add-service-health said off / n/a; add-isolated-backends design D6 chose twitch down) -->
