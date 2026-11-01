## ADDED Requirements

### Requirement: Injected text messages
The system SHALL subscribe with consumer group `chat` to `inject.request` and, for `target: "chat"` and `kind: "text"`, publish `chat.message` with `injected: true`, `remember` from the request, `text` whitespace-collapsed and trimmed, `user` = `meta.user` or `injected_viewer`, `platform` = `meta.platform` or `twitch`, `isMod`/`isSub` from `meta` (default false) and `mentionsCohost` computed from `cohost.name` as for real messages, then publish `inject.result {id, ok:true}`. The `chat.ignore_users` and `chat.ignore_prefixes` rules MUST NOT be applied. This MUST work regardless of `chat.source` and with no Twitch channel. Requests whose envelope `ts` is more than 60 s old, requests with another target/kind, and blank text SHALL yield `inject.result {ok:false, detail}` (ignored silently when the target is another service).

#### Scenario: Viewer fields
- **WHEN** `{target:"chat", kind:"text", text:"hi", meta:{user:"bob", isMod:true}, remember:false}` arrives
- **THEN** `chat.message {platform:"twitch", user:"bob", text:"hi", isMod:true, isSub:false, injected:true, remember:false}` and `inject.result {ok:true}` are published

#### Scenario: Ignore rules bypassed
- **WHEN** the injected text starts with an ignored prefix such as `!`
- **THEN** it is still published

#### Scenario: Mention
- **WHEN** the text contains `cohost.name` case-insensitively
- **THEN** `mentionsCohost` is true

#### Scenario: Blank text
- **WHEN** the text is whitespace only
- **THEN** no `chat.message` is published and `inject.result {ok:false}` is published

#### Scenario: Isolated chat
- **WHEN** `chat.source` is `fake` or the Twitch channel is empty
- **THEN** injection is still handled

#### Scenario: Stale request
- **WHEN** a request is more than 60 s old at handling time
- **THEN** `inject.result {ok:false, detail:"stale"}` is published and nothing else

#### Scenario: Other target
- **WHEN** `target` is `eyes`
- **THEN** chat publishes nothing
