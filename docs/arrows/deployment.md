# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the Linux installer, CI workflows, the VitePress docs site, workspace/TypeScript build setup, and the AGPL / DCO rules. No OpenSpec capability covers this segment.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`), not yet audited. 38 of 50 specs observed working; 12 gaps (installer defects, unenforced DCO, docs-build-on-PR, `.vts-token` ignore, `models` failure handling, stale docs).

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (50 specs, prefix `DEPLOY`)

### Tests
- No tests target this segment directly. Indirect: scripts/compose-smoke.sh (regression guard for #6), .github/workflows/test.yml (runs `pnpm test`), packages/control/test/healthcheck.test.ts (healthcheck logic).

### Code
- docker-compose.yml, docker-compose.gpu.yml, Dockerfile, .dockerignore
- scripts/install.sh, scripts/compose-smoke.sh, scripts/docs-prepare.mjs, scripts/dev/bus-pub.ts, scripts/dev/bus-tail.ts, scripts/dev/stub-llm.ts, scripts/dev/stub-tts.ts
- .github/workflows/test.yml, .github/workflows/compose-smoke.yml, .github/workflows/pages.yml
- package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, .gitignore
- LICENSE, CONTRIBUTING.md, docs/.vitepress/config.ts, docs/index.md, README.md (Quick start, Developing, Two-PC, Upgrading), docs/TESTING.md

### OpenSpec
- None (no capability for compose, Dockerfile, installer, CI, docs site or licensing).

## Architecture

**Purpose:** Turn the repository into a running stack (Compose), a verified build (CI), a published site (Pages) and a licensed, contributable project (AGPL + DCO). Owns no cohost runtime logic.

**Key Components:**
1. `docker-compose.yml` — 6 infra services (redis, postgres, ollama, tts, stt, one-shot models) and 10 TS services from one `x-ts-service` anchor; `eyes` / `ears` behind profiles; dashboard the only public port.
2. `Dockerfile` — base / build / runtime on node:22-slim; whole workspace compiled once per image; `SERVICE` selects the entrypoint; no prune.
3. Container healthcheck — `node packages/control/dist/healthcheck.js $SERVICE` from `@cohost/control`.
4. `docker-compose.gpu.yml` — NVIDIA overlay for ollama, tts, stt, selected via `COMPOSE_FILE`.
5. `scripts/install.sh` — Ubuntu/Debian/WSL2 bootstrap (docker, nvidia toolkit, node, pnpm, .env, config seeding, pulls, smoke).
6. CI — `test.yml` (pnpm test with Redis), `compose-smoke.yml` (build + restart-count check of 4 services), `pages.yml` (VitePress to GitHub Pages).
7. Docs site — VitePress 1.6.4 fed by `scripts/docs-prepare.mjs` (README and examples copied and link-rewritten).
8. Governance — AGPL-3.0-only (`LICENSE`, every `package.json`), DCO in `CONTRIBUTING.md`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Compose topology | DEPLOY-COMPOSE-001 to 011 | 10 | 0 | 1 (011) |
| Container health | DEPLOY-HC-001 to 002 | 2 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to 004 | 4 | 0 | 0 |
| Installer | DEPLOY-INST-001 to 011 | 7 | 0 | 4 (008-011) |
| Continuous integration | DEPLOY-CI-001 to 005 | 3 | 0 | 2 (004, 005) |
| Docs site | DEPLOY-DOCS-001 to 005 | 4 | 0 | 1 (005) |
| Licensing and contribution | DEPLOY-LIC-001 to 002 | 2 | 0 | 0 |
| Workspace and repo hygiene | DEPLOY-REPO-001 to 004 | 3 | 0 | 1 (004) |
| Documentation consistency | DEPLOY-README-001 to 003 | 0 | 0 | 3 |
| Dev helpers | DEPLOY-DEV-001 to 003 | 3 | 0 | 0 |

**Summary:** 38 of 50 specs implemented; 0 deferred; 12 gaps.

## Key Findings

1. **The installer's defects are all still present** — `install.sh:76` (integer test on `cut -c2-3`), `:104` (frozen-lockfile errors hidden), `:135` (`DASHBOARD_PORT` never sourced), `:139` (dev hint omits `stt`), `:95,98` (`COMPOSE_FILE` overwritten each run); plus `[inferred]` docker-group timing after a fresh install (`:52` vs `:59,111`). (DEPLOY-INST-008 to 011)
2. **`config/.vts-token` is a credential that is not git-ignored** — avatar writes `<configDir>/.vts-token` (`services/avatar/src/index.ts:30`, `drivers/vtube-studio.ts:104`), README.md:214 correctly says `config/.vts-token`, but `.gitignore` has no entry. Earlier sweeps mis-reported this as a README-vs-code location mismatch; it is not. (DEPLOY-REPO-004)
3. **Documentation drift** — `.env.example:9-15` says `STT_MODEL` is pulled by `models` (`docker-compose.yml:83` does not); `examples/providers/README.md:86` advises `AWS_PROFILE` + mounted `~/.aws` (not mounted); `docs/TESTING.md` "Known problems" 1-5, 9, 10 are fixed in code; `SPEC-DRIVEN.md` says six packages (now seven). (DEPLOY-README-001 to 003, DEPLOY-COMPOSE-008)
4. **Policy is unenforced in CI** — DCO sign-off is mandatory (`CONTRIBUTING.md:6-16`) with no check; docs site is built only on push to `main` (`pages.yml:3-6`) with `ignoreDeadLinks` limited to localhost, so a broken link surfaces after merge; `compose-smoke` inspects state and restart count, not Compose health, and covers 4 of 10 services. (DEPLOY-CI-004, DEPLOY-CI-005, DEPLOY-CI-002)
5. **`models` cannot fail** — the pull loop discards curl status (`docker-compose.yml:83-85`) and nothing waits on `ollama` health, so `memory` / `cortex` can start before models exist. (DEPLOY-COMPOSE-011)
6. **`docs/.vitepress/config.ts:12` `srcExclude` lists a nonexistent file**; the mapping working tree has an uncommitted edit excluding `arrows/**`, `intent/**`, `high-level-design.md`, which must be committed with the docs or the next `main` build publishes (and may fail on links in) those files. (DEPLOY-DOCS-005)
7. **Images are large and root-run** — `pnpm prune --prod` was dropped (`Dockerfile:3-5`), every image ships all services and dev dependencies, no `USER`; the voice server on 8700 is Compose-internal and reached via the dashboard `/audio/` proxy. `[inferred]` accepted trade-offs after #6.
8. **Version pins are inconsistent** — pnpm 10.0.0 in three files; GitHub Actions pinned by major tag in `test`/`compose-smoke` and exact version in `pages`; `latest` image tags for ollama, curl, kokoro, speaches.

## Work Required

### Must Fix
1. Add `config/.vts-token` to `.gitignore` (DEPLOY-REPO-004).
2. Make `models` report pull failure and/or gate dependents on Ollama readiness (DEPLOY-COMPOSE-011).
3. Commit the `srcExclude` additions together with the new `docs/` files (DEPLOY-DOCS-005).

### Should Fix
4. Fix the installer: numeric Node major check, source `.env` for the dashboard URL, stop masking lockfile errors, add `stt` to the dev hint, handle docker-group re-login (DEPLOY-INST-008 to 011).
5. Add a DCO check and a docs build on pull requests (DEPLOY-CI-005, DEPLOY-CI-004).
6. Correct `.env.example` (`STT_MODEL` heading), `examples/providers/README.md` (`AWS_PROFILE`), `docs/TESTING.md` known problems, `SPEC-DRIVEN.md` package count and `plans/control-plane.md` status (DEPLOY-README-001 to 003).

### Nice to Have
7. Make `compose-smoke` check Compose health status and cover memory-free services beyond the default four (DEPLOY-CI-002).
8. Unify action versions and the pnpm pin; pin `latest` image tags (DEPLOY-IMG-001, DEPLOY-CI-001).
9. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
