# tools specs

Segment `tools` (prefix `TOOL`). LLD: [tools-design.md](tools-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred.

Terms: "the service" is the `tools` service; "a tool" is a built-in tool or an MCP tool; "the catalog" is the `tool.catalog` snapshot; "the call limit" is `tools.timeout_ms`; "the confirmation window" is `tools.confirm_timeout_ms`; a tool's "label" is `read`, `acts` or `unlabelled` as its server or the service declares it, and its "effect" is `acts` when its label is not `read` or its `acts` mark is true, and `read` otherwise. The config keys are specified by [config](../config/config-specs.md) (CFG-SCH-075 onward) and the event shapes by [event-bus](../event-bus/event-bus-specs.md) (BUS-EVT-043 onward).

## Service and wiring (TOOL-SVC)

- [x] **TOOL-SVC-001**: When the service starts, it shall run on `runService` with the service name `tools` and subscribe in consumer group `tools`, start mode `latest`, to exactly `tool.request`, `tool.answer`, `memory.recall.reply` and `inject.request`.
- [x] **TOOL-SVC-002**: The service shall publish only `tool.result`, `tool.catalog`, `tool.confirm`, `tool.timer`, `memory.recall.request` and `inject.result`, and shall publish no `brain.say`, `brain.clause` or `attention.focus`.
- [x] **TOOL-SVC-003**: The service shall not subscribe to `control`.
- [x] **TOOL-SVC-004**: When the `tools` consumer group exists, the service shall report `ready` without waiting for any MCP server, and shall afterwards report the state `degraded` while any dependency is `down` and `ready` otherwise.
- [x] **TOOL-SVC-005**: The heartbeat mode shall be `mock` while `tools.mode` is `mock` and `live` otherwise.
- [x] **TOOL-SVC-006**: The heartbeat detail shall be the parts `<n> tools offered`, `no tools enabled` (when no tool is enabled), `<name> down` or `<name> refused its credential` for each server whose dependency is `down` (the second for an `auth` server) and `off LAN: <names>` for the external servers, joined by `; ` in that order, and shall name no URL.
- [x] **TOOL-SVC-007**: When the service reads a `tool.request` that passed validation, it shall publish exactly one `tool.result` with the same `id`, including for a request it refuses.
- [x] **TOOL-SVC-008**: When the service stops, it shall publish a `refused` `tool.result` of reason `shutdown` for each call in flight and each pending confirmation, then close its MCP sessions and its bus connection, and shall leave pending timers in Redis.
- [x] **TOOL-SVC-009**: When a call ends, the service shall log the tool name, the origin, the status and the duration at `info`, and shall log no argument, no result text, no secret and no userinfo or query string of a server URL at any level.

- [x] **TOOL-SVC-010**: The `tools` unit's manifest entry shall declare `secrets` as exactly `tools.servers.*.token`, `chat.twitch.client_id`, `chat.twitch.client_secret` and `chat.youtube.api_key`, so the service's secrets projection holds no other secret path (deployment DEPLOY-SECRET-003).
- [x] **TOOL-SVC-011**: When an MCP server's URL names a host that does not resolve or cannot be reached from the service's network (a Compose service other than `redis`, deployment DEPLOY-NET-002), the service shall treat the server as `down` like any unreachable server, with a sentence the service wrote and no resolver or socket error text.
- [x] **TOOL-SVC-012**: When the service starts, it shall create its logger with `createLogger("tools", { file: false })` and hand it to `runService`, so that it writes no log file whatever `logging.file.enabled` holds (config CFG-LOG-022) and its log reaches only its standard output; its level and terminal format follow the `logging` section like every program's.

## Tools and the catalog (TOOL-CAT)

- [x] **TOOL-CAT-001**: The service shall give the built-in tools the names `clock`, `stream_info`, `memory_lookup` and `timer`, and an MCP tool the name `<server>__<tool>` made of the server's name from `tools.servers` and the tool's own name.
- [x] **TOOL-CAT-002**: If an MCP tool's server name or own name has a character outside `[A-Za-z0-9_-]`, or its qualified name is longer than 64 characters, or its argument schema serializes to more than 4000 characters or nests more than 64 levels deep, then the service shall not list the tool and shall count it in the server's `detail`.
- [x] **TOOL-CAT-003**: When the service lists an MCP tool, it shall cut the tool's description to 400 characters and its title to 100.
- [x] **TOOL-CAT-004**: The service shall give `timer` the label `acts` and `clock`, `stream_info` and `memory_lookup` the label `read`.
- [x] **TOOL-CAT-005**: When the service lists an MCP tool, it shall give it the label `read` for the annotation `readOnlyHint: true`, `acts` for `readOnlyHint: false` and `unlabelled` when the tool has no such annotation.
- [x] **TOOL-CAT-006**: A tool shall be `offered` only while it is enabled in `tools.allow`, its server is `ok` or `mock` (or it is built in), its label is `read` or its `acts` mark is true, and, for an MCP tool outside mock mode, its definition matches its pinned hash (TOOL-PIN-004).
- [x] **TOOL-CAT-007**: When a tool is not offered, the catalog shall give it a `reason`, the first that applies of `not_enabled`, `acts_not_allowed`, `not_approved`, `changed` and `server_down`, and shall give an offered tool no `reason`.
- [x] **TOOL-CAT-008**: The catalog shall give each tool the `effect` `acts` when its label is not `read` or its `acts` mark is true and `read` otherwise, and every rule of this segment that depends on effect shall use that value.
- [x] **TOOL-CAT-009**: The catalog shall list every tool the service knows with its `name`, `server` (absent for a built-in tool), `title` when the server gives one, `description`, `parameters`, `label`, `effect`, the marks `enabled`, `acts`, `chat` and `confirm`, `hash` for an MCP tool, `offered` and `reason`.
- [x] **TOOL-CAT-010**: The catalog shall list every configured server with its `name`, its `state` (`ok`, `down`, `auth` or `mock`), `external`, `left_out` (the count of the server's tools the catalog left out) and a `detail` sentence.
- [x] **TOOL-CAT-011**: The service shall publish `tool.catalog` when it becomes ready, whenever the list of tools or the state of a server changes, and otherwise every `tools.catalog_ms` (default 30000), with `intervalMs` equal to `tools.catalog_ms`.
- [x] **TOOL-CAT-012**: The catalog shall describe the marks of the `config.yaml` the service loaded when it started.
- [x] **TOOL-CAT-013**: The service shall list at most `tools.max_tools_per_server` (default 32) tools of one server and at most `tools.max_tools` (default 64) tools in all, counting every tool whether or not it is enabled and taking the built-in tools first and then the servers in the order of `tools.servers`. The four built-in tools are always listed first, whatever the limits: they count toward `tools.max_tools`, so a `tools.max_tools` below four still lists them and the catalog then holds more tools than `tools.max_tools` allows.
- [x] **TOOL-CAT-014**: When tools of a server are left out by a limit, the service shall not list them, shall count them in that server's `left_out`, and shall state the count in that server's `detail`.
- [x] **TOOL-CAT-015**: An entry of `tools.allow` that names no listed tool shall be offered to nothing.

## Pinned definitions (TOOL-PIN)

- [x] **TOOL-PIN-001**: The service shall compute the `hash` of an MCP tool as the lower-case hexadecimal SHA-256 of the UTF-8 JSON object with exactly the members `name` (the qualified name), `title` (as cut; the member is absent when the server gives none), `description` (as cut), `parameters` (the argument schema) and `label`, serialized with the keys of every object, that one and those inside `parameters`, in ascending code-unit order and no whitespace outside strings.
- [x] **TOOL-PIN-002**: The catalog shall carry for each MCP tool the hash of the definition its server lists now, and shall carry no hash for a built-in tool.
- [x] **TOOL-PIN-003**: While `tools.mode` is not `mock`, if an enabled MCP tool's `tools.allow` entry records no `hash`, then the service shall not offer it and shall give it the catalog reason `not_approved`.
- [x] **TOOL-PIN-004**: While `tools.mode` is not `mock`, if an enabled MCP tool's recorded `hash` differs from the hash of the definition its server lists, then the service shall not offer it and shall give it the catalog reason `changed`.
- [x] **TOOL-PIN-005**: The service shall check no hash for a built-in tool, and none while `tools.mode` is `mock`.

## Who can cause a call (TOOL-ORIG)

- [x] **TOOL-ORIG-001**: When the service reads a `tool.request`, it shall take the origin, the round and `listed` from the request and shall not derive them.
- [x] **TOOL-ORIG-002**: Where the origin is `speech` or `dashboard`, the service shall allow any offered tool.
- [x] **TOOL-ORIG-003**: Where the origin is `reminder`, the service shall allow an offered tool only when its effect is `read`, so never `timer`.
- [x] **TOOL-ORIG-004**: Where the origin is `chat` or `guest`, the service shall allow an offered tool only when its `chat` mark is true and its effect is `read`.
- [x] **TOOL-ORIG-005**: Where the origin is `vision` or `idle`, the service shall allow no tool.
- [x] **TOOL-ORIG-006**: The service shall check the origin against its own catalog whatever tools cortex offered.

## The call pipeline (TOOL-CALL)

- [x] **TOOL-CALL-001**: When the service reads a `tool.request`, it shall run these steps in this order: look up, admit, confirm, call, shape, publish, and the first refusal of the look-up that applies, in the order `unknown_tool`, `not_enabled`, `acts_not_allowed`, `not_approved`, `definition_changed`, `server_down`, `origin_not_allowed`, `invalid_arguments`, shall end the request.
- [x] **TOOL-CALL-002**: If the requested tool is not in the catalog, then the service shall publish a `refused` result with reason `unknown_tool`, and for a tool in the catalog that is not enabled one with reason `not_enabled`.
- [x] **TOOL-CALL-003**: If the requested tool is enabled and its label is not `read` and its `acts` mark is not true, then the service shall publish a `refused` result with reason `acts_not_allowed`.
- [x] **TOOL-CALL-004**: While `tools.mode` is not `mock`, if the requested MCP tool has no recorded hash, then the service shall publish a `refused` result with reason `not_approved`, and if its hash differs, one with reason `definition_changed`.
- [x] **TOOL-CALL-005**: If the requested MCP tool's server is `down` or `auth`, then the service shall publish a `refused` result with reason `server_down` without sending a request to the server.
- [x] **TOOL-CALL-006**: If the origin does not allow the requested tool (TOOL-ORIG-002 to TOOL-ORIG-005), then the service shall publish a `refused` result with reason `origin_not_allowed`.
- [x] **TOOL-CALL-007**: If a built-in tool rejects a request's arguments, then the service shall publish a `refused` result with reason `invalid_arguments`.
- [x] **TOOL-CALL-008**: The service shall not validate the arguments of an MCP tool against the server's schema.
- [x] **TOOL-CALL-009**: While `tools.max_concurrent` (default 4) calls hold a slot, a call waiting for its confirmation included, the service shall refuse a further request at once with reason `busy` and shall not queue it.
- [x] **TOOL-CALL-010**: The service shall start the call limit `tools.timeout_ms` (default 10000) when it sends the call, and shall publish a `timeout` result when it passes.
- [x] **TOOL-CALL-011**: When the call limit passes on an MCP call, the service shall abort the HTTP request and send a cancellation notification to the server on a best-effort basis.
- [x] **TOOL-CALL-012**: If the HTTP request or the session of an MCP call fails during the call, then the service shall publish an `error` result with reason `unavailable` and a sentence it wrote.
- [x] **TOOL-CALL-013**: When an MCP result has text parts, the service shall join them with newlines as the result text, followed by one bracket pair per part that is not text, joined by a space and set after the text with a space, naming the part's type as `image`, `audio` or `resource`, and as `other` for any other type the server gives, never the server's own string.
- [x] **TOOL-CALL-014**: When an MCP result has no text part and has structured content, the service shall put the serialized structured content before the notes of TOOL-CALL-013, and when it has neither shall publish an empty `content`.
- [x] **TOOL-CALL-015**: When the result text is longer than `tools.max_result_chars` (default 1500), the service shall cut it to that length ending in `…` and set `truncated` to true.
- [x] **TOOL-CALL-016**: When an MCP server flags a result as an error, the service shall publish an `error` result with reason `tool_error` and keep the server's text.
- [x] **TOOL-CALL-017**: When a tool fails for a reason of the service's own (a missing credential, no answer from the memory service), the service shall publish an `error` result with reason `unavailable`.
- [x] **TOOL-CALL-018**: The `content` of a `refused`, `timeout` or `unavailable` result shall be a sentence the service wrote and no text from a server.
- [x] **TOOL-CALL-019**: The `tool.result` shall carry `id`, `tool`, `status`, `reason` where one applies, `content`, `truncated` where set, `durationMs` from the moment the service read the request, and, in mock mode, `mock` true.
- [x] **TOOL-CALL-020**: The service shall not retry a call.
- [x] **TOOL-CALL-021**: A call whose arguments serialize to more than 64 KiB (65536 UTF-8 bytes) shall be refused with reason `invalid_arguments` and shall not reach the server.
- [x] **TOOL-CALL-022**: While a `tool.request` with an `id` is admitted, a further `tool.request` with that `id` shall publish no result, be logged at `warn`, and leave the admitted request untouched, so that each admitted request has one result.

## Confirming an acting call (TOOL-CONF)

- [x] **TOOL-CONF-001**: When a request whose tool has the effect `acts` and is not the built-in `timer` has passed the look-up and admission, the service shall publish `tool.confirm` with the request's `id`, the tool, its arguments, the origin and `expiresAt`, unless TOOL-CONF-006 applies, and shall publish it for a request that carries `injected` whatever its `confirm` mark and `listed`.
- [x] **TOOL-CONF-002**: The `expiresAt` of a `tool.confirm` shall be the moment the service read the request plus `tools.confirm_timeout_ms` (default 20000), in epoch milliseconds.
- [x] **TOOL-CONF-003**: When a `tool.answer` with `allow` true arrives for a pending call, the service shall send the call and start the call limit then.
- [x] **TOOL-CONF-004**: When a `tool.answer` with `allow` false arrives for a pending call, the service shall publish a `refused` result with reason `denied`.
- [x] **TOOL-CONF-005**: If no `tool.answer` arrives for a pending call by its `expiresAt`, then the service shall publish a `refused` result with reason `unconfirmed` and never a `timeout` result.
- [x] **TOOL-CONF-006**: Where the tool's `confirm` mark is false, the request's round is 1, it carries no `injected`, and its origin is `dashboard` or is `speech` with `listed` true, the service shall run the call without publishing `tool.confirm`.
- [x] **TOOL-CONF-007**: The service shall accept a `tool.answer` only for a call that is pending and shall accept one answer per call, and shall ignore an answer for an unknown, finished or already answered `id` or one that arrives after `expiresAt`.
- [x] **TOOL-CONF-008**: While `tools.mode` is `mock`, the service shall run a call that would wait for a confirmation at once, without publishing `tool.confirm`.

## MCP servers (TOOL-MCP)

- [x] **TOOL-MCP-001**: The service shall reach an MCP server only over the protocol's Streamable HTTP transport and shall start no process for a server.
- [x] **TOOL-MCP-002**: When the service starts in live mode, it shall connect to every server in `tools.servers`, including one with no enabled tool, initialize a session and list its tools.
- [x] **TOOL-MCP-003**: When a server's connection drops or a request to it fails, the service shall reconnect with the shared retry-with-backoff, and meanwhile keep the server's tools in the catalog with their last known definitions and not offer them. A connection that stays up less than 10 seconds counts as a failure toward the backoff, and only a connection that stays up for 10 seconds or more resets it; a GET stream that ends on its own shall be reopened on the backoff only after a `ping` to the server is answered, and a `ping` that is not answered drops the connection.
- [x] **TOOL-MCP-004**: The service shall list a server's tools again when the server announces a change and every `tools.catalog_ms`, one list at a time. The next list starts no sooner than the greater of one second (`env.mcp.relistGapMs` in tests) and four times the duration of the last list after that last list ends, so a slow list stretches the gap; a change announced while a list runs or waits causes one more list after it, and no more. The catalog is published only when the listed tools changed.
- [x] **TOOL-MCP-005**: The service shall send a server's secret in the header named by `tools.servers.<name>.header`, `Authorization` when the name is blank or absent, with the value `Bearer <token>` when the header is `Authorization` (compared without regard to case) and the token as written for any other header; a token a header cannot carry (a control character, or a character above U+00FF) shall never be sent, and the server's `detail` shall say so.
- [x] **TOOL-MCP-006**: When a server answers `401` or `403`, the service shall give it the state `auth`, report it as a `down` dependency, and leave the state when a later reconnect succeeds.
- [x] **TOOL-MCP-007**: The service shall write no server secret, no userinfo and no query string of a server URL to an event, a catalog entry, a log line, a heartbeat detail or an error text.
- [x] **TOOL-MCP-008**: Where a server's URL is `http`, its host is off the LAN and a secret is set, the service shall put `credential sent without TLS` in the server's `detail` and shall still connect.
- [x] **TOOL-MCP-009**: The service shall mark a server `external` when its host is off the LAN by the LAN rule or when `tools.servers.<name>.external` is `true`.
- [x] **TOOL-MCP-010**: While a server has at least one enabled `tools.allow` entry naming it, listed or not, the heartbeat shall carry the dependency `mcp.<name>` as `ok` while the server is connected, `down` while it is not (including `auth`) and `n/a` in mock mode, and shall carry no dependency for a server with no such entry; an entry names a server when its key begins with the server's name and `__`.
- [x] **TOOL-MCP-011**: When the service starts in live mode, it shall log one warning for each egress entry of `tools` whose `offLan` is true, naming the server and the host.
- [x] **TOOL-MCP-012**: When an MCP server's response body is longer than 1 MiB, the service shall stop reading it at 1 MiB and hang up; a tool call whose response is so cut shall end `error` with reason `unavailable` and a sentence saying the server's response was too large, and nothing of the partial body shall be parsed or shown.
- [x] **TOOL-MCP-013**: The service shall follow no redirect on the MCP transport: a 3xx answer is an error for that call, and the secret header is sent only to the configured URL.
- [x] **TOOL-MCP-014**: When the service makes the initialize or the tools/list request of a connection attempt, it shall give that request a setup timeout of 10 seconds, and a request with no answer by then shall be aborted and count the attempt as failed.
- [x] **TOOL-MCP-015**: When a server's tools/list is paged, the service shall follow its `nextCursor` for at most 50 pages and at most 10 000 entries in all; a cursor that is not a non-empty string, a repeated cursor, or a list beyond either limit shall fail the list.
- [x] **TOOL-MCP-016**: When a server's tools/list response is longer than 1 MiB, the service shall fail the list and list none of its tools, before `tools.max_tools_per_server` is applied.
- [x] **TOOL-MCP-017**: When a server's list names one tool more than once, the service shall list only the first definition of that name.
- [x] **TOOL-MCP-018**: When a listed tool's `inputSchema` is not a JSON object, the service shall leave the tool out; a schema that serializes to more than 4000 characters or nests more than 64 levels deep is left out and counted in the server's `detail` as TOOL-CAT-002 states, and the other tools of that list and of the other servers are unaffected.
- [x] **TOOL-MCP-019**: When a listed tool's `readOnlyHint` annotation is not a boolean, the service shall give the tool the label `unlabelled`.
- [x] **TOOL-MCP-020**: When a listed tool's `title` is not a string, the service shall carry no title for it.
- [x] **TOOL-MCP-021**: The service shall declare no client capability at initialize; it shall answer a `ping` a server sends it with an empty result, and every other request a server sends it with a JSON-RPC error, never a result. It shall answer at most one such request at a time and five in any second, and shall drop the rest unanswered.
- [x] **TOOL-MCP-022**: The service shall never use a legacy `endpoint` event of a server to choose the address of a request, so that every request goes to the configured URL.
- [x] **TOOL-MCP-023**: The service shall never fetch a resource link in a tool result, and shall report the link only as a note of its type.
- [x] **TOOL-MCP-024**: When a response's JSON-RPC id is not the id of the request it answers, the service shall not take it as that request's answer.
- [x] **TOOL-MCP-025**: When calls run at once on one session, the service shall answer each call with the response whose JSON-RPC id is that call's request id.
- [x] **TOOL-MCP-026**: When a server answers 404 to a request that carries its session id, the service shall fail that request, start a new session, and shall not retry the call that failed, which ends `error` with reason `unavailable`. A 404 on the GET stream of a session is answered by a `ping`: the connection is dropped only if the ping fails; a 404 on a GET that carries no session id is no stream, and the connection stays up.
- [x] **TOOL-MCP-027**: When a server answers a `tools/call` with a JSON-RPC error, the service shall end the call `error` with reason `tool_error` and a sentence it wrote, and shall keep the session.
- [x] **TOOL-MCP-028**: When a call passes its call limit, the service shall not reconnect the server.

## Built-in tool: clock (TOOL-CLOCK)

- [x] **TOOL-CLOCK-001**: When `clock` is called, the service shall answer with one sentence of the form `It is HH:mm:ss on <weekday>, YYYY-MM-DD in <zone>.`, the time, date, weekday and zone being those of the current time in the zone named by `cohost.timezone`, and shall ignore any arguments.

## Built-in tool: stream info (TOOL-STRM)

- [x] **TOOL-STRM-001**: The `stream_info` tool shall take an optional argument `platform` of `twitch` or `youtube`, answering for that platform when it is given and for every platform that has a channel or video configured when it is not.
- [x] **TOOL-STRM-002**: When `stream_info` answers for a platform, it shall state whether the stream is live and, while it is, the title, the viewer count and how long it has been live, and for Twitch the category.
- [x] **TOOL-STRM-003**: For Twitch the service shall call Get Streams for `chat.twitch.channel` with `chat.twitch.client_id` and an app access token it obtains and refreshes with `chat.twitch.client_secret`, and shall use no user token.
- [x] **TOOL-STRM-004**: For YouTube the service shall look up the video that `parseVideoValue` reads from `chat.youtube.video`, with `chat.youtube.api_key`.
- [x] **TOOL-STRM-005**: The `stream_info` tool shall return one result: `ok` when at least one platform answered, with a sentence in its text naming each platform that did not and why, and an `error` result with reason `unavailable` when none answered, including when no platform is configured. Each platform's call has its own deadline of the built-in wait (TOOL-MEM-005); a platform that does not answer before it is one failed platform, and the other platform's answer still counts.
- [x] **TOOL-STRM-006**: The service shall cache a `stream_info` answer for a platform for `tools.stream_info.cache_ms` (default 30000), answer a repeated call from the cache and cache no failed call.
- [x] **TOOL-STRM-007**: While `stream_info` is enabled, the heartbeat shall carry `stream.twitch` and `stream.youtube` as `ok` after an answer, `down` after a failed call, and `n/a` before the platform's first call, for a platform whose channel, video or credentials are missing, and in mock mode; it shall carry neither while `stream_info` is not enabled.
- [x] **TOOL-STRM-008**: The service shall send a platform only the channel or video id and the credential and no chat text.

## Built-in tool: memory lookup (TOOL-MEM)

- [x] **TOOL-MEM-001**: The `memory_lookup` tool shall take a text argument `query` and an optional integer `k` from 1 to 8, default 4.
- [x] **TOOL-MEM-002**: When `memory_lookup` is called, the service shall publish `memory.recall.request` with a fresh uuid `id`, the query and `k`, and shall read no database.
- [x] **TOOL-MEM-003**: The service shall take as the answer the `memory.recall.reply` whose `id` equals its request's and shall ignore every other reply.
- [x] **TOOL-MEM-004**: The service shall render each recalled memory as one line `- (YYYY-MM-DD) <who>: <text>`, the date in `cohost.timezone`, with `who` through `speakerLabel` at `viewer_text.max_name_chars`; a `chat` or `note` memory's text is an untrusted quote through `quoteUntrusted` at `viewer_text.max_chars`, so a quote mark in it cannot close the quote within the tool result (the prompt's outer quote for the whole result is the prompt-level guard, SHARED-GUARD-028), and a `speech` or `self` memory's text is bounded with `boundText` at `brain.input_limits.speech_max_chars`, as cortex renders it. The lookup searches the memories of every viewer, as cortex recall does.
- [x] **TOOL-MEM-005**: The built-in wait of a lookup, and of each platform call of `stream_info` (TOOL-STRM-005), shall end at `min(floor(0.9 × tools.timeout_ms), 2^31−1)` milliseconds after it starts, so before the call limit (TOOL-CALL-010) ends the call. If no matching `memory.recall.reply` arrives before the lookup's wait ends, then `memory_lookup` shall end with an `error` result of reason `unavailable`; a reply that arrives later shall change nothing, and the wait shall be cancelled once the call ends.
- [x] **TOOL-MEM-006**: While `memory_lookup` is enabled, the heartbeat shall carry `memory` as `ok` after an answer, `down` after a lookup that got none, and `n/a` before the first and in mock mode; it shall carry no `memory` dependency while `memory_lookup` is not enabled.

## Built-in tool: timer (TOOL-TIMER)

- [x] **TOOL-TIMER-001**: The `timer` tool shall take an integer `minutes` from 1 to `tools.timer.max_minutes` (default 120) and a required text `note`, and shall bound the note with `boundText` at 200 characters, which also collapses line breaks, removes control and bidi characters and ends a cut with `…`.
- [x] **TOOL-TIMER-002**: If `minutes` is not an integer in its range, or `note` is missing, not text or empty after trimming, then the `timer` tool shall be refused with reason `invalid_arguments`.
- [x] **TOOL-TIMER-003**: When `timer` starts a timer, it shall answer with one sentence of the form `Timer set. It fires at HH:mm on <weekday>, YYYY-MM-DD (<zone>).`, the time being the due time in the zone named by `cohost.timezone`.
- [x] **TOOL-TIMER-004**: While `tools.timer.max_active` (default 5) timers are pending, a further `timer` call shall end with an `error` result of reason `limit`. A `timer` call shall count the stored timers first: it waits until they are read at start, and a call the pipeline has already ended while it waits (its call limit or the service stopping) shall store and arm nothing.
- [x] **TOOL-TIMER-005**: When a timer starts in live mode, the service shall store it in the Redis hash `<prefix>:tools:timers` under the field `id` with the JSON `{id, note, setAt, dueAt}` and no other member.
- [x] **TOOL-TIMER-006**: When a timer runs out, the service shall publish `tool.timer` with its `id`, `note`, `setAt` and `dueAt` and then delete its field from the hash.
- [x] **TOOL-TIMER-007**: When the service starts in live mode, it shall read the hash and publish `tool.timer` at once, oldest `dueAt` first and whatever the lateness, for each timer already due and delete it from the hash as TOOL-TIMER-006 says, and keep each other timer until its `dueAt`. A field is not a timer, and is skipped without stopping the other timers, when its value is not a JSON object of the four members of TOOL-TIMER-005, when its `id` is not the field, when its `note` is not text that is non-blank after trimming, or when its `setAt` or `dueAt` is not a safe integer; the skipped field stays in the hash.
- [x] **TOOL-TIMER-008**: The service shall provide no tool to cancel or list timers.

## Mock mode (TOOL-MOCK)

- [x] **TOOL-MOCK-001**: While `tools.mode` is `mock`, the service shall open no connection to an MCP server or a platform, publish no `memory.recall.request` and use no Redis key other than the bus stream and its own consumer group.
- [x] **TOOL-MOCK-002**: While `tools.mode` is `mock`, the state of every configured server in the catalog shall be `mock`.
- [x] **TOOL-MOCK-003**: While `tools.mode` is `mock`, each `tools.allow` entry named `<server>__<tool>` for a configured server shall be a tool with the description `a mock tool`, an argument schema that accepts any object and the label of the entry's `effect` key, `read` when absent.
- [x] **TOOL-MOCK-004**: While `tools.mode` is `mock`, a call to an MCP tool shall answer `mock <name> answered` followed by the arguments as JSON.
- [x] **TOOL-MOCK-005**: While `tools.mode` is `mock`, `clock` shall behave as in live mode, `stream_info` shall answer a live stream titled `Mock stream` with 42 viewers and one hour, and `memory_lookup` shall answer one fixed memory line.
- [x] **TOOL-MOCK-006**: While `tools.mode` is `mock`, `timer` shall keep its timers in the service's memory and publish `tool.timer` for each when it is due.
- [x] **TOOL-MOCK-007**: While `tools.mode` is `mock`, every `tool.result` shall carry `mock` true.
- [x] **TOOL-MOCK-008**: While `tools.mode` is `mock`, the service shall offer a mock tool only for an enabled entry and shall apply the marks, the origin rules, the call limit and the result limit as in live mode.

## Test injection (TOOL-INJ)

- [x] **TOOL-INJ-001**: When an `inject.request` with target `tools` and kind `text` arrives, the service shall read its text as the JSON `{"tool", "arguments"}` and run the call through the pipeline with origin `dashboard`, round 1, `listed` false and `injected` true.
- [x] **TOOL-INJ-002**: When an injected call has produced a `tool.result`, the service shall answer `inject.result` with `ok` true and a `detail` giving the status and the duration, whatever the status.
- [x] **TOOL-INJ-003**: If the text of an injection for `tools` is not that JSON, then the service shall answer `inject.result` with `ok` false and a `detail` naming the problem and shall publish no `tool.result`.

## Hardening of the built-in tools (TOOL-STRM, TOOL-MEM, TOOL-TIMER)

The built-in tools validate their inputs, bound and quote the text they show, and confine their platform calls as the lines below state.

- [x] **TOOL-STRM-009**: The service shall bound each stream title and category it shows with `boundText` at 100 characters and show it as an untrusted quote through `quoteUntrusted`, so that a quote mark in it cannot close the quote within the tool result (the prompt's outer quote for the whole result is the prompt-level guard, SHARED-GUARD-028), and the text is one line with no control or bidi character. A category that is blank after this bound is not shown.
- [x] **TOOL-STRM-010**: If `stream_info` is given a `platform` other than `twitch` or `youtube`, then it shall refuse the request with reason `invalid_arguments` and call no platform.
- [x] **TOOL-STRM-011**: When a platform reports that its channel or video is not live, the service shall answer `ok` with a sentence saying so, and shall not treat it as a failure.
- [x] **TOOL-STRM-012**: The service shall read a platform's response body only up to 1 MiB; a longer body shall be dropped and count as a failed platform.
- [x] **TOOL-STRM-013**: The service shall send the YouTube API key in the `x-goog-api-key` header and never in the request URL.
- [x] **TOOL-STRM-014**: The service shall call only `https` URLs on `id.twitch.tv`, `api.twitch.tv` and `www.googleapis.com`, shall follow no redirect, shall count a 3xx answer as a failed platform, and shall give every platform request an abort signal.
- [x] **TOOL-STRM-015**: The service shall keep every credential and token out of results, events, log lines and heartbeats, and any platform's error text out of its results: a failed platform is described by a sentence the service wrote.
- [x] **TOOL-MEM-007**: If `memory_lookup` is given a `query` that is blank after trimming, it shall refuse the request with reason `invalid_arguments` and publish no `memory.recall.request`; a `query` longer than `viewer_text.max_chars` shall be cut to that length before it is published.
- [x] **TOOL-MEM-008**: The service shall render at most `k` memory lines, and an empty answer shall be an `ok` result whose content is one sentence with no memory line.
- [x] **TOOL-TIMER-009**: If `tool.timer` cannot be published when a timer runs out, then the service shall leave the timer's field in the hash and shall not delete it, so that it fires at the next start; no retry runs while the service is up.
- [x] **TOOL-TIMER-010**: A timer whose delay is longer than 2^31−1 milliseconds shall be armed in steps of at most 2^31−1 milliseconds and shall fire only at its `dueAt`. A `timer` call whose due time would be past the latest instant a Date holds (8.64e15 epoch milliseconds) shall be refused as `invalid_arguments` at look-up, before anything is stored or armed; if the clock passes that bound while the call waits for the stored timers, the call shall end with an `error` result of reason `unavailable` and store and arm nothing. Any `tools.timer.max_minutes` up to the largest delay whose due time that holds works, with no configuration change.
