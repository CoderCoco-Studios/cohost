# Arrow: settings-store

`@cohost/store`: the SQLite settings store on the host (settings, personality and expressions documents, AES-256-GCM-encrypted credentials, generated keys, the control token's verifier), the master key file, per-unit projections, in-memory credential delivery to containers and host-run services, unit state keys, the reflection outbox, backups, YAML export and import, and the `mise run config:*` tasks.

## Status

**MAPPED, partly cut over.** 68 specs: 52 `[x]`, 16 `[ ]`, 0 `[D]`. Steps 1, 2 and 3a are built: the package and its tasks (`config:project`, `deliver` included), the library side of the consumers, and the cut-over of the control plane, the shared runtime, the services and the deployment (projections and delivery around every start, the unit runner, the boot order, the state files, the reflection outbox, the Compose mounts and tmpfs). Open: the dashboard's cut-over (step 3b: STORE-PKG-003, STORE-DB-003, -005, -008, -010, STORE-KEY-010, STORE-TOK-003 to -005, STORE-SET-001, -004, STORE-PROJ-006, STORE-DLV-005, STORE-OUT-002, STORE-TASK-006); STORE-DB-007 has its mechanism but no migration until schema version 2.

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
