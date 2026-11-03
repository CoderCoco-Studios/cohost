# Arrow: deployment

Compose topology, the single parameterised Dockerfile, the Linux installer, CI workflows, the VitePress docs site, workspace/TypeScript build setup, and the AGPL / DCO rules. No OpenSpec capability covers this segment.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 61 specs: 61 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and every gap fix has landed (compose, `.dockerignore`, installer, smoke script, `dco` and `docs-build` workflows, `srcExclude`, `.env.example`, Bedrock docs, `docs/TESTING.md`).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S4** Rewrite `COMPOSE_FILE` on every installer run → intended (re-detects the GPU). Specs: DEPLOY-INST-006 (reworded, `[x]`).
2. **P9** Lockfile mismatch → abort, no non-frozen fallback. Specs: DEPLOY-INST-012 (`[x]` → `[ ]`).
3. **P9** Failed smoke probe → print a failure line per probe, exit non-zero, poll instead of sleeping. Specs: DEPLOY-INST-007 (`[x]` → `[ ]`).
4. **P9** Fresh Docker install in the same run → stop with "log out/in and re-run", exit non-zero. Specs: DEPLOY-INST-010 (`[ ]`, reworded).
5. **S5** `redis` / `postgres` restart policy → `restart: unless-stopped`. Specs: DEPLOY-COMPOSE-015 (`[x]` → `[ ]`).
6. **B17** Pin control off in the dashboard container and pass the isolation env through → `CONTROL_ENABLED: "0"`; `${VAR:-}` entries in `x-ts-service`. Specs: DEPLOY-COMPOSE-016, DEPLOY-COMPOSE-017 (new `[ ]`; cross-ref CTRL-RUNTIME-009).
7. **S6** Bedrock credentials → fix the docs (`AWS_*` keys in `.env`), no `~/.aws` mount. Specs: DEPLOY-README-002 (`[ ]`, reworded).
8. **P9** DCO in CI → enforce on new pull requests; sign-off must match the author. Specs: DEPLOY-CI-005 (`[ ]`, reworded).
9. **P9** Docs build on pull requests → yes, build only. Specs: DEPLOY-CI-004 (`[ ]`, reworded).
10. **P9** `models` on a failed pull → exit non-zero; consumers stay on `service_started`. Specs: DEPLOY-COMPOSE-011 (`[ ]`).
11. **S7** `plans/README.md` in `srcExclude` → drop it. Specs: DEPLOY-DOCS-005 (reworded, `[x]`), DEPLOY-DOCS-006 (new `[ ]`).
12. **P9** compose-smoke requires `healthy` → yes. Specs: DEPLOY-CI-002 (`[x]` → `[ ]`).
- **B18** `config/.vts-token` git-ignored (`.gitignore:11-12`). Specs: DEPLOY-REPO-004 (`[ ]` → `[x]`).
- **B25** `.dockerignore` excludes `config/.vts-token` and the user config files. Specs: DEPLOY-IMG-005 (new `[ ]`).
- **P6** The installer, docs site and examples serve the owner's own stream; installer and docs defects are still bugs. LLD Context.
- **P4** Voice stays unpublished; host-side players use the dashboard proxy; Postgres credentials and root containers are accepted under the LAN trust boundary. LLD Decisions (Port exposure).

## References

### HLD
- docs/high-level-design.md (Segments table, operator / deployment)

### LLD
- docs/intent/deployment/deployment-design.md

### EARS
- docs/intent/deployment/deployment-specs.md (61 specs, prefix `DEPLOY`: 61 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- scripts/compose-smoke.sh (1 test annotation: DEPLOY-IMG-002, DEPLOY-IMG-003; run by `.github/workflows/compose-smoke.yml`)
- scripts/dco-check.sh (run by `.github/workflows/dco.yml`; exercised in a throwaway repository, no automated test: the test globs cover only `packages/*/test` and `services/*/test`)
- packages/control/test/healthcheck.test.ts (control-plane's file; cited from DEPLOY-HC-002 by `<!-- test: -->` comments, not annotated here)

### Code
`@spec` annotation lines in code: 47.
- docker-compose.yml (20, trailing comments on mapping keys), docker-compose.gpu.yml (1), Dockerfile (3, appended to existing comment lines), .dockerignore (1)
- scripts/install.sh (8, appended to section dividers), scripts/compose-smoke.sh (2: the header and the test annotation above), scripts/dco-check.sh (1), scripts/docs-prepare.mjs (2), scripts/dev/bus-pub.ts (1), scripts/dev/bus-tail.ts (1), scripts/dev/stub-llm.ts (1), scripts/dev/stub-tts.ts (1)
- .github/workflows/test.yml (1), .github/workflows/compose-smoke.yml (1), .github/workflows/pages.yml (1), .github/workflows/dco.yml (1), .github/workflows/docs-build.yml (1)
- Cited from the specs with `<!-- impl: -->` (24 cites on 17 specs, files owned elsewhere or plain data): package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.base.json, services/dashboard/tsconfig.json, .gitignore, LICENSE, CONTRIBUTING.md, docs/.vitepress/config.ts, packages/control/src/healthcheck.ts
- Cited from the specs, not annotated: .env.example (DEPLOY-README-001, -002), examples/providers/README.md (DEPLOY-README-002), docs/TESTING.md (DEPLOY-README-003)
- Not annotated (no spec cites a line): config/*.example.*, README.md, docs/index.md

### OpenSpec
- None (no capability for compose, Dockerfile, installer, CI, docs site or licensing). Design records cited by the LLD: `openspec/changes/archive/2026-11-01-add-service-health/design.md` (D5), `.../add-service-control/design.md`, `.../add-test-injection/design.md`.

## Architecture

**Purpose:** Turn the repository into a running stack (Compose), a verified build (CI), a published site (Pages) and a licensed, contributable project (AGPL + DCO). Owns no cohost runtime logic.

**Key Components:**
1. `docker-compose.yml` — 6 infra services (redis, postgres, ollama, tts, stt, one-shot models that exits non-zero on a failed pull) and 10 TS services from one `x-ts-service` anchor (which also pins `CONTROL_ENABLED=0` and passes the isolation env through); `eyes` / `ears` behind profiles; dashboard the only public port.
2. `Dockerfile` — base / build / runtime on node:22-slim; whole workspace compiled once per image; `SERVICE` selects the entrypoint; no prune.
3. Container healthcheck — `node packages/control/dist/healthcheck.js $SERVICE` from `@cohost/control`.
4. `docker-compose.gpu.yml` — NVIDIA overlay for ollama, tts, stt, selected via `COMPOSE_FILE`.
5. `scripts/install.sh` — Ubuntu/Debian/WSL2 bootstrap (docker, nvidia toolkit, node, pnpm, .env, config seeding, pulls, smoke).
6. CI — `test.yml` (pnpm test with Redis), `compose-smoke.yml` (build + `healthy`-with-no-restarts check of 4 services), `dco.yml` (sign-off check over the PR's commits), `docs-build.yml` (build-only docs check on PRs), `pages.yml` (VitePress to GitHub Pages).
7. Docs site — VitePress 1.6.4 fed by `scripts/docs-prepare.mjs` (README and examples copied and link-rewritten).
8. Governance — AGPL-3.0-only (`LICENSE`, every `package.json`), DCO in `CONTRIBUTING.md`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Compose topology | DEPLOY-COMPOSE-001 to 017 | 17 | 0 | 0 |
| Container health | DEPLOY-HC-001 to 002 | 2 | 0 | 0 |
| Image build | DEPLOY-IMG-001 to 005 | 5 | 0 | 0 |
| Installer | DEPLOY-INST-001 to 012 | 12 | 0 | 0 |
| Continuous integration | DEPLOY-CI-001 to 005 | 5 | 0 | 0 |
| Docs site | DEPLOY-DOCS-001 to 006 | 6 | 0 | 0 |
| Licensing and contribution | DEPLOY-LIC-001 to 002 | 2 | 0 | 0 |
| Workspace and repo hygiene | DEPLOY-REPO-001 to 006 | 6 | 0 | 0 |
| Documentation consistency | DEPLOY-README-001 to 003 | 3 | 0 | 0 |
| Dev helpers | DEPLOY-DEV-001 to 003 | 3 | 0 | 0 |

**Summary:** 61 of 61 specs implemented; 0 deferred; 0 gaps. Every `[x]` spec is linked to its implementation by an in-file `@spec` annotation or an `<!-- impl: -->` cite. Tests: DEPLOY-IMG-002 and -003 by `scripts/compose-smoke.sh`; DEPLOY-HC-002 by control-plane's `healthcheck.test.ts`; the rest is configuration verified by reading, by CI running it, or (the `models` pull loop, the installer's `probe`/port parsing/Node-major check, `scripts/dco-check.sh`) by running the script against stubs or a throwaway repository. No Docker was available when the gap fixes were made: the Compose file was parsed as YAML, not run.

## Key Findings

1. **Coverage counts corrected.** The mapped arrow doc reported 38 of 50 implemented with a gap at DEPLOY-DOCS-005, but the spec file marked DOCS-005 `[x]` (39 of 50). DOCS-005 is implemented: the `srcExclude` entries for `arrows/**`, `intent/**` and `high-level-design.md` are committed (`docs/.vitepress/config.ts:12`, commit 700192f). The `plans/README.md` entry still matches no file.
2. **All audited gaps are closed.** COMPOSE-011, -015, -016, -017; IMG-005; INST-007 to -012; CI-002, -004, -005; DOCS-006; README-001 to -003 are `[x]`.
3. **Seven behaviours had no spec and were added as implemented:** COMPOSE-012 (Ollama keep-alive, flash attention, `q8_0` KV cache), COMPOSE-013 (Redis snapshot, no AOF), COMPOSE-014 (images and their tags), COMPOSE-015 (restart policies; `redis`/`postgres` have none), INST-012 (silent frozen-lockfile fallback), REPO-005 (`onlyBuiltDependencies`), REPO-006 (`tsc -b` type-checks `src` only; tests run untyped through `tsx`).
4. **Spec lines reworded to match the code:** INST-002 (the `docker compose version` check runs on every run, not only after installing Docker); INST-006 (only an existing `COMPOSE_FILE=` line is rewritten); INST-007 (failing smoke probes are silent and non-fatal); INST-009 (Node 9 skips the install; a three-digit major is truncated); COMPOSE-004 (`models`, `tts`, `stt` are unprofiled); CI-002 (seeds `.env`; the script is the implementation, not a test of itself); REPO-002 (`lint`); REPO-003 (`.DS_Store`); DOCS-005 (rationale instead of commit narration); README-002 (now names the `.env` keys, S6); README-003 (current line numbers and fixing commits); plus detail added to COMPOSE-008/-009, HC-002, CI-001, DEV-001 to -003.
5. **Installer behaviour.** Lockfile mismatch aborts (`install.sh:108`); a fresh Docker install stops with a re-login message (`:55`); the Node major compares numerically (`:77-78`); smoke probes poll for 60 s and name the failing probe (`:124-145`); the dashboard URL reads `DASHBOARD_PORT` from the shell or `.env` without sourcing it (`:146-155`); the dev hint lists `stt` (`:165`). The `COMPOSE_FILE` rewrite at `:96-101` is intended (S4).
6. **`.env` reaches every container, including control flags.** `env_file: .env` would pass `CONTROL_ENABLED` / `CONTROL_BIND` to the containerised dashboard; `CONTROL_ENABLED: "0"` in `x-ts-service` pins the monitor-only decision (`docker-compose.yml:22`, DEPLOY-COMPOSE-016, B17). The isolation env set by `ComposeRuntime` reaches containers through `${VAR:-}` entries (`:24-31`, DEPLOY-COMPOSE-017).
7. **`config/.vts-token` is a credential** — avatar writes `<configDir>/.vts-token` (`services/avatar/src/index.ts:30`, `drivers/vtube-studio.ts:104`); both `.gitignore` (`:11-12`, DEPLOY-REPO-004, B18) and `.dockerignore` (`:9-12`, DEPLOY-IMG-005, B25) exclude it.
8. **Policy is enforced in CI** — the `dco` workflow rejects commits whose sign-off does not match the author (DEPLOY-CI-005), `docs-build` builds the site on pull requests (DEPLOY-CI-004), and `compose-smoke` requires `healthy` with no restarts for 4 of 10 services (DEPLOY-CI-002).
9. **`models` can fail** — the pull loop uses `curl -fsS`, treats an `"error"` line as a failure and exits non-zero after trying every model (`docker-compose.yml:96-107`, DEPLOY-COMPOSE-011); nothing waits on `ollama` health, so `memory` / `cortex` can start before models exist and wait for the backend themselves.
10. **Annotation placement.** Annotations in `docker-compose.yml`, `Dockerfile` and `.dockerignore` are trailing comments on mapping keys, appended to existing comment lines, or (`.dockerignore`) the last line. The `x-ts-service` environment additions moved every `docker-compose.yml` line after `:20` (healthcheck now `:39-46`); other segments' line cites were updated with them.
11. **Decisions now backed by evidence:** health signalling (OpenSpec add-service-health design D5), no-prune and its trade-off (commit 18ea80a), docs single source (commit 686cc8f), smoke scope (`compose-smoke.sh:2-4`), GPU overlay and profiles (compose comments, README); a new row records the monitor-only containerised dashboard (add-service-control design). Rationale against alternatives stays `[inferred]` where nothing records it.

## Work Required

### Must Fix
None.

### Should Fix
None.

### Nice to Have
1. Unify action versions and the pnpm pin; pin `latest` image tags (DEPLOY-COMPOSE-014, DEPLOY-CI-001).
2. Slim the runtime image or run as non-root once a safe prune/deploy path exists (DEPLOY-IMG-001, DEPLOY-IMG-002).
3. Update the `docs/plans/control-plane.md` status header (still "proposal").
