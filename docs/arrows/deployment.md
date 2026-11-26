# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the project's toolchains and command surface (`mise.toml`), the Linux installer, CI workflows (including the docs site's build and Pages deploy; the site itself is [docs-site](docs-site.md)), workspace/TypeScript build setup, and the licensing and contribution rules (AGPL-3.0-only plus an owner-reserved commercial licence, an individual CLA).

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): the `models` puller reads `config.yaml` (DEPLOY-COMPOSE-008, -011), Compose carries no operator credential and mounts `./config` (DEPLOY-COMPOSE-023 to -025), `secrets.yaml` is seeded and ignored (DEPLOY-INST-005, DEPLOY-REPO-003, DEPLOY-IMG-005), the dashboard ports are `config.yaml` keys (DEPLOY-INST-008, DEPLOY-HOST-002, -003), the dashboard UI build and its place in `build`, `typecheck`, `test` and `dashboard` (DEPLOY-REPO-002, DEPLOY-HOST-001) and the operator documentation, README quick start and Bedrock guidance follow (DEPLOY-README-002, -005, -007).

**Toolchains and commands (built, #344).** `mise.toml` pins Node, Zig, Python and watchexec, reads pnpm from `packageManager` and Rust from `rust-toolchain.toml`, and its `[tasks]` are the one command surface: no `package.json` has a `scripts` block. `mise.lock` holds the locked tool versions, and native code compiles and links through Zig by the wrappers `scripts/zig-cc`, `scripts/zig-cxx` and `scripts/zig-ar`. `scripts/fetch-mise.sh` downloads mise at a pinned version and verifies it against `scripts/mise-release-key.asc` before unpacking it; `scripts/doctor.sh` (`mise run doctor`) checks the system prerequisites of HLD Tenet 14 and installs nothing. `scripts/install.sh` bootstraps mise per user, installs system-wide only those prerequisites and runs the same tasks the `Dockerfile` stages and every workflow step run. `packages/config/test/toolchain.test.ts` holds the pins, the task graph, the `Dockerfile` and the workflows to the specs. Specs: DEPLOY-TOOL-001 to -021, DEPLOY-INST-015, -016, DEPLOY-CI-012 and the toolchain clauses of DEPLOY-IMG-001, -006, DEPLOY-INST-004, -007, -008, -009, -011, -012, -014, DEPLOY-CI-001 to -004, -006, -007, DEPLOY-SECRET-006, DEPLOY-REPO-002, -006, DEPLOY-HOST-001, -003 to -006 and DEPLOY-README-006. No workflow installs a system package: the desktop audio helper's Linux back end speaks the PulseAudio protocol through the pure-Rust `pulseaudio` client (ears EARS-SRC-023), so every workflow step is an action or one `mise run` (DEPLOY-CI-001, DEPLOY-CI-012). The `Dockerfile`'s `native` stage copies `mise.toml` and `mise.lock` with `rust-toolchain.toml` before `mise install --locked rust zig`, since Zig's version and the locked downloads live in them (DEPLOY-IMG-001). The design cascades to the HLD (Tenet 14, Key Design Decisions), event-bus (BUS-NAT-BLD-001, -002, -005, -009, BUS-NAT-ERR-011, BUS-NAT-GATE-001, -007), docs-site (DOCS-BUILD-001, -002, -006, DOCS-README-003, DOCS-FACT-001, DOCS-GUIDE-005, -026, and the example in DOCS-FACT-002), dashboard (DASH-DOCS-009, -014, DASH-BUILD-001, -005, DASH-AVP-001), memory (MEM-REEMBED-001, MEM-CONSOL-012), region-hooks (HOOK-SCHEMA-003, HOOK-EX-013), control-plane (CTRL-LAT-030, -031), ears (EARS-SRC-023) and the config, control-plane, module-contract, avatar and voice design prose; those segments' specs are implemented.

**MAPPED** — 152 specs: 143 implemented, 0 deferred, 9 gaps (DEPLOY-ENG-018 and -020 and DEPLOY-NET-006, manual checks on a Docker host; DEPLOY-COMPOSE-002, -020, -022, -028, -029 and -030, the `./data/logs` mount of the logging design, #349; the tools network of #319, DEPLOY-NET-001 to -004 and the network clause of DEPLOY-COMPOSE-026, is built); the last audit covered 79 specs and ran before DEPLOY-INST-007, -011, -014, DEPLOY-HOST-003, -004, -005, -006, DEPLOY-README-002, -003, -005, -006 and the UI-build wording of DEPLOY-REPO-002, DEPLOY-REPO-003 and DEPLOY-HOST-001 closed; those are not covered by that audit. DEPLOY-HOST-001 and 006 are tested in `services/dashboard/test/docs-script.test.ts` and DEPLOY-REPO-002 and 003 in `services/dashboard/test/root-scripts.test.ts`; the real `dashboard` script was run on 2026-11-15 (Verification log). DEPLOY-HOST-005 is docs-page content verified by reading. DEPLOY-INST-007 and DEPLOY-INST-014 are checked by source-order tests of `scripts/install.sh`; no run of the installer on a clean machine has exercised them. An audit pass is the next step: the specs are written and implemented, not yet audited against the code; the status moves to AUDITED when it has run.

**Secret scoping (built, #318) and the tools network (built, #319; DEPLOY-NET-006 is a manual check).** The operator's credentials file is `secrets/secrets.yaml`, which no container mounts; the control plane projects it per unit into `secrets/units/<composeName>/` from each unit's manifest `secrets` list, mounted read-only at `/app/secrets` (DEPLOY-SECRET-001 to -011; amended DEPLOY-COMPOSE-003, -023, -025, -026, DEPLOY-IMG-005, DEPLOY-INST-005, -008, DEPLOY-REPO-003). `tools` joins only a `tools-redis` network holding `redis` (DEPLOY-NET-001 to -006). Cascaded to the HLD (Trust boundary, Configuration split), config (CFG-SEC-001, CFG-SEC-019, CFG-ENV-012), module-contract (MOD-MAN-002, MOD-MAN-015 and the initial `secrets` declarations), control-plane (CTRL-RUNTIME-014 and -015: the projection before compose actions, citing DEPLOY-SECRET-004, and its command-line entry, citing DEPLOY-SECRET-006), dashboard (DASH-SECRET-001, -002, -008, -009, -012, -013) and the docs-site pages; DEPLOY-NET-005 is met by `docs/guide/connect/mcp.md`.

**Speech engine servers (design 2026-11-16; built in #190, readiness checks manual).** Three opt-in Compose profiles (`pocket`, `nemotron`, `kyutai`) build and run Pocket TTS, NeMo-Speech.cpp and `moshi-server`: image names `cohost-<service>:<version>`, sources pinned by full commit SHA or exact crate version, loopback ports, weight-cache volumes, GPU overlay entries, healthchecks and the Pocket token path are DEPLOY-ENG-001 to -018; the pin checks added to `scripts/lid-check.mjs` are DEPLOY-CI-010 and -011. Unverified: the servers' cache paths, VRAM, the Pocket and NeMo-Speech.cpp build times and whether the Pocket download needs the token.

## Orientation

- Design: LLD § Compose topology (services, profiles, isolation pass-through, healthcheck, `models`, `consolidate`, `reembed`), § Host-run dashboard, § Toolchains and commands, § Image build, § Installer, § Build, test and CI, § Docs site (the CI side only), § Licensing and contribution.
- The docs site's pages, checks and README shape are [docs-site](docs-site.md) (`DOCS-*`). The deployment specs that name a site page (DEPLOY-HOST-003, -004, DEPLOY-README-002, -003, -005, -006, DEPLOY-INST-011) carry what the page must say about this segment's files.
- The dashboard is not a Compose service; its start script and `.env` needs are DEPLOY-HOST-001 to -006. The `dashboard` task rebuilds the docs site first when it changed, because the dashboard serves the build at `/cohost/` (dashboard DASH-DOCS-*). Dashboard owner decisions: dashboard LLD § Host process and stack control and its [decision doc](../intent/dashboard/decisions/standalone-dashboard.md).
- The listening/speaking split (`ears`, `mouth`, `connector-discord`) is in [mouth.md](mouth.md) and [connections.md](connections.md): DEPLOY-COMPOSE-001, -004, -017, -020, -023, DEPLOY-REPO-001 and DEPLOY-README-004, -005 carry it into this segment. The Compose Discord connector service is `connector-discord`.
- The control plane's stack controller runs `docker compose up -d --build --remove-orphans` and `docker compose stop` against this Compose file, and the container healthcheck binary is `packages/control/dist/healthcheck.js` (see [control-plane.md](control-plane.md)).
- `.github/cla/signatures.json` (DEPLOY-CI-005, DEPLOY-LIC-003) is not in the `main` tree: the `cla` workflow writes it on the `cla-signatures` branch.

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (152 specs, prefix `DEPLOY`: 143 `[x]`, 9 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/compose-standalone.test.ts
- packages/config/test/compose-consolidate.test.ts
- packages/config/test/compose-models.test.ts
- packages/config/test/compose-chat-data.test.ts
- packages/config/test/compose-avatar.test.ts (DEPLOY-COMPOSE-028: the avatar service publishes no port and mounts only `./config`)
- packages/config/test/compose-engines.test.ts (the engine servers' Compose, Dockerfile and script checks)
- packages/config/test/installer.test.ts
- packages/config/test/lid-check.test.ts
- packages/config/test/toolchain.test.ts (the `mise.toml` pins and tasks, `mise.lock`, the Zig wrappers, the `Dockerfile` stages and the workflows' `mise run` steps)
- packages/control/test/compose.test.ts
- packages/control/test/healthcheck.test.ts (control-plane's file, cited from DEPLOY-HC-002 by a `<!-- test: -->` pointer, not annotated here)
- scripts/compose-smoke.sh (run by `.github/workflows/compose-smoke.yml`; guards DEPLOY-IMG-002 and DEPLOY-IMG-003)
- `.github/workflows/cla.yml` has no test: it runs only on `pull_request_target` from the base branch, and the test globs cover only `packages/*/test` and `services/*/test`.

### Code
Files carrying `@spec DEPLOY-` annotations (trailing comments on mapping keys in the Compose files, appended to existing comment lines in `Dockerfile` and `scripts/install.sh`, full comment lines elsewhere):
- docker-compose.yml, docker-compose.gpu.yml, Dockerfile, .dockerignore
- docker/tts-pocket/entrypoint.sh, docker/stt-nemotron/Dockerfile, docker/stt-kyutai/Dockerfile (the engine servers, DEPLOY-ENG-*)
- mise.toml, scripts/zig-cc, scripts/zig-cxx, scripts/zig-ar, scripts/fetch-mise.sh, scripts/doctor.sh
- scripts/install.sh, scripts/compose-smoke.sh, scripts/lid-check.mjs, scripts/dev/bus-pub.ts, scripts/dev/bus-tail.ts, scripts/dev/stub-llm.ts, scripts/dev/stub-tts.ts
- .github/workflows/test.yml, .github/workflows/compose-smoke.yml, .github/workflows/lid-check.yml, .github/workflows/pages.yml, .github/workflows/cla.yml, .github/workflows/docs-build.yml

Cited from the specs with `<!-- impl: -->` (files owned elsewhere or plain data): package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, services/dashboard/tsconfig.json, .gitignore, LICENSE, CONTRIBUTING.md, CLA.md, COMMERCIAL.md, README.md, .github/workflows/cla.yml, docs/.vitepress/config.ts (DEPLOY-LIC-004's footer), packages/control/src/healthcheck.ts

Cited from the specs, not annotated: .env.example (DEPLOY-README-001, -002), docs/guide/tune/model.md (DEPLOY-README-002, a docs-site page). The test of DEPLOY-README-005 in `packages/config/test/compose-chat-data.test.ts` reads `docs/guide/connect/discord.md`.

## Architecture

**Purpose:** Turn the repository into a running stack (Compose), a verified build (CI), a published site (Pages) and a licensed, contributable project (AGPL-3.0-only plus a commercial licence; CLA). Owns no cohost runtime logic.

**Key Components:**
1. `docker-compose.yml` — 5 infra services (redis, postgres, ollama, tts, stt), the one-shot `models`, the `maintenance`-profile one-shots `consolidate` and `reembed` (memory image), and 12 application services: eleven from the `x-ts-service` anchor (which passes the isolation env through) and `tools`, which takes the base anchor, a least-privilege environment of its own and a read-only `./config` mount (DEPLOY-COMPOSE-026); `eyes` / `ears` / `mouth` / `connector-discord` behind profiles (`eyes`, `ears`, `mouth`, `discord`).
2. `Dockerfile` — a `toolchain` stage (Debian 13 with a verified mise), `native` (Rust and Zig through mise, `mise run build:native`), `build` (`mise run build:ts`) and `runtime` on `node:<x.y.z>-trixie-slim`; whole workspace compiled once per image; `SERVICE` selects the entrypoint; no prune.
3. Container healthcheck — `node packages/control/dist/healthcheck.js $SERVICE` from `@cohost/control`.
4. `docker-compose.gpu.yml` — NVIDIA overlay for ollama, tts, stt, selected via `COMPOSE_FILE`.
5. `scripts/install.sh` — Ubuntu/Debian/WSL2 bootstrap: Docker and the NVIDIA toolkit (system prerequisites), a verified per-user mise and `mise install --locked` (Node, pnpm, Rust, Zig, Python), shell activation, `.env` and config seeding, `mise run build`, the secrets projection, the docs build, pulls, smoke.
5a. `mise.toml` — the toolchain pins and the task graph, the one command surface (`mise run <task>`), with `mise.lock`, mise's release key `scripts/mise-release-key.asc` and the Zig wrappers `scripts/zig-cc`, `scripts/zig-cxx`, `scripts/zig-ar`.
6. CI — every step an action or one `mise run <task>`: `test.yml` (`mise run lint`, `mise run test` with Redis and Postgres), `compose-smoke.yml` (build and `healthy`-with-no-restarts check of the smoke services, plus the launch end-to-end test), `lid-check.yml`, `cla.yml` (CLA Assistant Lite), `docs-build.yml` (build-only docs check on PRs), `pages.yml` (VitePress to GitHub Pages).
7. Docs site build — `docs-build.yml` and `pages.yml` run `mise run docs:build`; the site is [docs-site](docs-site.md).
8. Governance — AGPL-3.0-only (`LICENSE`, every `package.json`), commercial licence (`COMMERCIAL.md`), individual CLA (`CLA.md`, required by `CONTRIBUTING.md`, signatures in `.github/cla/signatures.json` on the `cla-signatures` branch).

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Compose topology | DEPLOY-COMPOSE-001 to DEPLOY-COMPOSE-030 (no 016) | 29 | 23 | 0 | 6 |
| Secret scoping | DEPLOY-SECRET-001 to DEPLOY-SECRET-011 | 11 | 11 | 0 | 0 |
| The tools network | DEPLOY-NET-001 to DEPLOY-NET-006 | 6 | 5 | 0 | 1 |
| Speech engine servers | DEPLOY-ENG-001 to DEPLOY-ENG-020 | 20 | 18 | 0 | 2 |
| Container health | DEPLOY-HC-001 to DEPLOY-HC-002 | 2 | 2 | 0 | 0 |
| Toolchains and commands | DEPLOY-TOOL-001 to DEPLOY-TOOL-021 | 21 | 21 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to DEPLOY-IMG-006 | 6 | 6 | 0 | 0 |
| Installer | DEPLOY-INST-001 to DEPLOY-INST-016 | 16 | 16 | 0 | 0 |
| Continuous integration | DEPLOY-CI-001 to DEPLOY-CI-012 | 12 | 12 | 0 | 0 |
| Licensing and contribution | DEPLOY-LIC-001 to DEPLOY-LIC-007 | 7 | 7 | 0 | 0 |
| Workspace and repository hygiene | DEPLOY-REPO-001 to DEPLOY-REPO-006 | 6 | 6 | 0 | 0 |
| Host-run dashboard | DEPLOY-HOST-001 to DEPLOY-HOST-006 | 6 | 6 | 0 | 0 |
| Documentation consistency | DEPLOY-README-001 to DEPLOY-README-007 | 7 | 7 | 0 | 0 |
| Dev helpers | DEPLOY-DEV-001 to DEPLOY-DEV-003 | 3 | 3 | 0 | 0 |

**Summary:** 143 of 152 specs implemented; 0 deferred; 9 open: DEPLOY-ENG-018, -020 and DEPLOY-NET-006 (manual checks, `[ ]` by design until a Docker host run) and DEPLOY-COMPOSE-002, -020, -022, -028, -029 and -030 (the `./data/logs` mount for the per-program log files, #349). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work Required

### Must Fix
None.

### Should Fix
- Run `scripts/install.sh` once on a clean machine to observe DEPLOY-INST-007 and DEPLOY-INST-014 end to end (their tests check the script's source, not a run).

### Nice to Have
1. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
