---
node: high-level-design
---

# Decision: every operator setting in one file the dashboard edits

## Context

An operator's values can spread across three places: `config/config.yaml` (behaviour), `.env` (credentials and "per-machine" values) and the environment variables that `config.yaml` reads through `${VAR}` and `${VAR:-default}` placeholders. A settings screen over that spread can edit only part of it: a key written as a bare `${VAR}` is read-only, and a `${VAR:-default}` key is editable but the variable wins when it is set, so an edit can silently do nothing.

The place a value lives also decides how it takes effect. A dashboard "restart" is `docker compose restart`, which keeps the container's environment; `.env` reaches a container through `env_file` only when Compose creates it. An edit to `.env` therefore needs the container recreated, while `config.yaml` is read from the bind-mounted `./config` at process start, so a restart applies an edit to it (HLD tenet 10).

The owner wants one place for every operator setting, editable from the dashboard, plus an explicit statement of what must stay outside it. The decision touches the trust boundary: some values are the lock that guards the dashboard, and a page served by the dashboard must not be able to remove its own lock.

## Decision Elements

Gates:

- **Settings apply on restart** (inherited, HLD tenet 10). An option in which an edit needs anything beyond restarting the services that read it fails.
- **No secret is returned by any read route** (inherited, HLD Trust boundary). An option that has to read a secret back to the page fails.
- **The dashboard cannot edit its own access controls** (doc-local). A page served by the dashboard must not be able to change `CONTROL_TOKEN`, `CONTROL_ENABLED`, `CONTROL_ADVANCED`, `DASHBOARD_HOST` or `VIEWERS_TOKEN`; an option that makes them editable there fails, because a UI that can remove its own lock is a privilege escalation.
- **Every service can load its settings on Redis alone, or with no bus at all** (inherited, HLD tenet 6; the `consolidate` and `reembed` one-shots never open the bus). An option whose settings are reachable only through the bus fails.

Weighted criteria:

- **One place for the operator** (major, owner direction): the Settings screen shows and edits every operator setting, and nothing the operator tunes is hidden in another file.
- **Hand-editable and diffable** (major, tenet 7 and the Applying decision): the owner can read, diff, back up and edit the settings with a text editor when the dashboard is down or the stack is stopped.
- **Durability of an edit** (major): a saved setting survives a crash or a container recreate.
- **Honest effect of an edit** (major): what the screen says about a value is what the services will use; nothing shadows it unannounced.
- **Moving parts** (minor): new infrastructure, new failure modes and new code paths.

## Options in the Domain

### A database or Redis-backed settings store

Settings live in Postgres or Redis; the dashboard reads and writes them there and services fetch them at start. Strong on a single editing surface and per-key writes with no text surgery. Redis in this stack has no authentication and runs `--save 60 1 --appendonly no`, so up to 60 seconds of edits can be lost; Postgres is owned by the memory service, and a settings table would make every other service depend on it. The `consolidate` and `reembed` one-shots never open the bus and `consolidate` would need credentials to a store it otherwise does not touch.

- Settings apply on restart: **passes** (read at start).
- No secret returned: **passes**.
- Access controls: **passes** if they stay out of the store (they must be readable before the store).
- Redis alone or no bus: **eliminated** for Redis (the one-shots never open the bus; a store outage would stop every service); a Postgres store makes services depend on memory's database.
- One place for the operator: **strong**.
- Hand-editable and diffable: **weak**; the file the owner reads, diffs and edits with the stack stopped disappears.
- Durability: **weak** for Redis (60 s window, no auth), **strong** for Postgres.
- Honest effect: **strong**.
- Moving parts: **weak**; a store, a migration path and a bootstrap problem (the store's own address is a setting).

### The dashboard edits `.env`

The Settings screen writes `.env`; `.env` becomes the one store. Strong on the operator already knowing the file and on Compose already handing it to every container.

- Settings apply on restart: **eliminated**. `docker compose restart` keeps the container's environment, and the dashboard cannot refresh its own environment or restart itself, so an edit needs container recreation (`up -d` with a changed environment) and, for the dashboard's own values, a manual restart of the host process.
- No secret returned: **passes** if reads report set or not set.
- Access controls: **eliminated** as stated; `CONTROL_TOKEN` and `DASHBOARD_HOST` are in `.env`, so the UI would hold the lock's own keys.
- Redis alone or no bus: **passes**.
- One place for the operator: **strong**.
- Hand-editable and diffable: **partial**; a flat variable file with no structure, no per-key comments the editor preserves, and values that need the schema's own validation reimplemented for text.
- Durability: **strong**.
- Honest effect: **weak**; `${VAR}` placeholders, shell environment and `env_file` precedence all still shadow it.
- Moving parts: **partial**.

### `config.yaml` for operator settings, `secrets.yaml` for credentials, `.env` for bootstrap and access (chosen)

Every operator setting is a literal key of `config.yaml` with a schema default. Credentials live in a second git-ignored file, `config/secrets.yaml`, in the same bind-mounted directory, merged by the loader at the secret paths. `.env` keeps only what must exist before configuration can be read, and the dashboard's own access controls. The isolation presets stay as start-time overrides the control plane injects for an isolated start.

- Settings apply on restart: **passes**; both files are in `./config`, read at process start.
- No secret returned: **passes**; reads report set or not set, and credentials are written only through a write-only route.
- Access controls: **passes**; they stay in `.env`.
- Redis alone or no bus: **passes**; the loader reads two local files.
- One place for the operator: **strong**; the one exception is credentials, which sit in a sibling file because the page must be able to show `config.yaml` values and must never show these.
- Hand-editable and diffable: **strong**; the existing seeded, comment-preserving file, plus a small secrets file.
- Durability: **strong**; atomic temp-file-and-rename writes.
- Honest effect: **strong**; no placeholder shadows an operator key; the one override left is an isolated start, which the editor reports.
- Moving parts: **strong**; no new service and no new transport; the cost is a loader change, a secrets writer and a presentation table.

## Selection

`config.yaml` plus `secrets.yaml` plus a reduced `.env`. It is the only option that passes every gate and is strong on the major criteria: it keeps the hand-editable file (tenet 7), applies on restart (tenet 10), keeps the lock out of the editor's reach and needs no store. The Redis store loses on its own gates (no auth, a 60 s loss window, one-shots without a bus), the Postgres store on the dependency it adds to every service, and the `.env` editor on restart semantics and the lock.

What it obliges downstream:

- The loader merges `secrets.yaml`, rejects placeholders for variables it no longer supports, and the isolation overrides are the only variables a placeholder may name (config).
- The settings editor reports a key overridden by a running isolated unit instead of presenting a permanent `.env` shadow, and the schema route serves a presentation table so the screen names every setting without hard-coding sections (module-contract).
- The `models` puller reads model names from config, not from `.env` (deployment).
- The dashboard owns the write-only route for secrets and the port and upload-limit keys it now reads from config (dashboard).

It forecloses a `.env`-only way to flip a backend: a backend is flipped by an isolated start or by editing a `config.yaml` key.

Fit: the selection would flip toward a store if the stack gained a second host that must share settings, or if per-key audit history became a goal.

## What lives where

| Setting | Home | Reason |
| --- | --- | --- |
| Every behaviour and operator setting (models, hooks, timings, voice, avatar, senses, Discord guild and channel, Twitch channel, OBS host, port and source, VTube Studio and VMC host and port, speech-to-text model, upload limits, dashboard ports) | `config.yaml`, literal keys with schema defaults | Edited whole by the Settings screen; applied by restart |
| `llm.openai.api_key`, `llm.claude.api_key`, `llm.bedrock.access_key_id`, `llm.bedrock.secret_access_key`, `vision.obs.password`, `ears.http.token`, `chat.twitch.client_id`, `chat.twitch.client_secret`, `chat.twitch.access_token`, `chat.twitch.refresh_token`, `connections.discord.token` | `secrets.yaml` (git-ignored, mode 0600, same bind-mounted directory) | Credentials; never returned by a read route; written only through the dashboard's write-only route; every container may read the file |
| `CONTROL_TOKEN`, `CONTROL_ENABLED`, `CONTROL_ADVANCED`, `DASHBOARD_HOST`, `VIEWERS_TOKEN` | `.env` | The dashboard's access controls; read once at dashboard start; a UI that can remove its own lock is a privilege escalation |
| `CONFIG_DIR`, `COHOST_ENV_FILE`, `COHOST_DATA_DIR`, `COHOST_DOCKER_BIN` | `.env` or the shell | Locate the files and tools needed before configuration can be read |
| `REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `VOICE_PORT` | `.env` or the shell (Compose pins the first six for containers) | Infrastructure addresses a service needs before it can open the bus; per machine |
| `COMPOSE_FILE`, `COMPOSE_PROFILES`, `COMPOSE_PATH_SEPARATOR`, `COMPOSE_PROJECT_NAME`, `KOKORO_IMAGE`, `SPEACHES_IMAGE` | `.env` | Read by `docker compose` itself, before any container exists |
| `HEARTBEAT_INTERVAL_MS` | `.env` | Read by the shared runtime and the container healthchecks, which derive staleness from it, outside the schema |
| `LOG_LEVEL` | `.env` | The logger exists before configuration is loaded, and reports its failures |
| `LLM_PROVIDER`, `MEMORY_STORE`, `MEMORY_EMBEDDER`, `VOICE_ENGINE`, `CHAT_SOURCE`, `VISION_ENABLED`, `VISION_ENGINE`, `EARS_SOURCES`, `EARS_STT_ENGINE`, `CONNECTIONS_DISCORD_ENABLED`, `MOUTH_DISCORD_ENABLED`, `MOUTH_DRYRUN_ENABLED`, `AVATAR_DRIVER` | Injected by the control plane for an isolated start; never an operator setting | Make one unit run with no external backend; the editor reports a key a running unit has overridden |
| `COHOST_VERSION`, `HOSTNAME`, `PATH`, `WSLENV` | Process environment, set by the image build, the host or Compose | Build and platform metadata; not settings |

The environment variables cohost source reads are exactly those named in the access, bootstrap, infrastructure, Compose, heartbeat, log, override and platform rows above; a test fails when source reads any other, so a new operator setting cannot arrive as an environment variable.
