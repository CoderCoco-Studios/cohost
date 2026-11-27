---
node: high-level-design
---

# Decision: every operator setting in one place the dashboard edits

## Context

An operator's values can spread across several places: a settings file for behaviour, `.env` for credentials and "per-machine" values, a credentials file beside them, and the environment variables that a settings file could read through `${VAR}` and `${VAR:-default}` placeholders. A settings screen over that spread can edit only part of it: a key written as a bare `${VAR}` is read-only, and a `${VAR:-default}` key is editable but the variable wins when it is set, so an edit can silently do nothing. A credential in a plaintext file or in `.env` sits on disk, in every copy of the checkout and every backup, and `.env` reaches every container through `env_file`.

The place a value lives also decides how it takes effect. A dashboard "restart" is `docker compose restart`, which keeps the container's environment; `.env` reaches a container through `env_file` only when Compose creates it. An edit to `.env` therefore needs the container recreated, while a value a service reads from a file at process start is applied by a restart (HLD tenet 10).

The owner wants one place for every operator setting, the persona, the emotion map and every credential, editable from the dashboard and from the command line, plus an explicit statement of what must stay outside it. The decision touches the trust boundary: some values decide how far the dashboard is exposed, the control token is the lock that guards it, and a page served by the dashboard must not be able to remove its own lock.

## Decision Elements

Gates:

- **Settings apply on restart** (inherited, HLD tenet 10). An option in which an edit needs anything beyond restarting the services that read it fails.
- **No secret is returned by any read route** (inherited, HLD Trust boundary). An option that has to read a secret back to the page fails.
- **The dashboard cannot edit its own access controls** (doc-local). A page served by the dashboard must not be able to change `CONTROL_ADVANCED` or `DASHBOARD_HOST`, nor read the control token; an option that makes them editable there fails, because a UI that can remove its own lock is a privilege escalation.
- **Every service can load its settings on Redis alone, or with no bus at all** (inherited, HLD tenet 6; the `consolidate` and `reembed` one-shots never open the bus). An option whose settings are reachable only through the bus fails.
- **Unattended start** (owner direction). The dashboard and the stack come up after a reboot with no person present; an option that needs a passphrase, PIN or prompt at start fails.

Weighted criteria:

- **One place for the operator** (major, owner direction): the Settings screen shows and edits every operator setting, the persona and every credential, and nothing the operator tunes is hidden in another file.
- **Nothing secret at rest in plaintext** (major, owner direction): no credential in a settings file, in `.env`, in a container's environment, in a bind-mounted file or in a backup.
- **Least privilege per unit** (major, HLD Trust boundary): a service sees only the settings and credentials its manifest entry declares.
- **Durability and atomicity of an edit** (major): a saved setting survives a crash or a container recreate, and a write that spans settings and credentials is all or nothing.
- **Portable and diffable** (minor): the owner can back up, move and compare the settings; a text form exists for that even if it is not the form edited day to day.
- **Honest effect of an edit** (major): what the screen says about a value is what the services will use; nothing shadows it unannounced.
- **Moving parts** (minor): new infrastructure, new failure modes and new code paths.

## Options in the Domain

### Hand-edited YAML files: `config.yaml` for settings, `secrets.yaml` for credentials

Every operator setting is a literal key of a git-ignored `config/config.yaml`, the persona and emotion map are files beside it, and credentials live in a git-ignored `secrets/secrets.yaml` merged by the loader, with a plaintext per-unit projection of it bind-mounted into each container. Strong on hand-editing with any text editor and on diffing.

- Settings apply on restart: **passes**.
- No secret returned: **passes**; reads report set or not set.
- Access controls: **passes** if they stay in `.env`.
- Redis alone or no bus: **passes**; the loader reads local files.
- Unattended start: **passes**.
- One place for the operator: **partial**; four files plus `.env`, two of which the dashboard edits by splicing text.
- Nothing secret at rest: **eliminated** as a goal; the credentials file and every projection are plaintext on disk, and copies of the checkout carry them.
- Least privilege: **partial**; per-unit credential projections, but every settings section reaches every container.
- Durability and atomicity: **partial**; each file is written atomically, but no write spans two files.
- Portable and diffable: **strong**.
- Honest effect: **strong** once placeholders are refused.
- Moving parts: **strong**; no new store.

### Redis or Postgres as the settings store

Settings live in Redis or in memory's Postgres; the dashboard reads and writes them there and services fetch them at start. Redis in this stack has no authentication and runs `--save 60 1 --appendonly no`, so up to 60 seconds of edits can be lost; Postgres is owned by the memory service, and a settings table would make every other service, and the dashboard's first screen, depend on a container that must already be running.

- Redis alone or no bus: **eliminated** for Redis (the one-shots never open the bus; a store outage would stop every service); a Postgres store makes services depend on memory's database.
- Durability: **weak** for Redis (60 s window, no auth), **strong** for Postgres.
- Moving parts: **weak**; the store's own address is a setting, and the dashboard cannot show a setting while the store's container is down.

### The dashboard edits `.env`

The Settings screen writes `.env`; `.env` becomes the one store.

- Settings apply on restart: **eliminated**. `docker compose restart` keeps the container's environment, and the dashboard cannot refresh its own environment or restart itself.
- Access controls: **eliminated**; the UI would hold the lock's own keys.
- Nothing secret at rest: **eliminated**; `.env` is plaintext and reaches every container through `env_file`.
- Honest effect: **weak**; shell environment and `env_file` precedence still shadow it.

### A SQLite settings store owned by the host-side programs, with per-unit projections and in-memory credential delivery (chosen)

Every operator setting, the persona, the emotion map and every credential live in one SQLite database, the settings store, at `<dataDir()>/store/cohost.db` on the host ([settings-store](../intent/settings-store/settings-store-design.md)). Settings are one JSON document per section; credentials are encrypted per value with AES-256-GCM under a master key kept in a 0600 file outside the checkout. The store is opened only by the dashboard, the control plane and the `mise run config:*` tasks. Before the control plane starts a unit it writes that unit's projection, a JSON file of the sections and documents its manifest entry declares and no credential, which the container mounts read-only as its config directory; after the process has started it delivers the unit's declared credentials in memory (into a container's `tmpfs` through `docker exec` from standard input, or on an inherited pipe for a host-run process). `.env` keeps only what must exist before anything else can run, and no credential. The control token is held by the owner; the store keeps only its scrypt verifier.

- Settings apply on restart: **passes**; the control plane writes a fresh projection and delivers credentials around every start it issues.
- No secret returned: **passes**; reads report set or not set, and credentials are written only through a write-only route or `mise run config:secret`.
- Access controls: **passes**; `CONTROL_ADVANCED` and `DASHBOARD_HOST` stay in `.env`, and the token is in no file the dashboard serves or reads.
- Redis alone or no bus: **passes**; a service reads its projection, a local file, and receives its credentials without the bus.
- Unattended start: **passes, with one stated exception**: the master key file is read without a prompt, but after a reboot the containers Docker restarts wait for their credentials until the dashboard starts (it delivers at its own start) or `mise run deliver` runs. Starting the dashboard at logon closes the gap; that autostart is a recommended follow-up, not built. A second stated exception concerns "every setting through the dashboard": a store so damaged that its token verifier cannot be read is fixed with host commands (`mise run config:restore`, `config:import`, `config:key -- --restore`), and the recovery key made when credentials are discarded is shown only on the dashboard's terminal or by `mise run config:key -- --show`.
- One place for the operator: **strong**; one file, one schema version, one backup and one export.
- Nothing secret at rest: **strong**; ciphertext in the store and its backups, nothing in projections, `.env`, a container environment or a bind mount. The master key file is the accepted root of trust.
- Least privilege: **strong**; a unit sees only its declared sections, documents and credentials, and only the control plane can decrypt.
- Durability and atomicity: **strong**; every write is one transaction validated against the whole schema.
- Portable and diffable: **partial**; the database is not edited by hand, and the YAML export (credentials only under a passphrase) is the diffable, movable form. Owner decision: hand-editing is given up.
- Honest effect: **strong**; every stored value is a literal, a placeholder is refused at the write, no environment variable shadows a setting, and the one override, an isolated start, is reported by the editor.
- Moving parts: **partial**; a store package, a key file, projection and delivery steps around every start, and a unit runner for the dev loop; no new container and no new system dependency (`node:sqlite` and `node:crypto` ship with Node).

### How an isolated start reaches a unit

An isolated start must flip a backend for one container without changing the stored settings. Options for the channel:

- **`${VAR:-default}` placeholders in the settings, one environment variable per override.** The control plane sets `AVATAR_DRIVER`, `LLM_PROVIDER` and the rest; Compose passes each through. Rejected: the same names are ordinary-looking variables, so a stray `AVATAR_DRIVER=null` line in `.env` silently overrides the saved setting in every container; a placeholder makes a key's form decide whether it can be edited; and an isolated start silently does nothing when the key is a literal.
- **One `COHOST_ISOLATION` variable carrying every override as a JSON object (chosen).** The control plane sets it on the `docker compose` process, Compose passes the one name to the container, and the loader applies each entry by key path from `ISOLATION_OVERRIDES`. The name is namespaced, so nothing writes it by accident; Compose needs one pass-through entry; `docker inspect` reads one entry; and the settings hold literals only.
- **One variable per override, namespaced (`COHOST_ISOLATED_AVATAR_DRIVER` and so on).** Rejected: it fixes the stray-name problem but keeps one Compose pass-through entry per override, makes the status probe filter a name pattern, and lets a partial set be written by hand.

## Selection

The SQLite settings store with per-unit projections and in-memory delivery (owner decision, #372). It is the only option that passes every gate and is strong on one place, nothing secret at rest, least privilege and atomicity. The YAML files lose on plaintext credentials and on writes that cannot span files; Redis on its own gates; Postgres on the dependency it adds; the `.env` editor on restart semantics, the lock and plaintext. The hand-editable file is given up deliberately; the export is the text form.

What it obliges downstream:

- The settings store owns the database, the master key, the control token's verifier, projections, delivery, seeding from the committed `config/*.example.*` files, export and import, backups and recovery (settings-store).
- The loader reads the unit's projection, validates each section, sets the delivered credentials, applies isolation overrides by key path from `COHOST_ISOLATION`, the only environment variable that can change a setting, and throws on a read of a section the unit does not declare; it never opens the store or names a credentials file (config).
- Credentials reach a client only from the delivery: a provider whose credential is not set is not configured, whatever the process environment holds, and no SDK default credential lookup is consulted (model-backends).
- Each unit's manifest entry declares its sections, its credential paths, its documents and whether it gets a state key, and a test ties each declaration to the source (module-contract).
- The settings editor reads and writes the store, refuses a credential in a settings write, reports a key a running isolated unit overrides, and the schema route serves a presentation table, including which keys are sensitive, so the screen names every setting without hard-coding sections (module-contract).
- Every settings write, like the credential write and every other mutation, needs the control token or the unlocked browser's session cookie; a key that decides where a secret-bearing request goes carries a warning on the settings screen and needs nothing more (dashboard, config).
- The control plane writes every projection before each `docker compose` command that starts a container and delivers credentials after it, and refuses to start anything while `.env` or the environment defines `CONTROL_TOKEN` (control-plane, settings-store).
- Each container mounts its own projection read-only at `/app/config` and a `tmpfs` at `/run/cohost`; the dev loop runs each host-run service through the unit runner (deployment).
- The `models` puller reads model names from its projection, not from `.env` (deployment).
- Services that persist a credential they obtain at run time (chat's Twitch token, avatar's VTube Studio token) encrypt it under a per-unit state key, and the reflection pass writes its personality change to an outbox the unit runner applies (chat, avatar, memory).

It forecloses a `.env`-only way to flip a backend, and a hand edit of the settings: a backend is flipped by an isolated start or by changing a stored setting through the dashboard or `mise run config:set`.

Fit: the selection would flip toward a networked store if the stack gained a second host that must share settings; per-key history would be an addition to this store, not a reason to leave it.

## What lives where

| Setting | Home | Reason |
| --- | --- | --- |
| Every behaviour and operator setting (models, hooks, timings, voice, avatar, senses, Discord guild and channel, Twitch channel, OBS host, port and source, VTube Studio and VMC host and port, speech-to-text model, upload limits, dashboard ports) | The settings store, one JSON document per section, with schema defaults for every key the owner has not set; each unit reads its projection | Edited by the Settings screen and `mise run config:*`; validated whole on every write; applied by restart |
| The persona (`personality`) and the emotion map (`expressions`) | The settings store, as documents; projected to the units that declare them | One place with the settings; the export and backups cover them |
| Credentials: the paths of `SECRET_PATHS` (`llm.openai.api_key`, `llm.claude.api_key`, `llm.bedrock.access_key_id`, `llm.bedrock.secret_access_key`, `vision.obs.password`, the speech engines' API keys, `voice.pocket.hf_token`, the four Twitch credentials, `chat.youtube.api_key`, `connections.discord.token`, `tools.servers.*.token`) | The settings store, encrypted per value; delivered in memory to the units that declare them | Never returned by a read route; written only through the dashboard's write-only route or `mise run config:secret`; never in a projection, `.env` or a container environment |
| The master key | `~/.config/cohost/master.key` (or `$XDG_CONFIG_HOME/cohost/master.key`, or `COHOST_KEY_FILE`), mode 0600, outside the checkout | The root of trust for an unattended start; a copy of the checkout, of `data/` or of a backup carries no key; printed once as the recovery key |
| `CONTROL_TOKEN` | The owner's password manager; the store keeps only its scrypt verifier | cohost's one lock, from which the ears audio listener's key is derived when it is set; in no file on disk and in no container. `.env` or the environment defining it makes the dashboard and the control plane refuse to start; `mise run dashboard:unlock` may take it from its own environment |
| `CONTROL_ADVANCED`, `DASHBOARD_HOST` | `.env` | Decide how far the dashboard is exposed; read at start; a page that can change its own exposure is a privilege escalation |
| `CONFIG_DIR`, `COHOST_ENV_FILE`, `COHOST_DATA_DIR`, `COHOST_KEY_FILE`, `COHOST_DOCKER_BIN` | `.env` or the shell (`CONFIG_DIR` is set by Compose and the unit runner to the projection directory) | Locate the files and tools needed before configuration can be read |
| `COHOST_CREDENTIALS_FD` | Set by the unit runner on a host-run service | The descriptor of the pipe that carries the unit's credentials; never written by the operator |
| `REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `VOICE_PORT` | `.env` or the shell (Compose pins the first six for containers) | Infrastructure addresses a service needs before it can open the bus; per machine |
| `COMPOSE_FILE`, `COMPOSE_PROFILES`, `COMPOSE_PATH_SEPARATOR`, `COMPOSE_PROJECT_NAME`, `KOKORO_IMAGE`, `SPEACHES_IMAGE` | `.env` | Read by `docker compose` itself, before any container exists |
| `HEARTBEAT_INTERVAL_MS` | `.env` | Read by the shared runtime and the container healthchecks, which derive staleness from it, outside the schema |
| `logging.*` (level, terminal format, log file and its rotation) | The settings store | An operator setting like any other; the logger, which exists before configuration is loaded so that it can report the load's failure, reads this one section itself, from the projection or, in a program that owns the store, from the source it registers ([config](../intent/config/config-design.md) Logging) |
| `COHOST_ISOLATION` | Set by the control plane on the `docker compose` process for an isolated start of one unit, passed to that container by Compose; never written by the operator | One JSON object of override names (`LLM_PROVIDER`, `AVATAR_DRIVER` and the rest of `ISOLATION_OVERRIDES`) to values, applied by key path; makes one unit run with no external backend; the editor reports a key a running unit has overridden. The override names are labels in that object, not environment variables: a plain `AVATAR_DRIVER` in `.env` or the shell is read by nothing |
| Provider credentials (`ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` and the like) | Not read | Clients are given credentials from the delivery only, so a key left in the environment cannot keep a provider working while Settings shows Not set |
| `EDITOR` | The shell | The editor `mise run config:personality -- --edit` opens |
| `COHOST_VERSION`, `HOSTNAME`, `PATH`, `WSLENV`, `NO_COLOR` | Process environment, set by the image build, the host or Compose | Build and platform metadata, and the cross-tool `NO_COLOR` convention that turns colour off in every program that honours it; not cohost settings |

The environment variables cohost source reads are exactly those named in the token, access, bootstrap, infrastructure, Compose, heartbeat, `COHOST_ISOLATION`, editor and platform rows above, plus `XDG_CONFIG_HOME` for the key file's default location; a test fails when source reads any other, so a new operator setting cannot arrive as an environment variable. That test covers cohost source only. The paths it cannot see are closed by other rules: Compose interpolation by the settings holding no placeholder and Compose passing the one `COHOST_ISOLATION` entry (deployment), and third-party libraries by constructing every client with credentials taken from the delivery alone (model-backends).
