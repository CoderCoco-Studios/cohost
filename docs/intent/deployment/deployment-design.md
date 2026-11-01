---
parent: high-level-design
prefix: DEPLOY
---

# deployment

Mapped 2026-10-31 at git `686cc8f`; status MAPPED (not audited). Parent: [high-level-design](../../high-level-design.md). Specs: [deployment-specs.md](deployment-specs.md).

**No OpenSpec capability covers this segment.** `openspec/specs/` has 15 capabilities (one per package or service) and none for Compose, the Dockerfile, the installer, CI, the docs site or licensing; the four unarchived change deltas do not touch them either except for the health/config environment they add. Everything below is written from the files.

## Context and Design Philosophy

The segment is everything that turns the repository into a running stack or a published artifact: the Compose topology, the one Dockerfile, the Linux installer, the CI workflows, the VitePress docs site, the workspace and TypeScript build setup, and the licensing and contribution rules. It owns no runtime behaviour of cohost itself; it wires the other segments together and checks that they start.

Observed philosophy `[inferred]`:

- **One image, many services.** Every TypeScript service is built from the same Dockerfile and differs only by a build argument; the whole workspace is compiled once per image (`Dockerfile:1-2`).
- **Infrastructure stays on loopback, the dashboard is the only public door.** Redis, Postgres, Ollama, TTS and STT are published on `127.0.0.1` for host-run development (`docker-compose.yml:43,57,68,90,96`); the dashboard binds all interfaces so OBS on another machine can load the sink page (README.md:222-225).
- **Config is bind-mounted, not baked.** `./config` is mounted at `/app/config` and `CONFIG_DIR` points at it (`docker-compose.yml:20-22`, `Dockerfile:22`), so the config segment's seeding writes real files on the host.
- **Optional pieces behind profiles.** `eyes` and `ears` need accounts or hardware, so they are Compose profiles (`docker-compose.yml:148,153`).
- **Docs have one source of truth.** The README and `examples/*/README.md` are generated into the docs site rather than copied by hand (`scripts/docs-prepare.mjs:1-4`).
- **Process-by-convention.** OpenSpec (`CLAUDE.md`, `docs/SPEC-DRIVEN.md`) and DCO (`CONTRIBUTING.md`) govern contribution; CI enforces build and tests but not either rule.

## Compose topology

`docker-compose.yml` (162 lines) with an optional GPU overlay `docker-compose.gpu.yml` (23 lines).

| Service | Image / build | Host port | Profile | `depends_on` (beyond redis healthy) | Notes |
| --- | --- | --- | --- | --- | --- |
| `redis` | `redis:7-alpine`, `--save 60 1 --appendonly no`, vol `redis-data` | `127.0.0.1:6379` | none | | healthcheck `redis-cli ping` 5 s / 3 s / 10 retries (`:39-48`) |
| `postgres` | `pgvector/pgvector:pg16`, user/password/db all `cohost`, vol `pg-data` | `127.0.0.1:5432` | none | | healthcheck `pg_isready -U cohost` (`:50-62`) |
| `ollama` | `ollama/ollama:latest`, `OLLAMA_KEEP_ALIVE=24h`, flash attention, `q8_0` KV cache, vol `ollama-data` | `127.0.0.1:11434` | none | | no healthcheck (`:64-72`) |
| `models` | `curlimages/curl:latest`, `env_file: .env` | none | none | `ollama` started | one-shot pull loop (`:74-85`); no restart policy |
| `tts` | `${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}` | `127.0.0.1:8880` | none | | (`:87-90`) |
| `stt` | `${SPEACHES_IMAGE:-ghcr.io/speaches-ai/speaches:latest-cpu}`, vol `stt-cache` | `127.0.0.1:8000` | none | | (`:92-96`) |
| `chat`, `salience`, `affect`, `avatar` | build `SERVICE=<name>` | none | none | redis only | `:99-138` |
| `memory` | build | none | none | `postgres` healthy, `ollama` started | `:114-120` |
| `cortex` | build | none | none | `ollama` started | `:122-127` |
| `voice` | build | none (container port 8700 internal) | none | `tts` started | `:129-134` |
| `dashboard` | build | `${DASHBOARD_PORT:-3000}:3000`, all interfaces | none | | `:140-143` |
| `eyes` | build | none | `eyes` | redis only | `:145-148` |
| `ears` | build | none | `ears` | `stt` started | `:150-156` |

Shared settings come from the `x-ts-service` anchor (`:9-35`): `restart: unless-stopped`, `env_file: .env`, in-network service URLs (`REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `DASHBOARD_URL`) and `CONFIG_DIR=/app/config` under `environment:` (which wins over `.env`, so these cannot be changed from `.env`), the `./config:/app/config` volume, `host.docker.internal:host-gateway` (reach OBS or VTube Studio on the host), `depends_on: redis: service_healthy`, and the container healthcheck. A service that declares its own `depends_on` (memory, cortex, voice, ears) replaces the anchor's map and therefore re-lists `redis`. Every one of the 10 `services/*` directories has a Compose service and a `tsconfig.json` reference; the 7 `packages/*` are libraries with none.

**Container healthcheck** (`:28-35`): `node packages/control/dist/healthcheck.js $$SERVICE`, interval 10 s, timeout 5 s, 3 retries, 30 s start period. `SERVICE` is baked into the image (`Dockerfile:20`). The script is in `@cohost/control` (`packages/control/src/healthcheck.ts`): it reads the last 200 entries of `cohost:health`, takes the newest heartbeat for the named service, and is healthy iff it is not `stopping` and younger than `STALE_FACTOR` (3) times that heartbeat's own `intervalMs`; it self-terminates with exit 1 after 4 s (`healthcheck.ts:10-30`). The healthcheck only reports; no `depends_on` waits for an application service to be healthy, so health gates nothing at startup. Heartbeat semantics belong to control-plane.

**`models`**: `until curl -sf ollama:11434/api/tags; do sleep 2; done`, then for `LLM_MODEL`, `VISION_MODEL`, `EMBED_MODEL` POSTs `/api/pull` and prints the last 200 bytes (`:82-85`). The loop never inspects the HTTP result, so a failed pull still exits 0. It is not profile-gated: it runs on every plain `docker compose up -d`, as do `tts` and `stt` (so the comment "minimal talking path" at `:5` is the only way to avoid the speech-to-text image).

**GPU overlay**: `x-gpu` anchor adds an NVIDIA `deploy.resources.reservations.devices` entry (`count: all`) to `ollama`, `tts`, `stt` and swaps the `tts`/`stt` images to the GPU variants (`docker-compose.gpu.yml:6-23`). `KOKORO_IMAGE` / `SPEACHES_IMAGE` override the image in both files, so setting one for a GPU host also changes the base (CPU) file's default image.

**Voice reachability**: `voice` listens on `VOICE_PORT` (default 8700, `services/voice/src/index.ts:21`) and advertises `urls.voice()` = `http://voice:8700` inside Compose; nothing publishes it. The dashboard proxies `/audio/*` to `VOICE_URL` (`services/dashboard/src/routes.ts:55-56`), which is the supported path for browsers and OBS. Host-run tools (for example `pnpm dev` services next to a containerised `voice`) cannot reach it.

## Image build

`Dockerfile` (23 lines), three stages on `node:22-slim`:

1. `base`: `corepack enable && corepack prepare pnpm@10.0.0 --activate`, `WORKDIR /app` (`:6-8`).
2. `build`: `CI=true`, copy `pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json`, then `packages/` and `services/`, `pnpm install --frozen-lockfile`, `pnpm exec tsc -b` (`:10-16`). The root `tsconfig.json` references all 17 projects, so every service directory must exist in the build context and every image compiles the whole workspace.
3. `runtime`: `ARG SERVICE`, `ENV NODE_ENV=production SERVICE=${SERVICE}`, `COPY --from=build /app /app` (the full tree including sources and dev dependencies), `CMD ["sh","-c","exec node services/${SERVICE}/dist/index.js"]` (`:18-23`).

`pnpm prune --prod` was removed (`:3-5`): under pnpm 10 it empties `services/*/node_modules` and drops the `@cohost/*` workspace links (issue #6). `pnpm deploy --prod` was tried and needs `inject-workspace-packages` lockfile settings. The consequence is a larger image that ships dev dependencies. No `USER` is set (containers run as root, so files the config loader seeds into the bind mount are root-owned on Linux hosts) and the Dockerfile declares no `HEALTHCHECK` (Compose supplies it).

`.dockerignore` (8 lines): `node_modules`, `**/node_modules`, `**/dist`, `.git`, `data`, `.env`, `**/*.tsbuildinfo`, `**/*.log`. The `.tsbuildinfo` and `*.log` entries were added after the base sweep so stale incremental state cannot make `tsc -b` skip emitting in the image (issue #7). It does not exclude `worktrees/`, `config/`, `docs/` or `graphify-out/`, which only inflates the context.

## Installer: `scripts/install.sh`

`set -euo pipefail`, runs from the repo root, flag `--no-pull`. Steps in order:

1. Detect WSL (`grep -qi microsoft /proc/version`), source `/etc/os-release`, warn if the distro is not Ubuntu or Debian (`:16-24`).
2. Detect NVIDIA via `nvidia-smi` (`:26-34`).
3. If `docker` is missing, install docker-ce from the Docker apt repo, `usermod -aG docker`, start the daemon (`service` on WSL, `systemctl` otherwise); die if `docker compose version` fails (`:36-56`).
4. If a GPU exists and `docker info` shows no NVIDIA runtime, install `nvidia-container-toolkit` if needed, `nvidia-ctk runtime configure`, restart Docker (`:58-73`).
5. If Node is missing or `<22`, install NodeSource `setup_22.x` (piped to `sudo bash`); if `pnpm` is missing, `corepack enable` and prepare `pnpm@10.0.0` (`:75-81`).
6. Seed `.env` and the three `config/` files from their examples if absent (`:83-93`); rewrite `COMPOSE_FILE` in `.env` unconditionally (GPU: `docker-compose.yml:docker-compose.gpu.yml`) (`:94-99`); `mkdir -p data` (`:100`, nothing references `data/` afterwards).
7. `pnpm install --frozen-lockfile 2>/dev/null || pnpm install`, then `pnpm typecheck` (`:102-106`).
8. Unless `--no-pull`: `docker compose pull --ignore-buildable`, `up -d ollama models`, follow `models` logs, `docker compose wait models` (`:108-118`).
9. Smoke test: `up -d redis postgres`, `redis-cli ping`, `pg_isready`, and Ollama `/api/tags` when pulling (`:120-128`); print next steps (`:130-141`).

Known defects (sweep-4, confirmed present at 686cc8f by reading the same lines): `:76` `node -v | cut -c2-3` used as an integer; `:104` hides frozen-lockfile failures by dropping stderr and falling back to a non-frozen install; `:135` prints `${DASHBOARD_PORT:-3000}` though `.env` is never sourced; `:139` dev-loop hint omits `stt`; `:95,98` overwrite `COMPOSE_FILE` every run. Additionally `[inferred]`, not executed: after a fresh docker-ce install the current shell lacks the `docker` group (`:52`), so the later `docker` calls (`:59,111,113`) can fail until re-login. `corepack prepare pnpm@10.0.0` (`:81`) duplicates `package.json:8` and `Dockerfile:7`.

## Build, test and CI

**Workspace and TypeScript**: `pnpm-workspace.yaml` globs `packages/*` and `services/*`. `tsconfig.json` is solution-style (`files: []`, 17 references: config, bus, llm, modules, working-memory, control, testing plus the 10 services). `tsconfig.base.json` sets ES2022, NodeNext, `strict`, `composite`, declarations and `noUncheckedIndexedAccess`, with `lib: ["ES2022"]` (no DOM). Per-package tsconfigs include only `src`, so test files are executed through `tsx` but not type-checked by `tsc -b`.

**Root scripts** (`package.json:12-25`): `build`, `typecheck` (`tsc -b --noEmit`), `lint` (identical to `typecheck`; there is no linter), `dev` (`pnpm -r --parallel --filter './services/*' dev`; each service runs `tsx watch src/index.ts`), `reflect`, `clean`, `test` (`tsc -b && node --import tsx --test "packages/*/test/*.test.ts" "services/*/test/*.test.ts"`), `test:only`, and the `docs:*` scripts. `pnpm.onlyBuiltDependencies` allows install scripts for `esbuild`, `@snazzah/davey`, `libsodium-wrappers`, `opusscript` (the Discord voice stack, `package.json:32-39`). `packageManager` pins `pnpm@10.0.0`; `engines.node` is `>=22`.

**Workflows** (`.github/workflows/`):

| Workflow | Triggers | What it does | Notes |
| --- | --- | --- | --- |
| `test.yml` | PR, push `main`; cancels older runs of the same ref | Redis 7 service, `REDIS_URL=redis://127.0.0.1:6379`, `pnpm install --frozen-lockfile`, `pnpm test`; 10 min | Redis presence makes the bus round-trip tests run instead of skipping; no Postgres or Ollama; actions pinned by major tag (`checkout@v4`, `pnpm/action-setup@v4`, `setup-node@v4`) |
| `compose-smoke.yml` | PR, push `main`; cancels older | `scripts/compose-smoke.sh`; 15 min | `checkout@v4` |
| `pages.yml` | push `main`, manual dispatch | build job: install, `pnpm docs:build`, upload `docs/.vitepress/dist`; deploy job: `deploy-pages` to `github-pages` | exact-version pins (`checkout@v7.0.1`, `pnpm/action-setup@v6.1.0`, `setup-node@v7.1.0`, `configure-pages@v6.0.0`, `upload-pages-artifact@v5.0.0`, `deploy-pages@v5.0.1`); not run on PRs |

`scripts/compose-smoke.sh` (24 lines): copies `.env.example` to `.env` if missing, `docker compose up -d --build redis <services>` (default `salience affect avatar dashboard`, chosen because they need no models or credentials), sleeps `SMOKE_WAIT` (15 s), then for each service requires `docker inspect` to report `running restarts=0`; on failure prints `docker compose logs --tail 20`; a `trap` always runs `docker compose down -v`, which also deletes the volumes. It checks container state, not the Compose health status, and covers only four of ten services. Its purpose is the regression guard for issue #6 (`compose-smoke.sh:2-3`).

There is no DCO, lint, docs-build-on-PR, image-publish or release workflow.

## Docs site

VitePress 1.6.4 (exact pin, `package.json:30`). `docs/.vitepress/config.ts`: `base: '/cohost/'`, `cleanUrls`, `lastUpdated: false`, `ignoreDeadLinks: [/^https?:\/\/localhost/]`, local search, a hand-written nav and sidebar (Guide, Testing, Spec-driven, Plans, Examples), AGPL footer. `srcExclude` (`config.ts:12`) at the mapped commit is `['plans/README.md']`, an entry that matches no file; the mapping working tree has an uncommitted edit to that same line adding `arrows/**`, `intent/**` and `high-level-design.md`. Without it VitePress would publish and index every `.md` under `docs/` (but not list them in the explicit sidebar), and any relative link to a non-markdown file or a missing page would fail the build because only localhost links are ignored.

`scripts/docs-prepare.mjs` (56 lines): maps `README.md` to `docs/guide/index.md`, `examples/README.md` to `docs/examples/index.md`, and each `examples/<d>/README.md` to `docs/examples/<d>.md`; removes `docs/guide` and `docs/examples` first; prepends a "Generated ... Edit the source" comment; rewrites inline `](relative)` links (regex at `:34`) to site paths for generated and native pages (`docs/TESTING.md`, `docs/SPEC-DRIVEN.md`) and otherwise to `github.com/CoderCoco/cohost/{blob|tree}/main/...`. It throws if `examples/` is missing (`:18`) and does not rewrite reference-style or HTML links. `docs/guide/`, `docs/examples/`, `docs/.vitepress/cache` and `docs/.vitepress/dist` are git-ignored (`.gitignore:12-17`). Hand-written pages: `docs/index.md` (home hero), `docs/TESTING.md` (427 lines), `docs/SPEC-DRIVEN.md` (91 lines), `docs/plans/control-plane.md` (401 lines, header still "Status: proposal").

## Licensing and contribution

`LICENSE` is the 661-line AGPL v3 text; the root and all 17 workspace `package.json` files declare `AGPL-3.0-only` (verified by `grep -L` returning nothing). `CONTRIBUTING.md` (56 lines) states contributions are under the same license and requires a DCO 1.1 sign-off on every commit (`git commit -s`; amend with `-s` or `git rebase --signoff`), with the DCO text embedded. The README License section repeats this (README.md:361-367). `CLAUDE.md` and `docs/SPEC-DRIVEN.md` add the OpenSpec propose/apply/archive process for event, config-key and behaviour changes; none of it is enforced by CI.

## Developer scripts (`scripts/dev/`)

`bus-pub.ts` validates a payload with the bus zod schemas then publishes (`exit 1` on rejection, `2` on unknown type or bad JSON); `bus-tail.ts` does a non-group `XREAD` tail with `--replay N`, `--json` and type filters; `stub-llm.ts` fakes Ollama `/api/tags` and `/api/chat` (not `/api/embed`) on `STUB_LLM_PORT` (11434); `stub-tts.ts` fakes `/v1/audio/speech` and returns a pulsing 24 kHz WAV on `STUB_TTS_PORT` (8880). All import the bus from `../../packages/bus/src` (source, not `dist`). Since `llm.provider: mock` and `voice.engine: stub` now exist (config segment), these stubs are largely superseded for service-level runs, but docs/TESTING.md still presents them as the primary substitutes.

## README and documentation versus code

| Claim | Where | Reality at 686cc8f |
| --- | --- | --- |
| VTube Studio token saved to `config/.vts-token` | README.md:214 | Correct: avatar passes `stateDir: configDir()` (`services/avatar/src/index.ts:30`, `drivers/vtube-studio.ts:104`). The earlier sweeps called this a mismatch; the real gap is that `.gitignore` does not ignore the file |
| `STT_MODEL` is pulled by the `models` service | `.env.example:9-15` | Not pulled; compose pulls only `LLM_MODEL`, `VISION_MODEL`, `EMBED_MODEL` (`docker-compose.yml:83`); `STT_MODEL` is only substituted into `ears.stt_model` and sent per request (`services/ears/src/hearing.ts:23`) |
| Bedrock via `AWS_PROFILE` with a mounted `~/.aws` | `examples/providers/README.md:86`, `.env.example:20` | No such mount; application services mount only `./config` (`docker-compose.yml:22`) |
| `docker compose up -d` is the "core" stack | README.md:49 | Starts everything without a profile, including `models`, `tts`, `stt`; the minimal command is in a compose comment (`:5`) |
| Dev loop infra is `redis postgres ollama tts stt` | README.md:337 | `install.sh:139` omits `stt` |
| `config.yaml`, `personality.md`, `expressions.yaml` are untracked | README.md:135-140 | True per `.gitignore:8-10`; text speaks to users upgrading from earlier tracked copies |
| voice HTTP on 8700 | `docker-compose.yml:18`, `services/voice/src/index.ts:21` | Container-internal only; browsers go through the dashboard's `/audio/` proxy |
| TESTING.md "Known problems" 1-5, 9, 10 | `docs/TESTING.md:392-425` | Fixed in code (see DEPLOY-README-003); TESTING.md:102 ("config is read from `./config` relative to the working directory") and the "206 tests" figure (`:61`) are also pre-change |
| "ten services and six packages" | `docs/SPEC-DRIVEN.md` | Seven packages now (`packages/control`) |
| `docs/plans/control-plane.md` is a proposal | its header | Implemented by changes #20-#23 |

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Image strategy | One Dockerfile, `SERVICE` build arg, whole workspace compiled in each image | per-service Dockerfiles; a shared base image plus per-service layers | `[inferred]` `Dockerfile:1-2` comment "layer-cached across services"; `docker-compose.yml:101,108,...` pass `args: { SERVICE: <name> }` |
| Dev dependencies in runtime | Ship the entire build stage, no prune | `pnpm prune --prod`; `pnpm deploy --prod` | `[inferred]` `Dockerfile:3-5` records that prune broke workspace links (#6) and deploy needs lockfile settings |
| Config delivery | Bind-mount `./config` at `/app/config` | bake config into the image; named volume | `[inferred]` `Dockerfile:22` comment and `docker-compose.yml:20-22`; lets users and the dashboard personality editor edit files in place |
| Port exposure | Infra on `127.0.0.1`, dashboard on all interfaces, voice unpublished | publish everything; reverse proxy | `[inferred]` `docker-compose.yml:43,57,68,90,96` comment "for `pnpm dev` outside docker"; dashboard must be reachable from OBS on another PC (README.md:222-225) |
| Optional services | Compose `profiles` for eyes and ears | separate compose files; always on | `[inferred]` `docker-compose.yml:6-7,148,153` |
| GPU support | Separate overlay file selected via `COMPOSE_FILE` in `.env` | profile; per-service image variables only | `[inferred]` `docker-compose.gpu.yml:1-4`; `install.sh:94-99` writes the variable |
| Health signalling | Heartbeat-based healthcheck through the bus, not HTTP probes | HTTP `/health` per service | `[inferred]` `docker-compose.yml:28-29` comment; only the dashboard and voice are HTTP servers, the other eight are bus-only |
| Smoke test scope | Four credential-free services, state plus restart count | all services; `docker compose up --wait` on health | `[inferred]` `scripts/compose-smoke.sh:2-4` comment (no models or credentials); guards #6 specifically |
| Docs site source | Generate guide and examples from READMEs at build time | maintain duplicate pages in `docs/` | `[inferred]` `scripts/docs-prepare.mjs:1-4` "originals stay the source of truth" |
| Docs hosting | GitHub Pages via Actions on push to `main` | Netlify/Vercel; build on PR | `[inferred]` `.github/workflows/pages.yml` |
| Licence and sign-off | AGPL-3.0-only plus DCO | CLA; MIT/Apache | `[inferred]` `CONTRIBUTING.md:3-16`; PR #25 summary (git log) names the license and DCO as the change |
| Installer scope | Bash script for Ubuntu/Debian/WSL2 only | cross-platform setup; Makefile | `[inferred]` `scripts/install.sh:2,20-23` |
| Test runner | Node's built-in `node:test` through `tsx`, tests excluded from `tsc -b` | vitest/jest | `[inferred]` `package.json:19`; per-package tsconfigs include only `src` |

## Open Questions & Future Decisions

1. **Installer bugs** (DEPLOY-INST-008 to -011): see the defect list above; sweep-7 confirmed none changed since 95afa19. Whether the silent fallback at `install.sh:104` is deliberate leniency is unknown.
2. **Unenforced policy.** DCO is mandatory in `CONTRIBUTING.md:6-16` but no workflow checks it (DEPLOY-CI-005); of the last 20 commit messages only one contains a `Signed-off-by` trailer (the DCO commit itself), so earlier history predates the rule. OpenSpec rules in `CLAUDE.md:29-37` are likewise unenforced.
3. **Docs publishing hazards.** The docs build is not exercised on PRs (DEPLOY-CI-004); `srcExclude` lists a nonexistent file; the docs site's `ignoreDeadLinks` allows only localhost, so any link added to `README.md` that is not rewritten (reference-style, HTML) can fail the main-branch deploy. Whether the `docs/intent`, `docs/arrows` and HLD files should ever be published is a decision, not yet made (DEPLOY-DOCS-005).
4. **`models` failure handling** (DEPLOY-COMPOSE-011) and the absence of an `ollama` healthcheck mean `memory`/`cortex` (`service_started` only) can race the model download; cortex logs "waiting for the model backend" and retries (docs/TESTING.md:115).
5. **Unpinned images.** `ollama/ollama:latest`, `curlimages/curl:latest`, Kokoro and speaches `latest-*` tags (`docker-compose.yml:65,76,88,93`) and Postgres `pg16` major pin only; CI and base image pin `redis:7-alpine`. Actions are pinned by major tag in two workflows and by exact version in the third.
6. **Security posture.** Hard-coded `cohost/cohost` Postgres credentials appear in the compose `environment` and the DSN given to every service (`docker-compose.yml:14,52-55`) though only `memory` uses Postgres; containers run as root; the control token and any docker-socket mount are opt-in (README.md:325-332). Port 5432 is loopback-only, so the exposure is local.
7. **`.vts-token` ignore** (DEPLOY-REPO-004) and the `data/` directory created by the installer but referenced nowhere else (`install.sh:100`, `.dockerignore:5`, `.gitignore:5`).
8. **Image size and duplication.** Every image carries all services' built code plus dev dependencies and sources (`Dockerfile:21`); `pnpm prune`/`deploy` were abandoned. A per-service filtered install is a possible future decision.
9. **Pnpm version in three places** (`package.json:8`, `Dockerfile:7`, `install.sh:81`); CI reads `packageManager`. Updating needs three edits.
10. **Stale documentation set** listed in the table above (TESTING.md known problems, SPEC-DRIVEN.md counts, plans/control-plane.md status, `.env.example` comment); `docs/SPEC-DRIVEN.md` also claims `openspec/specs/` "always describes what the system does today", which is untrue until the four merged changes are archived.
11. **Compose and CI inconsistencies.** `restart: unless-stopped` is set on `ollama`, `tts`, `stt` and the TS services but not on `redis` or `postgres` (`docker-compose.yml:39-62`); `compose-smoke.yml` and `test.yml` use older action versions than `pages.yml`; the smoke test would still pass when a container is `running` but `unhealthy`.

## References

**Files in this segment**
- Compose and image: `docker-compose.yml`, `docker-compose.gpu.yml`, `Dockerfile`, `.dockerignore`
- Scripts: `scripts/install.sh`, `scripts/compose-smoke.sh`, `scripts/docs-prepare.mjs`, `scripts/dev/bus-pub.ts`, `scripts/dev/bus-tail.ts`, `scripts/dev/stub-llm.ts`, `scripts/dev/stub-tts.ts`
- CI: `.github/workflows/test.yml`, `.github/workflows/compose-smoke.yml`, `.github/workflows/pages.yml`
- Workspace: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `.gitignore`
- Governance and docs: `LICENSE`, `CONTRIBUTING.md`, `docs/.vitepress/config.ts`, `docs/index.md`, `README.md` (Quick start 43-71, Developing 334-352, Two-PC 227-232, Upgrading 135-140), `docs/TESTING.md`

**Other segments (direction)**
- Deployment depends on every service segment (builds and runs them) and on `config` (`.env.example`, `config/*.example.*`, `CONFIG_DIR`, seeding), `control-plane` (the healthcheck binary `packages/control/dist/healthcheck.js` and heartbeats), `event-bus` (`scripts/dev` imports `packages/bus/src`; Redis is the only service every container waits for), `memory`/`cortex`/`voice`/`ears`/`eyes` (dependency ordering), and `dashboard` (the only published port, `/audio/` proxy).
- Nothing depends on deployment at runtime.

**External services and tools**: Docker Engine and Compose v2, NVIDIA container toolkit, Redis 7, pgvector (Postgres 16), Ollama, Kokoro-FastAPI, speaches, GitHub Actions and Pages, VitePress 1.6.4, pnpm 10.0.0, corepack, NodeSource.

**OpenSpec**: none for this segment. Related process docs: `CLAUDE.md`, `docs/SPEC-DRIVEN.md`, `openspec/config.yaml`.
