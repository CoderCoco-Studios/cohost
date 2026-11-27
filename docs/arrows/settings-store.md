# Arrow: settings-store

`@cohost/store`: the SQLite settings store on the host (settings, personality and expressions documents, AES-256-GCM-encrypted credentials, generated keys, the control token's verifier), the master key file, per-unit projections, in-memory credential delivery to containers and host-run services, unit state keys, the reflection outbox, backups, YAML export and import, and the `mise run config:*` tasks.

## Status

**MAPPED, partly built.** 68 specs: 36 `[x]`, 32 `[ ]`, 0 `[D]`. Designed under #372; the implementation follows the PR order in the design PR. Steps 1 and 2 are built and inert: nothing in a running service, the dashboard or the control plane uses them yet. Step 1: the package `@cohost/store` (the `node:sqlite` wrapper, schema, integrity check, keys and encryption, the token verifier with the session and listener keys, the write operation, backups and restore, the export and import codec, `checkStore`) and the `config:*` tasks except `config:project` and `deliver`. Step 2: the library side of the consumers. Each unit's settings declarations (`config`, `secrets`, `documents`, `stateKey`, the Compose name) live in `UNIT_SETTINGS` in `@cohost/config`, a leaf both `@cohost/control` and the store read, so `config:set` names the units a change reaches (STORE-TASK-002). `@cohost/config` has the projection loader `loadProjection` (with `loadProjectionPersonality` and `loadProjectionExpressions`) beside the YAML `loadConfig`, and the outbox writer `writePersonalityOutbox` (STORE-OUT-001); `@cohost/shared` has `receiveCredentials` (STORE-DLV-004's receiver, shared-runtime SHARED-BOOT-010) and the state-file helpers (STORE-STATE-002); the store has `applyPersonalityOutbox` (STORE-OUT-002). Open: STORE-PKG-003; STORE-DB-003, -005, -008, -010; STORE-KEY-010; STORE-TOK-003 to -005; STORE-SET-001, -004; STORE-PROJ-*; STORE-DLV-*; STORE-STATE-*; STORE-OUT-*; STORE-TASK-001, -006: each has a clause in a consumer (the dashboard, the control plane, a service) that the step 3 cut-over wires: the projection writer and delivery around every start, the boot order, `reflect` writing the outbox and the runner applying it, chat and avatar writing their state files. STORE-DB-007 (migrations) has its mechanism but no migration until schema version 2. Every segment that reads settings or credentials changes with it: config (the projection loader), control-plane (projection and delivery around every start), dashboard (Settings, the secret write, the token check, recovery), module-contract (the settings routes), deployment (mounts, `tmpfs`, installer, dev tasks), shared-runtime (waiting for the credentials message), memory, chat and avatar.

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
- docs/intent/settings-store/settings-store-specs.md (68 specs, prefix `STORE`: 35 `[x]`, 33 `[ ]`, 0 `[D]`)

### Tests
- packages/store/test/store-db.test.ts, store-keys.test.ts, store-token.test.ts, store-write.test.ts, store-io.test.ts, store-cli.test.ts, store-boundary.test.ts, store-outbox.test.ts
- packages/config/test/projection.test.ts; packages/shared/test/credentials.test.ts, state.test.ts; packages/control/test/manifest-contract.test.ts

### Code
- packages/store/src/ (`db.ts`, `store.ts`, `keys.ts`, `token.ts`, `paths.ts`, `errors.ts`, `codec.ts`, `outbox.ts`, `cli/`); the `config:*` tasks of `mise.toml`
- packages/config/src/units.ts, projection.ts, outbox.ts; packages/shared/src/credentials.ts, state.ts
- Planned: `packages/store/src/project.ts`, `deliver.ts`, `packages/control/src/run-unit.ts`

## Architecture

**Purpose:** one place for every setting and credential, with no credential on disk in plaintext and no service touching the store.

**Key Components:**
1. `db.ts`: the one wrapper of `node:sqlite`.
2. `keys.ts`, `token.ts`: the master key file, AES-256-GCM values, the scrypt verifier, the session and listener keys.
3. `project.ts`, `deliver.ts`: projections and the credentials message (`docker exec` into `/run/cohost`, or a pipe from the unit runner).
4. `codec.ts`, `cli/*.ts`: export, import and the `config:*` tasks.
