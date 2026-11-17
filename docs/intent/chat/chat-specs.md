# chat specs

Segment `chat` (prefix `CHAT`). LLD: [chat-design.md](chat-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred. A `<!-- test: ... -->` pointer names the test file; paths are relative to the repo root.

## Source selection

- [ ] **CHAT-PLAN-001**: Where `chat.sources` lists `fake`, the chat service shall publish scripted or stdin chat from the fake source, and where `fake` is the only listed source it shall attempt no IRC and no YouTube connection regardless of `chat.twitch.channel` and `chat.youtube.video`. <!-- test: services/chat/test/fake.test.ts --> <!-- openspec: chat § Fake source -->
- [ ] **CHAT-PLAN-002**: Where `chat.sources` lists `twitch` and `chat.twitch.channel` is non-empty after normalisation, the chat service shall connect to Twitch IRC and join that channel. <!-- test: services/chat/test/fake.test.ts -->
- [ ] **CHAT-PLAN-003**: If every source listed in `chat.sources` is a configuration gap, then the chat service shall stay running, publish no `chat.message`, not exit, and run the shared idle plan of kind `degraded` (SHARED-IDLE-002, SHARED-IDLE-003) with the gap reasons of the sources, in the order `chat.sources` lists them, joined by `; `: one error at startup naming each reason, then a `still idle` warning first after 60 seconds and then at doubling delays capped at one hour (SHARED-IDLE-006). <!-- test: services/chat/test/service.test.ts -->
- [x] **CHAT-PLAN-004**: The chat service shall normalise the configured channel by removing one leading `#` and lowercasing it. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § Channel configuration -->
- [ ] **CHAT-PLAN-005**: The chat service shall load `@twurple/chat` and `@twurple/auth` by dynamic import only when the `twitch` source runs, and `@grpc/grpc-js` only when the `youtube` source reads by stream. <!-- test: services/chat/test/service.test.ts -->
- [ ] **CHAT-PLAN-006**: When the process receives a shutdown signal, the chat service shall stop every source it started, and the idle plan, through the bootstrap's `onStop` steps (SHARED-BOOT-005) and stop the bus.
- [ ] **CHAT-PLAN-007**: Where `chat.sources` is absent or null, the chat service shall use the list `[twitch]`.
- [ ] **CHAT-PLAN-008**: Where `chat.sources` is an empty list, the chat service shall start no source and publish no `chat.message`, shall stay running with the heartbeat `ready` once the `inject.request` subscription exists, in mode `off`, with every source dependency `n/a`, and shall log nothing at warn level or above.
- [ ] **CHAT-PLAN-009**: When a source name appears more than once in `chat.sources`, the chat service shall start that source once.
- [ ] **CHAT-PLAN-010**: When one listed source is a configuration gap and another is runnable, the chat service shall start the runnable source, log one error naming the gap source's reason, and leave the gap source `stopped` with that reason.
- [ ] **CHAT-PLAN-011**: If a listed source's start rejects, then the chat service shall make that source `stopped` with the rejection's message as its reason, keep the process running and leave every other source unaffected.
- [ ] **CHAT-PLAN-012**: Where `chat.sources` lists `youtube` and `chat.youtube.api_key` is empty, the YouTube source shall be a configuration gap whose reason includes `chat.youtube.api_key is not set`; when the reason of CHAT-PLAN-013 or CHAT-PLAN-014 applies too, the source shall give all the reasons in the order api key, then video, joined by `; `.
- [ ] **CHAT-PLAN-013**: Where `chat.sources` lists `youtube` and `chat.youtube.video` is empty, the YouTube source shall be a configuration gap whose reason includes `chat.youtube.video is not set`, given after the api key reason of CHAT-PLAN-012 when both apply, joined by `; `.
- [ ] **CHAT-PLAN-014**: Where `chat.sources` lists `youtube` and `chat.youtube.video` is not a video id or a URL of an accepted form, the YouTube source shall be a configuration gap whose reason includes `chat.youtube.video is not a YouTube video URL or id` (given after the api key reason of CHAT-PLAN-012 when both apply, joined by `; `), and the config load shall not fail.
- [ ] **CHAT-PLAN-015**: When the chat service starts, it shall establish the `inject.request` subscription before it starts any source.

## Source contract

- [ ] **CHAT-SRC-001**: A chat source shall report exactly one of the states `starting`, `waiting`, `reading`, `retrying` and `stopped`.
- [ ] **CHAT-SRC-002**: The chat service shall treat the first time a source reports any state other than `starting`, a failure included, as that source's first outcome.
- [ ] **CHAT-SRC-003**: When every source listed in `chat.sources` has had a first outcome, or 30 seconds after the chat service starts, whichever comes first, the chat service shall signal heartbeat `ready`.
- [ ] **CHAT-SRC-004**: While a listed source has had no first outcome after the chat service has signalled `ready`, the chat service shall report that source's dependency `down`.
- [ ] **CHAT-SRC-005**: When a source's `stop` is called, the source shall cancel every timer, in-flight request and open call it holds.
- [ ] **CHAT-SRC-006**: After a source's `stop` has returned, the source shall publish no `chat.message` and no `chat.removed`.
- [ ] **CHAT-SRC-007**: When any source reads a message, the chat service shall hand it to the one chat filter together with that source's platform.
- [ ] **CHAT-SRC-008**: If publishing a `chat.message` or a `chat.removed` for any source fails, then the chat service shall log a warning and keep handling later messages.
- [ ] **CHAT-SRC-009**: While a source is in the state `waiting`, `retrying` or `stopped`, the chat service shall report that source's heartbeat dependency `down`; while it is `reading`, `ok`.

## Twitch connection

- [x] **CHAT-TW-001**: Unless `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.twitch.access_token` are all set, the chat service shall connect to Twitch anonymously (read-only) without creating an auth provider. <!-- test: services/chat/test/service.test.ts --> <!-- openspec: chat § Authentication -->
- [x] **CHAT-TW-002**: Where `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.twitch.access_token` are all set, the chat service shall authenticate with a `RefreshingAuthProvider` holding the access token and `chat.twitch.refresh_token` for intent `chat`. <!-- test: services/chat/test/service.test.ts --> <!-- openspec: chat § Authentication -->
- [x] **CHAT-TW-003**: When the Twitch auth provider refreshes a token, the chat service shall write an info log containing `expiresIn` and persist the refreshed token (CHAT-TW-011). <!-- openspec: chat § Authentication -->
- [ ] **CHAT-TW-004**: When the Twitch client connects, the chat service shall set the `twitch` source to `reading` and log the channel and whether it is authenticated. <!-- openspec: chat § Connection lifecycle -->
- [ ] **CHAT-TW-005**: When the Twitch client disconnects, the chat service shall set the `twitch` source to `retrying` and log a warning with `manually` and `reason`. <!-- test: services/chat/test/service.test.ts --> <!-- openspec: chat § Connection lifecycle -->
- [x] **CHAT-TW-006**: When authenticating with a user token, the chat service shall finish registering the token with the auth provider (and surface a failure) before the chat client first requests credentials. <!-- test: services/chat/test/twitch.test.ts -->
- [x] **CHAT-TW-007**: If publishing a `chat.message` for a Twitch message fails, the chat service shall log the failure and keep handling later messages. <!-- test: services/chat/test/twitch.test.ts -->
- [x] **CHAT-TW-008**: When a message arrives in the joined Twitch channel, the chat service shall pass the sender's login, the message text and the sender's user info through the chat filter and publish the resulting `chat.message`, if the filter returns one. <!-- test: services/chat/test/service.test.ts -->
- [ ] **CHAT-TW-009**: When the Twitch IRC connection drops without a manual quit, the chat service shall rely on the `@twurple/chat` client's built-in reconnect (the `ircv3` `reconnect` option left at its default `true`) and, when the client connects again, shall set the `twitch` source to `reading` again. <!-- test: services/chat/test/service.test.ts -->
- [ ] **CHAT-TW-010**: If `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.twitch.access_token` are all set and `chat.twitch.refresh_token` is unset or blank, then the chat service shall make the `twitch` source's start reject with an error that names `chat.twitch.refresh_token`, before registering any token with the auth provider, so that the source is `stopped` with that error as its reason (CHAT-PLAN-011) and the process does not exit. <!-- test: services/chat/test/twitch.test.ts -->
- [x] **CHAT-TW-011**: When the Twitch auth provider refreshes a token, the chat service shall write the refreshed access token, refresh token, `expiresIn`, `obtainmentTimestamp` and scopes to `<dataDir()>/chat/twitch-token.json` (atomically, readable by its owner only) together with the `chat.twitch.refresh_token` it started from, and shall log and otherwise ignore a failure to write. <!-- test: services/chat/test/service.test.ts -->
- [x] **CHAT-TW-012**: Where authenticating with a user token and `<dataDir()>/chat/twitch-token.json` holds a token whose recorded starting `chat.twitch.refresh_token` equals the current one, the chat service shall register that stored token instead of the `secrets.yaml` pair; a missing, unreadable, malformed or superseded file (the operator put a new `chat.twitch.refresh_token` in `secrets.yaml`) shall fall back to the `secrets.yaml` pair. <!-- test: services/chat/test/service.test.ts -->
- [ ] **CHAT-TW-013**: When a message arrives in the joined Twitch channel, the chat service shall pass the message id (`msg.id`) and the sender's user id to the chat filter, so that the published `chat.message` carries `messageId` and `userId`.
- [ ] **CHAT-TW-014**: When the Twitch client reports a removed message (`onMessageRemove`), the chat service shall publish `chat.removed` with `platform` `twitch`, `scope` `message` and the removed message's id as `messageId`.
- [ ] **CHAT-TW-015**: When the Twitch client reports a ban (`onBan`) whose `targetUserId` is not null, the chat service shall publish `chat.removed` with `platform` `twitch`, `scope` `user`, that id as `userId` and `reason` `banned`.
- [ ] **CHAT-TW-016**: When the Twitch client reports a timeout (`onTimeout`) whose `targetUserId` is not null, the chat service shall publish `chat.removed` with `platform` `twitch`, `scope` `user`, that id as `userId` and `reason` `timeout`.
- [ ] **CHAT-TW-017**: When the Twitch client reports a cleared chat (`onChatClear`), the chat service shall publish `chat.removed` with `platform` `twitch`, `scope` `all` and `reason` `cleared`.
- [ ] **CHAT-TW-018**: If the Twitch client reports a ban or a timeout whose `targetUserId` is null, then the chat service shall publish no `chat.removed` and log a warning.

## Filtering and payload

- [ ] **CHAT-FILT-001**: When any identifier the source supplies for the sender, as CHAT-FILT-012 and CHAT-FILT-013 list them, matches an entry of `chat.ignore_users` in any letter case, the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § Message filtering -->
- [ ] **CHAT-FILT-002**: When the bounded message text (CHAT-FILT-008) starts with any entry of `chat.ignore_prefixes`, the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § Message filtering -->
- [ ] **CHAT-FILT-003**: The chat service shall match `chat.ignore_prefixes` against `boundText(text, viewer_text.max_chars)`, so a line with leading whitespace or invisible characters before a prefix (such as `" !cmd"`) is dropped as a command. <!-- test: services/chat/test/filter.test.ts -->
- [ ] **CHAT-FILT-004**: When a message is empty after `boundText` (the characters SHARED-GUARD-005 removes and white space gone), the chat service shall publish no `chat.message` for that line. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § Message filtering -->
- [ ] **CHAT-FILT-005**: The chat service shall publish `chat.message` with `platform` as the source gives it, `userId` and `messageId` as the source gives them, `isSub` and `isMod` as the source worked them out, and the bounded `text` (CHAT-FILT-008) and `user` (CHAT-FILT-009). <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § chat.message payload -->
- [x] **CHAT-FILT-006**: When the sender is a moderator or the broadcaster, the chat service shall set `isMod` to true. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § chat.message payload -->
- [ ] **CHAT-FILT-007**: When the bounded text (CHAT-FILT-008) contains `cohost.name` as a case-insensitive substring (not necessarily a whole word, so `cocoa` and `@coco_fan` both mention `Coco`), the chat service shall set `mentionsCohost` to true. <!-- test: services/chat/test/filter.test.ts --> <!-- openspec: chat § chat.message payload -->
- [ ] **CHAT-FILT-008**: When the chat filter accepts a message, it shall set `text` to `boundText(text, viewer_text.max_chars)`: the characters SHARED-GUARD-005 removes gone, whitespace runs collapsed to single spaces, trimmed, and cut with a trailing `…` when longer than the limit.
- [ ] **CHAT-FILT-009**: When the chat filter accepts a message, it shall set `user` to the first of `boundText(displayName, viewer_text.max_name_chars)` and `boundText(login, viewer_text.max_name_chars)` that is not empty, and to `unknown` when both are empty.
- [ ] **CHAT-FILT-010**: When the chat filter sets `mentionsCohost`, it shall test `cohost.name` against the bounded `text`, so that a name beyond the cut is not a mention.
- [ ] **CHAT-FILT-011**: The chat filter shall be the only code that computes `mentionsCohost`; a consumer of `chat.message` shall take the flag as the event carries it.
- [ ] **CHAT-FILT-012**: When the source is Twitch, the chat service shall match `chat.ignore_users` against the sender's login and display name.
- [ ] **CHAT-FILT-013**: When the source is YouTube, the chat service shall match `chat.ignore_users` against the author's display name, the bare channel id and the form `youtube:<channelId>`, in any letter case.
- [ ] **CHAT-FILT-014**: The chat service shall apply `chat.ignore_users` to a sender whatever the platform, so an entry that matches a Twitch login also drops a YouTube author with that display name.

## Fake source

- [ ] **CHAT-FAKE-001**: Where `chat.sources` lists `fake` and stdin is not a TTY, the chat service shall publish the next line of a built-in script every `chat.fake.interval_ms` (default 8000) from a synthetic viewer name. <!-- test: services/chat/test/fake.test.ts --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-002**: When a fake-source line arrives on stdin, the chat service shall publish it as a message from `fake_viewer1`. <!-- test: services/chat/test/fake.test.ts --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-003**: The chat service shall pass every fake-source message through the normal chat filter, so ignored users, ignored prefixes and blank lines are dropped. <!-- test: services/chat/test/fake.test.ts --> <!-- openspec: chat § Fake source -->
- [x] **CHAT-FAKE-004**: Where stdin is a TTY, the fake source shall not run the built-in script and shall publish only typed lines. <!-- test: services/chat/test/fake.test.ts -->
- [x] **CHAT-FAKE-005**: While at least one stdin line has been received, the fake source shall stop publishing the built-in script. <!-- test: services/chat/test/fake.test.ts -->
- [x] **CHAT-FAKE-006**: If publishing a fake-source message fails, the chat service shall log a warning and continue. <!-- test: services/chat/test/fake.test.ts --> <!-- test: services/chat/test/service.test.ts -->
- [ ] **CHAT-FAKE-007**: When the fake source publishes a line from `fake_viewer1` or `fake_viewer3`, the chat service shall publish it with `platform` `twitch` and a `userId` equal to the name.
- [ ] **CHAT-FAKE-008**: When the fake source publishes a line from `fake_viewer2`, the chat service shall publish it with `platform` `youtube` and the `userId` `fake_viewer2`.
- [ ] **CHAT-FAKE-009**: When the fake source starts, the chat service shall set the `fake` source to `reading` at once.

## Test injection

- [ ] **CHAT-INJ-001**: The chat service shall subscribe with consumer group `chat` to `inject.request` in every shape (sources running, `off` and the idle plan), without needing a channel, a key or a connection. <!-- test: services/chat/test/service.test.ts --> <!-- openspec: chat § Injected text messages -->
- [ ] **CHAT-INJ-004**: If an `inject.request` for chat has text that is blank after `boundText`, the chat service shall publish `inject.result {ok:false}` with a detail and no `chat.message`. (A kind other than `text` is SHARED-INJ-003.) <!-- test: services/chat/test/inject.test.ts --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-010**: The chat service shall handle `inject.request` through the shared inject handler (shared-runtime SHARED-INJ-*) with target `chat` and the single kind `text`. (CHAT-INJ-002 and 003 are retired, now SHARED-INJ-001 and SHARED-INJ-002; numbers not reused.) <!-- test: services/chat/test/inject.test.ts -->
- [ ] **CHAT-INJ-005**: When a valid text `inject.request` for chat arrives, the chat service shall publish `chat.message` with `injected: true`, `remember` from the request, `platform` from `meta.platform` or `twitch`, `isMod`/`isSub` from `meta` (default false) and no `userId`, then publish `inject.result {ok:true}`. <!-- test: services/chat/test/inject.test.ts --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-006**: The chat service shall not apply `chat.ignore_users` or `chat.ignore_prefixes` to injected messages. <!-- test: services/chat/test/inject.test.ts --> <!-- openspec: chat § Injected text messages -->
- [ ] **CHAT-INJ-007**: When an injected message's bounded text (CHAT-INJ-011) contains `cohost.name` case-insensitively, the chat service shall set `mentionsCohost` true. <!-- test: services/chat/test/inject.test.ts --> <!-- openspec: chat § Injected text messages -->
- [x] **CHAT-INJ-008**: If publishing the injected `chat.message` fails, the chat service shall publish `inject.result {ok:false, detail}` when the bus can still answer, and otherwise swallow the error. <!-- test: services/chat/test/inject.test.ts -->
- [x] **CHAT-INJ-009**: The chat service shall subscribe its `inject.request` consumer group `chat` with start mode `latest`, so the group is reset to the newest entry on every start and no request published while chat was down is handled. <!-- test: services/chat/test/twitch.test.ts -->
- [ ] **CHAT-INJ-011**: When a valid text `inject.request` for chat arrives, the chat service shall publish `chat.message` with `text` equal to `boundText(text, viewer_text.max_chars)`, the same bound the chat filter applies to real chat.
- [ ] **CHAT-INJ-012**: When a valid text `inject.request` for chat arrives, the chat service shall publish `chat.message` with `user` equal to `boundText(meta.user, viewer_text.max_name_chars)`, or `injected_viewer` when `meta.user` is absent or bounds to nothing.
- [ ] **CHAT-INJ-013**: When an injected message contains `cohost.name` case-insensitively after the length bound, the chat service shall set `mentionsCohost` true.
- [ ] **CHAT-INJ-014**: When a valid text `inject.request` for chat names `meta.platform` `youtube`, the chat service shall publish `chat.message` with `platform` `youtube` and no `userId` and no `messageId`, and shall contact no platform.

## Health

- [x] **CHAT-HEALTH-001**: The chat service shall publish a heartbeat with `service: "chat"` via `startHeartbeat` from boot, including a `stopping` heartbeat on graceful shutdown. <!-- test: services/chat/test/health.test.ts --> <!-- openspec: chat § Heartbeat -->
- [ ] **CHAT-HEALTH-002**: Where `chat.sources` lists `fake`, the chat service shall report `mode: "mock"` and shall signal `ready` according to CHAT-SRC-003, the fake source being `reading` at once. <!-- test: services/chat/test/health.test.ts --> <!-- openspec: chat § Isolation preset and mode -->
- [ ] **CHAT-HEALTH-003**: Where `chat.sources` lists `twitch`, the chat service shall report `deps.twitch` `ok` only while the `twitch` source is `reading`, otherwise `down`. <!-- test: services/chat/test/health.test.ts --> <!-- openspec: chat § Heartbeat -->
- [ ] **CHAT-HEALTH-004**: While the chat service has signalled ready and a listed source's dependency is `down`, its heartbeat state shall be `degraded`. <!-- test: services/chat/test/health.test.ts -->
- [ ] **CHAT-HEALTH-005**: In the idle plan (every listed source a gap), the chat service shall publish a `degraded` heartbeat whose detail is the gap reasons joined by `; ` (for a lone Twitch gap, `chat.twitch.channel is not set`). <!-- test: services/chat/test/health.test.ts --> <!-- openspec: chat § Heartbeat -->
- [ ] **CHAT-HEALTH-006**: Where `chat.sources` lists `twitch` and no Twitch channel is configured, the chat service shall report `deps.twitch` `down`, and mode `live` when `fake` is not listed. <!-- test: services/chat/test/health.test.ts --> <!-- openspec: chat § Heartbeat (add-service-health said off / n/a; add-isolated-backends design D6 chose twitch down) -->
- [ ] **CHAT-HEALTH-007**: Where `chat.sources` is empty, the chat service shall report `mode: "off"` with `deps.twitch` and `deps.youtube` `n/a`.
- [ ] **CHAT-HEALTH-008**: Where a source is not listed in `chat.sources`, the chat service shall report that source's dependency `n/a`.
- [ ] **CHAT-HEALTH-009**: Where `chat.sources` lists `youtube`, the chat service shall report `deps.youtube` `ok` only while the YouTube source is `reading`, otherwise `down`.
- [ ] **CHAT-HEALTH-010**: Where `chat.sources` is `[fake]`, the chat service shall report `deps.youtube` `n/a` and start no YouTube source.
- [ ] **CHAT-HEALTH-011**: While the chat service has signalled `ready` and a quiet YouTube chat sends no message, the chat service shall keep the YouTube source `reading` and `deps.youtube` `ok`.
- [ ] **CHAT-HEALTH-012**: Where every source listed in `chat.sources` is `twitch` or `youtube`, the chat service shall report `mode: "live"`.

## YouTube source

Prefix `CHAT-YT`: the YouTube source is a group of about fifty behaviours of its own, none of which belongs to the Twitch lines (`CHAT-TW`) or the shared plan (`CHAT-PLAN`, `CHAT-SRC`).

- [ ] **CHAT-YT-001**: The YouTube source shall authenticate with the API key `chat.youtube.api_key` only, hold no OAuth token and send no chat line.
- [ ] **CHAT-YT-002**: The YouTube source shall read no environment variable for its settings or its key and shall use no Google client library.
- [ ] **CHAT-YT-003**: When `chat.youtube.api_key` is whitespace only, the chat service shall treat it as unset.
- [ ] **CHAT-YT-004**: When the YouTube source reads its video value, it shall trim it before parsing and accept a bare video id of eleven characters of letters, digits, `-` and `_`.
- [ ] **CHAT-YT-005**: When the YouTube source reads its video value, it shall accept the URL forms `youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/live/<id>`, `youtube.com/embed/<id>` and `youtube.com/live_chat?v=<id>` on the hosts `youtube.com`, `www.youtube.com` and `m.youtube.com` (and `youtu.be` for the short form), comparing the host case-insensitively, with or without the scheme and with other query parameters ignored.
- [ ] **CHAT-YT-006**: When the YouTube source reads a video value that is a channel URL, a playlist, a search phrase or anything else that names no video, it shall treat the value as unparseable.
- [ ] **CHAT-YT-007**: When the YouTube source starts, it shall look the video up once with `videos.list` and parts `liveStreamingDetails` and `snippet`, using the API key.
- [ ] **CHAT-YT-008**: If the video lookup returns no item, then the YouTube source shall be `stopped` with the reason that the video was not found.
- [ ] **CHAT-YT-009**: While the looked-up video's `liveBroadcastContent` is `upcoming`, the YouTube source shall be `waiting` with the reason that the broadcast has not started, and shall look the video up again every `chat.youtube.recheck_ms`.
- [ ] **CHAT-YT-010**: When a lookup returns a live video with an `activeLiveChatId`, the YouTube source shall read that chat.
- [ ] **CHAT-YT-011**: If a lookup returns a live video with no `activeLiveChatId`, then the YouTube source shall be `stopped` with the reason that live chat is disabled.
- [ ] **CHAT-YT-012**: If a lookup returns a video that is not live and has an `actualEndTime`, then the YouTube source shall be `stopped` with the reason that the broadcast has ended.
- [ ] **CHAT-YT-013**: If a lookup returns a video that is not live and has no `actualEndTime`, then the YouTube source shall be `stopped` with the reason that the video is not a live broadcast.
- [ ] **CHAT-YT-014**: While the YouTube source is `stopped`, it shall make no further request and shall read again only after the chat service restarts.
- [ ] **CHAT-YT-015**: Where `chat.youtube.transport` is `stream`, the YouTube source shall read by opening the `StreamList` call with the chat id and the parts `snippet` and `authorDetails`.
- [ ] **CHAT-YT-016**: When the response of a `StreamList` call begins (its initial metadata or its first message, whichever the gRPC client reports first), the YouTube source shall be `reading`.
- [ ] **CHAT-YT-017**: While a `StreamList` call is open and sends no message, the YouTube source shall stay `reading`.
- [ ] **CHAT-YT-018**: When a stream that has been open ends or fails, the YouTube source shall reopen it with the last page token after a delay of 1 second that doubles to a cap of 60 seconds and resets when a response begins, and shall be `retrying` meanwhile.
- [ ] **CHAT-YT-019**: When five consecutive attempts to open the stream end with no response, for any reason other than quota exhaustion or `NOT_FOUND`, the YouTube source shall read by polling for the rest of the process, after delays of 1, 2, 4 and 8 seconds between the five attempts.
- [ ] **CHAT-YT-020**: When opening the stream fails with `UNIMPLEMENTED` or `PERMISSION_DENIED`, the YouTube source shall read by polling for the rest of the process and log a warning naming the reason.
- [ ] **CHAT-YT-021**: Once the stream has been open in this process, the YouTube source shall not fall back to polling.
- [ ] **CHAT-YT-022**: If the stream fails with `PERMISSION_DENIED` after it has been open in this process, then the YouTube source shall be `stopped` with the reason that the chat refuses the API key.
- [ ] **CHAT-YT-023**: The YouTube source shall not return from polling to the stream until the chat service restarts.
- [ ] **CHAT-YT-024**: When the YouTube source switches to polling, it shall pass the last page token to `liveChatMessages.list`.
- [ ] **CHAT-YT-025**: If `liveChatMessages.list` rejects the page token on the switch to polling, then the YouTube source shall poll without a token and use the newest `publishedAt` it has seen as the baseline of CHAT-YT-035.
- [ ] **CHAT-YT-026**: Where `chat.youtube.transport` is `poll`, the YouTube source shall read by `liveChatMessages.list` only and open no stream.
- [ ] **CHAT-YT-027**: When the YouTube source polls, it shall wait between two calls the larger of the server's `pollingIntervalMillis` and `chat.youtube.poll_floor_ms`.
- [ ] **CHAT-YT-028**: Whenever a poll response arrives, the YouTube source shall be `reading`.
- [ ] **CHAT-YT-029**: The YouTube source shall read the video lookup, the stream and the polls through a transport interface with the methods `lookup`, `openStream` and `poll`, whose responses have the API's own JSON shape.
- [ ] **CHAT-YT-030**: The YouTube source shall keep an in-process tally of the quota units it spends, counting 1 unit for each `videos.list`, 5 for each `liveChatMessages.list` and 5 for each stream open, and the number of pushed stream batches separately from units, and log both totals every ten minutes and at every state change.
- [ ] **CHAT-YT-031**: The YouTube source shall not persist its quota tally and shall take no action on it.
- [ ] **CHAT-YT-032**: If a call fails with 403 `quotaExceeded`, then the YouTube source shall be `retrying` with the reason `quota` and look the video up again every hour until the lookup succeeds.
- [ ] **CHAT-YT-033**: When the YouTube source resumes after `quota`, it shall resume from its last page token, and if the token is rejected, poll or stream without it and use the newest `publishedAt` it has seen as the baseline.
- [ ] **CHAT-YT-034**: When the first response of the process's first session without a page token arrives and holds messages, the YouTube source shall publish no message from it and record every message id in it.
- [ ] **CHAT-YT-035**: When any later response arrives, the YouTube source shall publish a message only when its id has not been seen and its `publishedAt` is later than `newest` as it stood before that response arrived, narrowed after a break by CHAT-YT-063.
- [ ] **CHAT-YT-036**: Where the first response holds no message with a `publishedAt`, the YouTube source shall drop that response and publish every message of the later responses whose id has not been seen.
- [ ] **CHAT-YT-037**: The YouTube source shall compare `publishedAt` values with each other and never with the host's clock.
- [ ] **CHAT-YT-038**: The YouTube source shall keep the last 2,000 message ids it has seen, shared by the stream and the polling paths, and drop a message whose id is in that set.
- [ ] **CHAT-YT-039**: When the chat service restarts, the YouTube source shall start with no `newest` and no recorded ids.
- [ ] **CHAT-YT-040**: If a call fails with 403 `forbidden` or `PERMISSION_DENIED` on the video lookup, then the YouTube source shall be `stopped` with the reason that the API key was rejected.
- [ ] **CHAT-YT-041**: If a poll fails with 403 `forbidden`, then the YouTube source shall be `stopped` with the reason that the chat refuses the API key.
- [ ] **CHAT-YT-042**: If a call fails with 401 or `UNAUTHENTICATED`, then the YouTube source shall be `stopped` with the reason that authentication failed.
- [ ] **CHAT-YT-043**: If a call fails with a 400 or 403 that no other line of this group names, then the YouTube source shall be `stopped` with the API's reason as its reason.
- [ ] **CHAT-YT-044**: If a call fails with 403 `liveChatDisabled`, 403 `liveChatEnded` or `FAILED_PRECONDITION`, then the YouTube source shall look the video up again, paced by the capped backoff of CHAT-YT-049, and act on the lookup result exactly as CHAT-YT-008 to CHAT-YT-013 say.
- [ ] **CHAT-YT-045**: If a call fails with 404 `liveChatNotFound` or `NOT_FOUND`, then the YouTube source shall look the video up again, be `stopped` when the broadcast has ended and be `retrying` otherwise, with the capped backoff of CHAT-YT-049.
- [ ] **CHAT-YT-046**: If a call fails with 400 `pageTokenInvalid` or `INVALID_ARGUMENT`, then the YouTube source shall discard its page token and read without one, using the newest `publishedAt` it has seen as the baseline.
- [ ] **CHAT-YT-047**: If a poll fails with 403 `rateLimitExceeded`, then the YouTube source shall double the next wait once and then return to the rule of CHAT-YT-027.
- [ ] **CHAT-YT-048**: If a call fails with `RESOURCE_EXHAUSTED`, then the YouTube source shall treat it as quota exhaustion, exactly as CHAT-YT-032 says.
- [ ] **CHAT-YT-049**: If a call of any kind fails with a network failure, a 5xx, `UNAVAILABLE`, `DEADLINE_EXCEEDED` or `INTERNAL`, then the YouTube source shall be `retrying` and retry with a delay of 1 second that doubles to a cap of 60 seconds and resets when a call succeeds.
- [ ] **CHAT-YT-050**: When a response carries `offlineAt` or a `chatEndedEvent` arrives, the YouTube source shall be `stopped` with the reason that the broadcast has ended.
- [ ] **CHAT-YT-051**: When a message of type `textMessageEvent` is published, the chat service shall use `textMessageDetails.messageText` as its text, `authorDetails.displayName` as `user`, `authorDetails.channelId` as `userId`, the message resource's `id` as `messageId` and `youtube` as `platform`.
- [ ] **CHAT-YT-052**: When the YouTube source maps an author, it shall set `isMod` to `isChatModerator` or `isChatOwner`, and `isSub` to `isChatSponsor`.
- [ ] **CHAT-YT-053**: When a message of type `superChatEvent` carries a comment in its own comment field (`snippet.superChatDetails.userComment`, a field name not verified here), the chat service shall publish that comment, and never `displayMessage`, as an ordinary chat line, with no amount, currency, tier or paid marker on the `chat.message` or any other event; if the field is absent from the response it shall publish nothing for the message.
- [ ] **CHAT-YT-054**: When a message of type `superChatEvent` carries no comment, the chat service shall publish nothing for it.
- [ ] **CHAT-YT-055**: When a message is of type `superStickerEvent`, `newSponsorEvent`, `memberMilestoneChatEvent`, `membershipGiftingEvent`, `giftMembershipReceivedEvent`, `giftEvent` or a poll event, the chat service shall publish nothing for it.
- [ ] **CHAT-YT-056**: When a message is of type `sponsorOnlyModeStartedEvent` or `sponsorOnlyModeEndedEvent`, the YouTube source shall log it at info level and publish nothing.
- [ ] **CHAT-YT-057**: If a YouTube message of a type that is mapped to `chat.message` has no text, or its author has no channel id, then the YouTube source shall drop it; this rule shall not apply to the removal markers `tombstone` and `userBannedEvent`.
- [ ] **CHAT-YT-058**: When the YouTube source maps a message of any other type, it shall drop it.
- [ ] **CHAT-YT-059**: The chat service shall send to YouTube no credential or identifier other than the API key, the video id and the chat id, and only to `youtube.googleapis.com` and `www.googleapis.com`.
- [ ] **CHAT-YT-060**: After each response, the YouTube source shall set `newest` to the latest `publishedAt` that response holds, and leave it unchanged when the response holds none.
- [ ] **CHAT-YT-061**: When the first response of the process's first session without a page token holds no message, the YouTube source shall treat there as being no history to drop, publish the messages of the following responses whose ids have not been seen, and set `newest` from the first response that holds any message.
- [ ] **CHAT-YT-062**: If the quota is exhausted before the stream has ever opened, then the YouTube source shall follow CHAT-YT-032 and shall not count that failure toward the five attempts of CHAT-YT-019.
- [ ] **CHAT-YT-063**: When the YouTube source returns to `reading` after `retrying` for any reason, quota included, and resumes from a page token, it shall not publish a message whose `publishedAt` is more than 60 seconds earlier than the newest `publishedAt` in that same response.
- [ ] **CHAT-YT-064**: When the YouTube source resumes from a page token as CHAT-YT-063 says and the response carries no `publishedAt`, it shall drop that whole response.
- [ ] **CHAT-YT-065**: While the YouTube source reads without a break, it shall apply CHAT-YT-063 to no response.
- [ ] **CHAT-YT-066**: When a response after the first holds a `tombstone` or a `userBannedEvent`, the YouTube source shall report that removal once and record the marker's id in the set of CHAT-YT-038, so that neither the stream nor polling reports it twice.
- [ ] **CHAT-YT-067**: When a response holds a message and a removal marker that covers it (by message id, or by author for a `userBannedEvent`), the YouTube source shall publish neither the message nor the removal.
- [ ] **CHAT-YT-068**: When the YouTube source looks the video up in response to a read error, it shall make the lookups no faster than the capped backoff of CHAT-YT-049 allows, so that a chat that keeps failing after a lookup that says it is live causes no faster lookups.

## Forgetting a removed message

- [ ] **CHAT-FORGET-001**: When a source reports a removal, the chat service shall publish `chat.removed` with that source's `platform`, the removal's `scope`, its `messageId` or `userId` and its `reason`.
- [ ] **CHAT-FORGET-002**: When the YouTube source reads a `tombstone` that carries the deleted message's id, it shall report a removal of `scope` `message` with that id.
- [ ] **CHAT-FORGET-003**: When the YouTube source reads a `userBannedEvent` that carries the banned channel's id, it shall report a removal of `scope` `user` with that id and `reason` `banned` for a permanent ban and `timeout` for a temporary one.
- [ ] **CHAT-FORGET-004**: If a `tombstone` or a `userBannedEvent` carries no usable id, then the YouTube source shall report no removal and log a warning.
- [ ] **CHAT-FORGET-005**: When the first response of the YouTube source holds a `tombstone` or a `userBannedEvent`, the YouTube source shall report no removal for it.
- [ ] **CHAT-FORGET-006**: The chat service shall not apply `chat.ignore_users` or `chat.ignore_prefixes` to a removal.
- [ ] **CHAT-FORGET-007**: The chat service shall send no removal, timeout or ban to any platform and take no moderation action there.
- [ ] **CHAT-FORGET-008**: When a source reports that a viewer was timed out, the chat service shall publish `chat.removed` of `scope` `user` for that viewer exactly as it does for a ban, with `reason` `timeout`.
