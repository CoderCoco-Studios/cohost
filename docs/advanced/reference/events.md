---
title: Bus events
description: Every event type on the bus, who publishes and reads it, and its payload fields.
track: advanced
verified: f126b94
---

# Bus events

Services never call each other. They publish [events](../../start/glossary.md#event) on the [bus](../../start/glossary.md#bus), which is built on [Redis Streams](../../start/glossary.md#redis-streams), and read the types they care about through [consumer groups](../../start/glossary.md#consumer-group). The registry of types and their payload schemas is `EventPayloads` in `packages/bus/src/events.ts`; this page is its readable form. `bus-pub --list` prints the type names.

Every event has the same envelope: `id` (the stream id, such as `1718000000000-0`), `type`, `ts` (epoch milliseconds), `source` (the publishing service) and `data` (the payload below). Domain events live on the stream `cohost:events`. `service.heartbeat` has its own capped stream, `cohost:health`, so it never crowds out the feed.

`Bus.publish` checks every payload against its schema before it reaches the stream, so a typo fails at the publisher. Fields marked "optional" can be left out, and fields shown with a default are filled in when omitted. A field named `injected` is set to `true` on test inputs; `remember` says whether `memory` should keep an injected event.

## Chat, senses and speech

| Type | Published by | Read by | Payload |
| --- | --- | --- | --- |
| `chat.message` | `chat`, the dashboard (bus-level injection) | `salience`, `affect`, `cortex`, `memory` | `platform` (`twitch`, `youtube` or `discord`), `user`, `userId` (optional), `text`, `isMod` (false), `isSub` (false), `mentionsCohost` (false), `injected`, `remember` |
| `vision.summary` | `eyes`, the dashboard | `salience`, `affect`, `cortex` | `text`, `changed` (true when materially different from the last summary), `timing` (optional), `injected`, `remember` |
| `speech.heard` | `ears`, the dashboard | `salience`, `affect`, `cortex`, `memory` | `speaker`, `speakerId` (optional), `text`, `durationMs`, `timing` (optional), `source` (the listening source: a [connector](../../start/glossary.md#connector) tag, `http` or `dir`), `utteranceId` (ties the final to its partials), `injected`, `remember` |
| `speech.partial` | `ears` | The dashboard feed | `speaker`, `speakerId` (optional), `source`, `text` (the words firmed up so far), `utteranceId`, `seq`, `timing` (optional). A later partial replaces it and `speech.heard` ends it |

## The brain

| Type | Published by | Read by | Payload |
| --- | --- | --- | --- |
| `attention.focus` | `salience` | `cortex` | `reason` (free text, such as `mentioned`), `score`, `focus` (optional: `kind` of `chat`, `speech` or `vision`, `who`, `text`, `mention`), `timing`, `injected`, `remember` |
| `affect.state` | `affect` | `salience`, `cortex`, `avatar` | `valence` (-1 to 1), `arousal` (0 to 1), `mood` (the nearest emotion), `cause` (optional) |
| `brain.say` | `cortex`, `salience` (a [reflex](../../start/glossary.md#reflex)), the dashboard (unit-level injection) | `voice`, `avatar`, `affect`, `salience`, `cortex`, `memory` | `id`, `text`, `emotion`, `gesture` (optional), `reason` (optional), `route` (optional: the mouth outputs this line is for; absent means every enabled output), `timing`, `injected`, `remember` |
| `brain.status` | `cortex` | `salience`, `memory` | `state` (`idle`, `thinking`, `speaking` or `muted`), `detail` (optional) |
| `memory.recall.request` | `cortex` | `memory` | `id`, `query`, `k` (optional) |
| `memory.recall.reply` | `memory` | `cortex` | `id`, `memories[]`: `ts`, `kind` (`chat`, `speech`, `self` or `note`), `who`, `text`, `similarity` (optional). An empty list is a valid answer |
| `memory.viewer` | `memory` | `cortex` | `user`, `isNew`, `msgCount`, `regular`. Carries no note text |
| `memory.notes.request` | `cortex` | `memory` | `id`, `users[]` (at least one; the first is the viewer being replied to) |
| `memory.notes.reply` | `memory` | `cortex` | `id`, `viewers[]`: `user`, `regular`, `msgCount`, `notes[]` of `layer` (`core` or `recent`), `category` (`general`, `health` or `family`), `text` (absent for health and family notes), `hint`, `strength`. Never forwarded to the dashboard's browser feed |
| `memory.viewers.request` | The dashboard | `memory` | `id` and an `op`: `list` (optional `query`), `get` (`key`), `delete_note` (`noteId`, optional `reason`), `restore` (`deletionId`), `clear` (`key`, optional `reason`), `set_regular` (`regular` and a `key` or `name`), `link_discord` (`discordId` and a `key` or `name`) or `unlink_discord` (`discordId`). Never forwarded to the browser feed |
| `memory.viewers.reply` | `memory` | The dashboard | `id`, `ok`, `error` (optional: `not_found` or `failed`), `detail` (optional), `data` (the operation's result) |

## Voice and avatar

| Type | Published by | Read by | Payload |
| --- | --- | --- | --- |
| `voice.utterance` | `voice` | `avatar`, `mouth` | `id`, `text`, `emotion`, `gesture` (optional), `route` (optional, copied from `brain.say`), `durationMs`, `envelopeHz`, `envelope[]` (mouth-open level per frame, 0 to 1), `audioUrl` (`/audio/<id>.wav` on the voice service), `sampleRate` |
| `voice.playing` | A [sink](../../start/glossary.md#sink): `mouth`, the dashboard sink page | `voice`, `avatar`, `mouth`, `ears` (to ignore its own echo) | `id`, `sink` |
| `voice.done` | A sink, or `voice` itself when synthesis fails (sink `error`) | `avatar`, `cortex`, `ears` | `id`, `sink`, and for an interrupted line `interrupted` (true), `spokenText` and `unsaidText` |
| `voice.failed` | A sink | `voice`, `cortex` | `id`, `sink`, `reason`, `fallback` (optional: `clip`, `text`, present exactly when a fallback clip plays for this id) |
| `voice.stop` | `salience` (a barge-in) | `voice`, `mouth`, `cortex` | `reason`, `ids` (optional: the lines to stop; absent means every line) |
| `avatar.state` | `avatar` | The dashboard feed | `emotion`, `intensity`, `mouthOpen`, `mouthSmile`, `headX`, `headY`, `headZ` (degrees), `eyeX`, `eyeY`, `blink` (0 open to 1 closed), `driver`, `connected`. Published at about 5 Hz |

## Operator and test inputs

| Type | Published by | Read by | Payload |
| --- | --- | --- | --- |
| `control` | The dashboard | `affect`, `salience`, `cortex`, `mouth` | `cmd` (`mute`, `unmute`, `say`, `forget_context`, `reload_personality`, `pause`, `resume` or `set_routing`), `text` (for `say`), `target` (the service it is for; absent means every service), `routing` (for `set_routing`: output id to `enabled` and `gain_db`), `route` (for `say`) |
| `inject.request` | The dashboard | The target service | `id`, `target` (`eyes`, `ears`, `chat` or `connector-discord`), `kind` (`image`, `audio` or `text`), `uploadId` (the bytes the dashboard stored in [Redis](../../start/glossary.md#redis)), `contentType`, `text`, `meta` (`user`, `platform`, `isMod`, `isSub`, `source`), `remember`. Binaries never ride the stream |
| `inject.result` | `eyes`, `ears`, `chat`, `connector-discord` | The dashboard | `id` (the request's id), `ok`, `detail` (optional) |
| `service.lifecycle` | The dashboard, `cohostctl` | The dashboard feed | `service`, `action` (`start`, `stop` or `restart`), `by` (`dashboard` or `cohostctl`), `ok`, `detail` (optional). An audit record of each attempt |
| `service.heartbeat` | Every service, on `cohost:health` | The dashboard's health tracker, `cohostctl status` | `service`, `instance` (unique per process), `pid`, `version`, `startedAt`, `state` (`starting`, `ready`, `degraded` or `stopping`), `deps` (name to `ok`, `down` or `n/a`), `mode` (`live`, `mock` or `off` by convention), `detail` (optional), `intervalMs` |

## Timing stamps

`timing` carries epoch-millisecond stamps along the speech and vision paths. Each stage adds its own stamp and never changes one it received, and every member is optional: `audioEndedAt`, `heardAt`, `capturedAt`, `describedAt`, `focusedAt`, `llmStartedAt`, `llmEndedAt` and `criticEndedAt`. `cohostctl latency` turns them into per-stage percentiles; see [Commands](commands.md).

## Reading the table

- "Read by" lists the services whose consumer group subscribes to the type. The dashboard also tails the whole stream for its live feed, which is how most types reach the browser; the memory note and viewer types named above are held back.
- A service that starts from `latest` ignores events published while it was away, and one that resumes picks up where its group stopped. `memory` resumes; `salience`, `affect`, `cortex` and `avatar` start from `latest`.
- `voice.stop` and `voice.done` with `interrupted` come from a barge-in: someone spoke over the co-host while `brain.salience.barge_in` was on.
