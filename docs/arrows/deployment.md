# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the Linux installer, CI workflows, the VitePress docs site, workspace/TypeScript build setup, and the AGPL / DCO rules. No OpenSpec capability covers this segment.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`). 46 of 57 specs implemented; 11 gaps (installer defects, unenforced DCO, docs-build-on-PR, `.vts-token` ignore, `models` failure handling, stale docs). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **Is rewriting `COMPOSE_FILE` on every installer run intended?** `scripts/install.sh:94-99` replaces any hand-set value; DEPLOY-INST-006 records this as implemented while the mapping listed it as a defect. Recommended: intended (the installer re-detects the GPU each run); keep INST-006 `[x]`.
2. **Should a lockfile mismatch abort the installer?** `scripts/install.sh:104` drops the `--frozen-lockfile` error and falls back to a plain `pnpm install` (DEPLOY-INST-012), while `test.yml` and `Dockerfile:15` both require a frozen lockfile. Recommended: abort; then reword INST-012 to require failure and mark it `[ ]`.
3. **Should a failed installer smoke probe fail the installer?** `scripts/install.sh:122-128`: a failing `redis-cli ping` / `pg_isready` / `/api/tags` probe prints nothing and the script still prints "Done"; the probes run after a fixed `sleep 2` (DEPLOY-INST-007). Recommended: yes; print a failure line per probe, exit non-zero, and poll instead of sleeping.
4. **What should the installer do after it installs Docker in the same run?** `scripts/install.sh:52-54` adds the user to `docker` and only warns; `:111,113,122` then run without the group (DEPLOY-INST-010 asks for "continue without re-login"). Recommended: stop right after a fresh Docker install with a "log out/in and re-run" message, and reword INST-010 to that contract.
5. **Should `redis` and `postgres` restart unless stopped?** `docker-compose.yml:39-62` gives them no restart policy while `:10,66,89,94` give one to every other long-running service (DEPLOY-COMPOSE-015). Recommended: yes, add `restart: unless-stopped` to both; every application container depends on `redis`.
6. **Should Compose pin service control off for the containerised dashboard?** `env_file: .env` (`docker-compose.yml:11`) passes `CONTROL_*` to the dashboard container; with `CONTROL_ENABLED=1` it binds `127.0.0.1` inside the container (`packages/control/src/config.ts:32-35`) and the published port stops answering, although the containerised dashboard is meant to be monitor-only (`openspec/changes/archive/2026-11-01-add-service-control/design.md:28`). Recommended: yes, set `CONTROL_ENABLED: "0"` in the dashboard's `environment:` and add a COMPOSE spec for it.
7. **Bedrock credentials in Compose: fix the docs or add a mount?** `examples/providers/README.md:86` and `.env.example:20` suggest `AWS_PROFILE` with a mounted `~/.aws`; application services mount only `./config` (`docker-compose.yml:21-22`) (DEPLOY-README-002). Recommended: fix the docs; `AWS_*` keys in `.env` already work, and a home-directory mount would expose credentials to all ten containers.
8. **Enforce the DCO in CI, and must the sign-off match the commit author?** `CONTRIBUTING.md:6-16` makes sign-off mandatory with no check (DEPLOY-CI-005); commit 686cc8f is signed off by `Pane <runpane@users.noreply.github.com>`, not its author. Recommended: yes to both, for new pull requests only.
9. **Should pull requests build the docs site?** `.github/workflows/pages.yml:4-7` runs on push to `main` and manual dispatch only, so a dead link first fails on `main` (DEPLOY-CI-004). Recommended: yes, a build-only job on `pull_request` with no deploy.
10. **Should `models` fail when a pull fails?** `docker-compose.yml:82-85` uses `curl -s … | tail -c 200` and ends on `echo`, so it always exits 0 (DEPLOY-COMPOSE-011). Recommended: exit non-zero on a failed pull; keep `memory`/`cortex` on `service_started`. Neither waits for the model: `Ollama.ping()` only requests `/api/tags`, so both proceed once Ollama responds.
11. **Keep or drop the `plans/README.md` entry in `srcExclude`?** `docs/.vitepress/config.ts:12` lists it, but `docs/plans/` holds only `control-plane.md` (DEPLOY-DOCS-005). Recommended: drop it.
12. **Should the compose smoke test require `healthy`, not just `running`?** `scripts/compose-smoke.sh:19-25` checks container state and restart count only (DEPLOY-CI-002), though every application service now has a heartbeat healthcheck (DEPLOY-HC-001). Recommended: yes, wait for `healthy` on the same four services.

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (57 specs, prefix `DEPLOY`: 46 `[x]`, 11 `[ ]`, 0 `[D]`)

### Tests
- scripts/compose-smoke.sh (1 test annotation: DEPLOY-IMG-002, DEPLOY-IMG-003; run by `.github/workflows/compose-smoke.yml`)
- packages/control/test/healthcheck.test.ts (control-plane's file; cited from DEPLOY-HC-002 by `<!-- test: -->` comments, not annotated here)

### Code
`@spec` annotation lines in code: 39.
- docker-compose.yml (18, trailing comments on mapping keys), docker-compose.gpu.yml (1), Dockerfile (3, appended to existing comment lines), .dockerignore (1)
- scripts/install.sh (6, appended to section dividers), scripts/compose-smoke.sh (1, plus the test annotation above), scripts/docs-prepare.mjs (2), scripts/dev/bus-pub.ts (1), scripts/dev/bus-tail.ts (1), scripts/dev/stub-llm.ts (1), scripts/dev/stub-tts.ts (1)
- .github/workflows/test.yml (1), .github/workflows/compose-smoke.yml (1), .github/workflows/pages.yml (1)
- Cited from the specs with `<!-- impl: -->` (16 cites on 11 specs, files owned elsewhere or plain data): package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, services/dashboard/tsconfig.json, .gitignore, LICENSE, CONTRIBUTING.md, docs/.vitepress/config.ts, packages/control/src/healthcheck.ts
- Not annotated (no implemented spec lives there): .env.example, config/*.example.*, README.md, docs/TESTING.md, docs/index.md

### OpenSpec
- None (no capability for compose, Dockerfile, installer, CI, docs site or licensing). Design records cited by the LLD: `openspec/changes/archive/2026-11-01-add-service-health/design.md` (D5), `.../add-service-control/design.md`, `.../add-test-injection/design.md`.

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
| Compose topology | DEPLOY-COMPOSE-001 to 015 | 14 | 0 | 1 (011) |
| Container health | DEPLOY-HC-001 to 002 | 2 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to 004 | 4 | 0 | 0 |
| Installer | DEPLOY-INST-001 to 012 | 8 | 0 | 4 (008-011) |
| Continuous integration | DEPLOY-CI-001 to 005 | 3 | 0 | 2 (004, 005) |
| Docs site | DEPLOY-DOCS-001 to 005 | 5 | 0 | 0 |
| Licensing and contribution | DEPLOY-LIC-001 to 002 | 2 | 0 | 0 |
| Workspace and repo hygiene | DEPLOY-REPO-001 to 006 | 5 | 0 | 1 (004) |
| Documentation consistency | DEPLOY-README-001 to 003 | 0 | 0 | 3 |
| Dev helpers | DEPLOY-DEV-001 to 003 | 3 | 0 | 0 |

**Summary:** 46 of 57 specs implemented; 0 deferred; 11 gaps. Every `[x]` spec is linked to its implementation: 35 by an in-file `@spec` annotation, 11 by `<!-- impl: -->` cites. Tests: DEPLOY-IMG-002 and -003 by `scripts/compose-smoke.sh`; DEPLOY-HC-002 by control-plane's `healthcheck.test.ts`; the rest is configuration verified only by reading or by CI running it.

## Key Findings

1. **Coverage counts corrected.** The mapped arrow doc reported 38 of 50 implemented with a gap at DEPLOY-DOCS-005, but the spec file marked DOCS-005 `[x]` (39 of 50). DOCS-005 is implemented: the `srcExclude` entries for `arrows/**`, `intent/**` and `high-level-design.md` are committed (`docs/.vitepress/config.ts:12`, commit 700192f). The `plans/README.md` entry still matches no file.
2. **No marker flips.** Every `[ ]` line was re-checked at HEAD and is still a gap: COMPOSE-011, INST-008 to -011, CI-004, CI-005, REPO-004, README-001 to -003.
3. **Seven behaviours had no spec and were added as implemented:** COMPOSE-012 (Ollama keep-alive, flash attention, `q8_0` KV cache), COMPOSE-013 (Redis snapshot, no AOF), COMPOSE-014 (images and their tags), COMPOSE-015 (restart policies; `redis`/`postgres` have none), INST-012 (silent frozen-lockfile fallback), REPO-005 (`onlyBuiltDependencies`), REPO-006 (`tsc -b` type-checks `src` only; tests run untyped through `tsx`).
4. **Spec lines reworded to match the code:** INST-002 (the `docker compose version` check runs on every run, not only after installing Docker); INST-006 (only an existing `COMPOSE_FILE=` line is rewritten); INST-007 (failing smoke probes are silent and non-fatal); INST-009 (Node 9 skips the install; a three-digit major is truncated); COMPOSE-004 (`models`, `tts`, `stt` are unprofiled); CI-002 (seeds `.env`; the script is the implementation, not a test of itself); REPO-002 (`lint`); REPO-003 (`.DS_Store`); DOCS-005 (rationale instead of commit narration); README-002 (neutral about docs-vs-mount, see question 7); README-003 (current line numbers and fixing commits); plus detail added to COMPOSE-008/-009, HC-002, CI-001, DEV-001 to -003.
5. **Installer defects still present** — `install.sh:76` (integer test on `cut -c2-3`), `:104` (frozen-lockfile errors hidden), `:122-128` (failed probes silent), `:135` (`DASHBOARD_PORT` never sourced), `:139` (dev hint omits `stt`); plus `[inferred]` docker-group timing after a fresh install (`:52` vs `:111,113,122`). Whether the `COMPOSE_FILE` rewrite at `:94-99` is a defect is question 1.
6. **`.env` reaches every container, including control flags.** `env_file: .env` passes `CONTROL_ENABLED` / `CONTROL_BIND` to the containerised dashboard, which then binds loopback inside the container; the monitor-only decision for that container is not enforced (`[inferred]`, question 6).
7. **`config/.vts-token` is a credential that is not git-ignored** — avatar writes `<configDir>/.vts-token` (`services/avatar/src/index.ts:30`, `drivers/vtube-studio.ts:104`); `.gitignore` has no entry. (DEPLOY-REPO-004)
8. **Policy is unenforced in CI** — DCO sign-off is mandatory (`CONTRIBUTING.md:6-16`) with no check, and 686cc8f's sign-off names a bot rather than its author; the docs site is built only on push to `main` (`pages.yml:4-7`); `compose-smoke` inspects state and restart count, not health, and covers 4 of 10 services. (DEPLOY-CI-002, -004, -005)
9. **`models` cannot fail** — the pull loop discards curl status (`docker-compose.yml:82-85`) and nothing waits on `ollama` health, so `memory` / `cortex` can start before models exist. (DEPLOY-COMPOSE-011)
10. **Annotation placement keeps cross-segment line cites stable.** Other segments cite `docker-compose.yml`, `Dockerfile` and `.dockerignore` by line, so annotations there are trailing comments on mapping keys, appended to existing comment lines, or (`.dockerignore`) a new last line; no line in those files moved.
11. **Decisions now backed by evidence:** health signalling (OpenSpec add-service-health design D5), no-prune and its trade-off (commit 18ea80a), docs single source (commit 686cc8f), smoke scope (`compose-smoke.sh:2-4`), GPU overlay and profiles (compose comments, README); a new row records the monitor-only containerised dashboard (add-service-control design). Rationale against alternatives stays `[inferred]` where nothing records it.

## Work Required

### Must Fix
1. Add `config/.vts-token` to `.gitignore` (DEPLOY-REPO-004).
2. Make `models` report pull failure (DEPLOY-COMPOSE-011, question 10).
3. Decide and, if confirmed, pin control off for the containerised dashboard (question 6).

### Should Fix
4. Fix the installer: numeric Node major check, source `.env` for the dashboard URL, stop masking lockfile errors and probe failures, add `stt` to the dev hint, handle docker-group re-login (DEPLOY-INST-007 to -012, questions 2-4).
5. Add a DCO check and a docs build on pull requests (DEPLOY-CI-005, DEPLOY-CI-004).
6. Correct `.env.example` (`STT_MODEL` heading), `examples/providers/README.md` (`AWS_PROFILE`), `docs/TESTING.md` known problems and figures, and the `plans/control-plane.md` status (DEPLOY-README-001 to -003).

### Nice to Have
7. Make `compose-smoke` check Compose health status (DEPLOY-CI-002, question 12).
8. Add restart policies to `redis` / `postgres` (DEPLOY-COMPOSE-015, question 5); unify action versions and the pnpm pin; pin `latest` image tags (DEPLOY-COMPOSE-014, DEPLOY-CI-001).
9. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
