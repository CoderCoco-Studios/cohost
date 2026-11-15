# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the Linux installer, CI workflows, the VitePress docs site, workspace/TypeScript build setup, and the licensing and contribution rules (AGPL-3.0-only plus an owner-reserved commercial licence, an individual CLA).

## Status

**AUDITED** — 81 specs: 79 implemented, 0 deferred, 2 gaps (DEPLOY-INST-007 and DEPLOY-INST-014: the installer's host Rust build and toolchain steps match `scripts/install.sh`, but no run of the installer has exercised them).

## Orientation

- Design: LLD § Compose topology (services, profiles, isolation pass-through, healthcheck, `models`, `consolidate`, `reembed`), § Host-run dashboard, § Image build, § Installer, § Build, test and CI, § Docs site, § Licensing and contribution.
- The dashboard is not a Compose service; its start script and `.env` needs are DEPLOY-HOST-001 to -004. Dashboard owner decisions: dashboard LLD § Host process and stack control and its [decision doc](../intent/dashboard/decisions/standalone-dashboard.md).
- The listening/speaking split (`ears`, `mouth`, `connector-discord`) is in [mouth.md](mouth.md) and [connections.md](connections.md): DEPLOY-COMPOSE-001, -004, -017, -020, -023, DEPLOY-REPO-001 and DEPLOY-README-004, -005 carry it into this segment. The Compose Discord connector service is `connector-discord`.
- The control plane's stack controller runs `docker compose up -d --build --remove-orphans` and `docker compose stop` against this Compose file, and the container healthcheck binary is `packages/control/dist/healthcheck.js` (see [control-plane.md](control-plane.md)).
- `.github/cla/signatures.json` (DEPLOY-CI-005, DEPLOY-LIC-003) is not in the `main` tree: the `cla` workflow writes it on the `cla-signatures` branch.

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (81 specs, prefix `DEPLOY`: 79 `[x]`, 2 `[ ]`, 0 `[D]`)

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
- scripts/install.sh, scripts/compose-smoke.sh, scripts/docs-prepare.mjs, scripts/lid-check.mjs, scripts/dev/bus-pub.ts, scripts/dev/bus-tail.ts, scripts/dev/stub-llm.ts, scripts/dev/stub-tts.ts
- .github/workflows/test.yml, .github/workflows/compose-smoke.yml, .github/workflows/lid-check.yml, .github/workflows/pages.yml, .github/workflows/cla.yml, .github/workflows/docs-build.yml

Cited from the specs with `<!-- impl: -->` (files owned elsewhere or plain data): package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, services/dashboard/tsconfig.json, .gitignore, LICENSE, CONTRIBUTING.md, CLA.md, COMMERCIAL.md, README.md, .github/workflows/cla.yml, docs/.vitepress/config.ts, packages/control/src/healthcheck.ts

Cited from the specs, not annotated: .env.example (DEPLOY-README-001, -002), examples/providers/README.md (DEPLOY-README-002), docs/TESTING.md (DEPLOY-README-003).

## Architecture

**Purpose:** Turn the repository into a running stack (Compose), a verified build (CI), a published site (Pages) and a licensed, contributable project (AGPL-3.0-only plus a commercial licence; CLA). Owns no cohost runtime logic.

**Key Components:**
1. `docker-compose.yml` — 5 infra services (redis, postgres, ollama, tts, stt), the one-shot `models`, the `tools`-profile one-shots `consolidate` and `reembed` (memory image), and 11 application services from one `x-ts-service` anchor (which passes the isolation env through); `eyes` / `ears` / `mouth` / `connector-discord` behind profiles (`eyes`, `ears`, `mouth`, `discord`).
2. `Dockerfile` — a Rust `native` stage plus `base` / `build` / `runtime` on node:22-slim; whole workspace compiled once per image; `SERVICE` selects the entrypoint; no prune.
3. Container healthcheck — `node packages/control/dist/healthcheck.js $SERVICE` from `@cohost/control`.
4. `docker-compose.gpu.yml` — NVIDIA overlay for ollama, tts, stt, selected via `COMPOSE_FILE`.
5. `scripts/install.sh` — Ubuntu/Debian/WSL2 bootstrap (docker, nvidia toolkit, node, pnpm, .env, config seeding, Rust toolchain, host build, pulls, smoke).
6. CI — `test.yml` (Rust and pnpm tests with Redis and Postgres), `compose-smoke.yml` (build and `healthy`-with-no-restarts check of the smoke services, plus the launch end-to-end test), `lid-check.yml`, `cla.yml` (CLA Assistant Lite), `docs-build.yml` (build-only docs check on PRs), `pages.yml` (VitePress to GitHub Pages).
7. Docs site — VitePress fed by `scripts/docs-prepare.mjs` (README and examples copied and link-rewritten).
8. Governance — AGPL-3.0-only (`LICENSE`, every `package.json`), commercial licence (`COMMERCIAL.md`), individual CLA (`CLA.md`, required by `CONTRIBUTING.md`, signatures in `.github/cla/signatures.json` on the `cla-signatures` branch).

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Compose topology | DEPLOY-COMPOSE-001 to DEPLOY-COMPOSE-023 (no 016) | 22 | 22 | 0 | 0 |
| Container health | DEPLOY-HC-001 to DEPLOY-HC-002 | 2 | 2 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to DEPLOY-IMG-006 | 6 | 6 | 0 | 0 |
| Installer | DEPLOY-INST-001 to DEPLOY-INST-014 | 14 | 12 | 0 | 2 |
| Continuous integration | DEPLOY-CI-001 to DEPLOY-CI-009 | 9 | 9 | 0 | 0 |
| Docs site | DEPLOY-DOCS-001 to DEPLOY-DOCS-006 | 6 | 6 | 0 | 0 |
| Licensing and contribution | DEPLOY-LIC-001 to DEPLOY-LIC-004 | 4 | 4 | 0 | 0 |
| Workspace and repository hygiene | DEPLOY-REPO-001 to DEPLOY-REPO-006 | 6 | 6 | 0 | 0 |
| Host-run dashboard | DEPLOY-HOST-001 to DEPLOY-HOST-004 | 4 | 4 | 0 | 0 |
| Documentation consistency | DEPLOY-README-001 to DEPLOY-README-005 | 5 | 5 | 0 | 0 |
| Dev helpers | DEPLOY-DEV-001 to DEPLOY-DEV-003 | 3 | 3 | 0 | 0 |

**Summary:** 79 of 81 specs implemented; 0 deferred; 2 open (DEPLOY-INST-007, DEPLOY-INST-014). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work Required

### Must Fix
None.

### Should Fix
- Run `scripts/install.sh` once on a clean machine to close DEPLOY-INST-007 and DEPLOY-INST-014.

### Nice to Have
1. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
