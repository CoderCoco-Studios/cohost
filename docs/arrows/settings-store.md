# Arrow: settings-store

`@cohost/store`: the SQLite settings store on the host (settings, personality and expressions documents, AES-256-GCM-encrypted credentials, generated keys, the control token's verifier), the master key file, per-unit projections, in-memory credential delivery to containers and host-run services, unit state keys, the reflection outbox, backups, YAML export and import, and the `mise run config:*` tasks.

## Status

**MAPPED, cut over.** 68 specs: 67 `[x]`, 1 `[ ]`, 0 `[D]`. Built: the package and its tasks (`config:project` and `deliver` included); the projections and the delivery around every start (`packages/control/src/provision.ts`), the unit runner, the boot order, the state files and the reflection outbox; and the dashboard's use of the store: its settings, personality and secret routes, the bearer check against the verifier with its bounded queue and cache, the session key, the refusal of `CONTROL_TOKEN` in `.env` or the environment, recovery mode for the four causes with the recovery-key banner, the outbox and the day's backup at its start, and re-delivery to waiting units (STORE-DLV-005). The store-opening `mise` tasks are raw, so the recovery key and the hidden prompts reach the terminal (STORE-KEY-002, deployment DEPLOY-TOOL-024), and under the test environment (`COHOST_TEST_ENV`) the key file has no default path (STORE-KEY-001). The docs site describes the store, with the Settings, backups and recovery page (step 4). Open: STORE-DB-007 has its mechanism but no migration until schema version 2.

## Orientation

- Design: LLD § The database (library, tables, transactions, backups), Keys (master key, encryption, the control token), Projections, Credential delivery (the carrier comparison), Unit state keys, The reflection pass's write, Seeding, export and import, The `config:*` tasks, Recovery, Decisions & Alternatives (TPM sealing recorded, not built).
- Only the dashboard, `@cohost/control` and the task entry points import the package (STORE-PKG-001); services read `settings.json` through `@cohost/config` (CFG-LOAD-001).
- The ears listener key's label stays in control-plane CTRL-RUNTIME-017; the store derives and keeps the key (STORE-TOK-002).

## References

### HLD
- docs/high-level-design.md (Tenet 7, Segments table, Key Design Decisions: Configuration split, Trust boundary)

### LLD
- docs/intent/settings-store/settings-store-design.md

### EARS
- docs/intent/settings-store/settings-store-specs.md (68 specs, prefix `STORE`: 67 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests
- packages/store/test/store-db.test.ts, store-keys.test.ts, store-token.test.ts, store-write.test.ts, store-io.test.ts, store-cli.test.ts, store-boundary.test.ts, store-outbox.test.ts
- packages/store/test/store-project.test.ts, store-peek.test.ts
- packages/config/test/projection.test.ts; packages/shared/test/credentials.test.ts, state.test.ts; packages/control/test/manifest-contract.test.ts, provision.test.ts, run-unit.test.ts, cli-deliver.test.ts, healthcheck.test.ts
- services/dashboard/test/recovery.test.ts, recovery-start.test.ts, settings.test.ts, secrets.test.ts, routes.test.ts, service.test.ts, deliver.test.ts, unlock.test.ts

### Code
- packages/store/src/ (`db.ts`, `store.ts`, `keys.ts`, `token.ts`, `paths.ts`, `errors.ts`, `codec.ts`, `outbox.ts`, `project.ts`, `deliver.ts`, `cli/`); the `config:*` tasks of `mise.toml`
- packages/config/src/units.ts, projection.ts, outbox.ts; packages/shared/src/credentials.ts, state.ts
- packages/control/src/provision.ts, run-unit.ts; services/dashboard/src/recovery.ts, settings.ts, secrets.ts, access.ts, deliver.ts

## Architecture

**Purpose:** one place for every setting and credential, with no credential on disk in plaintext and no service touching the store.

**Key Components:**
1. `db.ts`: the one wrapper of `node:sqlite`.
2. `keys.ts`, `token.ts`: the master key file, AES-256-GCM values, the scrypt verifier, the session and listener keys.
3. `project.ts`, `deliver.ts`: projections and the credentials message (`docker exec` into `/run/cohost`, or a pipe from the unit runner).
4. `codec.ts`, `cli/*.ts`: export, import and the `config:*` tasks.
