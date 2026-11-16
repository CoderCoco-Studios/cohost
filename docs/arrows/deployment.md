# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the Linux installer, CI workflows (including the docs site's build and Pages deploy; the site itself is [docs-site](docs-site.md)), workspace/TypeScript build setup, and the licensing and contribution rules (AGPL-3.0-only plus an owner-reserved commercial licence, an individual CLA).

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): the `models` puller reads `config.yaml` (DEPLOY-COMPOSE-008, -011), Compose carries no operator credential and mounts `./config` (DEPLOY-COMPOSE-023 to -025), `secrets.yaml` is seeded and ignored (DEPLOY-INST-005, DEPLOY-REPO-003 is open below, DEPLOY-IMG-005), the dashboard ports are `config.yaml` keys (DEPLOY-INST-008, DEPLOY-HOST-002, -003) and the operator documentation, README quick start and Bedrock guidance follow (DEPLOY-README-002, -005, -007). Open: the dashboard UI build and Node floor (DEPLOY-HOST-001, -006, DEPLOY-REPO-002, DEPLOY-REPO-003), which belong to the new dashboard. Total 81 specs: 77 `[x]`, 4 `[ ]`, 0 `[D]`.

**PARTIAL** — 81 specs: 77 implemented, 0 deferred, 4 gaps (the dashboard UI build: DEPLOY-HOST-001, -006, DEPLOY-REPO-002, -003); the last audit covered 79 specs and ran before DEPLOY-INST-007, -011, -014, DEPLOY-HOST-003, -004 and DEPLOY-README-002, -003, -005, -006 closed; those nine are not covered by that audit). DEPLOY-HOST-001 (the script builds the docs first), DEPLOY-HOST-005 (the Commands page says so) and DEPLOY-HOST-006 (a failed docs build does not stop the start) were added after the audit; they are implemented, DEPLOY-HOST-001 and 006 are tested in `services/dashboard/test/docs-script.test.ts`, and the real script was run on 2026-11-15 (Verification log). DEPLOY-HOST-005 is docs-page content verified by reading. DEPLOY-INST-007 and DEPLOY-INST-014 are checked by source-order tests of `scripts/install.sh`; no run of the installer on a clean machine has exercised them.

## Orientation

- Design: LLD § Compose topology (services, profiles, isolation pass-through, healthcheck, `models`, `consolidate`, `reembed`), § Host-run dashboard, § Image build, § Installer, § Build, test and CI, § Docs site (the CI side only), § Licensing and contribution.
- The docs site's pages, checks and README shape are [docs-site](docs-site.md) (`DOCS-*`). The deployment specs that name a site page (DEPLOY-HOST-003, -004, DEPLOY-README-002, -003, -005, -006, DEPLOY-INST-011) carry what the page must say about this segment's files.
- The dashboard is not a Compose service; its start script and `.env` needs are DEPLOY-HOST-001 to -006. The start script builds the docs site first, because the dashboard serves the build at `/cohost/` (dashboard DASH-DOCS-*). Dashboard owner decisions: dashboard LLD § Host process and stack control and its [decision doc](../intent/dashboard/decisions/standalone-dashboard.md).
- The listening/speaking split (`ears`, `mouth`, `connector-discord`) is in [mouth.md](mouth.md) and [connections.md](connections.md): DEPLOY-COMPOSE-001, -004, -017, -020, -023, DEPLOY-REPO-001 and DEPLOY-README-004, -005 carry it into this segment. The Compose Discord connector service is `connector-discord`.
- The control plane's stack controller runs `docker compose up -d --build --remove-orphans` and `docker compose stop` against this Compose file, and the container healthcheck binary is `packages/control/dist/healthcheck.js` (see [control-plane.md](control-plane.md)).
- `.github/cla/signatures.json` (DEPLOY-CI-005, DEPLOY-LIC-003) is not in the `main` tree: the `cla` workflow writes it on the `cla-signatures` branch.

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (81 specs, prefix `DEPLOY`: 77 `[x]`, 4 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/compose-standalone.test.ts
- packages/config/test/compose-consolidate.test.ts
- packages/config/test/compose-models.test.ts
- packages/config/test/compose-chat-data.test.ts
- packages/config/test/installer.test.ts
- packages/config/test/lid-check.test.ts
- packages/config/test/pnpm-version.test.ts
- packages/control/test/compose.test.ts
- packages/control/test/healthcheck.test.ts (control-plane's file, cited from DEPLOY-HC-002 by a `<!-- test: -->` pointer, not annotated here)
- scripts/compose-smoke.sh (run by `.github/workflows/compose-smoke.yml`; guards DEPLOY-IMG-002 and DEPLOY-IMG-003)
- `.github/workflows/cla.yml` has no test: it runs only on `pull_request_target` from the base branch, and the test globs cover only `packages/*/test` and `services/*/test`.

### Code
Files carrying `@spec DEPLOY-` annotations (trailing comments on mapping keys in the Compose files, appended to existing comment lines in `Dockerfile` and `scripts/install.sh`, full comment lines elsewhere):
- docker-compose.yml, docker-compose.gpu.yml, Dockerfile, .dockerignore
- scripts/install.sh, scripts/compose-smoke.sh, scripts/lid-check.mjs, scripts/dev/bus-pub.ts, scripts/dev/bus-tail.ts, scripts/dev/stub-llm.ts, scripts/dev/stub-tts.ts
- .github/workflows/test.yml, .github/workflows/compose-smoke.yml, .github/workflows/lid-check.yml, .github/workflows/pages.yml, .github/workflows/cla.yml, .github/workflows/docs-build.yml

Cited from the specs with `<!-- impl: -->` (files owned elsewhere or plain data): package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, services/dashboard/tsconfig.json, .gitignore, LICENSE, CONTRIBUTING.md, CLA.md, COMMERCIAL.md, README.md, .github/workflows/cla.yml, docs/.vitepress/config.ts (DEPLOY-LIC-004's footer), packages/control/src/healthcheck.ts

Cited from the specs, not annotated: .env.example (DEPLOY-README-001, -002), docs/guide/tune/model.md (DEPLOY-README-002, a docs-site page). The test of DEPLOY-README-005 in `packages/config/test/compose-chat-data.test.ts` reads `docs/guide/connect/discord.md`.

## Architecture

**Purpose:** Turn the repository into a running stack (Compose), a verified build (CI), a published site (Pages) and a licensed, contributable project (AGPL-3.0-only plus a commercial licence; CLA). Owns no cohost runtime logic.

**Key Components:**
1. `docker-compose.yml` — 5 infra services (redis, postgres, ollama, tts, stt), the one-shot `models`, the `tools`-profile one-shots `consolidate` and `reembed` (memory image), and 11 application services from one `x-ts-service` anchor (which passes the isolation env through); `eyes` / `ears` / `mouth` / `connector-discord` behind profiles (`eyes`, `ears`, `mouth`, `discord`).
2. `Dockerfile` — a Rust `native` stage plus `base` / `build` / `runtime` on node:26-slim; whole workspace compiled once per image; `SERVICE` selects the entrypoint; no prune.
3. Container healthcheck — `node packages/control/dist/healthcheck.js $SERVICE` from `@cohost/control`.
4. `docker-compose.gpu.yml` — NVIDIA overlay for ollama, tts, stt, selected via `COMPOSE_FILE`.
5. `scripts/install.sh` — Ubuntu/Debian/WSL2 bootstrap (docker, nvidia toolkit, node, pnpm, .env, config seeding, Rust toolchain, host build, pulls, smoke).
6. CI — `test.yml` (Rust and pnpm tests with Redis and Postgres), `compose-smoke.yml` (build and `healthy`-with-no-restarts check of the smoke services, plus the launch end-to-end test), `lid-check.yml`, `cla.yml` (CLA Assistant Lite), `docs-build.yml` (build-only docs check on PRs), `pages.yml` (VitePress to GitHub Pages).
7. Docs site build — `docs-build.yml` and `pages.yml` run `pnpm docs:build`; the site is [docs-site](docs-site.md).
8. Governance — AGPL-3.0-only (`LICENSE`, every `package.json`), commercial licence (`COMMERCIAL.md`), individual CLA (`CLA.md`, required by `CONTRIBUTING.md`, signatures in `.github/cla/signatures.json` on the `cla-signatures` branch).

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Compose topology | DEPLOY-COMPOSE-001 to DEPLOY-COMPOSE-024 (no 016) | 23 | 23 | 0 | 0 |
| Container health | DEPLOY-HC-001 to DEPLOY-HC-002 | 2 | 2 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to DEPLOY-IMG-006 | 6 | 6 | 0 | 0 |
| Installer | DEPLOY-INST-001 to DEPLOY-INST-014 | 14 | 14 | 0 | 0 |
| Continuous integration | DEPLOY-CI-001 to DEPLOY-CI-009 | 9 | 9 | 0 | 0 |
| Licensing and contribution | DEPLOY-LIC-001 to DEPLOY-LIC-004 | 4 | 4 | 0 | 0 |
| Workspace and repository hygiene | DEPLOY-REPO-001 to DEPLOY-REPO-006 | 6 | 6 | 0 | 0 |
| Host-run dashboard | DEPLOY-HOST-001 to DEPLOY-HOST-006 | 6 | 3 | 0 | 3 |
| Documentation consistency | DEPLOY-README-001 to DEPLOY-README-006 | 6 | 6 | 0 | 0 |
| Dev helpers | DEPLOY-DEV-001 to DEPLOY-DEV-003 | 3 | 3 | 0 | 0 |

**Summary:** 77 of 81 specs implemented; 0 deferred; 4 open (DEPLOY-HOST-001, DEPLOY-HOST-006, DEPLOY-REPO-002, DEPLOY-REPO-003: the dashboard UI build). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work Required

### Must Fix
None.

### Should Fix
- Close DEPLOY-HOST-001, -005 and -006: the `dashboard` script builds the docs first and starts anyway when that build fails, and the Commands page says so.
- Run `scripts/install.sh` once on a clean machine to observe DEPLOY-INST-007 and DEPLOY-INST-014 end to end (their tests check the script's source, not a run).

### Nice to Have
1. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
