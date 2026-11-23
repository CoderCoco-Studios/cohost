---
parent: high-level-design
prefix: CHAT
---

# chat

Segment `chat` (`services/chat`, package `@cohost/chat`). Describes the intended behaviour; the [specs](chat-specs.md) mark which of it is built.

## Context and Design Philosophy

`chat` is the text sense. It turns Twitch IRC lines and YouTube live chat messages into `chat.message` events on the bus (see [HLD](../../high-level-design.md)). It is one of three senses (`chat`, `eyes`, `ears`) that publish and never consume brain events; it consumes only `inject.request` (test injection). Downstream consumers of `chat.message`: `salience`, `affect`, `memory` (each via `bus.subscribe`, `services/salience/src/main.ts`, `services/affect/src/main.ts`, `services/memory/src/startup.ts`) and the `dashboard` feed.

Chat is multi-platform (HLD goal 9). The service runs a list of **sources** at once, the way [ears](../ears/ears-design.md#multiple-sources) runs a list of audio sources: Twitch IRC, YouTube live chat and a fake source, each behind one `ChatSource` contract that stamps its own `platform`, with one filter and one guard for all of them ([Sources and Plan](#sources-and-plan)). `chat.message.platform` admits `twitch`, `youtube` and `discord` (`packages/bus/src/events.ts`), so a further platform arrives as a further source with no change to the brain (HLD tenet 2).

Design stance (evidence per bullet):

- Read-only by default. Anonymous IRC needs only `chat.twitch.channel` (`TwitchSource`, `twitch.ts`); credentials are optional. Typing in chat is a deferred project goal: the authenticated Twitch path stays so that a later body output beside `voice` can send lines, but nothing in the service sends a chat line today. The YouTube source reads with an API key alone and holds no OAuth token, so it cannot send a line; a YouTube body output would need a credential this design does not hold.
- Pure translation is separated from I/O. `filter.ts` has no side effects and is unit-tested; `plan.ts` holds the plan; `service.ts` starts and wires the sources, and each source takes its platform dependencies through `ChatServiceDeps` (the Twitch client and auth provider in `twitch.ts`; the YouTube transport when the reader lands), and `index.ts` only hands it to `runService`. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": chat gained `createChatFilter` / `channelName` so the logic could be tested without Twitch).
- A configuration gap is not a crash. A source with no channel, no key or no usable video idles and reports `down`, and a service with no runnable source idles and reports `degraded`, rather than `process.exit(1)`, so a supervisor sees a health state instead of a restart loop (HLD tenet 5). Evidence: comment at `service.ts`; commit 51d5a9c.
- Text is bounded where it enters the system. A viewer's message and name are length-bounded and flattened to one line before `chat.message` is published, by the shared untrusted text guard ([shared-runtime](../shared-runtime/shared-runtime-design.md) Untrusted text guard), so the dashboard feed and every consumer start from bounded text (HLD tenet 13). Chat can also reach the bus without passing through this service (the dashboard's bus-level injection), so each consumer bounds again at its own intake; the sense is the first bound, not the only one. The sense only bounds. Marking text as viewer text happens where a prompt line is rendered, and the sense never moderates a viewer.
- The service must run on Redis alone (HLD tenet 6). `chat.sources: [fake]` stands in for Twitch and YouTube with stdin or a scripted loop, and the libraries of a platform (`@twurple/*`, `@grpc/grpc-js`) are loaded with dynamic `import()` only when that platform's source runs. Evidence: commit 51d5a9c ("mock/off backends so any service runs on Redis alone").

## Sources and Plan

`chat.sources` lists the sources that are enabled, any number at once: `twitch`, `youtube` and `fake`. An absent or null `chat.sources` is `[twitch]`; an empty list is no sources (`off`); a name listed twice is read once; an unknown name fails the config load like any other enum value ([config](../config/config-design.md)). `chat.twitch` and `chat.youtube` are both optional sections whose every key has a default. The list is read at start, so a change takes effect on restart (HLD tenet 10).

### The source contract

A source is one `ChatSource`: a small object the service starts and stops, which reports its own state and hands every message it reads to the one filter.

| Member | Meaning |
|---|---|
| `name` | `twitch`, `youtube` or `fake`: the key in `chat.sources` and the name of its heartbeat dependency |
| a plan state | Decided before start from config alone by a pure function: `runnable`, or a gap with a reason (below) |
| `start` | Begins reading and returns without waiting for the first message. It is given `emit`, `emitRemoval`, the log, and a callback to report state changes |
| `emit(sender, text, messageId?)` | Hands one message to the shared filter with the source's platform. The filter returns a `chat.message` payload or drops the line; the service publishes it. A failed publish is logged at warn level and the next message is handled normally (CHAT-TW-007, CHAT-FAKE-006 hold for every source) |
| `emitRemoval(removal)` | Hands one removal (`scope`, `messageId` or `userId`, `reason`) to the service, which publishes `chat.removed` with the source's platform ([Forgetting a removed message](#forgetting-a-removed-message)). A failed publish is logged and handled like a failed message |
| `state` | One of the five states below, with a reason string for every state but `starting` and `reading` |
| `stop` | Cancels every timer, every in-flight request and every open call of the source and releases its connection; no `chat.message` and no `chat.removed` is published by the source after `stop` returns. Called from the bootstrap's `onStop` steps (CHAT-PLAN-006) |

**One vocabulary for a source's state.** Every source reports exactly these:

| State | Meaning | Heartbeat dependency |
|---|---|---|
| `starting` | started, no outcome yet | `down` once the service has reported `ready` (below), until then the service is `starting` |
| `waiting` | healthy but nothing to read yet: the YouTube broadcast has not started and is rechecked every `chat.youtube.recheck_ms` | `down` |
| `reading` | delivering: the Twitch client is connected, the fake source is running, the YouTube stream is open or a poll has returned a response (a quiet chat stays `reading`) | `ok` |
| `retrying` | a failure that may pass: the source retries with capped backoff, or hourly while the quota is spent (reason `quota`) | `down` |
| `stopped` | stopped with a reason until the next start: a gap, a rejected key, an ended broadcast, a start that rejected | `down` |

A source's **first outcome** is the first time it reaches any state other than `starting`, a failure included. A gap source is `stopped` with its reason at start, so its first outcome is immediate.

A sender is platform-neutral: the display name, the login where the platform has one, the platform's user id, the moderator and subscriber flags already worked out by the source, and the identifiers `chat.ignore_users` is matched against ([Filter and Payload](#filter-and-payload-filterts)). Every platform-specific decision (which flags mean moderator, which message types are chat) is inside the source; the filter holds none.

Starting is isolated per source, as in ears: a source whose `start` rejects, or that is a gap, is `stopped` with the rejection's message or the gap's reason and does not stop, restart or delay the others. A source that cannot be started never makes the process exit. This holds for the Twitch source's token registration too: a failed registration makes the `twitch` source `stopped` with the error's message as its reason, and the process stays up.

### The plan

`sourcePlan(cfg.chat)` (pure) returns, for each listed source, `runnable` or a gap with its reason:

| Source | Gap when | Reason text |
|---|---|---|
| `twitch` | `chat.twitch.channel` is empty after normalisation | `chat.twitch.channel is not set` |
| `youtube` | `chat.youtube.api_key` is empty | `chat.youtube.api_key is not set` |
| `youtube` | `chat.youtube.video` is empty | `chat.youtube.video is not set` |
| `youtube` | `chat.youtube.video` is not a video id or a URL of an accepted form ([The video value](#the-video-value)) | `chat.youtube.video is not a YouTube video URL or id` |
| `fake` | never | |

When several reasons apply to one source they are all given, in the order of the table above, joined by `; `. The service starts every runnable source. The whole service then takes one of these shapes:

| `chat.sources` | Shape | Heartbeat |
|---|---|---|
| `[]` | `off`: no source, no network; nothing is logged at warn level or above | mode `off`, every dependency `n/a`, `ready` as soon as the injection subscription exists |
| at least one runnable source | each runnable source starts; each gap source logs one error naming its reason and is `stopped` | mode `mock` when `fake` is listed, else `live`; one dependency per source (`ok`, `down`, or `n/a` for a source not listed); `ready` per the rule below |
| listed, none runnable | the shared idle plan (`startIdle`, kind `degraded`): one error at start naming each reason, then a `still idle` warning first after 60 s, then at doubling delays capped at one hour; publishes nothing | mode `live`, every listed source `down`, `degraded` with the reasons, in the order `chat.sources` lists the sources, joined by `; ` as the detail (a lone Twitch gap gives `chat.twitch.channel is not set`) |

The service is `ready` when every listed source has had a first outcome, or 30 s after start, whichever comes first (a broadcast hours away is `waiting`, which is an outcome, so it does not hold the service in `starting`). A source with no outcome at that moment counts as `down`. A `down` dependency on a `ready` service makes it `degraded` through the shared heartbeat (`packages/shared/src/lifecycle.ts`), which names the source; the reason is in the log, and in the heartbeat detail only when no source is runnable.

`channelName` strips one leading `#` and lowercases (`filter.ts`). `chat.fake.interval_ms` defaults 8000 (`schema.ts`). The isolation override is `CHAT_SOURCES` (applied by key path from `COHOST_ISOLATION`, config CFG-ISO-007, a flow value such as `[fake]`); the settings and credentials are config keys (`chat.twitch.channel`, `chat.youtube.video` and the others below in `config.yaml`; the Twitch `client_id`, `client_secret`, `access_token` and `refresh_token` and the YouTube `api_key` in `secrets.yaml`). The control plane's isolated start sets `CHAT_SOURCES=[fake]` (`packages/control/src/manifest.ts`, owned by `control-plane`), which stands in for Twitch and YouTube together, so the isolated service reaches no platform (HLD tenet 6).

In every shape, including `off` and the idle plan, the `inject.request` subscription is established before the sources start (`service.ts`), so test injection works with no channel, no key and no connection. `subscribeInject` (`packages/shared/src/inject.ts`) first creates the `chat` consumer group (`Bus.resetGroup`) and then starts the read loop with the bus start mode `latest` (the group is reset to the newest entry on every start), so requests published while chat was down are never handled (CHAT-INJ-009). Because the group exists before any source runs, heartbeat `ready` is only ever signalled after the subscription is established. A failure to create the group is logged as `fatal` and exits non-zero. A failing subscription read is retried with backoff inside the bus ([event-bus](../event-bus/event-bus-design.md)).

## Twitch Path

The `twitch` source (`TwitchSource`, `twitch.ts`), started by the service when the plan makes it runnable:

1. `buildAuth()` first, then the `ChatClient` is created through a dynamic `import("@twurple/chat")`.
2. `buildAuth()` (`twitch.ts`) returns `undefined` (anonymous) unless `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.twitch.access_token` are all set. Otherwise it builds a `RefreshingAuthProvider`, logs `twitch token refreshed` with `expiresIn` on refresh and persists the refreshed token (see Token persistence below), and registers the token via `addUserForToken` (`registerUserToken`, `twitch.ts`) with intent `["chat"]`: the stored token when there is a current one, else the `secrets.yaml` pair with `expiresIn: 0`, `obtainmentTimestamp: 0`. `chat.twitch.refresh_token` is required on this path: when it is unset or blank, `registerUserToken` rejects with an error naming it before calling `addUserForToken` (CHAT-TW-010); the rejection makes the `twitch` source `stopped` with that error as its reason, and the process does not exit. With no complete token set the path is anonymous and the variable is ignored (CHAT-TW-001). `buildAuth` awaits the registration before it returns, so the `ChatClient` is constructed only after the token is registered; a failed registration rejects the source's `start`, which makes the `twitch` source `stopped` with the error's message as its reason and is logged as an error; the process stays up and the other sources run (CHAT-TW-006). A refreshed token is logged and persisted (Token persistence below).
3. `new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } })`.
4. `onConnect`: the source's state is `reading`, which is its first outcome on the first connect, info log with `channel` and `authenticated`. `onDisconnect`: the source's state is `retrying` with the library's reason, warn log with `manually` and `reason`; no explicit reconnect code. Reconnect is the library default: `@twurple/chat` 8.2.0 drives an `ircv3` 0.33.1 client whose `connection.reconnect` option defaults to `true` (`ircv3/lib/IrcClient.js`), and `ChatClient` is constructed without overriding it, so an unexpected drop is retried and `onConnect` fires again (re-signalling `ready`). This library reconnect is the specified behaviour (CHAT-TW-009); the service adds no reconnect code of its own.
5. `onMessage` runs `createMessageHandler` (`twitch.ts`): `emit` the sender built from `msg.userInfo` (login, display name, user id, `isMod || isBroadcaster`, `isSubscriber`) with the text and `msg.id` as the `messageId` and, if the filter returns an event, publish `chat.message` with `platform: "twitch"`. A failed publish is caught, logged at warn level (`chat.message publish failed`) and the next message is handled normally, as on the fake path (CHAT-TW-007).
6. `onMessageRemove`, `onBan`, `onTimeout` and `onChatClear` call `emitRemoval` ([Forgetting a removed message](#forgetting-a-removed-message)).
7. `client.connect()` is not awaited. `TwitchSource.stop()` sets a stopped flag and calls `client.quit()`; a stop that arrives while the auth provider or the client is still being built makes `start` quit the client (if one was built) and return without connecting. The service stops every built source in its shutdown step.

The source's state feeds the heartbeat `twitch` dependency; when it leaves `reading` after `ready`, the dependency is `down` and the shared heartbeat derives `degraded` automatically (`packages/shared/src/lifecycle.ts`).

### Token persistence (`token-store.ts`)

A refreshed token must outlive the process, or a restart would start again from the `secrets.yaml` pair, whose refresh token Twitch has already rotated. On every refresh the service writes `{accessToken, refreshToken, expiresIn, obtainmentTimestamp, scope, envRefreshToken}` to `<dataDir()>/chat/twitch-token.json` (temp file then rename, mode `0600`; CHAT-TW-011), where `envRefreshToken` is the `chat.twitch.refresh_token` the process started from. A failed write is logged at warn level and ignored; the token in memory still works. On start `loadStoredToken` returns the stored token only when its `envRefreshToken` equals the current `chat.twitch.refresh_token` (CHAT-TW-012): when the operator re-authorises and puts a new refresh token in `secrets.yaml`, the file is superseded and the `secrets.yaml` pair wins. A missing, unreadable or malformed file also falls back to `secrets.yaml`.

## YouTube Source

The `youtube` source reads the live chat of one YouTube broadcast through the YouTube Data API, authenticated by an API key. It holds no OAuth token and never sends a line. It lives in `youtube.ts` (the state machine and read paths), `youtube-video.ts` (the pure video-value parser), `youtube-map.ts` (the pure mapping of a message resource to a sender and text) and a transport module behind an interface ([The transport](#the-transport)).

Facts about the API that the design rests on come from the official documentation. Where a fact is unverified the design says so and states what happens under each answer.

### Settings and the secret

| Key | Default | Meaning |
|---|---|---|
| `chat.youtube.video` | `""` | The broadcast: a video URL or id ([The video value](#the-video-value)). The owner sets it before a stream and restarts chat |
| `chat.youtube.api_key` | `""` | The API key, a `secrets.yaml` key written only through the dashboard's write-only route ([config](../config/config-design.md) Secrets file). A whitespace-only value is unset |
| `chat.youtube.transport` | `stream` | `stream`: the server stream, with polling as the fallback decided at start. `poll`: polling only. A blank value is the default |
| `chat.youtube.poll_floor_ms` | `12000` | The shortest time between two polls, an integer of at least 1000; a value below 1000 or not an integer fails the config load ([Polling and quota](#polling-and-quota)) |
| `chat.youtube.recheck_ms` | `120000` | How long a source waits between lookups while the broadcast has not started, an integer of at least 30000; a smaller or non-integer value fails the config load |

Every value is a key of `config.yaml` except the key, which is the one secret (HLD tenet 7). The service reads no environment variable for any of them. It uses no Google client library: the stream is `@grpc/grpc-js` with the published `stream_list.proto` (loaded with `@grpc/proto-loader`) and the key sent as `x-goog-api-key` metadata, and the lookups and polls are plain HTTPS requests with the runtime's `fetch`, so no application-default-credentials or ambient API-key lookup can shadow the saved key. The hosts are fixed in code (`youtube.googleapis.com` for the stream, `www.googleapis.com` for REST), so no setting decides where the key travels and none of these keys is a `sensitive` key.

### The video value

The value is trimmed and read by one pure function, `parseVideoValue` in `@cohost/shared`, which returns a video id or nothing and which the [tools](../tools/tools-design.md) service's stream info calls too, so the second reader does not copy it (HLD tenet 11); the host of a URL is compared case-insensitively. A video id is eleven characters of letters, digits, `-` and `_`. Accepted:

| Form | Example |
|---|---|
| a bare id | `dQw4w9WgXcQ` |
| a watch URL | `https://www.youtube.com/watch?v=<id>` (other query parameters ignored; `m.youtube.com` and `youtube.com` too) |
| a short URL | `https://youtu.be/<id>` |
| a live URL | `https://www.youtube.com/live/<id>` |
| an embed URL | `https://www.youtube.com/embed/<id>` |
| a pop-out chat URL | `https://www.youtube.com/live_chat?v=<id>` |

The scheme may be left out. A channel URL (`/@handle`, `/channel/...`, `/c/...`, `/user/...`), a playlist, a search phrase or anything else names no video, so it is not accepted: finding a channel's current broadcast from a channel needs a search call that costs 100 units or an OAuth token.

An unparseable value is a configuration gap, not an invalid value. The source is `stopped` with the reason `chat.youtube.video is not a YouTube video URL or id`, the rest of the service runs, and the schema accepts any string for the key. The reasons: the key is the one setting the owner rewrites before every stream, so it is the likeliest to hold a typo; a failed config load stops every service and the dashboard, the program the owner would fix it in; and whether the id names a live broadcast is only knowable from the API, so a parse check at load would catch some mistakes and leave the rest to the source anyway. HLD tenet 5 (a gap degrades, never crashes) decides it over the failure posture's invalid-value case. The two numeric keys are different: a value that is not an integer in range is an operator mistake with no stream-by-stream reason to tolerate, so it fails the load.

### Finding the chat

When the source starts it looks the video up once with `videos.list` (`part=liveStreamingDetails,snippet`, 1 quota unit, API key). The result decides the state:

| Result | State | What the source does |
|---|---|---|
| no item | `stopped` | `video <id> was not found (private, deleted or mistyped)` |
| `liveBroadcastContent` is `upcoming` | `waiting` | looks again every `chat.youtube.recheck_ms`, 1 unit each: 30 units an hour at the default, so waiting a whole day costs 720 of the 10,000 daily units. Reason: `the broadcast has not started` |
| `live` and `activeLiveChatId` present | reads | reads that chat ([Reading the chat](#reading-the-chat)) |
| `live` and no `activeLiveChatId` | `stopped` | `live chat is disabled for this broadcast` |
| `none` and `actualEndTime` present | `stopped` | `the broadcast has ended` |
| `none` and no `actualEndTime` | `stopped` | `the video is not a live broadcast` |

A `stopped` source logs one error naming the reason and does nothing more: a new broadcast has a new video id and a new chat id, so continuing needs the new URL in settings and a restart of chat (HLD tenet 10), which the owner does for each stream. The chat id is not kept anywhere; a restart looks it up again.

The same lookup is the source's answer to an ambiguous failure: after an error that does not say whether the broadcast is still live, the source looks the video up again before it retries, paced by the capped backoff of [Errors](#errors), so a chat that keeps failing after a lookup that says it is live causes no faster lookups ([Errors](#errors)).

### Reading the chat

**Stream.** Where `transport` is `stream` the source opens `V3DataLiveChatMessageService.StreamList` at `youtube.googleapis.com:443`, asking for the chat id with the `snippet` and `authorDetails` parts. The server sends recent history on connect and then pushes each batch of new messages; Google recommends this method over polling. The stream is **open**, and the source is `reading` and its dependency `ok`, as soon as the call's response has begun: its initial metadata or its first message, whichever the gRPC client reports first. A quiet chat sends no message for minutes and the source stays `reading`. Each response carries a next page token, which the source keeps. A stream that ends or fails after it has been open is reopened with the last token, after a delay of 1 s that doubles to a cap of 60 s and resets when a response begins; the source is `retrying` meanwhile. A response carrying `offlineAt` ends the source (`stopped`, `the broadcast has ended`).

**Fallback to polling is decided at start only.** The stream cannot be opened when five consecutive attempts end with no response, for any reason other than quota exhaustion or `NOT_FOUND` (the four delays between the five attempts are 1, 2, 4 and 8 s; quota exhaustion before the stream ever opened follows the quota rule of [Errors](#errors) and is not counted), or when an attempt fails with `UNIMPLEMENTED` (the failure a proxy or network that blocks gRPC gives) or `PERMISSION_DENIED`. The source then reads by polling for the rest of the process and logs a warning naming why. Once the stream has been open in this process the source never falls back: it retries the stream with the capped backoff above, and a `PERMISSION_DENIED` after the stream has been open is a `stopped` failure with a reason (`this chat refuses the API key`). A restart tries the stream first again. The source never goes back from polling to the stream on its own: polling is a complete path, a mid-stream switch is the riskiest point for duplicate or missed messages, and a restart is how settings take effect in any case. A `PERMISSION_DENIED` at open falls back to polling, and the first poll then decides whether the key is refused everywhere ([Errors](#errors)).

**The page token on the switch.** The switch to polling passes the last page token the stream gave to `liveChatMessages.list`. If the token is rejected (`pageTokenInvalid`), polling starts without a token and the newest `publishedAt` the source has already seen is the baseline of [History and duplicates](#history-and-duplicates), so nothing is replayed and nothing after it is lost.

**Polling.** `liveChatMessages.list` (`GET https://www.googleapis.com/youtube/v3/liveChat/messages`, 5 units a call, `part=snippet,authorDetails`) is called with the last `nextPageToken`. The wait before the next call is the larger of the server's `pollingIntervalMillis` and `chat.youtube.poll_floor_ms`; a call made faster than the server's interval is refused with 403 `rateLimitExceeded`. The first call carries no token and returns recent history, oldest first. Polling is `reading` and `ok` whenever a poll response arrives; a failed call makes it `retrying` until one succeeds.

### The transport

The source takes its API access through one interface, so a scripted transport can produce every state in this section with no network (the Twitch source takes its client the same way):

| Method | Meaning |
|---|---|
| `lookup(videoId)` | Returns the video's `liveBroadcastContent`, `activeLiveChatId`, `actualEndTime` and `scheduledStartTime`, or no item |
| `openStream({ chatId, pageToken?, signal })` | Returns an async sequence of responses, whose start is the call's response beginning (it yields an initial `opened` marker before any message) and whose end is the server closing the stream |
| `poll({ chatId, pageToken?, signal })` | Returns one response |

A response is **the API's own JSON shape** (`items` of `liveChatMessage` resources, `nextPageToken`, `pollingIntervalMillis`, `offlineAt`), which the gRPC transport produces from the proto message by the same field names, and the pure mapper of `youtube-map.ts` turns each item into a sender and text, a removal or nothing. Tests therefore script realistic API JSON and exercise the mapper too. A failure is thrown as an error carrying the HTTP status or gRPC status name and the API's `reason`, which the source classifies by the table in [Errors](#errors). The source is given a clock and timers, so tests advance time without waiting. In the isolated mode (`chat.sources` is `[fake]`) the fake source stands in for both platforms and the `youtube` dependency is `n/a`; the YouTube source itself is not started.

### Polling and quota

The default quota is 10,000 units a day for general methods. A poll costs 5 units, so a stream of `D` hours polled every `I` seconds costs `5 × 3600 × D / I` units, and a floor that keeps it inside a budget `Q` is `I ≥ 18000 × D / Q` seconds.

| Interval | Cost of a 6 hour stream | Longest stream in 10,000 units |
|---|---|---|
| 5 s | 21,600 units | 2.8 hours |
| 10.8 s | 10,000 units | 6 hours |
| 12 s (default floor) | 9,000 units | 6.7 hours |

For example, an 8 hour stream needs a floor of 14.4 s. The default floor of 12 s therefore keeps a 6 hour stream at 9,000 units and leaves about 1,000 for the one-unit lookups (the first lookup, the waiting rechecks, the lookups after errors). The server's interval wins when it is longer, which only lowers the cost. A longer stream or a quota shared with other uses of the same key's project needs a larger floor, by the formula. The floor applies only to polling; the stream's pace is the server's.

Whether a `StreamList` call costs its 5 units once per connection or once per pushed batch is not documented. Under per connection the stream costs almost nothing. Under per batch it can cost more than polling and spend the daily quota in a busy chat; the owner then observes the source go `retrying` with the reason `quota` (the dependency `down`, the service `degraded`), and the remedy is `chat.youtube.transport: poll`, whose cost is bounded by the floor. The source keeps an in-process tally of the units it spends (1 for each `videos.list`, 5 for each `liveChatMessages.list`, 5 for each stream open) and, counted separately as a number of batches and not as units, the stream batches received and logs the optimistic and pessimistic totals every ten minutes and at every state change, so the owner can compare it with the Cloud console's usage. The tally is a log aid for this process: it is not persisted, a restart starts it at zero, and the source takes no action on it.

### History and duplicates

The API sends recent history first, on the stream's connect and on a poll without a token, and the co-host must not answer chat from before it connected (HLD Start position after a restart). The source compares YouTube's clock only with itself, never with the host's. It keeps `newest`, the latest `publishedAt` in the responses it has processed, and the set of message ids it has seen. After each response `newest` is set to the latest `publishedAt` that response holds; a response that holds none leaves it unchanged. A message is published only when both hold:

1. **Baseline.** The first response of the process's first tokenless session that holds messages is history; a first response that holds no messages means there is no history to drop: the source publishes the messages of the following responses normally (subject to the seen-id set) and sets `newest` from the first response that holds any, so the first live messages of a chat with no history are not dropped. Nothing in the first response is published; every id in it is recorded and `newest` becomes the latest `publishedAt` in it. Every later response, whether it comes from the stream, from polling or from a session resumed after a break, is published only for the messages whose `publishedAt` is later than `newest` as it stood before that response arrived. When the first response holds no message with a `publishedAt` (the field is read here without having been verified), there is no baseline: only the first response is dropped, and every later response is published whole.
2. **No repeat.** A message id already seen is dropped. The set holds the last 2,000 ids and is shared by the stream and the polling paths; it covers the overlap when a session resumes from a token, when the token is rejected and history arrives again (the baseline drops the older part, the ids drop the rest), and when the source falls back to polling.

Whether the stream sends history in one response or spreads it over several is unverified. Under one response the baseline holds everything; under several, the history that arrives after the first response is dropped only when its `publishedAt` is not later than the baseline, and a message with no `publishedAt` in a later response would be published. The source logs the item count of each of its first three responses so the case is visible.

**After a break.** When the source returns to `reading` after `retrying`, for any reason and the quota included, and resumes from a page token, it does not publish a message whose `publishedAt` is more than 60 s earlier than the newest `publishedAt` in that same response; when that response carries no `publishedAt`, it drops the response whole. The 60 s compares YouTube's clock only with itself, so it needs no agreement with the host's clock, and it keeps the HLD decision that the co-host never answers minutes-old chat. A session that continues without a break is unaffected.

### Errors

"Re-resolve" is the lookup of [Finding the chat](#finding-the-chat). Every row logs its transition. A `retrying` state keeps the dependency `down` until a read delivers again. The backoff is 1 s doubling to a cap of 60 s, reset when a call succeeds.

| Signal | Meaning | What the source does |
|---|---|---|
| 403 `quotaExceeded` (any call) | the daily quota is spent | `retrying`, reason `quota`; re-resolves every hour until it succeeds, then resumes from its last token as the switch to polling does (a rejected token is dropped and `newest` is the baseline) |
| 403 `forbidden`, `PERMISSION_DENIED` on the lookup | the key is refused | `stopped`, `the API key was rejected` |
| `PERMISSION_DENIED` when the stream is opened | the key may be refused only for streaming | falls back to polling (Reading the chat); if polling is refused too, `stopped`, `this chat refuses the API key` |
| 403 `forbidden` on a poll | the chat refuses the key | `stopped`, `this chat refuses the API key` |
| 401, `UNAUTHENTICATED` | the key is not accepted | `stopped`, `authentication failed`, until restart |
| any other 400 or 403 not named in this table (for example the API is not enabled for the key's project) | the request is refused | `stopped`, with the API's reason as the source's reason, until restart |
| 403 `liveChatDisabled`, 403 `liveChatEnded`, `FAILED_PRECONDITION` | chat is disabled or has ended (the stream status does not say which) | re-resolves, then acts on the lookup result exactly as the table of [Finding the chat](#finding-the-chat) says |
| 404 `liveChatNotFound`, `NOT_FOUND` | the chat id is gone | re-resolves; `stopped` when the broadcast has ended, else `retrying` with the capped backoff |
| 400 `pageTokenInvalid`, `INVALID_ARGUMENT` | the page token is not accepted | discards the token and starts a session without one, with `newest` as the baseline when there is one; a second such error with no token is `retrying` |
| 403 `rateLimitExceeded` on a poll | the call came before the server's interval | doubles the next wait once, then returns to the normal rule |
| `RESOURCE_EXHAUSTED` | treated as quota exhaustion | exactly as the 403 `quotaExceeded` row says |
| a network failure on any call (lookup, stream, poll), 5xx, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, a stream closed without an end signal | transient | `retrying` with the backoff |
| `offlineAt`, a `chatEndedEvent` | the broadcast ended | `stopped`, `the broadcast has ended` |

### Mapping to `chat.message`

| Message `snippet.type` | Handling |
|---|---|
| `textMessageEvent` | published; `text` is `textMessageDetails.messageText` |
| `superChatEvent` | the comment of the Super Chat, taken from its own comment field (`snippet.superChatDetails.userComment`: a name this design takes from the API reference without having verified it) and never from `displayMessage`, is published as an ordinary chat line, with no amount, no currency, no tier and no paid marker; a Super Chat with no comment publishes nothing. Nothing about the payment is read, stored or carried on any event (HLD tenet 9). If the field is absent from the real response, a Super Chat publishes nothing |
| `superStickerEvent`, `newSponsorEvent`, `memberMilestoneChatEvent`, `membershipGiftingEvent`, `giftMembershipReceivedEvent`, `giftEvent`, a poll event | dropped: they are notices of purchases or memberships, and carry no chat from a person |
| `sponsorOnlyModeStartedEvent`, `sponsorOnlyModeEndedEvent` | not chat; logged at info level; no other effect |
| `userBannedEvent`, `tombstone` | a removal ([Forgetting a removed message](#forgetting-a-removed-message)) |
| `chatEndedEvent` | ends the source (above) |
| any other type | dropped |

A message of a type that is mapped to `chat.message` with no text, or an author with no channel id, is dropped; the removal markers `tombstone` and `userBannedEvent` are never dropped by this rule; so is a message whose bounded text is empty (CHAT-FILT-004). For a published line, `platform` is `youtube`; `user` is `authorDetails.displayName`; `userId` is `authorDetails.channelId`, exactly as the API gives it (the platform is carried beside it, so the pair is the viewer's identity, [shared-runtime](../shared-runtime/shared-runtime-design.md) `viewerKey`); `messageId` is the message resource's `id`; `isMod` is `isChatModerator || isChatOwner`, the channel's owner being the broadcaster as Twitch's broadcaster is; `isSub` is `isChatSponsor`, a paying channel member, which is the one subscriber-like status the API shows. `isVerified` is not read. The sender's ignore identifiers are the display name, the bare channel id and the prefixed form `youtube:<channelId>`. A chat message is at most 200 characters, under every bound the filter applies; Unicode emoji arrive as Unicode and channel custom emoji reportedly as `:shortcode:` text (community reports only), which is passed through as text either way.

### Egress and trust

Reading YouTube chat is a platform connection, an intentional external integration, not egress (HLD tenet 8); the tools service's stream info reads the same `chat.youtube.video` and `chat.youtube.api_key` and `chat.twitch.channel`, `client_id` and `client_secret` for its own lookups and is a platform connection of the same kind. What leaves the host is the API key, the video id and the chat id, and no other credential or identifier, to the two fixed Google hosts; no chat text, memory, embedding or viewer note is sent anywhere. The chat container needs outbound HTTPS (port 443) to those hosts and publishes no port. Chat stores nothing from YouTube; what memory keeps of a YouTube viewer, and for how long, is memory's owner decision (memory Decisions & Alternatives, Retention of YouTube viewers).

## Forgetting a removed message

When a platform removes chat, cohost forgets it: the message, or every message of a banned or timed-out viewer, leaves every working-memory window and stored memory, and counts toward no later decision or mood. This is forgetting, not moderation: cohost never times out, bans or deletes on a platform (HLD Non-Goal 1), and it reports only what the platform did. The design is one for both platforms.

**The event.** Each source calls `emitRemoval`, and the service publishes `chat.removed` ([event-bus](../event-bus/event-bus-design.md)) with the source's platform. It carries `scope` `message` with the `messageId` of the removed message, `scope` `user` with the `userId` of the viewer, or `scope` `all`, and a free `reason`. A `chat.message` carries the platform's `messageId` and `userId` so that every consumer matches on platform and id and never on a display name. A removal marker in YouTube's first (history) response is not published. In every later response each removal marker is published once: its id is recorded in the set of seen ids, so the stream and polling cannot publish it twice. A message that a removal marker in the same response covers is not published, and neither is the removal. `chat.ignore_users` and `chat.ignore_prefixes` do not apply to it (a removed message of an ignored viewer is forgotten like any other, harmlessly).

| Platform event | `chat.removed` | Notes |
|---|---|---|
| Twitch `onMessageRemove(channel, messageId, msg)` | `scope: message`, `messageId` | |
| Twitch `onBan(channel, user, msg)` | `scope: user`, `userId` = `msg.targetUserId`, reason `banned` | a null `targetUserId` publishes nothing and logs a warning |
| Twitch `onTimeout(channel, user, duration, msg)` | `scope: user`, `userId` = `msg.targetUserId`, reason `timeout` | as for a ban |
| Twitch `onChatClear(channel, msg)` | `scope: all`, reason `cleared` | names no message or viewer |
| YouTube `tombstone` | `scope: message`, the deleted message's id (`messageDeletedDetails.deletedMessageId`, a field name not verified here) | no id: nothing, a warning |
| YouTube `userBannedEvent` | `scope: user`, the banned channel's id (`userBannedDetails.bannedUserDetails.channelId`, not verified here), reason `banned` for a permanent ban and `timeout` for a temporary one (`banType`, not verified here) | no channel id: nothing, a warning |

The Twitch events and their parameters are confirmed from the type declarations of `@twurple/chat` 8.2.0 (`ChatClient.d.ts`: `onMessageRemove`, `onBan`, `onTimeout`, `onChatClear`; `ClearMsg.targetMessageId`; `ClearChat.targetUserId`, typed `string | null`; `ChatMessage.id`). That Twitch delivers them to an anonymous read-only client is not verified, and `ChatClientLike` must carry the four handlers. YouTube has no clear-chat event. Where a field name is unverified and the field is absent in the real response, cohost forgets nothing for that item, which is the same as not having the feature for that item.

**A timeout forgets like a ban.** Both platforms hide the viewer's messages when a moderator times them out, and a timeout is the tool a moderator uses against hostile or flooding chat, so the lines the platform hid are lines cohost should not hold. The alternative is to forget only permanent bans, which would keep the text of a viewer the moderators had just silenced.

**What each consumer does.** working-memory in salience and in cortex removes the matching chat entries (`forget`), so they count toward no decision, appear in the transcript or become a focus; salience drops a decision whose focus was removed while its scorer ran; affect drops queued appraisals of the covered lines; memory deletes the stored chat rows the removal covers, but none for `scope: all`. Each consumer reads `chat.removed` in the same subscription as `chat.message`.

**Limits.** A line the co-host already spoke cannot be unsaid. A think already in flight may still use the text it took. A mood that already moved stays moved. Viewer notes already derived from a removed message are not traced back and stand until the owner deletes them on the Viewers page. A removal that arrives for a message the source never published (it was history, or it was dropped by the filter) forgets nothing.

## Filter and Payload (`filter.ts`)

`createChatFilter(cfg, platform)` returns `(sender, text, messageId?) => EventInput<"chat.message"> | undefined` (`filter.ts`), where `sender` is a `ChatSender`, with the source's platform bound: the one filter and the one guard for every source, so a line from Twitch, from YouTube and from the fake source is bounded, ignored, prefix-checked and mention-tested by the same code. Order of checks:

1. Any identifier the source gives for the sender (lowercased) in `chat.ignore_users` (lowercased set) drops the message (CHAT-FILT-001). The identifiers are the platform's: for Twitch the login and the display name; for YouTube the display name, the bare channel id and the prefixed form `youtube:<channelId>` (a YouTube author has no login, and a display name is not unique, so an entry can name a bot's display name or, exactly, its channel id). The list is not scoped to a platform, so `nightbot` matches a Twitch login and a YouTube display name alike.
2. `text` is bounded with `boundText(text, viewer_text.max_chars)`: the characters the guard removes gone, whitespace runs (line breaks included) collapsed to one space, trimmed, and cut with a trailing `…` when longer than the limit. Both the whitespace collapse and the length bound are the guard's; the filter holds no copy of either. Bounding happens once, here, so one definition of the text serves the prefix match, the empty check, the mention test and the payload (CHAT-FILT-008).
3. The bounded text starting with any `chat.ignore_prefixes` entry drops the message, so `" !cmd"` and a command behind an invisible character are commands too (CHAT-FILT-002, CHAT-FILT-003). Default prefixes `["!"]` (`schema.ts`); the example config ships `ignore_users: ["nightbot","streamelements","moobot"]`.
4. An empty bounded text drops the message (CHAT-FILT-004).

Payload: `platform` as the source gives it, `user` the first non-empty of `boundText(sender.displayName, viewer_text.max_name_chars)` and `boundText(sender.login, viewer_text.max_name_chars)` (a Twitch sender always has a login; a YouTube sender has no login, and its display name is always present), else `unknown` (`UNKNOWN_NAME`); `userId` and `messageId` as the source gives them (the Twitch user id and message id; the YouTube channel id and message id), the bounded `text`, `isMod` and `isSub` as the source worked them out (Twitch: moderator or broadcaster, subscriber; YouTube: moderator or channel owner, channel member), `mentionsCohost: text.toLowerCase().includes(cfg.cohost.name.toLowerCase())` on the bounded text. The mention test is a plain substring match, so `cocoa` and `@coco_fan` both mention `Coco`; a test pins `@coco_fan hi` and comments "substring match, by design" (`test/filter.test.ts`). `cohost.name` is `z.string().min(1)` so the empty-name always-true case cannot occur through config. A mention test on the bounded text means a co-host name past the cut is not a mention: what a model is shown and what salience scores agree. `mentionsCohost` is computed here and only here; a consumer takes the flag as the event carries it, so a bus-injected event's flag is whatever its publisher set.

The limits are `viewer_text.max_chars` and `viewer_text.max_name_chars` ([config](../config/config-design.md) owns the keys, their defaults and their minimums; every region that renders a prompt reads the same values). The default message limit equals Twitch's own, so on Twitch the bound mostly bites on test input and other sources; it exists so that no source, present or future, can put an unbounded message on the bus. A Twitch name always has a login and a YouTube name a display name, so `unknown` arises only for a name from a source that supplies neither (CHAT-FILT-008 to CHAT-FILT-011).

`ChatSender` (`filter.ts`, its only definition) is the platform-neutral sender a source builds: display name, login, user id, the two flags and the ignore identifiers. It carries an optional `platform`, which only the fake source sets because it emits for two platforms; every other source's lines take the platform of the source. The Twitch source builds it from twurple's `ChatUser` and the YouTube source from `authorDetails`, so the filter and tests need no twurple or Google import.

## Fake Source (`fake.ts`)

`FakeSource` (`fake.ts`) is a `ChatSource`, constructed with `{ cohostName, intervalMs, stdin }`. It reports `reading` as soon as it starts, so the service is `ready` at once. It is the stand-in for both platforms: an isolated stack lists only `fake` (HLD tenet 6), and the lines it emits exercise the same filter and the same two platform shapes the real sources produce.

- Every emitted line goes through `toEvent` (the real filter), so `ignore_users`, `ignore_prefixes` and whitespace rules apply. Users are synthetic (`fake_viewer1..3`) and all flag fields are false (`fake.ts`). `fake_viewer1` and `fake_viewer3` are on `twitch` with a `userId` equal to the username; `fake_viewer2` is on `youtube` with the `userId` `fake_viewer2`, so the YouTube shape (its platform beside its id) reaches the brain and the dashboard with no account and no network.
- If `stdin` is supplied, a `readline` interface turns each line into a message from `fake_viewer1` and sets `stdinSeen`.
- If `stdin.isTTY`, the script is not started at all (interactive mode) (`fake.ts`).
- Otherwise a `setInterval` cycles a 6-line script (`fakeScript`, `fake.ts`: two mentions, a question, a `!uptime` line the filter drops, two plain lines) every `intervalMs`; once any stdin line has been seen the timer keeps ticking but emits nothing (`fake.ts`).
- Publish failures are caught by the service's publish step, which logs a warning and keeps handling later lines (CHAT-SRC-008). When `fake` is listed the service logs one warning that the source stands in and the mode is `mock`.
- `service.ts` passes `process.stdin` unless a test supplies `deps.stdin`, so in a container with no TTY and a closed or empty stdin the script runs.

## Test Injection (`inject.ts`)

`createInjectHandler({ bus, log, cohostName, viewerText, now? })`, where `viewerText` is `viewer_text` (`max_chars`, `max_name_chars`) wraps the shared inject handler (SHARED-INJ-*; target `chat`, the one kind `text`; CHAT-INJ-010) for group `chat`, start mode `latest` per CHAT-INJ-009. Steps, the first four being the shared handler's:

1. `target !== "chat"` returns silently.
2. Any other path answers with `inject.result {id, ok, detail?}`.
3. Stale if `now() - ev.ts > INJECT_STALE_MS` (60 000 ms, from `@cohost/shared`; the eyes LLD owns it, SHARED-INJ-008) gives `ok:false, detail:"stale"`.
4. `kind !== "text"` gives `ok:false` with `chat cannot handle kind '<kind>'`.
5. Text is bounded with the same `boundText` call and limit the filter uses; blank gives `ok:false, detail:"blank text"`.
6. Publishes `chat.message` with `platform: meta.platform ?? "twitch"`, `user` the bounded `meta.user` (limit `viewer_text.max_name_chars`) or, when that is absent or bounds to nothing, `injected_viewer`, `isMod`/`isSub` from `meta` (default false), `mentionsCohost` (CHAT-FILT-011) on the bounded text, `injected: true`, `remember: r.remember`; no `userId` (the field is optional and an injected viewer has no platform id, whichever platform the request names: a line injected as `youtube` or as `twitch` takes no platform account and sends nothing to either). `ignore_users`/`ignore_prefixes` are deliberately not applied; the length bound is applied exactly as for real chat, so a test shows what a real long message does (CHAT-INJ-007, CHAT-INJ-011, CHAT-INJ-012). A request injected on the bus instead of through this service (the dashboard's bus-level path) reaches the bus unbounded; its consumers bound it (shared-runtime, Where text is bounded).
7. Then `inject.result {ok:true}`. Any thrown error becomes `ok:false` with `String(err)`; if even the failure result cannot be published the error is swallowed.

The `inject.*` schemas belong to `event-bus`; the HTTP side and bus-level (skip-the-service) injection belong to `dashboard`.

## Health (`health.ts`)

`chatHealth(sources, states)` returns the `HeartbeatSpec` `runService` starts the heartbeat with (`service.ts`); the heartbeat contract is owned by `control-plane`.

- `chat.sources` empty: `{service:"chat", mode:"off", deps: {twitch:"n/a", youtube:"n/a"}}`.
- else `mode` is `mock` when `fake` is listed and `live` otherwise. `deps` has `twitch` and `youtube`, each `n/a` when the source is not listed and otherwise `ok` or `down` from its state; the fake source has no dependency, since it reaches nothing.
- `twitch` is `ok` only while the source is `reading`: the channel is configured and the IRC client is connected. `youtube` is `ok` only while the source is `reading`: the stream is open or a poll has returned a response. In `waiting`, `retrying` and `stopped` (and after the 30 s bound while still `starting`) a listed source is `down`.
- Before the service is `ready` its state stays `starting`, not `degraded` (the shared heartbeat only derives `degraded` from `down` deps once the base state is `ready`, `packages/shared/src/lifecycle.ts`); `ready` follows the rule in [The plan](#the-plan).
- `mode` is a static string, not a getter; it cannot change at runtime.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Anonymous vs authenticated IRC | Anonymous unless all of client id, secret and access token are set (`twitch.ts`) | Always require credentials; remove the credential path; Twitch EventSub | Header comment (`service.ts`): chat works read-only with just `chat.twitch.channel`, so a stream needs no Twitch app registration to give the co-host its text sense. Typing in chat is a deferred project goal; the credential path stays so that a later body output beside `voice` can send lines with the same client. Requiring credentials would make the simplest setup harder for no read-side gain, and removing the path would have to be undone for that goal. Twitch EventSub chat subscriptions need an app and a user token even to read, so they lose the anonymous read-only setup; IRC through `@twurple/chat` keeps it. |
| Token registration | `addUserForToken` with the stored token, else the `secrets.yaml` pair with `expiresIn: 0`, `obtainmentTimestamp: 0` (`twitch.ts`) | Pass real expiry for the `secrets.yaml` pair; never persist | Owner decision of 2026-11-08: `chat.twitch.refresh_token` is required for the authenticated path (CHAT-TW-010). Tokens in `secrets.yaml` carry no expiry metadata, and zero expiry makes the provider treat the access token as already expired, so it refreshes before first use. `@twurple/auth` 8.2.0 `addUserForToken` then requires a refresh token (it throws `InvalidTokenError` without one) and `addUser` rejects any token without one, so a missing refresh token is reported at startup rather than as a library error. |
| Token registration ordering | Await `addUserForToken` before the `ChatClient` asks for credentials (CHAT-TW-006); a failed registration makes the `twitch` source `stopped` with the error as its reason | Fire-and-forget; exit the process on failure | Owner decision 2026-11-01: the client must not race the registration, and a failed registration must surface instead of becoming an unhandled rejection. A failed Twitch registration must not stop the YouTube source or the process (HLD tenet 5). |
| Twitch publish failure | Log and handle the next message (CHAT-TW-007) | Let the rejection escape the twurple listener; crash and restart | Owner decision 2026-11-01 (project-wide): a failed bus publish is logged and the service continues, as the fake path already does (CHAT-FAKE-006). |
| Reconnect | Library default: `ircv3` `reconnect: true`, `onConnect` re-signals `ready` (CHAT-TW-009) | Own reconnect loop | Owner decision 2026-11-01: the library already retries an unexpected drop; the spec records it rather than adding code. |
| A source with a gap | The source is stopped with its reasons (dependency `down`) while the other sources run; with no runnable source, idle plus a `degraded` heartbeat through the shared idle plan: one error, then a reminder warning that backs off from 60 s to a one-hour cap (CHAT-PLAN-003, SHARED-IDLE-003, SHARED-IDLE-006) | `process.exit(1)`; letting one gap stop the other sources | Avoid restart loops under a supervisor (HLD tenet 5): comment at `service.ts`; commit 51d5a9c. A Twitch channel left empty must not silence a working YouTube source, as one absent audio source does not stop the others in ears. |
| Lazy platform libraries | Dynamic `import()` inside each source's start (`@twurple/*` for Twitch, `@grpc/grpc-js` for YouTube) | Static import | The fake and idle plans, and a stack that lists one platform, must not load the other's library (`twitch.ts`). |
| Mention detection | Substring on lowercased cleaned text (`filter.ts`) | Word-boundary or `@name` match | Test comment "substring match, by design" (`test/filter.test.ts`). Owner decision 2026-11-01: keep substring matching; false positives such as `cocoa` are accepted. |
| Command prefixes | Matched after trimming (CHAT-FILT-003) | Match the raw text | Owner decision 2026-11-01: a leading space must not defeat the command filter. |
| Fake source reuses real filter | The fake source emits through the same per-source filter as every source (`createChatFilter(cfg, platform)`, `fake.ts`) | Publish scripted events directly | So fake runs exercise ignore rules and cleaning exactly like Twitch. |
| Injection bypasses ignore rules, not the bound | `inject.ts` does not call the filter, so `ignore_users` and `ignore_prefixes` do not apply; it applies the same length bound as the filter (owner decision) | Reuse `createChatFilter`; skip the bound for injected text | "A dropped test is useless": comment at `inject.ts`. The bound is not a filter on who may speak, it keeps the prompt bounded, and a test that skipped it would show a message the real path never delivers. |
| Where the message bound sits | In the sense, through the shared guard's `boundText`, for the text and the user name; the bus schema keeps no maximum; every consumer bounds again at its own intake (shared-runtime) | A `max` on `chat.message.text` in the bus schema; bound only in prompt builders; bound only in this service | A schema maximum makes the bus drop an over-long event as poison, so the dashboard feed, memory and cortex all lose a message instead of seeing a bounded one. A bound only here fails for chat that reaches the bus without passing through this service. A bound only in the prompt builders leaves the feed and stored rows unbounded. |
| Excess text | Cut with a trailing `…`, never dropped | Drop the message | Dropping would delete a viewer's message, including a mention near its end, which is not discounting; the cut is visible to the model and the owner (shared-runtime Decisions). |
| Mention test on bounded text | `mentionsCohost` is computed on the text after the bound, and only by this service | Compute it on the full text; recompute it in each consumer | A name placed after a long run of filler would set `mentionsCohost` and score 1.0 for text the model never sees. A consumer that recomputed it would disagree with another that did not. A bus-injected event carries whatever flag its publisher chose. |
| A name that bounds to nothing | The login name, then `unknown` | Drop the message; keep an empty name | A message from a viewer is still a message; an empty name would break the transcript line and every key built on the name. |
| Never moderate | The sense bounds and flattens; it never times out, bans, deletes or answers a viewer; it reports what a platform removed and the brain forgets it | A rate limit or block list per viewer at the sense | HLD Non-Goal 1 and tenet 13: against hostile or flooding chat the co-host only ignores, discounts or forgets. Discounting a flood is salience's job (salience Decisions); the sense passes every message on. |
| Platform | Each source stamps its own platform (`twitch`, `youtube`); the fake source emits both shapes; injected chat carries the platform its request names and no `userId` | Hard-code `twitch` in the filter and for the fake source; a `fake` platform value | The schema has no `fake` platform and `userId` is optional. A fake source that only emitted Twitch lines would leave the YouTube shape untested in an isolated stack, which HLD tenet 6 asks to run with no account. `chat.message.platform` already admits `youtube`/`discord` (`packages/bus/src/events.ts`), so a new platform is a new source that sets its own value. |
| Health mode for a source with a gap | `live` with that source `down` (`health.ts`; asserted at `test/health.test.ts`); `mock` when `fake` is listed; `off` only for an empty list | `off` with `n/a` for a gap | A source with a gap is `degraded` with `deps` `down`, and a service with a real source reports `live`; the test is titled "stays live-mode" (`test/health.test.ts`). Owner decision 2026-11-01 confirms `live` / `down`. An empty `chat.sources` is the owner's explicit choice of no chat, which is `off`, as in ears. `mock` marks any run that includes synthetic viewers, so a mixed list is not reported as plain `live`. |
| Refreshed token storage | A JSON file under `<dataDir()>/chat/`, preferred over `secrets.yaml` while its recorded `secrets.yaml` refresh token is current (CHAT-TW-011, CHAT-TW-012) | Never persist; write the refreshed token back into `secrets.yaml`; a database row | Twitch rotates the refresh token on every refresh, so the refresh token in `secrets.yaml` goes stale within hours. A file in the service's own data directory needs no new infrastructure, keeps `secrets.yaml` written only through the dashboard's write-only route and never by a service, and recording the `secrets.yaml` refresh token it descends from lets a re-authorisation there win over an older file. Owner approved persistence on 2026-11-11. |
| Clock for staleness | The publisher's event timestamp against the local wall clock (SHARED-INJ-002) | A monotonic or Redis-time comparison | Every container runs on the one host and shares its clock, and the window is 60 s (owner 2026-11-11). |
| Normalisation of injected whitespace | Chat collapses and bounds text on its own path | Collapse in the dashboard | Service-level injection is bounded here; a bus-level injection skips this service and is bounded by each consumer at its intake (owner 2026-11-11 for the whitespace rule). |
| Injection start mode | `latest`: the `chat` group is reset to the newest entry on every start (CHAT-INJ-009) | `resume` (replay requests published while down) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; a stale test request has no value after a restart, and delivery across restarts is at-most-once. |
| Where YouTube chat runs | Inside this service, as a source in `chat.sources` beside Twitch and the fake source, behind one `ChatSource` contract, one filter and one guard; each source reports its own dependency | A separate `youtube-chat` service; a connector process; a branch in `main` per platform | Owner decision 2026-11-16. ears already runs a list of sources in one service ([ears](../ears/ears-design.md#multiple-sources)), so the pattern exists; one filter and one guard mean the ignore lists, the prefix filter, the mention test and the viewer-text bound cannot drift between platforms (HLD tenets 11 and 13); a second service would copy all of it. A branch per platform in `main` is what the plan did for Twitch alone, and a third source would need a third branch. |
| The source setting | `chat.sources`, a list of `twitch`, `youtube` and `fake`, default `[twitch]`; no other source setting | Keep a single `chat.source` and add `chat.youtube.enabled`; keep `chat.source` as an alias | Owner decision 2026-11-16: the project is pre-alpha with no backward compatibility, so the list is the only setting and no alias is kept. One list is the one place that says which platforms are read, as `ears.sources` does for audio. |
| An empty `chat.sources` | `off`: no source, `ready`, mode `off`, every dependency `n/a` | Treat it as a gap and idle `degraded` | An empty list is something the owner wrote, not something missing, and `ears.sources: []` already means `off`. A gap is a source the owner enabled that lacks a value. Design choice. |
| Read path | The server stream `liveChatMessages.streamList` first, polling `liveChatMessages.list` when the stream cannot be opened | Polling only; the REST form of `streamList` through `@googleapis/youtube`; the unofficial web-client route | Owner decision 2026-11-16. Google recommends the stream over polling and it pushes messages without waiting out an interval. Polling is complete and survives a network that blocks gRPC, so it is the fallback. Whether the REST form delivers messages incrementally through that wrapper is unverified, so it is not relied on. The web-client route (InnerTube, as libraries such as `youtubei.js` use it) is rejected: the YouTube Terms of Service forbid automated access by means other than the API, the Developer Policies forbid scraping, and its parsers break whenever YouTube changes a response shape. |
| Client libraries | `@grpc/grpc-js` with `@grpc/proto-loader` and the published `stream_list.proto`; the runtime's `fetch` for lookups and polls | `googleapis` or `@googleapis/youtube`; a hand-written HTTP/2 client | There is no official Node gRPC client for the stream. A Google client library reads ambient credentials and an API-key environment variable by default, which HLD tenet 7 rejects as a way to shadow the saved key; two REST calls need no SDK. |
| The transport setting | `chat.youtube.transport`, `stream` (default) or `poll` | No setting: the fallback is the only way to poll | Whether the stream's 5 units are charged per connection or per pushed batch is undocumented. If it is per batch, the stream can cost more than polling at the floor, and the owner needs a way to take the stream out without a code change. Design choice, open to the owner. |
| Fallback decided at start, one way | Polling is used instead of the stream only when the stream cannot be opened at start: five consecutive failed opens with no response, or `UNIMPLEMENTED` or `PERMISSION_DENIED` on open; after the stream has been open once in the process it only retries; polling never returns to the stream until the next start | Probe the stream again every few minutes while polling; fall back after any later failure | Polling is a complete path; a switch in mid-stream is the riskiest point for a duplicate or a gap; every probe costs at least 5 units and exercises the path that just failed; a restart already tries the stream first. Owner review 2026-11-16. |
| Finding the stream | A video URL or id in `chat.youtube.video`, set before each stream, applied by restarting chat; one `videos.list` lookup (1 unit, API key) finds the chat id | A channel id and a search for its current broadcast (`search.list`, 100 units a call); the owner's own broadcasts through `liveBroadcasts.list` (needs OAuth); following the channel's next broadcast automatically | Owner decision 2026-11-16: API key only, no OAuth. A URL costs the owner a paste per stream, which HLD tenet 10 already makes a restart; the lookup is the cheapest call the API has for it, and a new broadcast has a new video id and chat id, so automatic following would need the dearer search or a credential this design avoids. |
| An unparseable video value | A gap: the source is `down` with a reason, the schema accepts any string | Fail the config load as an invalid value (HLD failure posture) | The key changes before every stream, so it is the likeliest typo; a failed load stops every service and the dashboard, which the owner would fix it in; whether an id is a live broadcast is only knowable from the API. HLD tenet 5 over the failure posture's invalid-value case. Design choice, open to the owner. |
| Waiting for an upcoming broadcast | Look up again every `chat.youtube.recheck_ms` (default 120000, minimum 30000): 1 unit each, 30 an hour | Look up every 60 s (60 units an hour); sleep until `scheduledStartTime`; poll the chat of an upcoming broadcast | The owner may start chat hours before a stream, and a day of waiting at the default costs 720 of 10,000 units, leaving the stream day's polling intact. A start up to two minutes late costs only chat the co-host would not have answered as history anyway. Sleeping until the scheduled time misses a stream that starts early. Design choice, open to the owner. |
| `stopped` states need a restart | A stream that is not live, has ended, has no chat, or was not found is `stopped`: one error, `down`, no retry | Retry every few minutes in case chat is enabled or a broadcast appears | A new broadcast is a new video id, so a retry on the old id can only find the same answer; a restart with the new URL is how settings apply (HLD tenet 10). Waiting for `upcoming` is the one state with something to wait for. |
| The polling floor | `chat.youtube.poll_floor_ms`, default 12000, minimum 1000, honouring the server's `pollingIntervalMillis` when it is longer | Follow the server's interval alone; a fixed 10 s | The server's interval is the lower bound for correctness; the floor is the owner's quota budget, and the arithmetic in Polling and quota shows 12 s fits a 6 hour stream in 9,000 of 10,000 units where 5 s needs 21,600. Design choice, open to the owner. |
| History on connect | The first response of the process's first tokenless session that holds messages is history and is not published; afterwards only messages whose `publishedAt` is later than the newest `publishedAt` seen are published, compared with YouTube's own clock only; ids are published once; after a break, a resumed session drops messages more than 60 s older than the newest in its response, and drops a response with no `publishedAt` | Publish history; publish history marked so only memory stores it; compare with the host's clock; publish everything later than `newest` after a break | The co-host must not answer chat from before it connected, nor minutes-old chat after a break, as HLD Start position after a restart says of a restarted co-host. A marked-history flag would be a new `chat.message` field and a new rule in every consumer. A comparison with the host's clock depends on two clocks agreeing; YouTube's timestamps compared with each other need no agreement. Owner decision 2026-11-16. |
| Super Chat text | The comment of a Super Chat is published as an ordinary chat line with no amount and no paid marker; one with no comment publishes nothing; nothing about the payment is stored or carried | Drop Super Chats; publish the amount as a flag | Owner decision 2026-11-16. A paid message is a message a person wrote and the streamer would expect read; HLD tenet 9 says nobody is called out by wealth and money is never remembered beyond subscriber status, so the amount does not enter the system. |
| Membership, gift, sticker and poll events | Dropped | Publish a synthetic line for a new member or a gift | They are purchase notices with no text from a person, and a synthetic line would put money or membership news into viewer text. `isSub` already carries membership status from `isChatSponsor`. |
| Deletions and bans | A removed message, a banned or timed-out viewer and a cleared chat are forgotten: one `chat.removed` event for both platforms, which working memory, affect and memory act on; a timeout forgets like a ban | Ignore them (cohost is not a moderation tool); retract the published message; forget permanent bans only | Owner decision 2026-11-16: cohost forgets what the platform removed. HLD Non-Goal 1 still holds: cohost reports and forgets, never acts on the platform, and a published `chat.message` cannot be recalled, so a line already spoken stays said. A timeout hides the viewer's messages on both platforms, so a timeout forgets like a ban (design choice, open to the owner). |
| A timeout forgets like a ban | `chat.removed` of `scope: user` for a timeout, with `reason` `timeout`, as for a ban | Forget permanent bans only | Both platforms hide the viewer's messages on a timeout, and a timeout is the tool a moderator uses against hostile or flooding chat, so the lines the platform hid are lines cohost should not hold. Owner decision 2026-11-16. |
| `scope: all` forgets windows only | A cleared chat removes the platform's lines from working memory and deletes nothing from stored memory | Delete every stored chat row of the platform | A cleared chat names no message or viewer, and stored rows outlive the stream, so memory cannot tell which rows were cleared. Owner decision 2026-11-16. |
| The YouTube `userId` | The bare channel id, exactly as the API gives it, with `platform: youtube` beside it | A `youtube:`-prefixed id; the display name | A viewer is a platform and a user id (owner decision 2026-11-16), so the platform field already separates a channel id from a Twitch id and the prefix would only repeat it. The id is case-sensitive, so no consumer folds it ([shared-runtime](../shared-runtime/shared-runtime-design.md) `viewerKey`). |
| Moderator and subscriber on YouTube | `isMod` is `isChatModerator || isChatOwner`; `isSub` is `isChatSponsor` | `isMod` from `isChatModerator` only; `isSub` also for `isChatOwner` | The channel owner is the broadcaster, who Twitch also counts as a moderator. A channel member is the one paying-supporter status the API exposes and the nearest thing to a Twitch subscriber. Design choice. |
| What `ignore_users` matches | Any identifier the source gives: login and display name on Twitch; display name, bare channel id and `youtube:<channelId>` on YouTube; the list is not platform-scoped | Match the display name only; scope entries by platform | A YouTube author has no login and display names repeat, so a channel id is the exact way to ignore one author, and the prefixed form is the form an owner may copy from a viewer key. A platform prefix on each entry would make every existing entry say which platform it means for no gain on a list of bot names. |
| YouTube connection is not egress | A platform connection under HLD tenet 8 | Treat it as egress that needs separate configuration | Tenet 8 names YouTube beside Twitch and Discord as an intentional external integration. Only the key and two ids leave the host. |
| Service `ready` with several sources | `ready` once every listed source has had a first outcome, or 30 s after start, whichever is first; a source that has not reported by then is `down` | `ready` on the first source to connect; `ready` only when all are `reading` | A YouTube broadcast hours away would hold the whole service in `starting`, and the first source to connect would report `ready` while another is still trying; the 30 s bound keeps a source that never answers from holding it either. Design choice. |
| Viewer identity | A viewer is a platform and a user id; `chat.message` carries `platform`, `userId` and `messageId`; display names are for rendering | Identify by display name | Owner decision 2026-11-16: two viewers can share a name across platforms and YouTube does not keep display names unique; a sensitive note about one must never be applied to the other (HLD tenet 9). The shared guard's `viewerKey` is the one key ([shared-runtime](../shared-runtime/shared-runtime-design.md)). |
| Transport interface | Three methods (`lookup`, `openStream`, `poll`) returning the API's own JSON shape; a pure mapper normalises | A transport that yields normalised messages | A scripted transport can produce every state and a realistic response, and the mapper is tested with the real shape; a normalising transport would hide the mapping from the tests. |
| Removal events from a source | `emitRemoval`, published as `chat.removed`, not from YouTube's history response | Publish removals from history too | A ban from hours ago, replayed on every restart, would delete a viewer's stored lines each time; removals follow the same history rule as messages. |

## Open Questions & Future Decisions

- **Several viewers named `unknown`.** A name that bounds to nothing and has no login falls back to `unknown`, and every consumer then treats all such viewers as one: the burst rule counts them as one viewer, and memory keeps no viewer row or note for a chat line named `unknown` that carries no `userId`. On Twitch the case does not arise (a login always exists); it can arise for a bus-injected event or another source. Readings: accept the merge (the case is rare and the cost is a discounted burst); or give a nameless viewer a name made from its `userId` or platform when one exists. Not decided.
- **Unverified API behaviour.** (a) Whether a `StreamList` call is charged per connection or per pushed batch: the design observes it and `chat.youtube.transport: poll` is the remedy. (b) Whether the stream sends history in one response or several, and whether each message carries `snippet.publishedAt`: with the field the baseline drops history that arrives after the first response; without it a history split over several responses would be published. (c) The names of the Super Chat comment field and of the removal fields (`messageDeletedDetails.deletedMessageId`, `userBannedDetails.bannedUserDetails.channelId`, `banType`): when one is absent the item forgets or publishes nothing. (d) Whether channel custom emoji arrive as `:shortcode:` text. (e) Whether `@googleapis/youtube` 40.1.0's REST `streamList` delivers incrementally, which would make a second, gRPC-free streaming path possible. (f) Whether Twitch sends `CLEARMSG` and `CLEARCHAT` to an anonymous read-only client. Each is to be settled against the live service before the matching behaviour is specified as built.
- **The reason a source is down.** With several sources the shared heartbeat's dependency-down detail names the source and not its reason; the reason is in the log. Carrying a per-source reason in the heartbeat needs a change to the shared heartbeat. Not decided.

## References

### Files in this segment
- `services/chat/src/index.ts`, `service.ts`, `filter.ts`, `fake.ts`, `health.ts`, `inject.ts`, `token-store.ts`, `twitch.ts`; the sources' contract and the YouTube source's modules (`source.ts`, `youtube.ts`, `youtube-video.ts`, and the transport module) as the design places them
- `services/chat/test/filter.test.ts`, `fake.test.ts`, `health.test.ts`, `inject.test.ts`, `service.test.ts`, `twitch.test.ts`, `contract.test.ts`
- `services/chat/package.json`, `services/chat/tsconfig.json`

### Other segments
- `event-bus` (depends on): `Bus`, `chat.message`, `inject.request`/`inject.result` schemas.
- `@cohost/shared` (workspace package, depends on): `runService`, `startIdle`, the inject handler and `subscribeInject`, and `boundText` from `@cohost/shared/untrusted` ([shared-runtime](../shared-runtime/shared-runtime-design.md)).
- `config` (depends on): `loadConfig`, `createLogger`; the keys it reads are `chat.*` (including `chat.sources` and `chat.youtube.*`), `cohost.name`, `viewer_text.max_chars` and `viewer_text.max_name_chars`.
- `control-plane` (depends on): `HeartbeatSpec`, `cohost:health`.
- `dashboard` (called by): publishes `inject.request`, shows `inject.result`, renders `chat.message`.
- `salience`, `affect`, `memory` (consumed by): subscribe to `chat.message`.
- `deployment`: compose service `chat` (`docker-compose.yml`).

### External
- `@twurple/chat` and `@twurple/auth` (`^8.2.0`), Twitch IRC.
- `@grpc/grpc-js` and `@grpc/proto-loader`, the YouTube `StreamList` gRPC stream, with the published `stream_list.proto`; the runtime's `fetch` for the YouTube lookups and polls. No Google client library.
- The YouTube Data API (`videos.list`, `liveChatMessages.list`, `liveChatMessages.streamList`), its API Services Terms and Developer Policies.

### Docs
- [HLD](../../high-level-design.md), [specs](chat-specs.md), [arrow](../../arrows/chat.md)
