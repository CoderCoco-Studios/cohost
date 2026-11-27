---
title: HTTP routes
description: Every HTTP route of the dashboard, the voice service and the ears capture endpoint, with methods, bodies, status codes and who may call them.
track: advanced
verified: 11075e1
---

# HTTP routes

Three services speak HTTP: the [dashboard](../../guide/operate/dashboard.md) (the operator's surface), `voice` (the audio) and `ears` (an optional capture endpoint). Everything else talks over the [bus](../../start/glossary.md#bus). The dashboard's ports are keys in [Configuration](config.md); the other addresses are on [Environment and ports](env.md).

## Who may call what

- **Every route that changes something needs the control token whenever one is set.** With a `CONTROL_TOKEN` configured (the installer writes one), every route marked "token" below needs `Authorization: Bearer <CONTROL_TOKEN>` or an unlocked browser's session cookie and answers `401` without them, whatever `CONTROL_ENABLED` says. `CONTROL_ENABLED=1` (the default in `.env.example`) only switches the service and stack action routes on; with it off they answer `404`. With no `CONTROL_TOKEN` and control off there is nothing to check a request against, so those routes are open on the loopback-only dashboard.
- **The secret write and a change to a sensitive setting need the control token in both modes.** `PUT /secrets/<path>`, `PUT /secrets` and a `PUT /config/<section>` that changes a sensitive key need `Authorization: Bearer <CONTROL_TOKEN>` even with `CONTROL_ENABLED` unset, and answer `403` when no `CONTROL_TOKEN` is configured at all. See [Dashboard: settings](#dashboard-settings).
- **An unlocked browser's session cookie stands in for the control token.** Wherever a route needs `Authorization: Bearer <CONTROL_TOKEN>`, in normal mode and in [config recovery mode](#config-recovery-mode), a valid `cohost_session` cookie counts in its place. The cookie comes from the one-time unlock link (see [Dashboard: unlock](#dashboard-unlock)). A request that carries an `Authorization` header is judged by that header alone, so a wrong token fails even from an unlocked browser. On a request whose method is not `GET`, `HEAD` or `OPTIONS`, the cookie counts only when the request carries an `Origin` header naming its own host, as a browser sends it; a script that sends the cookie without an `Origin` is refused. A program on the same machine is not trusted for being local: the `tools` container reaches the host's loopback through `host.docker.internal`, so the token or the cookie is needed whatever address a request comes from. A browser sends a cookie to every port of the host it was set for, so the session cookie also travels with the browser's requests to the other services on `127.0.0.1` (voice, the speech servers, Ollama, a dev server); they do not use it. The `__Host-` prefix and `Secure`, which would narrow that, need HTTPS, which the dashboard does not serve; the 90-day lifetime, [`POST /unlock/forget`](#dashboard-unlock) and changing `CONTROL_TOKEN` limit it.
- **Viewers routes always need `VIEWERS_TOKEN`**, whatever `CONTROL_ENABLED` says. With the variable unset, every `/viewers` route answers `403`.
- **Browser requests are checked.** A request whose method is not `GET`, `HEAD` or `OPTIONS` (`POST`, `PUT`, `DELETE` and `PATCH` among them), and a `/ws` upgrade, that carries an `Origin` header must be an `http` origin matching the request's own host (a `null`, unparsable or `https` `Origin` fails too); a request without an `Origin` header, as from `curl`, passes. While the full dashboard is bound to loopback, which is the default, it also requires the `Host` header to name a loopback address. On the second (LAN) listener, and on the full dashboard when it is not bound to loopback, every request, a `/ws` upgrade included and with or without an `Origin`, is refused with `403 forbidden` unless the name in its `Host` header is an IPv4 address, a bracketed IPv6 address, `localhost` or a name listed in the [`dashboard.allowed_hosts`](config.md#dashboard) key (compared without regard to case or a trailing dot; the port is not checked): a web page that reaches the dashboard through a host name it controls (DNS rebinding) sends an `Origin` equal to its `Host`, so comparing the two cannot stop it, and it cannot have an address-literal `Host`. `POST /sink` follows the `Origin` rule above too. These checks answer `403` and stop a web page you visit from steering your dashboard, posting to the sink or reading its feed. They do not stop a program on your network that sends no `Origin` and uses the IP address: the LAN is the trust boundary.
- **The token and the session cookie travel in cleartext.** The dashboard serves plain HTTP, so on a dashboard opened to other machines with `DASHBOARD_HOST` both cross the network readable; use it on a network you trust, or reach it through an `ssh -L` tunnel.
- **Never put a port forward or a proxy in front of the loopback port.** A forward or proxy that relays other machines' requests to `127.0.0.1:<dashboard.port>` makes every machine that reaches it look local to the dashboard, and passes the loopback `Host` check. To reach the full dashboard from another machine, set [`DASHBOARD_HOST`](env.md#the-dashboard-s-access-controls) instead. An `ssh -L` tunnel that you open from your own machine is fine: only you reach its end.
- **Bodies are capped.** A body over a route's limit answers `413`.

The full dashboard listens on `dashboard.port` (3000 by default). A second listener on `dashboard.lan_port` (3001 by default, all interfaces) serves only `GET /` (a redirect to `/?sink=1` when the request has no `sink` parameter), `GET` and `HEAD` for the UI's files (`/assets/*` and `/favicon.svg`), `GET /audio/<id>-<seq>.wav`, `POST /sink`, `/health` and the `/ws` upgrade, and answers `404` to everything else, so a second PC can host the [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source) without reaching the controls.

## Dashboard: page, audio and feed

`GET /`, `/assets/*`, `/favicon.svg`, `/ws`, `/audio/<id>-<seq>.wav`, `POST /sink`, `/health`, `GET` and `HEAD /avatar`, `GET` and `HEAD /avatar/model` and the `/avatar/ws` upgrade are served on both listeners; every other route below is on the full dashboard only, `GET /avatar/renderer` included.

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /` | none | The dashboard page: the built UI's `index.html`, with the co-host's name filled in, read on every request, so a rebuild shows without a restart. While the UI is not built it answers `503` with a page that says so and names `mise run build`. The [sink](../../start/glossary.md#sink) page is the same page with `?sink=1` (any value) |
| `GET /assets/*`, `HEAD /assets/*`, `GET /favicon.svg`, `HEAD /favicon.svg` | none | The UI's files (its script, stylesheet and icon), served from the built UI with a content type, an `etag` and a long cache lifetime for the hashed files under `assets/`; `304` when `If-None-Match` names the etag, `404` for anything not in the build |
| `GET /ws` | none | The WebSocket live feed of bus [events](../../start/glossary.md#event) (the memory note and viewer events are not sent). A browser's upgrade request carries an `Origin` header, and it must be an `http` origin naming the same host and port as the request's `Host`; a different, `https` or `null` origin is refused with `403`, so another web page cannot read the feed. On the second listener the [Host rule](#who-may-call-what) applies, so the sink page on another PC is opened by the AI PC's IP address (`http://192.168.1.20:3001/?sink=1`) or by a machine name listed in `dashboard.allowed_hosts`. A client that sends no `Origin`, such as a script, is accepted. Tool events to a socket that is on the LAN listener, or on a full surface bound beyond loopback, are redacted: `tool.request` and `tool.confirm` arrive with `arguments` `{}`, `tool.result` with an empty `content`, an `inject.request` for the tools unit with an empty `text`, and a `tool.timer` with an empty `note`; an event that emptied something carries `redacted: true` (a `/ws` member only, never on the bus) |
| `GET /audio/<id>-<seq>.wav` | none | The audio of one clause of an utterance, fetched from `voice` and sent without caching |
| `POST /sink` | none | A sink page reports playback of one clause: body `{"event": "playing" or "done", "id": "...", "seq": N}`, `seq` a non-negative integer. A `done` may also carry `"interrupted": true` with `spokenText` and `unsaidText` (a `voice.stop` cut the clip), or `"final": true` (the page stops taking the line). Publishes `voice.playing` or `voice.done` with `seq` and sink `dashboard`. Answers `204`, `400` for any other `event` or a missing or invalid `seq` (nothing is published), or `403` for an `Origin` that is not the request's own host (a page on another site cannot post events) |
| `GET /health` | none | `ok`, for any method |
| `GET /avatar`, `HEAD /avatar` | none | The renderer page, `avatar.html` of the built UI, read on each request, with `content-security-policy` (`default-src 'self'`, `blob:` and `data:` for images and fetches only, `worker-src 'none'`, `frame-ancestors 'self'`) and `cache-control: no-cache`. While it is not built, `503` with a page titled "Avatar renderer not built" that loads nothing and names `mise run build`. The page is for an OBS Browser Source, `http://<ai-pc-ip>:3001/avatar`, or a browser tab on the owner's machine |
| `GET /ws` upgrade on `/avatar/ws` | none | The renderer relay, a WebSocket of its own, separate from `/ws`. It carries the connect pair `view` then `status`, then `frame` messages (the newest frame, never a replay) from the server, and from a loopback socket only one `model` report (`{"type":"model","version","state":"loading" or "ready" or "failed","detail"}`, `detail` cut at 200 characters). A `preview=1` query makes a settings preview, which the full surface alone accepts. The Origin and Host rules of `/ws` apply, a refused upgrade is `403`, and a cap is `503` with `retry-after: 5`: 4 renderer pages per listener, 2 previews, and 2 pages from one non-loopback address across both listeners. A message over 4096 bytes closes the socket with `1009`; more than 20 messages in a second close it with `1008`, and terminate it one second later if the close is not completed. The server pings every 10 s and closes a socket silent for 20 s, and closes one whose send has stayed buffered for 5 s. A loopback address is the owner's machine. A NAT or port-forwarding layer that makes a remote client arrive from loopback makes it look local; the dashboard cannot see that, so keep such a layer off the LAN port |
| `GET /avatar/renderer` | none, full surface only (`404` on the LAN listener) | `200` with `cache-control: no-store` and `{state, driver, fps, applied, pages, previews, maxPages, maxPreviews}`: `state` `live`, `waiting` or `off` and `driver` as the relay's status, `fps` the frames received in the last 2 s over 2 (null unless `live`), `applied` `{model, configuredModel, zoom, offsetY, turn}`, and one entry per renderer page in `pages` as `{sentFps, model, since}`, `since` the connect time in epoch milliseconds and `model` the page's last `{state, detail}` report (null for a socket that is not on loopback or has reported nothing). `maxPages` is 4 and `maxPreviews` is 2 |
| `GET /cohost/…`, `HEAD /cohost/…` | none | The built documentation site, served on the full-surface listener only (not on the second listener). It answers with the pages built by `mise run docs:build`, or, while the site is not built, with a page that says so, names `mise run docs:build` and says that `mise run dashboard` builds the site when it starts. See [Service health](../../guide/operate/health.md) for the one page that reads `GET /services` live |
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
| `GET /services/control` | none | `{"enabled": true, "runtime": "...", "advanced": false, "unlocked": false}`, or `{"enabled": false, "unlocked": false}`. `unlocked` is `true` when the request carries a valid session cookie (an [unlocked browser](#dashboard-unlock)); it is answered the same way in config recovery mode |
| `POST /services/<id>/start`, `/stop`, `/restart` | token | Runs the action on one service. An optional body `{"mode": "resume" or "fresh", "isolated": true}` picks the start mode and the isolation presets. Answers `200 {"ok": ...}`, `404` for an unknown service (the dashboard itself is not one), `403` for `redis` or `postgres` while `CONTROL_ADVANCED` is off, `409` while another action holds the lock, `400` for a malformed body |
| `GET /stack` | none | The stack's state: [Docker](../../start/glossary.md#docker) reachability, the [containers](../../start/glossary.md#container) and the running action |
| `POST /stack/launch`, `/rebuild`, `/stop`, `/restart`, `/consolidate` | token | Starts a whole-stack action and answers `202 {"ok": true, "action": "..."}` at once; progress shows in `GET /stack`. Answers `409` while another action runs |

Only service ids in the manifest are accepted, and nothing from a request reaches a command line except by choosing one of them. The dashboard and `cohostctl` share one lock, so while one runs an action the other refuses. See [Commands](commands.md).

## Dashboard: settings

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /config/schema` | none | Every settings section with the services that read it, its JSON Schema and its secret keys |
| `GET /config/<section>` | none | The section's keys with their effective values and where each comes from, plus an `etag` of the file. Secret values are never returned |
| `PUT /config/<section>` | token; and in both modes when it changes a sensitive key | Body `{"etag": "...", "values": {...}}`. Validates against the schema, writes `config.yaml` in place (comments kept; values are literal, so no `${VAR}` placeholders exist) and answers `200 {"ok": true, "etag": "...", "restart": [...], "warnings": [...]}`, where `restart` lists the running services that read the section. `400` carries the schema `issues`; `409` means the file changed under you and carries the current `etag`. Add `?dryRun=1` to validate without writing. A save that changes a key marked sensitive (the addresses a credential or the voice is sent to: `llm.openai.base_url`, `vision.obs.host` and `port`, `avatar.vtube_studio.host` and `port`, `mouth.outputs.http.url`) needs the token whatever `CONTROL_ENABLED` says, and answers `401` with `www-authenticate: Bearer` and `{"ok": false, "detail": "...", "sensitive": ["llm.openai.base_url"]}` without it, or `403` with the same body when no `CONTROL_TOKEN` is configured. A key is changed when its value differs from the current one, so resubmitting a sensitive value unchanged does not need the token, and a dry run never does |
| `PUT /secrets/<path>` | token, always | Body `{"value": "..."}` sets one secret in `secrets/secrets.yaml`, trimmed of surrounding whitespace; `{"value": null}` clears it (the key stays, empty, and every read reports it not set). `<path>` is the secret's dotted config path, for example `llm.openai.api_key`. Answers `200 {"ok": true, "set": true, "restart": [...]}`, where `restart` lists the running services that read the secret's section. The value is never returned or logged. See the order of refusals below |
| `PUT /secrets` | token, always | Body `{"values": {"llm.bedrock.access_key_id": "...", "llm.bedrock.secret_access_key": "..."}}` (a value is a string or `null`) applies several changes in one write, all or nothing. Answers `200 {"ok": true, "set": {"<path>": true}, "restart": [...]}`. A set for `tools.servers.<name>.token` is accepted only when the saved `config.yaml` holds a `tools.servers` entry of that name; otherwise the whole request is answered `404 {"ok": false, "detail": "unknown secret", "paths": [...]}` naming those paths and nothing is applied. A clear (`null`) for such a path always applies, so the token of a removed server can be cleared |
| `POST /tools/answer` | token, always; a foreign `Origin` is `403` | Body `{"id": "...", "allow": true or false}`, where `id` is the `id` of a pending `tool.confirm` (1 to 256 characters). Publishes `tool.answer` and answers `202`; `400` for any other body, `401` with `www-authenticate: Bearer` for a missing or wrong token, `403` naming `CONTROL_TOKEN` and `CONTROL_ENABLED` when no control token is configured. The answer to a call that has already ended is published and ignored by the tools service. Full surface only |
| `GET /options/voices` | none | `{"voices": [...]}`: the voice ids [Kokoro](../../start/glossary.md#kokoro) offers, sorted, read from `<TTS_URL>/v1/audio/voices`. Only while `voice.engine` is `kokoro`; with any other engine it answers `502 {"ok": false, "detail": "no voice list for engine <name>"}` and contacts no voice server |
| `GET /options/models` | none | `{"models": [...]}`: the models installed in [Ollama](../../start/glossary.md#ollama), sorted, read from `<OLLAMA_URL>/api/tags` |
| `GET /egress` | none | `{"destinations": [...]}`: every destination private data is sent to under the saved `config.yaml`, read on each request with `network.lan` applied. Each entry is `{service, data, engine, host, hosted, offLan}`: `service` is `voice`, `ears`, `eyes`, `cortex` or `tools`, `data` is `text`, `audio` or `frames`, `host` is the bare host name (or `hosted` names a hosted provider with no host), and `offLan` says whether it leaves the LAN. No secret value is ever returned. A config that fails to load answers `500 {"ok": false, "detail": "..."}` naming the loader's error, never cached. Full dashboard only: the LAN listener answers `404` |

`PUT /config/<section>` never touches `secrets.yaml` or `.env` and never starts or restarts a service. See [Configuration](config.md) for the keys.

The secret routes are served on the full dashboard only, never on the second listener. They refuse in this order: `403` for a foreign `Host` or `Origin`; `403 {"ok": false, "detail": "..."}` naming `CONTROL_TOKEN` and `CONTROL_ENABLED` when no token is configured; `401` with `www-authenticate: Bearer` for a missing or wrong token; `413` for a body over 64 KiB; `404 {"ok": false, "detail": "unknown secret"}` for a path that is not one of the secret paths (`PUT /secrets` lists them in `paths`); `400 {"ok": false, "detail": "..."}` for a body that is not `{"value": ...}` (or `{"values": {...}}`) or a value that is empty after trimming or holds a line break or NUL. The token is checked before the path, so `PUT /secrets/access-check` with `{"value": null}` answers `404` for the right token and `401` for a wrong one and writes nothing. A failed write answers `500 {"ok": false, "detail": "..."}` and leaves the file as it was.

`llm.bedrock.access_key_id` and `llm.bedrock.secret_access_key` are set or cleared together: a request that would leave exactly one of them set answers `400 {"ok": false, "detail": "...", "paths": ["llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"]}` and writes nothing. Use `PUT /secrets` to set or clear both in one request.

The two `GET /options/...` routes are served on the full dashboard only. They fetch the addresses `TTS_URL` and `OLLAMA_URL` name (nothing in the request changes them), read at most 1 MiB, wait at most 3 seconds, never cache, and answer `502 {"ok": false, "detail": "..."}` naming the cause (unreachable, a non-2xx status, no answer in time, too large, or a body of the wrong shape) when the server is down or answers badly.

## Dashboard: unlock

The unlock link lets the owner's browser act with the control token without the token being pasted into it. When the dashboard starts, in normal mode and in config recovery mode, and a `CONTROL_TOKEN` is configured, it prints one line to its terminal (its standard output, never `data/logs/dashboard.log` and never the bus):

```text
Unlock this browser: http://127.0.0.1:3000/unlock?n=<nonce>
```

The host is the full dashboard's address (`127.0.0.1` when it listens on every address) and the port `dashboard.port`. Each link works once, within 10 minutes of being made, and lives only in the dashboard's memory, so a restart ends the links it printed before. `mise run dashboard:unlock` asks the running dashboard for a fresh one (see [Commands](commands.md)).

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /unlock?n=<nonce>` | the nonce | Spends the nonce and answers `303` to `/` with `set-cookie: cohost_session=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000` (90 days; no `Secure`, because the dashboard serves plain HTTP), `cache-control: no-store` and `referrer-policy: no-referrer`. A missing, unknown, used or expired nonce, or a dashboard with no `CONTROL_TOKEN`, answers `400` with a plain-text page saying the link is not valid and how to get a new one (`mise run dashboard:unlock`, or restart the dashboard; with no token, set `CONTROL_TOKEN` in `.env` and restart), and sets no cookie. Full surface only: the LAN listener answers `404` |
| `POST /unlock/link` | `Authorization: Bearer <CONTROL_TOKEN>` only; a session cookie does not count | Makes a fresh nonce and answers `200 {"ok": true, "url": "http://127.0.0.1:3000/unlock?n=..."}` with `cache-control: no-store`, the address being the dashboard's own (`127.0.0.1` when it listens on every address); neither is logged. `401` with `www-authenticate: Bearer` for a missing or wrong token, `403` naming `CONTROL_TOKEN` when none is configured. Full surface only |
| `POST /unlock/forget` | none (it only removes access); the `Origin` rule applies | Answers `204` with `set-cookie: cohost_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, so this browser is locked again. The Access panel's **Lock** sends it. Full surface only |

The session in the cookie is signed with a key derived from `CONTROL_TOKEN`, and the dashboard keeps no list of sessions: a session holds across dashboard restarts and in config recovery mode, and changing `CONTROL_TOKEN` ends every session at once. A browser holding the cookie is unlocked for every route that needs the control token, the secret write and tool confirmations included. To lock one browser, press **Lock** in its Access panel (or clear its cookies for the dashboard's address); a copy of the cookie elsewhere stays valid until `CONTROL_TOKEN` changes.

### Config recovery mode

While `config.yaml` or `secrets.yaml` does not validate, the dashboard runs one listener (the usual address, or port 3000 when the `dashboard` section itself is broken) that serves the page, `/health`, `GET /services/control`, the [unlock routes](#dashboard-unlock) and the routes below. `POST /stack/stop` stops the stack (below); the other stack routes and the service routes answer `409 {"ok": false, "detail": "the config is invalid (...)"}` with control on and `404` with it off; every other route answers `503`.

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /recovery` | none | `{"active": false}` in normal mode. In recovery mode `{"active": true, "file", "secretsFile", "etag", "problems"}`: each problem is `{file, path, message, kind, secret, sensitive, section?, fallback?, resetPath?, repair?, raw?, actions: {set, reset, fallback}}`, `kind` one of `placeholder`, `schema`, `syntax`, `secrets`; `raw: true` marks a file that is not valid YAML, edited through `/recovery/raw`. Answers `{"active": false}` and starts the normal dashboard once nothing fails |
| `PUT /secrets/<path>` | token, always | The Access dialog's token check; it writes nothing and reads no body. `403` naming `CONTROL_TOKEN` and `CONTROL_ENABLED` when no control token is configured, `401` with `www-authenticate: Bearer` when it is missing or wrong, otherwise `404 {"ok": false, "detail": "unknown secret"}` for any path. Set a secret on the Settings screen once the dashboard is back |
| `POST /recovery/set` | token whenever one is configured; in both modes for a sensitive key or an entry of a sensitive list | Body `{"etag", "path", "value"}`. Sets one key (a string value is read as YAML when the key accepts that), keeping the rest of the file. `400 {"ok": false, "issues"}` for a value the key refuses, a credential or an entry inside a list entry; a single-value list entry `key[i]` can be set |
| `POST /recovery/reset` | token whenever one is configured, except for a `config.yaml` problem while the full dashboard is bound to loopback; in both modes when it changes `secrets.yaml` | Body `{"etag", "path"}`. Removes the key (a whole list for a path inside one) so its default applies, or repairs a broken `secrets.yaml` path: a plain value that is not a string is rewritten quoted, anything else is cleared |
| `POST /recovery/fallback` | token whenever one is configured, except while the full dashboard is bound to loopback | Body `{"etag", "path"}`, the path of a `config.yaml` problem with `fallback` true (the **Use** button). Writes that problem's own fallback value at the path; the request carries no value. `400 {"ok": false, "issues"}` for a path that is no such problem |
| `POST /recovery/reset-all` | token whenever one is configured, except for the `config.yaml` part while the full dashboard is bound to loopback; the `secrets.yaml` part needs it in both modes | Body `{"etag"}`. Writes each placeholder's fallback where it has one the key accepts (a single-value list entry included), resets the rest, in rounds, then writes each file once. Without the token `secrets.yaml` is left alone and the answer lists its paths as `tokenNeeded` |
| `GET /recovery/raw?file=config\|secrets` | `secrets`: token in both modes (`403` naming `CONTROL_TOKEN` when none is configured); `config`: token with control on or a `CONTROL_TOKEN` configured | Only for a file with `raw: true` (not valid YAML, or empty, a scalar or a list): `{"ok": true, "file", "path", "text", "etag", "message", "line"?, "col"?}`, the whole text, its SHA-256 etag and the parser's message and position. `409` for a file that parses to a mapping, `400` for another `file` |
| `POST /recovery/raw` | as the read | Body `{"file", "etag", "text"}`, at most 1 MiB. Replaces the file with `text` as sent (atomically; `config.yaml` keeps its permissions, `secrets.yaml` is written `0600`) while it still has `raw: true` and `etag` is current. The answer adds `rawEtag`, the etag of the text written. The text is never logged |
| `POST /stack/stop` | token; `404` with control off | Runs `docker compose stop` for the project without reading the config, under the lifecycle lock, and waits for it: `200 {"ok": true, "action": "stop"}`, `502 {"ok": false, "detail"}` when the command fails, `409` while another stack action holds the lock. When the files become valid meanwhile, the normal dashboard starts only after this answer |

Every write answers `200 {"ok": true, "etag", "problems", "valid", "moved"?, "port"?, "tokenNeeded"?}` with the problems still left (`moved` and `port`, once valid, say the normal dashboard listens on another port than the recovery listener), or `409 {"ok": false, "etag"}` when the file changed since the `etag` was read; when `valid` is true the normal dashboard starts in the same process. In normal mode the writes and `GET /recovery/raw` answer `409`.

A reset of a `config.yaml` key, a fallback and the `config.yaml` part of a reset-all write no value the caller chooses, so while the full dashboard is bound to loopback they need no token even with control on. Every other recovery write keeps its token rule above; an unlocked browser's session cookie counts as the token.

## Dashboard: avatar models

The model store holds the `.vrm` files the browser renderer draws. Its files live in the dashboard's data folder, `dashboard/avatar-models/`, and the store lists only regular files whose names follow the `renderer.model` grammar (at most 80 characters, letters, digits, space, `_`, `.` and `-`, starting with a letter or digit, ending in a lower-case `.vrm`). Names compare without regard to ASCII case.

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /avatar/model`, `HEAD /avatar/model` | none | The applied model's file, `model/gltf-binary`, with `etag: W/"<size hex>-<modified ms hex>"`, `cache-control: no-cache` and `x-content-type-options: nosniff`; `304` when `If-None-Match` names the etag or is `*`. `404 {"ok": false, "detail"}` when no model is applied or its file is gone. Served on both listeners |
| `GET /avatar/models` | none | `200` with `cache-control: no-store` and `{models, active, maxBytes, maxModels, maxTotalBytes}`: the stored models sorted by name, each `{name, bytes, modified, active, vrm, title, authors, license, usage, expressions}` or, for a file whose head fails the checks, the same with `error`. `active` is the applied model's name or null. `maxModels` is 20 and `maxTotalBytes` 2147483648. Full surface only |
| `GET /avatar/models/<name>`, `HEAD /avatar/models/<name>` | none | One listed model without an `error`, served as `/avatar/model` serves the applied one. `404` for a name outside the grammar, an unknown name or a model with an `error`. Full surface only |
| `POST /avatar/models?name=<name>[&replace=1]` | token where `CONTROL_ENABLED=1`; a foreign `Origin` is `403` | Stores the request body, a glTF binary [VRM](../../start/glossary.md#vrm). The name is the last path segment of `name`, reduced to the grammar (`.vrm` removed, other characters as `_`, the stem cut to 76 characters). `201 {"ok": true, "model": <entry>}`. `409` when the name is stored (without `replace=1`; the answer names it), when 20 models are stored or the total would pass 2 GiB, or when another upload is running. `413` when `Content-Length` or the body passes `dashboard.models.max_bytes`. `400` when the head is not a VRM (magic, version 2, JSON chunk first and at most 16 MiB, `VRMC_vrm` or `VRM` in `extensionsUsed`, a supported `extensionsRequired`, no Draco, KTX2 or meshopt compression, no external buffer or image) or the length differs from the header's. `408` when no byte arrives for 30 s. `507` on a full disk, `500` on other write failures. The body is streamed to a temporary `.incoming-*` file that is linked or renamed into place and removed on every failure. Full surface only |
| `DELETE /avatar/models/<name>` | token where `CONTROL_ENABLED=1`; a foreign `Origin` is `403` | Removes one stored model: `200 {"ok": true}`. `404` for a name outside the grammar or no stored model of that name, `409 {"ok": false, "detail"}` for the applied model, which stays. Full surface only |

A `PUT /config/renderer` (dry run included) that would leave `renderer.model` naming no stored model that loads answers `400` with an issue on `renderer.model`. A successful save sets the applied model at once, with no restart. Uploading a stored model changes no setting; replacing the applied model's file changes what `/avatar/model` serves, under a new etag.

## Dashboard: test inputs

All inject routes need the token (or a session cookie) whenever one is configured. Each answers `202 {"id": "..."}`, or `409` when the service the input is for is not running (`service not running: <unit>`).

| Route | Body or query | What it does |
| --- | --- | --- |
| `POST /inject/text` | JSON `{"level": "service" or "bus", "as": "chat", "speech", "vision" or "tool", "text": "...", "user", "platform", "isMod", "isSub", "remember", "source"}` | `service` level asks `chat` to publish the line through its real path and supports `as: chat`. `as: tool` (service level only) takes `text` as the JSON `{"tool": "...", "arguments": {...}}` of one call and asks the tools service to run it as origin `dashboard`; it always needs the control token (`401` without it, `403` when none is configured), answers `409` while `tools` is not running, ignores the chat fields and never remembers. `bus` level publishes `chat.message`, `speech.heard` or `vision.summary` directly with `injected: true`. `source` names a listening source and is only for `level: bus` with `as: speech`. `text` must be non-blank |
| `POST /inject/image` | The image as the body, with `Content-Type` of `image/png`, `image/jpeg` or `image/webp`. Query `user`, `remember` | Stores the upload in [Redis](../../start/glossary.md#redis) and asks `eyes` to describe it. `415` for another type, `413` over `dashboard.inject.max_image_bytes`, `400` for an empty body, `503` if the upload store is unavailable |
| `POST /inject/audio` | The clip as the body, with `Content-Type` of `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/ogg`, `audio/webm` or `audio/mp4`. Query `target` (`ears`, the default, or `connector-discord`), `source` (a source tag, for `ears` only), `user`, `remember` | Stores the upload in Redis and asks the target to treat it as heard audio. `413` over `dashboard.inject.max_audio_bytes` |
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
| `GET /audio/<id>-<seq>.wav` | The WAV of one clause (`<id>` is the `brain.say` id, `<seq>` the clause number), `200` with `audio/wav`, or `404` once it has expired |
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
