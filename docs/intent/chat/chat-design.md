---
parent: high-level-design
prefix: CHAT
---

# chat

Segment `chat` (`services/chat`, package `@cohost/chat`). Describes the implemented behaviour.

## Context and Design Philosophy

`chat` is the text sense. It turns Twitch IRC lines into `chat.message` events on the bus (see [HLD](../../high-level-design.md)). It is one of three senses (`chat`, `eyes`, `ears`) that publish and never consume brain events; it consumes only `inject.request` (test injection). Downstream consumers of `chat.message`: `salience`, `affect`, `memory` (each via `bus.subscribe`, `services/salience/src/main.ts`, `services/affect/src/main.ts`, `services/memory/src/startup.ts`) and the `dashboard` feed.

Multi-platform chat is a project goal; Twitch is the only implemented platform. `chat.message.platform` already admits `youtube` and `discord` (`packages/bus/src/events.ts`), so another platform arrives as a new chat source that sets its own `platform` value, with no change to the brain.

Design stance (evidence per bullet):

- Read-only by default. The header comment (`service.ts`) says anonymous IRC works with only `chat.twitch.channel`; credentials are optional. Typing in chat is a deferred project goal: the authenticated path stays so that a later body output beside `voice` can send lines, but nothing in the service sends a chat line today.
- Pure translation is separated from I/O. `filter.ts` has no side effects and is unit-tested; `service.ts` holds the plan dispatch, auth and `ChatClient` wiring behind injectable dependencies, and `index.ts` only hands it to `runService`. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": chat gained `createChatFilter` / `channelName` so the logic could be tested without Twitch).
- A configuration gap is not a crash. With no channel the service idles and reports `degraded` rather than `process.exit(1)` (`service.ts`), so a supervisor sees a health state instead of a restart loop. Evidence: comment at `service.ts`; commit 51d5a9c.
- Text is bounded where it enters the system. A viewer's message and name are length-bounded and flattened to one line before `chat.message` is published, by the shared untrusted text guard ([shared-runtime](../shared-runtime/shared-runtime-design.md) Untrusted text guard), so the dashboard feed and every consumer start from bounded text (HLD tenet 13). Chat can also reach the bus without passing through this service (the dashboard's bus-level injection), so each consumer bounds again at its own intake; the sense is the first bound, not the only one. The sense only bounds. Marking text as viewer text happens where a prompt line is rendered, and the sense never moderates a viewer.
- The service must run on Redis alone. `chat.source: fake` replaces Twitch with stdin or a scripted loop, and `@twurple/*` is loaded with dynamic `import()` only on the Twitch path (`service.ts`). Evidence: commit 51d5a9c ("mock/off backends so any service runs on Redis alone").

## Source Selection (plan)

`chatPlan(cfg.chat)` (`filter.ts`) maps config to one of three plans, chosen once at boot (`service.ts`):

| `chat.source` | `chat.twitch.channel` | Plan | Behaviour | Heartbeat |
|---|---|---|---|---|
| `fake` | any | `fake` | `startFakeSource`, no network | mode `mock`, `twitch: n/a`, `ready()` immediately (`service.ts`) |
| `twitch` | non-empty | `twitch` | `startTwitch(channel)` | mode `live`, `twitch: ok` while connected else `down`; `ready()` on first connect (`service.ts`) |
| `twitch` | empty | `idle` | the shared idle plan (`startIdle`, kind `degraded`): one error at start naming `chat.twitch.channel`, then a `still idle` warning first after 60 s, then at doubling delays capped at one hour; publishes nothing | mode `live`, `twitch: down`, `degraded("chat.twitch.channel is not set")` |

`channelName` strips one leading `#` and lowercases (`filter.ts`). `chat.source` blank resolves to `twitch` via `z.preprocess` (`packages/config/src/schema.ts`); `chat.fake.interval_ms` defaults 8000 (`schema.ts`). The isolation override is `CHAT_SOURCE` (applied by key path from `COHOST_ISOLATION`, config CFG-ISO-007); the channel and the Twitch credentials are config keys (`chat.twitch.channel` in `config.yaml`; `client_id`, `client_secret`, `access_token` and `refresh_token` in `secrets.yaml`). The control plane's isolated start sets `CHAT_SOURCE=fake` (`packages/control/src/manifest.ts`, owned by `control-plane`).

In all three plans the `inject.request` subscription is established before the plan branches (`service.ts`), so test injection works with no channel and no connection. `subscribeInject` (`packages/shared/src/inject.ts`) first creates the `chat` consumer group (`Bus.resetGroup`) and then starts the read loop with the bus start mode `latest` (the group is reset to the newest entry on every start), so requests published while chat was down are never handled (CHAT-INJ-009). Because the group exists before any plan runs, heartbeat `ready` is only ever signalled after the subscription is established. A failure to create the group is logged as `fatal` and exits non-zero. A failing subscription read is retried with backoff inside the bus ([event-bus](../event-bus/event-bus-design.md)).

## Twitch Path

`startTwitch` (`service.ts`):

1. `buildAuth()` first, then the `ChatClient` is created through a dynamic `import("@twurple/chat")`.
2. `buildAuth()` (`service.ts`) returns `undefined` (anonymous) unless `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.twitch.access_token` are all set. Otherwise it builds a `RefreshingAuthProvider`, logs `twitch token refreshed` with `expiresIn` on refresh and persists the refreshed token (see Token persistence below), and registers the token via `addUserForToken` (`registerUserToken`, `twitch.ts`) with intent `["chat"]`: the stored token when there is a current one, else the `secrets.yaml` pair with `expiresIn: 0`, `obtainmentTimestamp: 0`. `chat.twitch.refresh_token` is required on this path: when it is unset or blank, `registerUserToken` rejects with an error naming it before calling `addUserForToken` (CHAT-TW-010). With no complete token set the path is anonymous and the variable is ignored (CHAT-TW-001). `buildAuth` awaits the registration before it returns, so the `ChatClient` is constructed only after the token is registered; a failed registration rejects `startTwitch` and is logged as `fatal` (CHAT-TW-006). A refreshed token is logged and persisted (Token persistence below).
3. `new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } })`.
4. `onConnect`: `connected = true`, `heartbeat.ready()`, info log with `channel` and `authenticated`. `onDisconnect`: `connected = false`, warn log with `manually` and `reason`; no explicit reconnect code. Reconnect is the library default: `@twurple/chat` 8.2.0 drives an `ircv3` 0.33.1 client whose `connection.reconnect` option defaults to `true` (`ircv3/lib/IrcClient.js`), and `ChatClient` is constructed without overriding it, so an unexpected drop is retried and `onConnect` fires again (re-signalling `ready`). This library reconnect is the specified behaviour (CHAT-TW-009); the service adds no reconnect code of its own.
5. `onMessage` runs `createMessageHandler` (`twitch.ts`): `toEvent(user, text, msg.userInfo)` and, if it returns an event, publish `chat.message`. A failed publish is caught, logged at warn level (`chat.message publish failed`) and the next message is handled normally, as on the fake path (CHAT-TW-007).
6. `client.connect()` is not awaited; the service's `onStop` step calls `client.quit()` and the bootstrap then stops the bus.

The `connected` flag feeds the heartbeat `twitch` dependency; when the flag goes false after `ready`, the shared heartbeat derives `degraded` automatically (`packages/shared/src/lifecycle.ts`).

### Token persistence (`token-store.ts`)

A refreshed token must outlive the process, or a restart would start again from the `secrets.yaml` pair, whose refresh token Twitch has already rotated. On every refresh the service writes `{accessToken, refreshToken, expiresIn, obtainmentTimestamp, scope, envRefreshToken}` to `<dataDir()>/chat/twitch-token.json` (temp file then rename, mode `0600`; CHAT-TW-011), where `envRefreshToken` is the `chat.twitch.refresh_token` the process started from. A failed write is logged at warn level and ignored; the token in memory still works. On start `loadStoredToken` returns the stored token only when its `envRefreshToken` equals the current `chat.twitch.refresh_token` (CHAT-TW-012): when the operator re-authorises and puts a new refresh token in `secrets.yaml`, the file is superseded and the `secrets.yaml` pair wins. A missing, unreadable or malformed file also falls back to `secrets.yaml`.

## Filter and Payload (`filter.ts`)

`createChatFilter(cfg)` returns `(user, text, info) => EventInput<"chat.message"> | undefined` (`filter.ts`). Order of checks:

1. The sender's login or display name (lowercased) in `chat.ignore_users` (lowercased set) drops the message (CHAT-FILT-001).
2. `text` is bounded with `boundText(text, viewer_text.max_chars)`: the characters the guard removes gone, whitespace runs (line breaks included) collapsed to one space, trimmed, and cut with a trailing `…` when longer than the limit. Both the whitespace collapse and the length bound are the guard's; the filter holds no copy of either. Bounding happens once, here, so one definition of the text serves the prefix match, the empty check, the mention test and the payload (CHAT-FILT-008).
3. The bounded text starting with any `chat.ignore_prefixes` entry drops the message, so `" !cmd"` and a command behind an invisible character are commands too (CHAT-FILT-002, CHAT-FILT-003). Default prefixes `["!"]` (`schema.ts`); the example config ships `ignore_users: ["nightbot","streamelements","moobot"]`.
4. An empty bounded text drops the message (CHAT-FILT-004).

Payload: `platform: "twitch"` (hard-coded, also for `fake`), `user` the first non-empty of `boundText(info.displayName, viewer_text.max_name_chars)` and `boundText(user, viewer_text.max_name_chars)` (`user` is the sender's login name, which the Twitch client always supplies), else `unknown` (`UNKNOWN_NAME`); `userId: info.userId`, the bounded `text`, `isMod: info.isMod || info.isBroadcaster`, `isSub: info.isSubscriber`, `mentionsCohost: text.toLowerCase().includes(cfg.cohost.name.toLowerCase())` on the bounded text. The mention test is a plain substring match, so `cocoa` and `@coco_fan` both mention `Coco`; a test pins `@coco_fan hi` and comments "substring match, by design" (`test/filter.test.ts`). `cohost.name` is `z.string().min(1)` so the empty-name always-true case cannot occur through config. A mention test on the bounded text means a co-host name past the cut is not a mention: what a model is shown and what salience scores agree. `mentionsCohost` is computed here and only here; a consumer takes the flag as the event carries it, so a bus-injected event's flag is whatever its publisher set.

The limits are `viewer_text.max_chars` and `viewer_text.max_name_chars` ([config](../config/config-design.md) owns the keys, their defaults and their minimums; every region that renders a prompt reads the same values). The default message limit equals Twitch's own, so on Twitch the bound mostly bites on test input and other sources; it exists so that no source, present or future, can put an unbounded message on the bus. A Twitch name always has a login, so `unknown` arises only for a name from a source that supplies neither (CHAT-FILT-008 to CHAT-FILT-011).

`ChatUserInfo` (`filter.ts`) is a structural subset of twurple's `ChatUser`, so the filter and tests need no twurple import.

## Fake Source (`fake.ts`)

`startFakeSource({ toEvent, publish, cohostName, intervalMs, stdin, onError })` returns a stop function (`fake.ts`).

- Every emitted line goes through `toEvent` (the real filter), so `ignore_users`, `ignore_prefixes` and whitespace rules apply. Users are synthetic (`fake_viewer1..3`); `userId` equals the username and all flag fields are false (`fake.ts`).
- If `stdin` is supplied, a `readline` interface turns each line into a message from `fake_viewer1` and sets `stdinSeen`.
- If `stdin.isTTY`, the script is not started at all (interactive mode) (`fake.ts`).
- Otherwise a `setInterval` cycles a 6-line script (`fakeScript`, `fake.ts`: two mentions, a question, a `!uptime` line the filter drops, two plain lines) every `intervalMs`; once any stdin line has been seen the timer keeps ticking but emits nothing (`fake.ts`).
- Publish failures are caught and passed to `onError` (the entry point logs a warning) (`fake.ts`, `service.ts`).
- `service.ts` always passes `process.stdin`, so in a container with no TTY and a closed or empty stdin the script runs.

## Test Injection (`inject.ts`)

`createInjectHandler({ bus, log, cohostName, now? })` wraps the shared inject handler (SHARED-INJ-*; target `chat`, the one kind `text`; CHAT-INJ-010) for group `chat`, start mode `latest` per CHAT-INJ-009. Steps, the first four being the shared handler's:

1. `target !== "chat"` returns silently.
2. Any other path answers with `inject.result {id, ok, detail?}`.
3. Stale if `now() - ev.ts > INJECT_STALE_MS` (60 000 ms, from `@cohost/shared`; the eyes LLD owns it, SHARED-INJ-008) gives `ok:false, detail:"stale"`.
4. `kind !== "text"` gives `ok:false` with `chat cannot handle kind '<kind>'`.
5. Text is bounded with the same `boundText` call and limit the filter uses; blank gives `ok:false, detail:"blank text"`.
6. Publishes `chat.message` with `platform: meta.platform ?? "twitch"`, `user` the bounded `meta.user` (limit `viewer_text.max_name_chars`) or, when that is absent or bounds to nothing, `injected_viewer`, `isMod`/`isSub` from `meta` (default false), `mentionsCohost` from the lowercased `cohostName` substring of the bounded text, `injected: true`, `remember: r.remember`; no `userId` (the field is optional and an injected viewer has no Twitch id). `ignore_users`/`ignore_prefixes` are deliberately not applied; the length bound is applied exactly as for real chat, so a test shows what a real long message does (CHAT-INJ-011 to CHAT-INJ-013). A request injected on the bus instead of through this service (the dashboard's bus-level path) reaches the bus unbounded; its consumers bound it (shared-runtime, Where text is bounded).
7. Then `inject.result {ok:true}`. Any thrown error becomes `ok:false` with `String(err)`; if even the failure result cannot be published the error is swallowed.

The `inject.*` schemas belong to `event-bus`; the HTTP side and bus-level (skip-the-service) injection belong to `dashboard`.

## Health (`health.ts`)

`chatHealth(channel, twitchConnected, source)` returns the `HeartbeatSpec` `runService` starts the heartbeat with (`service.ts`); the heartbeat contract is owned by `control-plane`.

- `source === "fake"`: `{service:"chat", mode:"mock", deps: {twitch:"n/a"}}`.
- else: `mode:"live"`, `deps.twitch = channel && twitchConnected() ? "ok" : "down"`.
- Before the first connect the state stays `starting`, not `degraded` (the shared heartbeat only derives `degraded` from `down` deps once the base state is `ready`, `packages/shared/src/lifecycle.ts`).
- `mode` is a static string, not a getter; it cannot change at runtime.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Anonymous vs authenticated IRC | Anonymous unless all of client id, secret and access token are set (`service.ts`) | Always require credentials; remove the credential path; Twitch EventSub | Header comment (`service.ts`): chat works read-only with just `chat.twitch.channel`, so a stream needs no Twitch app registration to give the co-host its text sense. Typing in chat is a deferred project goal; the credential path stays so that a later body output beside `voice` can send lines with the same client. Requiring credentials would make the simplest setup harder for no read-side gain, and removing the path would have to be undone for that goal. Twitch EventSub chat subscriptions need an app and a user token even to read, so they lose the anonymous read-only setup; IRC through `@twurple/chat` keeps it. |
| Token registration | `addUserForToken` with the stored token, else the `secrets.yaml` pair with `expiresIn: 0`, `obtainmentTimestamp: 0` (`service.ts`) | Pass real expiry for the `secrets.yaml` pair; never persist | Owner decision of 2026-11-08: `chat.twitch.refresh_token` is required for the authenticated path (CHAT-TW-010). Tokens in `secrets.yaml` carry no expiry metadata, and zero expiry makes the provider treat the access token as already expired, so it refreshes before first use. `@twurple/auth` 8.2.0 `addUserForToken` then requires a refresh token (it throws `InvalidTokenError` without one) and `addUser` rejects any token without one, so a missing refresh token is reported at startup rather than as a library error. |
| Token registration ordering | Await `addUserForToken` before the `ChatClient` asks for credentials (CHAT-TW-006) | Fire-and-forget (the original code) | Owner decision 2026-11-01: the client must not race the registration, and a failed registration must surface instead of becoming an unhandled rejection. |
| Twitch publish failure | Log and handle the next message (CHAT-TW-007) | Let the rejection escape the twurple listener; crash and restart | Owner decision 2026-11-01 (project-wide): a failed bus publish is logged and the service continues, as the fake path already does (CHAT-FAKE-006). |
| Reconnect | Library default: `ircv3` `reconnect: true`, `onConnect` re-signals `ready` (CHAT-TW-009) | Own reconnect loop | Owner decision 2026-11-01: the library already retries an unexpected drop; the spec records it rather than adding code. |
| Missing channel | Idle plus `degraded` heartbeat through the shared idle plan: one error, then a reminder warning that backs off from 60 s to a one-hour cap (CHAT-PLAN-003, SHARED-IDLE-003, SHARED-IDLE-006) | `process.exit(1)` | Avoid restart loops under a supervisor: comment at `service.ts`; commit 51d5a9c. |
| Lazy `@twurple` import | Dynamic `import()` inside `startTwitch`/`buildAuth` (`service.ts`) | Static import | The fake and idle plans must not load the IRC library: comment at `service.ts`; commit 51d5a9c. |
| Mention detection | Substring on lowercased cleaned text (`filter.ts`) | Word-boundary or `@name` match | Test comment "substring match, by design" (`test/filter.test.ts`). Owner decision 2026-11-01: keep substring matching; false positives such as `cocoa` are accepted. |
| Command prefixes | Matched after trimming (CHAT-FILT-003) | Match the raw text (the original code) | Owner decision 2026-11-01: a leading space must not defeat the command filter. |
| Fake source reuses real filter | `toEvent` injected into `startFakeSource` (`fake.ts`) | Publish scripted events directly | So fake runs exercise ignore rules and cleaning exactly like Twitch: header comment `fake.ts`. |
| Injection bypasses ignore rules, not the bound | `inject.ts` does not call the filter, so `ignore_users` and `ignore_prefixes` do not apply; it applies the same length bound as the filter (owner decision) | Reuse `createChatFilter`; skip the bound for injected text | "A dropped test is useless": comment at `inject.ts`. The bound is not a filter on who may speak, it keeps the prompt bounded, and a test that skipped it would show a message the real path never delivers. |
| Where the message bound sits | In the sense, through the shared guard's `boundText`, for the text and the user name; the bus schema keeps no maximum; every consumer bounds again at its own intake (shared-runtime) | A `max` on `chat.message.text` in the bus schema; bound only in prompt builders; bound only in this service | A schema maximum makes the bus drop an over-long event as poison, so the dashboard feed, memory and cortex all lose a message instead of seeing a bounded one. A bound only here fails for chat that reaches the bus without passing through this service. A bound only in the prompt builders leaves the feed and stored rows unbounded. |
| Excess text | Cut with a trailing `…`, never dropped | Drop the message | Dropping would delete a viewer's message, including a mention near its end, which is not discounting; the cut is visible to the model and the owner (shared-runtime Decisions). |
| Mention test on bounded text | `mentionsCohost` is computed on the text after the bound, and only by this service | Compute it on the full text; recompute it in each consumer | A name placed after a long run of filler would set `mentionsCohost` and score 1.0 for text the model never sees. A consumer that recomputed it would disagree with another that did not. A bus-injected event carries whatever flag its publisher chose. |
| A name that bounds to nothing | The login name, then `unknown` | Drop the message; keep an empty name | A message from a viewer is still a message; an empty name would break the transcript line and every key built on the name. |
| Never moderate | The sense bounds and flattens; it never times out, bans, deletes or answers a viewer | A rate limit or block list per viewer at the sense | HLD Non-Goal 1 and tenet 13: against hostile or flooding chat the co-host only ignores or discounts. Discounting a flood is salience's job (salience Decisions); the sense passes every message on. |
| Platform | Hard-coded `"twitch"` in filter (`filter.ts`), also for fake chat; injected chat carries no `userId` | Carry platform from the source; a `fake` platform value | Owner decision 2026-11-01: keep both. The schema has no `fake` platform and `userId` is optional. Multi-platform chat is a goal and Twitch the only implementation; the schema already allows `youtube`/`discord` (`packages/bus/src/events.ts`), so a new platform is a new source that sets its own value. |
| Health mode for idle channel | `live` with `twitch: down` (`health.ts`; asserted at `test/health.test.ts`) | `off` with `twitch: n/a` | An idle channel is `degraded` with `deps: {twitch: "down"}`, and a service with a real source reports `live`; the test is titled "stays live-mode" (`test/health.test.ts`). Owner decision 2026-11-01 confirms `live` / `down`. |
| Refreshed token storage | A JSON file under `<dataDir()>/chat/`, preferred over `secrets.yaml` while its recorded `secrets.yaml` refresh token is current (CHAT-TW-011, CHAT-TW-012) | Never persist (the original); write the refreshed token back into `secrets.yaml`; a database row | Twitch rotates the refresh token on every refresh, so the refresh token in `secrets.yaml` goes stale within hours. A file in the service's own data directory needs no new infrastructure, keeps `secrets.yaml` written only through the dashboard's write-only route and never by a service, and recording the `secrets.yaml` refresh token it descends from lets a re-authorisation there win over an older file. Owner approved persistence on 2026-11-11. |
| Clock for staleness | The publisher's event timestamp against the local wall clock (SHARED-INJ-002) | A monotonic or Redis-time comparison | Every container runs on the one host and shares its clock, and the window is 60 s (owner 2026-11-11). |
| Normalisation of injected whitespace | Chat collapses and bounds text on its own path | Collapse in the dashboard | Service-level injection is bounded here; a bus-level injection skips this service and is bounded by each consumer at its intake (owner 2026-11-11 for the whitespace rule). |
| Injection start mode | `latest`: the `chat` group is reset to the newest entry on every start (CHAT-INJ-009) | `resume` (replay requests published while down) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; a stale test request has no value after a restart, and delivery across restarts is at-most-once. |

## Open Questions & Future Decisions

- **Several viewers named `unknown`.** A name that bounds to nothing and has no login falls back to `unknown`, and every consumer then treats all such viewers as one: the burst rule counts them as one viewer, and memory keeps no viewer row or note for a chat line named `unknown` that carries no `userId`. On Twitch the case does not arise (a login always exists); it can arise for a bus-injected event or another source. Readings: accept the merge (the case is rare and the cost is a discounted burst); or give a nameless viewer a name made from its `userId` or platform when one exists. Not decided.

## References

### Files in this segment
- `services/chat/src/index.ts`, `service.ts`, `filter.ts`, `fake.ts`, `health.ts`, `inject.ts`, `token-store.ts`, `twitch.ts`
- `services/chat/test/filter.test.ts`, `fake.test.ts`, `health.test.ts`, `inject.test.ts`, `service.test.ts`, `twitch.test.ts`, `contract.test.ts`
- `services/chat/package.json`, `services/chat/tsconfig.json`

### Other segments
- `event-bus` (depends on): `Bus`, `chat.message`, `inject.request`/`inject.result` schemas.
- `@cohost/shared` (workspace package, depends on): `runService`, `startIdle`, the inject handler and `subscribeInject`, and `boundText` from `@cohost/shared/untrusted` ([shared-runtime](../shared-runtime/shared-runtime-design.md)).
- `config` (depends on): `loadConfig`, `createLogger`; the keys it reads are `chat.*`, `cohost.name`, `viewer_text.max_chars` and `viewer_text.max_name_chars`.
- `control-plane` (depends on): `HeartbeatSpec`, `cohost:health`.
- `dashboard` (called by): publishes `inject.request`, shows `inject.result`, renders `chat.message`.
- `salience`, `affect`, `memory` (consumed by): subscribe to `chat.message`.
- `deployment`: compose service `chat` (`docker-compose.yml`).

### External
- `@twurple/chat` and `@twurple/auth` (`^8.2.0`), Twitch IRC.

### Docs
- [HLD](../../high-level-design.md), [specs](chat-specs.md), [arrow](../../arrows/chat.md)
