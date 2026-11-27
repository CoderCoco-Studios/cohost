---
parent: high-level-design
prefix: STORE
---

# settings-store

Status: MAPPED. The package `@cohost/store` (`packages/store/`) and its `config:*` tasks are built; no consumer uses them yet: the dashboard, the control plane and the services still read the YAML files until the cut-over (projections, delivery, state keys, the outbox and the consumer clauses of the other specs). Parent: [high-level-design](../../high-level-design.md). Specs: [settings-store-specs.md](settings-store-specs.md).

## Context and Design Philosophy

cohost keeps every operator setting, the co-host's persona, the emotion map and every credential in one SQLite database, the **settings store**, at `<dataDir()>/store/cohost.db` on the host. The store is owned by the host-side programs that operate cohost: the dashboard, the control plane (the dashboard's controller, `cohostctl` and the unit runner of the dev loop) and the `mise run config:*` tasks. No service opens it. Before the control plane starts a unit it writes that unit's **projection**, a plain JSON file holding the settings sections and documents the unit's manifest entry declares and nothing else, and after the unit's process has started it **delivers** the unit's credentials to it in memory. A credential is never on disk in plaintext: it is encrypted in the store, crosses into a container through `docker exec`'s standard input into a RAM-only mount, and reaches a host-run service through an inherited pipe. The one plaintext secret on disk is the master key file, outside the checkout, mode 0600.

The owner never edits a file by hand. Settings change through the dashboard's Settings screen, through `cohostctl` and the store's own `mise run config:*` tasks, and in bulk through a YAML export and import. The import is also how a new store is seeded from the committed examples, and how settings move between machines.

Five properties drive the design:

1. **One place.** Settings, persona, emotion map, credentials, the control token's verifier and the keys cohost itself generates live in one file with one schema version, one backup and one export. The HLD's tenet 7 is this segment's rule.
2. **Least privilege per unit.** A unit sees only its declared sections, documents and credentials. Only the control plane holds the master key, so only it can decrypt.
3. **Nothing secret at rest in plaintext.** No credential in a projection, in `.env`, in a container environment variable (Docker keeps a container's environment in its on-disk configuration, so an environment variable counts as at rest), in a bind-mounted file, or in a log.
4. **Unattended start, with one stated exception.** No passphrase, PIN or Windows Hello prompt: the master key file is the accepted root of trust (Threat model), so no person is needed to unlock anything. The exception is delivery after a reboot: Docker brings the containers back by its restart policy, but they wait for their credentials until the dashboard starts (it delivers at its own start, STORE-DLV-005) or `cohostctl deliver` (`mise run deliver`, control-plane CTRL-CLI-019) runs. An optional user-level autostart of the dashboard (a systemd user unit or a Windows logon task) would close that gap; it is a follow-up, not built.
5. **One code path for containers and the dev loop.** A host-run service under `mise run dev` reads the same projection a container mounts and receives its credentials through the same message, over a different carrier.

### Threat model

| Threat | Covered | How |
|---|---|---|
| The checkout, `data/` or a backup copied, zipped for a support request or synced to a cloud drive | Yes | The store and its backups hold only ciphertext for credentials; the master key file lives outside the checkout (`~/.config/cohost/master.key`), so a copy of the checkout or of `data/` carries no key. |
| A container compromised (a third-party MCP server's reach into `tools`, a malicious model reply exploiting a service) | Partly | The container holds only its own unit's credentials, in process memory; it never sees the store, the key, another unit's credentials or the control token. |
| `docker inspect`, the Docker Desktop VM disk, a container's on-disk configuration | Yes | No credential is a container environment variable or a bind-mounted file; the delivery mount is `tmpfs`. |
| A disk image of the host taken while cohost is off | No, by design | The key file is on the same disk as the store. A disk-level attacker holding both decrypts. The optional TPM sealing (Decisions & Alternatives) would cover this case and is not built. |
| A process running as the owner's OS user | No, by design | It can read the key file, as it could read the operator's files before. The OS user is the boundary, as it is for `cohostctl` and the Docker socket (HLD Trust boundary). |
| Swap | No, by design | A credential in process memory or in a `tmpfs` page can be swapped to the swap file or the VM's swap disk. |

## Package and ownership

The store is a workspace package, `@cohost/store` (`packages/store`), ESM, AGPL-3.0-only, depending on `@cohost/config` (the zod schema, `SECRET_PATHS`, the presentation table and the section list) and on nothing outside Node's standard library. It exports `openStore(options)`, which returns a `Store` handle with the operations below, and the export and import codecs.

Who imports it (STORE-PKG-001): `services/dashboard`, `packages/control` (the controller, `cohostctl`, the unit runner) and the `config:*` task entry points under `packages/store/src/cli/`. A test fails when any other package or service imports `@cohost/store` or opens a file under `<dataDir()>/store/`. Services keep importing `@cohost/config` for the schema, the loader and the helpers; the loader reads the projection.

## The database

### Library

The store uses Node's built-in `node:sqlite` module (STORE-DB-001), class `Database` (Node 26 documents `DatabaseSync` as its deprecated alias). Node 26.13.1, the version `mise.toml` pins, marks the module Stability 1.2, release candidate, since v25.7.0: no flag is needed, the API is not expected to change incompatibly, and it is not yet marked Stable. The store wraps it in one module, `packages/store/src/db.ts`, exposing only open, `exec`, prepared statements, a transaction helper and the online backup, so a change of library touches one file. Decisions & Alternatives records `better-sqlite3` as the alternative and why it is not chosen; the owner question in the design PR asks the owner to accept a release-candidate module.

### File, directory and connection settings

- **Path.** `<dataDir()>/store/cohost.db` (CFG-DIR-006, CFG-DIR-007), with SQLite's `-wal` and `-shm` files beside it. `dataDir()` on the host is the checkout's `data/` or `COHOST_DATA_DIR`; no container mounts `data/store`.
- **Permissions.** The store directory is created with mode 0700 and the database, WAL and shared-memory files with 0600: the opening process sets its umask to `0o077` around the open and checks the modes afterwards, warning (never failing) when group or other has any permission, except on Windows and where the filesystem reports `0777` for every file (a drvfs checkout), as the log and key checks do (STORE-DB-002).
- **Pragmas at open** (STORE-DB-003): `journal_mode=WAL`, `synchronous=NORMAL` (WAL's durable-on-checkpoint mode; a power cut can lose the last committed write, never corrupt the file), `foreign_keys=ON`, `secure_delete=ON` (a cleared credential's ciphertext pages are zeroed), and a busy timeout of 5000 ms in the control plane, the unit runner and the tasks but 250 ms in the dashboard, which retries a blocked write asynchronously (STORE-SET-004).
- **Integrity at open** (STORE-DB-004): `PRAGMA integrity_check` must answer `ok`, and `meta.schema_version` and `meta.store_id` must be present. A failure is a **damaged store**: the dashboard starts in recovery mode, and `cohostctl` and the `config:*` tasks refuse with the reason. A `meta.schema_version` greater than this build knows is a **newer store**: the message says `the settings store is newer than this build: update cohost`, and nothing offers to change the file (Recovery).

### Tables

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,           -- schema_version, store_id, key_id, revision, created_at, token_verifier
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sections (
  path       TEXT PRIMARY KEY,      -- a declared section path: 'cohost', 'llm', 'brain.salience', ...
  doc        TEXT NOT NULL,         -- JSON: only the keys the owner set (sparse; defaults are the schema's), or the value of a one-value section
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE documents (
  name       TEXT PRIMARY KEY CHECK (name IN ('personality', 'expressions')),
  body       TEXT NOT NULL,         -- personality: Markdown; expressions: JSON of ExpressionMapSchema
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE secrets (
  path       TEXT PRIMARY KEY,      -- a concrete secret path: 'llm.openai.api_key', 'tools.servers.search.token'
  nonce      BLOB NOT NULL,         -- 12 random bytes
  tag        BLOB NOT NULL,         -- 16-byte GCM tag
  ciphertext BLOB NOT NULL,
  key_id     TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE keys (                 -- keys cohost generates for itself, encrypted like secrets
  name       TEXT PRIMARY KEY,      -- 'session', 'ears-listener', 'state:<unit>'
  nonce      BLOB NOT NULL,
  tag        BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  key_id     TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
```

**Settings as per-section JSON documents** (STORE-DB-005). A row per declared section path (the sections of the presentation table, CFG-PRES-*: every top-level key of `ConfigSchema` except `brain`, and the seven `brain.*` sections), holding the keys the owner set, sparse, exactly as the section would be written in YAML; the two sections the schema holds as one number (`brain.working_memory_events`, `brain.working_memory_own_lines`) hold that value. A key the row does not hold takes its schema default when the configuration is assembled, so a default changed in code applies to every key the owner never set. The assembled configuration is the nested object of all rows, validated by `ConfigSchema` (the same `parseConfig` pipeline the projection loader uses, minus the file parsing: null-dropping, then the schema) on every write. A key the schema does not know is an issue of the write, not silently dropped, so a stored setting a newer build removed shows up as an invalid setting (Recovery, cause 4). A section document never holds a credential: a value at a secret path is an issue of the write. Section-shaped rows match how the schema, the manifest's `config` lists, the settings routes (`PUT /config/:section`) and the projection are all shaped; a key/value row per leaf would need reassembly for lists and maps (`tools.servers`, `brain.salience.reflexes`) and buys nothing a JSON document lacks.

**Documents.** `personality` (Markdown text, at most 64 KiB, as the personality route allows) and `expressions` (`ExpressionMapSchema`, stored as JSON). They are rows of their own because they are not keys of `ConfigSchema` and because units declare them separately (module-contract MOD-MAN-016).

**Revision.** `meta.revision` is an integer incremented by every committed write of any table (STORE-DB-006). It is the settings editor's etag, the projections' `revision`, and how a long-lived reader (the dashboard) learns that another writer changed the store: it re-reads what it caches when `PRAGMA data_version` changes or the revision differs.

**Schema version and migrations** (STORE-DB-007). `meta.schema_version` starts at 1. A build that finds an older version takes a backup and migrates inside one transaction; a newer version is refused as a newer store, so an older checkout never writes a store a newer one made. Migrations are of the store's own tables; there is no import of any file format other than the export format.

### Transactions and concurrency

Writers are the dashboard (Settings, personality, secrets, recovery), `cohostctl` (token checks only read; it writes nothing but the projections and deliveries it reads for), the `config:*` tasks and the unit runner (which only reads, apart from the reflect outbox). WAL lets readers proceed while one writer commits.

- Every write is one `BEGIN IMMEDIATE` transaction: read the current state, apply the change, validate the whole assembled configuration (and the documents), bump `meta.revision`, commit (STORE-SET-002). A validation failure rolls back and returns the issues; nothing is half-written.
- A writer that carries an etag (the settings routes) compares it with `meta.revision` inside the same transaction, so the check and the write cannot interleave with another writer: a stale etag is a `409` (STORE-SET-003).
- The busy timeout (5 s outside the dashboard) covers the brief exclusive moments of another writer; a write still blocked after it fails with a message naming the store and `SQLITE_BUSY`, and changes nothing. `node:sqlite` is synchronous, so a busy wait inside the dashboard would hold its event loop: the dashboard's timeout is 250 ms, and a blocked write is retried asynchronously after 50, 100, 200, 400 and 800 ms before it fails (STORE-SET-004).
- A projection or delivery reads its unit's sections, documents and credentials in one read transaction, so it sees one revision (STORE-PROJ-003).
- The lifecycle lock (control-plane CTRL-LOCK-*) is unchanged and still serialises lifecycle actions; writing projections and delivering credentials happen inside the action that holds it. Settings writes do not take the lifecycle lock: a write committed while a unit starts reaches that unit at its next start, the restart-to-apply rule (HLD tenet 10).

### Backups

The store makes a backup with SQLite's online backup API (`backup()` of `node:sqlite`) to `<dataDir()>/store/backups/cohost-<UTC yyyymmddThhmmssZ>.db`, mode 0600 (STORE-DB-008): at the dashboard's first start of each UTC day, before a schema migration, before an import, before a restore, and on demand through `mise run config:backup`. The ten newest are kept; older ones are deleted. A backup holds ciphertext only and is useless without the master key; it is restored with `mise run config:restore -- <file>`. A backup may come from anywhere, so the restore treats it as data: it first copies it, through the online backup from a read-only connection, to a private 0600 file in the store directory, and checks that copy (integrity, exactly this build's schema version, exactly this build's columns in every table, and a key id the key file or a kept key file beside it holds). It then backs up the live store (never pruning the backup being restored, so restoring the oldest of ten works), attaches the copy read-only with `trusted_schema` off and in defensive mode, and replaces every row of every table by named columns in one `BEGIN IMMEDIATE` transaction, which also reads the live revision and sets it one higher, so a running dashboard sees a new revision rather than a replaced file. A backup taken before a rotation or a restore of the key is restored with the kept key, which becomes the key file again. Two backups taken in the same second never overwrite each other: the later one is named for the next free second. An import or a restore sets `meta.revision` to the live store's previous revision plus one, whatever the restored content carried, so an etag a browser still holds can never match the new content (STORE-DB-011). An import or a restore over a damaged store first moves it aside as `cohost.db.damaged-<timestamp>` (STORE-TASK-006).

## Keys

### The master key

- **Location** (STORE-KEY-001): `COHOST_KEY_FILE` when set and non-empty, else `$XDG_CONFIG_HOME/cohost/master.key`, else `~/.config/cohost/master.key`. Outside the checkout on purpose: a copy of the checkout, of `data/` or of a backup carries no key, and the home directory is on the WSL2 distribution's own filesystem, where modes mean something, even when the checkout is on a Windows drive.
- **Content**: one line, `cohost-key-1:` followed by 32 random bytes in base64url (no padding). The same text is the **recovery key**.
- **Creation** (STORE-KEY-002): when a program opens the store and the key file does not exist, and the store does not exist or holds no row in `secrets` or `keys`, the program creates the key: the directory with mode 0700, a temporary file with mode 0600 holding the line, then `link()` to the key file's name, so the key appears whole or not at all and two programs starting at once cannot both create one (the loser gets `EEXIST` and reads the winner's file, retrying for up to 2 s until it parses). When standard output is a terminal it prints the recovery-key notice there (never through its logger, so never to `data/logs/`, and never on the bus): the recovery key, and that it is the only way to recover the stored credentials if this file is lost, to be kept in a password manager. When it is not a terminal (the dashboard started by a service manager, output redirected to a file), it prints only that a recovery key was created and to run `mise run config:key -- --show`, on standard error so that `mise run config:export > file` never receives it, and sets `meta.recovery_key_unconfirmed`; the dashboard then shows a banner until the owner confirms the key is saved (STORE-KEY-010).
- **Refusal** (STORE-KEY-003): when the key file is missing and the store holds at least one row in `secrets` or `keys`, the program refuses and generates nothing: the message names the key file and the store, says how many credentials the store holds, and names the two ways forward: `mise run config:key -- --restore` with the recovery key, or `mise run config:reset-credentials`, which, after a typed confirmation, deletes every row of `secrets` and `keys`, makes a new key and a new session key at once (the token verifier stays), and leaves ears without a listener key until the next bearer check that succeeds or the next `mise run config:token` (STORE-KEY-009, STORE-TOK-003). The dashboard starts in recovery mode for this case.
- **Key id** (STORE-KEY-004): `key_id` is the first 16 lowercase hex digits of HMAC-SHA256 keyed with the key of the text `cohost/key-id/v1`. `meta.key_id` records it when the key is first used; at open, a key file whose id differs from `meta.key_id` is the wrong key and is refused like a missing one, naming both ids (never the key).
- **Mode check** (STORE-KEY-005): a key file with any group or other permission is refused (not warned) outside Windows and drvfs, naming the file and `chmod 600`: unlike a log file, the key is the whole root of trust.
- **Replacing a key file.** Restoring the key from the recovery key (STORE-KEY-008) and discarding the credentials (STORE-KEY-009) write a key file where one may already exist (a wrong key, or the key the discarded credentials were under). The existing file is renamed beside it first, as `master.key.replaced-<timestamp>` or `master.key.discarded-<timestamp>`, and set to mode 0600, because older backups may still need it; the new file is then made as a missing one is. Discarding the credentials therefore does not destroy them: the backup taken before the reset and the discarded key file still decrypt them, and `config:restore` of that backup brings them back with that key.
- **Rotation** (STORE-KEY-007): `mise run config:key -- --rotate` writes a new key to a temporary 0600 file beside the key file, re-encrypts every row of `secrets` and `keys` under it and updates `meta.key_id` in one transaction, keeps the old key file as `master.key.rotated-<timestamp>` (0600), so backups taken before the rotation stay restorable, and renames the temporary file over the key file. It shows the new recovery key as a new key's is shown (a terminal only; otherwise the pointer and the unconfirmed flag). A failed transaction leaves the key file as it was; a rename that fails after the commit leaves the new key in the temporary file, which the error names. Each row carries `key_id`, so a row encrypted under another key is detected rather than decrypted to garbage.

### Encryption of a value

AES-256-GCM through `node:crypto` (STORE-KEY-006): a fresh 12-byte random nonce per write, the 16-byte tag stored beside the ciphertext, and associated data `cohost/v1|<store_id>|<table>|<path or name>`, so a ciphertext copied to another row, another table or another store fails authentication instead of decrypting as a different credential. The master key encrypts values directly; there is no per-value data key, because the store is small and a rotation re-encrypts every row in one transaction. A decryption failure (wrong key, a tampered row) is reported naming the path, never a value, and is a damaged store.

### The control token

`CONTROL_TOKEN` is cohost's one lock (HLD Trust boundary); the owner holds it, in a password manager, and the store holds only what verifies it and what derives from it.

- **Setting it** (STORE-TOK-001): `mise run config:token` generates a token of 32 random bytes in base64url (43 characters), stores its verifier and prints the token once, with the advice to keep it in a password manager. `mise run config:token -- --stdin` reads the owner's own token from standard input instead (never from an argument, which `ps` would show), trims it and refuses one shorter than 32 characters, as the dashboard's rule is (CTRL-CONFIG-001). The installer runs `mise run config:token` when the store holds no verifier (deployment DEPLOY-INST-013).
- **The verifier** (STORE-TOK-002): `meta.token_verifier` is JSON `{alg: "scrypt", N: 32768, r: 8, p: 1, maxmem: 67108864, salt, hash}`, `salt` 16 random bytes and `hash` the 32-byte scrypt output, both base64url. `maxmem` is stated because Node's scrypt refuses parameters above its 32 MiB default. scrypt rather than an HMAC because an owner-chosen token may be weaker than a generated one, and the verifier sits in a file a backup copies.
- **Checking a bearer** (STORE-TOK-003): the dashboard computes scrypt of the presented value with the stored parameters and compares in constant time. One check costs tens of milliseconds and 32 MiB, so the dashboard runs at most one at a time with at most four waiting; a fifth is answered `429` at once, which bounds the memory and CPU a flood of bad tokens can take. It remembers, in memory only, the SHA-256 of up to four bearer values that verified; a remembered value skips scrypt, and the memory is cleared whenever the verifier changes. A value that verifies while the store holds no listener key (after the credentials were discarded) re-derives `keys.ears-listener` from it.
- **The session key** (STORE-TOK-004): a separate 32-byte random key, `keys.session`, made when the token is set and replaced every time it is set again, so setting a new token ends every browser session. The session cookie's MAC (dashboard DASH-UNL-005) is keyed with it; it is not derived from the token.
- **The ears listener key** (STORE-TOK-002): derived when the token is set, as control-plane CTRL-RUNTIME-017 defines it (HMAC-SHA256 keyed with the token of the label that spec names), and stored as `keys.ears-listener`, so the control plane can deliver it to ears without the token. The clients that send audio derive it from the token they hold, as before.
- **Where the token is not** (STORE-TOK-005): not in `.env`, not in any environment the control plane or the dashboard reads, not in the store, not in a projection or a delivery, not in a log. `.env` defining a non-empty `CONTROL_TOKEN` is refused by the control plane before it starts anything and by the dashboard at start, naming `.env` and the line, never the value, because `.env` reaches every application container but `tools` through `env_file`.
- **Programs that need it.** A program that calls a gated route sends `Authorization: Bearer <token>`, and the owner supplies the token to it (the desktop capture helper, a script). `mise run dashboard:unlock` reads `CONTROL_TOKEN` from its own process environment when the owner sets it there (for example through a password manager's command-line runner), and otherwise asks for it on the terminal without echo (dashboard DASH-UNL-007).

## Projections

A projection is what a unit may read of the settings: its manifest entry's `config` sections and `documents`, never a credential (STORE-PROJ-001).

- **Path and form** (STORE-PROJ-002): `data/projections/<composeName>/settings.json` under the workspace root, the directory Compose mounts, whatever `COHOST_DATA_DIR` says, directory 0700, file 0600 written through a temporary file in the same directory and a rename. The file is JSON `{"format": 1, "unit": "<id>", "revision": <n>, "sections": {"<path>": {...}}, "documents": {"personality"?: "<text>", "expressions"?: {...}}}`, each section the stored sparse document. A unit dropped from the manifest has its directory removed.
- **When** (STORE-PROJ-003): before every `docker compose` command the control plane issues that creates, starts or restarts an application container (Launch, Rebuild, Restart all, a unit's start or restart, an isolated start, `consolidate` and `reembed`), for every unit, in one read transaction; on every dev-loop or one-shot run by the unit runner, for that unit; and by `mise run config:project` for every unit (the installer and `scripts/compose-smoke.sh` use it before a hand-run `docker compose up`). A failure stops the action, naming the file and the reason. The `models` container reads a projection of the sections `ollamaModels` reads (config CFG-MODEL-001), listed beside that function and checked by a test.
- **Personality saves.** When the dashboard saves the personality, it rewrites the projection of every unit that declares the `personality` document, then sends `control reload_personality` as before, so cortex re-reads it without a restart.
- **The mount.** A container mounts `./data/projections/<composeName>` read-only at `/app/config` (deployment DEPLOY-COMPOSE-025); `CONFIG_DIR=/app/config` is unchanged, so the loader's directory rule is unchanged. A host-run service gets `CONFIG_DIR` pointed at its projection directory by the unit runner.
- **The loader** (config CFG-LOAD-001): reads `settings.json`, takes the declared sections, merges the delivered credentials at the secret paths, applies the isolation overrides, validates, and returns a configuration in which a section the unit did not declare throws on access, naming the section and the unit, so a service that reads an undeclared section fails at once instead of silently running on defaults.

## Credential delivery

### Choosing the carrier

| Carrier | At rest | Docker Desktop on WSL2 | Native Linux Docker | Host-run (`mise run dev`) | One-shots | After Docker's own restart |
|---|---|---|---|---|---|---|
| (a) Launch nonce in the environment, service fetches over HTTP from a control-plane listener | Nonce on disk (harmless once spent) | Works through `host.docker.internal` | The dashboard's loopback listener is not reachable from the bridge; a new listener on the bridge address would be needed | Works | Works | Nonce spent: nothing delivered until the control plane acts |
| (b) `tmpfs` mount written before the process starts | None | A host `tmpfs` bind-mounted from the WSL distribution is not reliably shared with the Docker Desktop VM; a container `tmpfs` cannot be written before the container starts | Host `/run/user` exists only with systemd | Not applicable | Same as service | Mount empty again |
| (c) Encrypted projection file plus a per-unit key delivered by (a) | Ciphertext on disk | As (a) | As (a) | As (a) | As (a) | As (a) |
| **(d) Push after start: `docker exec -i` writes the message from standard input into the container's own `tmpfs`; a host-run service gets it on an inherited pipe** | **None** | **Works: the same `docker` CLI the control plane already drives** | **Works** | **Works (pipe)** | **Works (`run -d`, then exec)** | **Service waits and says so; the dashboard re-delivers** |

(d) is chosen (STORE-DLV-001). It needs no listener and no new network path, runs over the control plane's existing `docker` access on both Docker Desktop and native Linux, keeps the message in the Docker API stream and container RAM only, and needs no process alive after the delivery, so `cohostctl` can exit once it has delivered. Option (a)'s listener and option (c)'s second mechanism add a moving part each and still rely on a live process to hand over a key.

### The message

JSON, at most 64 KiB (STORE-DLV-002): `{"format": 1, "unit": "<id>", "revision": <n>, "credentials": {"<secret path>": "<value>", ...}, "state_key"?: "<base64url>"}`. `credentials` holds exactly the declared secret paths that the store holds (the wildcard `tools.servers.*.token` expanded to the servers the stored `tools` section holds), plus `ears.http.verifier` for the `ears` unit alone (from `keys.ears-listener`). A unit that declares no secret path and no state key receives no message and does not wait for one.

### Into a container

1. The control plane reads each unit container's `State.StartedAt` (`docker inspect`), runs its `docker compose` command (`up -d`, `restart`, `run -d --name <name>` for a one-shot), and reads `StartedAt` again. A container is **started** by the command when its `StartedAt` changed or it did not exist before; a one-shot is the container named by `--name` (STORE-DLV-003). Only started containers are delivered to, so a Launch that leaves a running unit untouched does not overwrite anything, and each delivery's container id and `StartedAt` are recorded in `data/control/deliveries.json` (no credential), written through a temporary file and a rename because the dashboard and `cohostctl deliver` both write it.
2. For each started container whose unit receives a message, it runs `docker exec -i <container> sh -c 'umask 077 && cat > /run/cohost/.credentials.tmp && mv /run/cohost/.credentials.tmp /run/cohost/credentials.json'` with the message on standard input (STORE-DLV-003). The message is never an argument and never in the environment of the `docker` process.
3. Each such service mounts `/run/cohost` as `tmpfs` (mode 0700, size 1 MiB; Docker accepts no option that keeps its pages out of swap, so they can be swapped as process memory can, Threat model), and every application container runs with `ulimits: core: 0`, so a crash writes no core file holding credentials (deployment DEPLOY-COMPOSE-033, DEPLOY-COMPOSE-034).
4. The service's bootstrap creates its logger with the logging defaults and its bus from `REDIS_URL`, starts its heartbeat `starting` with the reason `waiting for credentials`, waits for `/run/cohost/credentials.json`, reads it, deletes it, validates the message (format, unit id equal to its own, every path one it declares) and keeps the credentials in memory, and only then loads its configuration (STORE-DLV-004, shared-runtime SHARED-BOOT-009 to SHARED-BOOT-011). It waits as long as it takes. A one-shot that never opens the bus (`consolidate`, `reembed`) logs the reason once instead; it is only ever run by the control plane, which delivers to it. Waiting is not the missing-credentials idle plan: that plan applies, as before, to a credential the message did not carry.
5. A failed exec (the container exited, `sh` missing) fails the action naming the unit and the exit status, never the message.

**Docker's own restarts and reboots** (STORE-DLV-005, control-plane CTRL-CLI-019). Application services run `restart: unless-stopped`, so after a crash, a Docker daemon restart or a reboot a container comes back with an empty `tmpfs` and no delivery. It then waits, reporting `waiting for credentials`. The dashboard delivers to every running unit that reports that reason or whose `StartedAt` differs from its last recorded delivery, at its own start and afterwards from its heartbeat feed and stack probe; `cohostctl deliver` (`mise run deliver`) does the same once, for an owner who does not run the dashboard. A unit with no recorded delivery whose heartbeat is already `ready` holds its credentials and is skipped, so a first dashboard start against a running stack delivers nothing twice; `tts-pocket`, which has no heartbeat, is judged by `StartedAt` alone. After a reboot, therefore, units wait until one of the two runs: the stated exception to the unattended start.

**The Pocket engine** (STORE-DLV-006). `tts-pocket` runs a third-party server with a shell entry point and publishes no heartbeat. It receives a single value instead of the JSON message: the control plane always writes `/run/cohost/hf_token` the same way, holding `voice.pocket.hf_token` or empty when the store holds none, so the file's arrival is the signal. The entry point waits for it with no timeout, exports a non-empty value as `HF_TOKEN` for the server process only, deletes the file and starts the server. Because it has no heartbeat, the dashboard's stack probe re-delivers whenever its `StartedAt` changes.

### Into a host-run service: the unit runner

`node packages/control/dist/run-unit.js <unit> [entry]` (STORE-DLV-007) is how every host-run service and one-shot starts: each `dev:<service>` task, and `mise run reflect`, `consolidate` and `reembed`. It opens the store, writes the unit's projection, starts `node <entry>` (default `services/<unit>/dist/index.js`) with the service directory as working directory, `CONFIG_DIR` set to the projection directory, `COHOST_CREDENTIALS_FD=3` and a pipe on file descriptor 3, writes the message to the pipe and closes it, then forwards `SIGINT` and `SIGTERM` to the child and exits with its status. The child reads descriptor 3 to its end (STORE-DLV-004). `mise watch --restart` restarts the runner, so every restart delivers again.

### Isolated starts and the stub backends

An isolated start passes `COHOST_ISOLATION` as before (config CFG-ISO-007) and delivers the same message: the overrides select mock backends that do not use the credentials, and a credential delivered but unused costs nothing.

## Unit state keys

Two services persist a credential they obtain at run time: `chat` writes the refreshed Twitch token (chat CHAT-TW-011) and `avatar` the VTube Studio plugin token (avatar AVATAR-VTS-003). They cannot write the store. Each unit whose manifest entry sets `stateKey: true` (`chat`, `avatar`) gets a 32-byte random key, `keys.state:<unit>`, made at its first delivery and carried in its message (STORE-STATE-001). The service encrypts the file it persists under `<dataDir()>/<unit>/` with AES-256-GCM under that key (associated data `cohost/state/v1|<unit>|<file name>`) and treats a file it cannot decrypt as absent, logging one warning (STORE-STATE-002). The VTube Studio token moves out of the config directory to `<dataDir()>/avatar/vts-token.enc`, through a `./data/avatar` mount of its own (deployment DEPLOY-COMPOSE-028).

## The reflection pass's write

`reflect` appends a `## Learned` block to the personality (memory MEM-REFLECT-007), and it is a service-side program that cannot write the store. It writes `{base, text}` to an outbox file, `<dataDir()>/memory/personality-outbox.json` (mode 0600, through a rename), instead of saving it: `base` is the SHA-256 of the personality text it read from its projection and `text` the whole new text (STORE-OUT-001). The unit runner, after `reflect` exits 0, writes `text` into the `personality` document when the SHA-256 of the current document still equals `base` (otherwise it keeps the outbox and reports a conflict), deletes the outbox and rewrites the personality projections (STORE-OUT-002). Comparing the text's hash rather than a revision means an unrelated settings write between the read and the apply is no conflict. A dashboard that starts with an outbox present applies it the same way and logs that it did. Personality text is not a credential, so the outbox is plain.

## Seeding, export and import

### The export format

YAML, one document (STORE-IO-001):

```yaml
cohost_export: 1
settings:            # nested exactly as the schema's sections are, sparse
  cohost: { name: Ava, timezone: Europe/London }
  llm: { provider: ollama, model: qwen2.5:7b-instruct-q4_K_M }
personality: |
  # Ava
  ...
expressions: { vtube_studio: { joy: Happy } }
secrets:             # only with --secrets
  kdf: { alg: scrypt, N: 131072, r: 8, p: 1, maxmem: 268435456, salt: <base64url> }
  values:
    llm.openai.api_key: "enc1:<nonce>.<ciphertext+tag in base64url>"
```

- `mise run config:export -- [file] [--secrets]` (STORE-IO-002) writes the format to the file (mode 0600) or standard output. Without `--secrets` the `secrets` block is absent and a comment lists which secret paths are set, never a value. With it, the task asks twice for a passphrase of at least 12 characters on the terminal, derives a key with scrypt (`N` 2^17) and encrypts each value with AES-256-GCM (associated data the path), so an export with credentials is still never plaintext. The token verifier and cohost's own keys are never exported.
- `mise run config:import -- <file>` (STORE-IO-003) reads the format, validates the whole result as a write would, takes a backup, and replaces the settings, documents and, when present, the credentials in one transaction (asking for the passphrase); a section or document the file does not hold is removed, so an import makes the store equal the file. It refuses, writing nothing, on any problem, listing each as `path: message`. `--dry-run` validates and prints what would change (sections and documents added, changed or removed, the credential paths it would set) and writes nothing.
- **Parts** (STORE-IO-004): `config:import` also takes the parts separately, `--settings <yaml>` (a mapping shaped like `settings:`), `--personality <md>`, `--expressions <yaml>` and `--secrets <yaml>`, where a part's secrets are a plain mapping nested by path. A plaintext secrets part is accepted because the owner brings it; the task prints a reminder to delete that file. A hand-kept file may carry what the store does not take: a credential written in the settings part, or a path in the secrets part that is no credential of this build (a retired one). The import leaves each out and lists it as a note, by path, never a value; the dry run shows the same notes. This is how a new store is seeded and how a hand-kept file is brought in once; there is no other reader of YAML settings.
- **Seeding a new store** (STORE-IO-005): when a program creates the store, it imports the committed examples as parts: `config/config.example.yaml`, `config/personality.example.md` and `config/expressions.example.yaml`. The examples stay in the repository as the seed (config CFG-USR-*); they are never copied into the owner's files.

## The `config:*` tasks

Every task is a `mise.toml` task running an entry point of `@cohost/store` (STORE-TASK-001); arguments after `--`. Each opens the store with the rules above (creating it, or refusing for a damaged store or a missing key, except where noted), never prints a credential except where the task's purpose is to print one, and exits 0 on success and 1 with one message otherwise. Settings and credential writes made by a task apply to running units at their next start, as a dashboard save does; the task names the units that read what it changed.

| Task | Does |
|---|---|
| `config:get -- <path>` | Prints the effective value of a setting (the stored value, or the default marked as such) as YAML; a secret path prints `set` or `not set` |
| `config:set -- <path> <yaml value>` | Sets one setting (not a secret path), validating the whole configuration |
| `config:reset -- <path>` | Removes one setting so its default applies |
| `config:secret -- <path> [--clear]` | Sets a credential read from standard input without echo, or clears it |
| `config:personality -- [--edit]` | Prints the personality, or opens it in `$EDITOR` from a 0600 temporary file and saves it on exit |
| `config:token -- [--stdin]` | Sets the control token (The control token) |
| `config:key -- --show \| --restore \| --rotate` | Prints the recovery key; writes the key file from a recovery key read without echo after checking its id; rotates |
| `config:reset-credentials` | Deletes every credential and generated key after typed confirmation (Keys) |
| `config:export`, `config:import` | Seeding, export and import |
| `config:backup`, `config:restore -- <file>` | Backups |
| `config:check` | Runs the integrity check, the key check and the validation of the stored settings, and lists every problem |
| `config:project` | Writes every unit's projection (no credentials) |
| `deliver` | Runs `cohostctl deliver`: delivers credentials to every running unit that waits for them or was started since its last delivery (control-plane CTRL-CLI-019) |

## Recovery

The dashboard must start when the store cannot be used, so the owner can fix it from the page (dashboard Config recovery mode). Four causes remain, reported in this order when several apply (STORE-RCV-001):

1. **Damaged store**: unreadable, `integrity_check` not `ok`, a missing schema version or store id, or a row that fails to decrypt. The screen offers restoring one of the listed backups and importing an export file; either moves the damaged file aside first.
2. **Newer store**: `meta.schema_version` is newer than this build. The only fix is to update cohost, so the screen says that and offers nothing that changes the store.
3. **Key missing or wrong** (STORE-KEY-003, STORE-KEY-004, STORE-KEY-005). The screen offers entering the recovery key, accepted from a loopback peer only (dashboard DASH-RCV-026), and discarding the credentials. A key file with group or other permissions is fixed with `chmod 600` and Check again.
4. **Stored settings fail the current schema**: a code update changed or removed what a stored key may hold. `checkStore()` lists each problem as `{path, message}` and the screen offers Set and Reset per key and Reset all, against the store's revision as etag.

When several apply, the cause reported is the first in this order: damaged store, newer store, missing key, invalid settings (STORE-RCV-001).

**Access in recovery.** The session key is encrypted under the master key, so while the store is damaged or newer or the key is missing no browser session can be checked or made: the dashboard prints no unlock link and its gate accepts only a bearer the verifier accepts (`meta.token_verifier` is not encrypted). When the store is so damaged that even the verifier cannot be read, the page shows the host commands instead of controls (`mise run config:restore`, `config:import`, `config:key -- --restore`), which run as the owner's OS user (dashboard DASH-RCV-028).

**Two stated exceptions to settings through the dashboard.** When the verifier itself cannot be read, the fix is a host command run as the owner's OS user, not a page action (dashboard DASH-RCV-028); and the recovery key made when credentials are discarded from the page is printed only to the dashboard's terminal (or, without one, shown by `mise run config:key -- --show`), never sent to a browser.

**Writing over a damaged store.** An import or a restore never writes into a damaged file: it renames the database and its WAL and shared-memory files aside as `cohost.db.damaged-<timestamp>`, creates a new empty store and imports or copies into it (STORE-TASK-006), so the damaged file stays for inspection.

**Discarding credentials** makes a new key and a new session key at once; ears has no listener key until the token is set again, because the listener key derives from the token (STORE-KEY-009).

A missing store is not a recovery case: it is created and seeded. Syntax errors, placeholders, malformed credentials files and a raw-text editor have no counterpart: no file is edited by hand, every write is validated, and a credential is always a string.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Where configuration lives | One SQLite file in `data/store/`, owned by the host-side programs | YAML files edited by hand and by the dashboard (`config.yaml`, `secrets/secrets.yaml`, `personality.md`, `expressions.yaml`); Redis; Postgres; a directory of JSON files | Owner decision (#372): one place with transactions, one backup and one encrypted credentials table. Redis here has no auth and loses up to 60 s of writes; Postgres is a container that must be running before the dashboard can show a setting; JSON files have no transactions across files. The hand-editable, diffable property of YAML is given up deliberately: the export is the diffable form. |
| SQLite library | `node:sqlite` (built in, Stability 1.2 release candidate on Node 26.13.1), wrapped in one module | `better-sqlite3` 13.2.0 (MIT, stable, synchronous, mature) | Built in means no dependency, no native addon to build or fetch for Node 26's ABI on the host and in CI, and nothing added to the image (no service opens the store). The API used is small (open, prepared statements, `exec`, backup). The release-candidate status is the risk, contained by the one-module wrapper; `better-sqlite3` is the fallback if the owner declines it or the API changes. |
| Settings shape | One JSON document per declared section, sparse, the whole configuration validated by `ConfigSchema` on every write | A typed key/value row per leaf; one JSON document for everything | Sections are the unit of the schema, the manifest, the settings routes and the projection. Per-leaf rows need reassembly for lists and maps. One document for everything makes every write rewrite everything and every projection parse everything. |
| Personality and expressions | Documents in the store | Keep them as files in `config/` | The owner's rule is one place and no hand-edit path; the export and backup then cover the persona too. |
| Who opens the store | The dashboard, the control plane (controller, `cohostctl`, unit runner) and the `config:*` tasks; never a service | Every service opens it read-only | Owner decision: SQLite locking over a Docker Desktop bind mount from WSL is unreliable, only the control plane may hold the key, each unit should see only its own settings, and the service loaders barely change. |
| Undeclared section access | Throws, naming the section and the unit | Project every section to every unit (settings are not secret); fill undeclared sections with defaults | Least privilege per unit was the owner's direction; a throw makes a missing declaration a loud failure at first use instead of a service silently running on defaults. Each unit has a boot test that runs its service against a projection of only its declared sections (module-contract MOD-MAN-018), so a missing declaration fails in CI rather than on a stream. |
| Credential delivery carrier | `docker exec -i` from standard input into a container `tmpfs`; an inherited pipe for host-run programs | A launch nonce and an HTTP fetch; a host `tmpfs` bind mount; an encrypted projection with a per-unit key delivered by nonce | See Credential delivery: (d) works the same on Docker Desktop and native Linux with no listener and no live broker, and nothing touches a disk. |
| After Docker restarts a container | It waits for credentials and says so; the dashboard re-delivers | Start with no credentials (the missing-credentials idle plan) and require a restart; deliver nothing until the owner acts | Waiting is honest and recovers without a person when the dashboard runs; starting without credentials would then need a restart to apply them (tenet 10). |
| Master key | A 0600 key file outside the checkout, created automatically, printed once as the recovery key | OS keyring (Secret Service is absent on a headless WSL distribution; Windows Credential Manager needs interop); a passphrase or PIN at start (owner: unattended start); TPM sealing (below) | Owner decisions: no prompt at start, a key file made automatically when missing. Outside the checkout so copies of the checkout or `data/` carry no key. |
| Key missing while credentials exist | Refuse; restore from the recovery key or discard the credentials explicitly | Generate a new key silently | A new key would orphan every stored credential without saying so (owner decision). |
| Recovery path | The recovery key printed once at creation (and on demand) is the key file's own content | An export with credentials under a passphrase as the recovery path | A printed key is one string to keep, works when the machine is gone, and needs no export to have been taken. The passphrase export exists for moving settings, not for recovery. |
| Encryption | AES-256-GCM per value, random 96-bit nonce, associated data binding store, table and path | Whole-file encryption (SQLCipher, not in `node:sqlite`); a per-value data key wrapped by the master key | Per-value encryption keeps settings queryable and in plain JSON; binding the path stops a row swap. A wrapped data key per value adds nothing for a store this small, where rotation re-encrypts every row. |
| Control token at rest | The owner keeps it; the store holds an scrypt verifier; the session key is a separate random key; the ears listener key is derived when the token is set and stored encrypted | Token in `.env` (plaintext on disk and in every container's `env_file`); token encrypted in the store (the dashboard would hold the token it guards); an HMAC verifier | Owner decision. scrypt resists guessing an owner-chosen token from a copied store; a short in-memory cache keeps program requests cheap. A separate session key lets the token change end sessions without the token being on disk. |
| `CONTROL_TOKEN` in `.env` | Refused while non-empty, by the control plane and the dashboard | Ignore it; pin it empty for containers | A credential in `.env` reaches every application container through `env_file`, which the at-rest rule forbids; a refusal tells the owner once, where ignoring it would leave it on disk. |
| Export format | YAML of the settings tree, the documents and, optionally, passphrase-encrypted credentials; the same reader takes separate parts | JSON; a SQLite file copy; plaintext credentials in the export | Owner decision: YAML. Parts make the committed examples the seed with no second reader. Credentials leave the store only encrypted. |
| Seeding | Import the committed `config/*.example.*` files when the store is created | Schema defaults only; a seed SQL file | The examples are the shipped starting point the existing specs describe (an example that loads with no credentials, CFG-ISO-005); importing them uses the one import path. |
| Concurrency | WAL; `BEGIN IMMEDIATE` writes with an etag compared inside the transaction; a busy timeout of 5 s outside the dashboard and 250 ms with asynchronous retries inside it; the lifecycle lock unchanged | A store-wide lock file; the lifecycle lock around settings writes; one long busy timeout everywhere | SQLite serialises writers itself; holding the lifecycle lock for a settings write would block a save behind a slow Launch. `node:sqlite`'s API is synchronous, so a 5 s busy wait in the dashboard would freeze every route and the feed; the short timeout and an asynchronous retry keep the event loop free at the cost of a few more attempts under contention. |
| Which containers get a delivery | Those whose `State.StartedAt` changed across the command (or that did not exist), the one-shot named by `--name`, and any running unit reporting `waiting for credentials` | Every unit of the project after every command; only the units the action named | A Launch or Rebuild leaves some containers running; delivering to them is harmless but noisy, and only `StartedAt` says which ones Compose really started. |
| After a reboot | Units wait; the dashboard delivers at its own start and `cohostctl deliver` delivers on demand; an autostart of the dashboard is a recommended follow-up, not built | Deliver from a system service holding the key; keep credentials on disk for restarts | A separate always-on service is a second process holding the key; credentials on disk break the at-rest rule. The wait is the stated exception to the unattended start. |
| Restoring a backup into the live store | Copy the backup to a private file, check it, attach the copy read-only and replace every table's rows by named columns in one `BEGIN IMMEDIATE` transaction | SQLite's online backup API (`backup()` of `node:sqlite`) with the live file as destination; attaching the owner's file directly | The online backup into a file another connection holds open in WAL mode failed under `node:sqlite` on Node 26.13.1; one transaction on the live connection is atomic, keeps the WAL protocol, and every open reader sees the new revision. The private copy means the pre-restore backup's pruning or another program cannot change the file between the checks and the copy, and the read-only attach, named columns, `trusted_schema` off and defensive mode keep a crafted file from acting through the live connection. Backups themselves still use the online backup API, whose destination is a new file. |
| Key file creation | A temporary file then `link()`; on `EEXIST` read the winner's file, retrying until it parses | `O_CREAT \| O_EXCL` then write | An exclusive create exposes an empty or partial file to a concurrent reader for a moment; `link()` makes the whole file appear at once. |
| Recovery key without a terminal | Print only that one was created and set a flag; the dashboard shows a banner until the owner confirms it is saved | Print it into whatever standard output is (a service manager's journal, a redirected log file) | A redirected standard output is a file on disk, which the at-rest rule forbids for the key. |
| Runtime credentials a service persists | Encrypted with a per-unit state key delivered in memory | Plaintext files (chat's token file, avatar's `.vts-token`); let services write the store | Keeps the at-rest rule for tokens the platforms issue at run time, without giving services the store. |
| Reflection's personality write | An outbox file the unit runner (or the next dashboard start) applies | A gated dashboard route (`reflect` has no token); a bus event the dashboard applies (the dashboard may be off when `reflect` runs) | The runner is already the store-opening parent of `reflect`, and the outbox survives the runner dying. |
| TPM sealing of the master key | Not built; recorded as an optional future step | Seal the key with the TPM: on Windows through PowerShell over WSL interop using the Microsoft Platform Crypto Provider (a non-exportable key that wraps the master key), on native Linux with `systemd-creds` and TPM2; fall back to the key file without a TPM | It would protect a copied disk or VM image, and the key could not leave the machine. It also adds a Windows-side dependency and interop calls at every start, makes a TPM reset or a motherboard swap lose the key without the recovery key, and still lets any process running as the owner unseal the key unless a PIN or Windows Hello prompt is required, which the owner ruled out. Tenet 14 would need an exception for the TPM tooling. Owner: "the key was just a thought"; the key-file baseline must not depend on it. |
| System dependencies | None added: `node:sqlite` and `node:crypto` are part of the pinned Node; `docker exec` uses the Docker CLI already required | A system SQLite library; TPM tooling | Tenet 14 holds without a new exception. |

## Open Questions & Future Decisions

- **Dashboard autostart.** After a reboot, units wait for credentials until the dashboard starts or `mise run deliver` runs. A user-level autostart of the dashboard (a systemd user unit on Linux, a logon task on Windows that starts it in WSL) would make the stack fully unattended; recommended as a follow-up, not specified here.
- **Settings history.** The store could keep earlier section documents for undo; the backups are the only history.

## References

**Files in this segment**: built: `packages/store/src/` (`db.ts`, `store.ts`, `keys.ts`, `token.ts`, `paths.ts`, `errors.ts`, `codec.ts` for export and import, `cli/` for the tasks), `packages/store/test/*.test.ts`, the `config:*` tasks in `mise.toml`; to be created: `packages/store/src/project.ts`, `deliver.ts`, `packages/control/src/run-unit.ts`, the `config:project` and `deliver` tasks.

**Other segments**: [config](../config/config-design.md) (schema, presentation, the projection loader, `SECRET_PATHS`); [control-plane](../control-plane/control-plane-design.md) (projection and delivery around every start, the listener key label, CTRL-RUNTIME-017); [dashboard](../dashboard/dashboard-design.md) (Settings, the secret write, the token check, the session key, recovery); [module-contract](../module-contract/module-contract-design.md) (the manifest's `config`, `secrets`, `documents` and `stateKey`); [deployment](../deployment/deployment-design.md) (mounts, `tmpfs`, the installer, `dev:<service>` tasks); [shared-runtime](../shared-runtime/shared-runtime-design.md) (waiting for and receiving the message); [memory](../memory/memory-design.md) (the reflection outbox); [chat](../chat/chat-design.md) and [avatar](../avatar/avatar-design.md) (state files).

**Decision**: [config in one place](../../decisions/config-in-one-place.md).

**External**: Node.js `node:sqlite` (Stability 1.2, release candidate since v25.7.0), `node:crypto` (AES-256-GCM, scrypt, HMAC).
