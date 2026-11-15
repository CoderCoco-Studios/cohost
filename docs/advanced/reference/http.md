---
title: HTTP routes
description: Every HTTP route of the dashboard, the voice service and the ears capture endpoint, with methods, bodies, status codes and who may call them.
track: advanced
verified: f126b94
---

# HTTP routes

Three services speak HTTP: the [dashboard](../../guide/operate/dashboard.md) (the operator's surface), `voice` (the audio) and `ears` (an optional capture endpoint). Everything else talks over the [bus](../../start/glossary.md#bus). Ports are on [Environment and ports](env.md).

## Who may call what

- **Control routes need the bearer token while control is on.** With `CONTROL_ENABLED=1` (the default in `.env.example`), every route marked "token" below needs `Authorization: Bearer <CONTROL_TOKEN>` and answers `401` without it. With control off, the service and stack action routes answer `404`.
- **Viewers routes always need `VIEWERS_TOKEN`**, whatever `CONTROL_ENABLED` says. With the variable unset, every `/viewers` route answers `403`.
- **Browser requests are checked.** A `POST`, `PUT` or `DELETE` that carries an `Origin` header must match the request's own host. While the full dashboard is bound to loopback, which is the default, it also requires the `Host` header to name a loopback address. Both checks answer `403` and stop a web page you visit from steering your dashboard.
- **Bodies are capped.** A body over a route's limit answers `413`.

The full dashboard listens on `DASHBOARD_PORT` (3000). A second listener on `DASHBOARD_LAN_PORT` (3001, all interfaces) serves only `GET /`, `GET /audio/<id>.wav`, `POST /sink` and `GET /health`, and answers `404` to everything else, so a second PC can host the [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source) without reaching the controls.

## Dashboard: page, audio and feed

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /` | none | The dashboard page. The [sink](../../start/glossary.md#sink) page is the same page with `?sink=1` |
| `GET /ws` | none | The WebSocket live feed of bus [events](../../start/glossary.md#event) (the memory note and viewer events are not sent) |
| `GET /audio/<id>.wav` | none | The audio of one utterance, fetched from `voice` and sent without caching |
| `POST /sink` | none | A sink page reports playback: body `{"event": "playing" or "done", "id": "..."}`. Publishes `voice.playing` or `voice.done` with sink `dashboard`. Answers `204`, or `400` for any other `event` |
| `GET /health` | none | `ok` |
| `GET /cohost/…`, `HEAD /cohost/…` | none | The built documentation site, served on the full-surface listener only (not on the second listener). It answers with the pages built by `pnpm docs:build`, or, while the site is not built, with a page that says so and names `pnpm docs:build`. See [Service health](../../guide/operate/health.md) for the one page that reads `GET /services` live |
| `GET /personality` | none | The text of `personality.md` |
| `PUT /personality` | token | Replaces `personality.md` with the request body and publishes `control` with `reload_personality`. Answers `204` |

## Dashboard: operator controls

| Route | Auth | Body | What it does |
| --- | --- | --- | --- |
| `POST /control` | token | `{"cmd": "...", "text": "...", "target": "...", "route": ["..."]}` | Publishes a `control` event. `cmd` is `mute`, `unmute`, `say`, `forget_context`, `reload_personality`, `pause`, `resume` or `set_routing`. `text` is for `say`, `target` addresses one service, and `route` names the mouth outputs for `say`. Answers `204` |
| `POST /mouth/routing` | token | `{"outputs": {"discord": {"enabled": true, "gain_db": 0}}}` | Re-routes `mouth` outputs without a restart by sending it a `set_routing` command. At least one output is required; `gain_db` is -40 to 12. Answers `204`, or `400` with the reason |

```bash
curl -XPOST localhost:3000/control -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' -d '{"cmd":"say","text":"hi"}'
```

## Dashboard: services and stack

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /services` | none | `{"services": [...]}`: the derived health of each service: state, mode and dependencies, from [heartbeats](../../start/glossary.md#heartbeat) |
| `GET /services/manifest` | none | `{"units": [...]}`: each unit's config sections, the units it uses and requires, whether it honours `pause`, its test inputs and the event types that show its reaction |
| `GET /services/control` | none | `{"enabled": true, "runtime": "...", "advanced": false}`, or `{"enabled": false}` |
| `POST /services/<id>/start`, `/stop`, `/restart` | token | Runs the action on one service. An optional body `{"mode": "resume" or "fresh", "isolated": true}` picks the start mode and the isolation presets. Answers `200 {"ok": ...}`, `404` for an unknown service, `403` for `redis` or `postgres` while `CONTROL_ADVANCED` is off, `409` while another action holds the lock or for the dashboard itself, `400` for a malformed body |
| `GET /stack` | none | The stack's state: [Docker](../../start/glossary.md#docker) reachability, the [containers](../../start/glossary.md#container) and the running action |
| `POST /stack/launch`, `/rebuild`, `/stop`, `/restart`, `/consolidate` | token | Starts a whole-stack action and answers `202 {"ok": true, "action": "..."}` at once; progress shows in `GET /stack`. Answers `409` while another action runs |

Only service ids in the manifest are accepted, and nothing from a request reaches a command line except by choosing one of them. The dashboard and `cohostctl` share one lock, so while one runs an action the other refuses. See [Commands](commands.md).

## Dashboard: settings

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /config/schema` | none | Every settings section with the services that read it, its JSON Schema and its secret keys |
| `GET /config/<section>` | none | The section's keys with their effective values and where each comes from, plus an `etag` of the file. Secret values are never returned |
| `PUT /config/<section>` | token | Body `{"etag": "...", "values": {...}}`. Validates against the schema, writes `config.yaml` in place (comments and `${VAR}` placeholders kept) and answers `200 {"ok": true, "etag": "...", "restart": [...], "warnings": [...]}`, where `restart` lists the running services that read the section. `400` carries the schema `issues`; `409` means the file changed under you and carries the current `etag`. Add `?dryRun=1` to validate without writing |

The route never touches `.env` and never starts or restarts a service. See [Configuration](config.md) for the keys.

## Dashboard: test inputs

All inject routes need the token while control is on. Each answers `202 {"id": "..."}`, or `409` when the service the input is for is not running (`service not running: <unit>`).

| Route | Body or query | What it does |
| --- | --- | --- |
| `POST /inject/text` | JSON `{"level": "service" or "bus", "as": "chat", "speech" or "vision", "text": "...", "user", "platform", "isMod", "isSub", "remember", "source"}` | `service` level asks `chat` to publish the line through its real path and supports only `as: chat`. `bus` level publishes `chat.message`, `speech.heard` or `vision.summary` directly with `injected: true`. `source` names a listening source and is only for `level: bus` with `as: speech`. `text` must be non-blank |
| `POST /inject/image` | The image as the body, with `Content-Type` of `image/png`, `image/jpeg` or `image/webp`. Query `user`, `remember` | Stores the upload in [Redis](../../start/glossary.md#redis) and asks `eyes` to describe it. `415` for another type, `413` over `INJECT_MAX_IMAGE_BYTES`, `400` for an empty body, `503` if the upload store is unavailable |
| `POST /inject/audio` | The clip as the body, with `Content-Type` of `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/ogg`, `audio/webm` or `audio/mp4`. Query `target` (`ears`, the default, or `connector-discord`), `source` (a source tag, for `ears` only), `user`, `remember` | Stores the upload in Redis and asks the target to treat it as heard audio. `413` over `INJECT_MAX_AUDIO_BYTES` |
| `POST /inject/event` | JSON `{"unit": "...", "type": "...", "data": {...}}`, at most 64 KiB | Publishes one bus event that the unit declares as a test input, after checking the unit, the type and the payload against the event's schema. `400` otherwise, with the schema `issues` |

Results of the service-level routes arrive later as `inject.result` events. See [Fake inputs](../testing/inject.md).

## Dashboard: viewers

Every route needs `VIEWERS_TOKEN`. `{key}` is a viewer's key as the list returns it, URL-encoded.

| Route | Body | What it does |
| --- | --- | --- |
| `GET /viewers` | Query `q` (optional) | Lists viewers, filtered by `q` |
| `GET /viewers/{key}` | | One viewer with every stored note |
| `POST /viewers/{key}/notes/{noteId}/delete` | Optional `{"reason": "..."}` | Deletes a note. A reason stops the co-host re-learning similar notes |
| `POST /viewers/deletions/{deletionId}/restore` | | Undoes a deletion |
| `POST /viewers/{key}/clear` | Optional `{"reason": "..."}` | Clears all of a viewer's notes |
| `POST /viewers/regular` | `{"regular": true, "key": "..." or "name": "..."}` | Marks someone as a regular, even before they have chatted |
| `POST /viewers/links` | `{"discordId": "...", "key": "..." or "name": "..."}` | Links a Discord user id to a chat viewer |
| `POST /viewers/links/{discordId}/delete` | | Removes the link |

Each route sends a `memory.viewers.request` and answers with the matching `memory.viewers.reply`.

## Voice

The `voice` service answers `GET` and `HEAD` only (`405` otherwise) on port 8700.

| Route | What it does |
| --- | --- |
| `GET /audio/<id>.wav` | The WAV of one utterance, `200` with `audio/wav`, or `404` once it has expired |
| `GET /fallback/manifest.json` | The list of spoken fallback clips |
| `GET /fallback/<name>` | One fallback clip |
| `GET /health` | `ok` |

## Ears: capture endpoint

Active when `ears.sources` includes `http`. It listens on `ears.http.host` and `ears.http.port` (`127.0.0.1:8765` by default) and answers one clip at a time.

`POST /audio` carries one clip. The body is a 16-bit WAV (`audio/wav`, `audio/x-wav` or `audio/wave`) or raw 16-bit PCM (`audio/L16` or `audio/pcm`) whose `rate` and `channels` parameters default to 16000 and 1, such as `audio/L16; rate=24000; channels=1`. Bodies are capped at 25 MiB. Query parameters: `speaker` (a name; defaults to the source) and `source` (a [connector](../../start/glossary.md#connector) tag that takes audio over HTTP; defaults to `http`). With `ears.http.token` set, the request needs `Authorization: Bearer <token>`.

| Status | Meaning |
| --- | --- |
| `200 {"heard": true, "text": "..."}` | The clip was transcribed and published as `speech.heard` |
| `200 {"heard": false, "reason": "..."}` | The clip was dropped, for example as a known silence phrase |
| `400` | An unknown `source`, or audio that does not decode |
| `401` | The bearer token is missing or wrong |
| `404`, `405` | A path other than `/audio`, or a method other than `POST` |
| `408`, `413` | The body arrived too slowly, or is over the size cap |
| `415` | An unsupported content type |
| `502` | The [STT](../../start/glossary.md#stt) server failed |
| `503` | Too many clips are waiting |

```bash
curl -X POST -H 'Content-Type: audio/wav' --data-binary @clip.wav 'http://127.0.0.1:8765/audio?speaker=Chris'
```
