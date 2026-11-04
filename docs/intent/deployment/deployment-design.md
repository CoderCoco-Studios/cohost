---
parent: high-level-design
prefix: DEPLOY
---

# deployment

Parent: [high-level-design](../../high-level-design.md). Specs: [deployment-specs.md](deployment-specs.md).

The retired OpenSpec baseline (`openspec/specs/`, 17 capabilities, one per package or service plus `service-control` and `service-health`) has no capability for Compose, the Dockerfile, the installer, CI, the docs site or licensing. Everything below is written from the files.

## Context and Design Philosophy

The segment is everything that turns the repository into a running stack or a published artifact: the Compose topology, the one Dockerfile, the Linux installer, the CI workflows, the VitePress docs site, the workspace and TypeScript build setup, and the licensing and contribution rules. It owns no runtime behaviour of cohost itself; it wires the other segments together and checks that they start.

The installer, the docs site and the examples serve the owner's own stream; packaging cohost for other streamers is not a goal. A defect in the installer or the docs is still a bug and is fixed with the same weight as a runtime defect, and the installer fails loudly rather than leaving a half-working stack: it aborts on a lockfile mismatch, on a failed smoke probe, and after a fresh Docker install that needs a re-login.

Describes the intended design and the files that realize it; where the files lag, the text says so and names the gap spec.

Philosophy, with the evidence for each:

- **One image, many services.** Every TypeScript service is built from the same Dockerfile and differs only by a build argument; the whole workspace is compiled once per image (`Dockerfile:1-2`).
- **Infrastructure stays on loopback, the dashboard is the only public door.** Redis, Postgres, Ollama, TTS and STT are published on `127.0.0.1` "for `pnpm dev` outside docker" (`docker-compose.yml:55`, same pattern at `:70,81,112,118`); the dashboard is published on all interfaces so OBS on another machine can load the sink page (README.md:222-232).
- **CPU by default, GPU as an overlay.** The base file is CPU-only and the GPU is layered on by a second file that `install.sh` selects through `COMPOSE_FILE` (`docker-compose.yml:1-2`, `docker-compose.gpu.yml:1-4`).
- **Config is bind-mounted, not baked.** `./config` is mounted at `/app/config` and `CONFIG_DIR` points at it (`docker-compose.yml:20,32-33`, `Dockerfile:22`), so the config segment's seeding writes real files on the host.
- **Optional pieces behind profiles.** `eyes` and `ears` are Compose profiles (`docker-compose.yml:6-7,170,175`; README.md:58-63 "Add the optional pieces when you're ready").
- **Docs have one source of truth.** The README and `examples/*/README.md` are generated into the docs site rather than copied by hand (`scripts/docs-prepare.mjs:1-4`).
- **Process rules checked where a machine can check them.** The DCO (`CONTRIBUTING.md`) is enforced in CI for new pull requests (DEPLOY-CI-005) and the docs site builds on every pull request (DEPLOY-CI-004); linked-intent development (`CLAUDE.md`, `docs/SPEC-DRIVEN.md`) stays a convention.

## Compose topology

`docker-compose.yml` with an optional GPU overlay `docker-compose.gpu.yml`.

| Service | Image / build | Host port | Profile | `depends_on` (beyond redis healthy) | Notes |
| --- | --- | --- | --- | --- | --- |
| `redis` | `redis:7-alpine`, `--save 60 1 --appendonly no`, vol `redis-data` | `127.0.0.1:6379` | none | | healthcheck `redis-cli ping` 5 s / 3 s / 10 retries; `restart: unless-stopped` (`:50-60`, DEPLOY-COMPOSE-015) |
| `postgres` | `pgvector/pgvector:pg16`, user/password/db all `cohost`, vol `pg-data` | `127.0.0.1:5432` | none | | healthcheck `pg_isready -U cohost`; `restart: unless-stopped` (`:62-75`, DEPLOY-COMPOSE-015) |
| `ollama` | `ollama/ollama:latest`, `OLLAMA_KEEP_ALIVE=24h`, flash attention, `q8_0` KV cache, vol `ollama-data` | `127.0.0.1:11434` | none | | no healthcheck (`:77-86`) |
| `models` | `curlimages/curl:latest`, `env_file: .env` | none | none | `ollama` started | one-shot pull loop that exits non-zero on a failed pull, no restart policy (`:87-107`) |
| `tts` | `${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:latest}` | `127.0.0.1:8880` | none | | (`:109-112`) |
| `stt` | `${SPEACHES_IMAGE:-ghcr.io/speaches-ai/speaches:latest-cpu}`, vol `stt-cache` | `127.0.0.1:8000` | none | | (`:114-118`) |
| `chat`, `salience`, `affect`, `avatar` | build `SERVICE=<name>` | none | none | redis only | `:121-160` |
| `memory` | build | none | none | `postgres` healthy, `ollama` started | `:136-142` |
| `cortex` | build | none | none | `ollama` started | `:144-149` |
| `voice` | build | none (container port 8700 internal) | none | `tts` started | `:151-156` |
| `dashboard` | build | `${DASHBOARD_PORT:-3000}:3000`, all interfaces | none | | `:162-165` |
| `eyes` | build | none | `eyes` | redis only | `:167-170` |
| `ears` | build | none | `ears` | `stt` started | `:172-178` |

Shared settings come from the `x-ts-service` anchor (`:9-46`): `restart: unless-stopped`, `env_file: .env`, in-network service URLs (`REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `DASHBOARD_URL`) `CONFIG_DIR=/app/config`, `CONTROL_ENABLED=0` and the isolation pass-throughs under `environment:` (which wins over `.env`, so the URLs, `CONFIG_DIR` and `CONTROL_ENABLED` cannot be changed from `.env`), the `./config:/app/config` volume, `host.docker.internal:host-gateway` (reach OBS or VTube Studio on the host), `depends_on: redis: service_healthy`, and the container healthcheck. `DASHBOARD_URL=http://dashboard:3000` exists so `eyes` and `ears` can fetch injected test uploads from the dashboard; the loopback default would fail inside containers (`docker-compose.yml:19`; `openspec/changes/archive/2026-11-01-add-test-injection/design.md:15,70`). A service that declares its own `depends_on` (memory, cortex, voice, ears) replaces the anchor's map and therefore re-lists `redis`. Every one of the 10 `services/*` directories has a Compose service and a `tsconfig.json` reference; the 7 `packages/*` are libraries with none.

Because `env_file: .env` applies to every application service, any variable an operator puts in `.env` reaches every container unless the `environment:` block names it. That includes `CONTROL_ENABLED`: the containerised dashboard stays monitor-only (`openspec/changes/archive/2026-11-01-add-service-control/design.md:28`, README.md:325-326), and README.md:294-297 enables control by exporting variables in the host shell for a host-run dashboard. Compose therefore pins `CONTROL_ENABLED: "0"` in the shared `x-ts-service` `environment:` (`:22`, DEPLOY-COMPOSE-016), so every application container, the dashboard included, ignores a `CONTROL_ENABLED=1` in `.env`; without the pin the container would bind `127.0.0.1` inside itself (`packages/control/src/config.ts:32-35`) and the published port would stop answering. The anchor, not the `dashboard` service alone, carries the pin because the dashboard is the only reader of the variable, so pinning it everywhere costs nothing and cannot be forgotten for a service added later.

The reverse direction matters for the control plane's isolated starts: `ComposeRuntime` sets the isolation preset (`CHAT_SOURCE`, `MEMORY_STORE`, `MEMORY_EMBEDDER`, `LLM_PROVIDER`, `VOICE_ENGINE`, `AVATAR_DRIVER`, `VISION_ENABLED`, `EARS_SOURCE`) on the `docker compose` process (`packages/control/src/runtime.ts:61`), and those reach a container only if the `environment:` block names them. The `x-ts-service` block passes each through as `${VAR:-}` (`:24-31`), so an unset variable still falls to the `${VAR:-default}` in `config.yaml` (DEPLOY-COMPOSE-017, control-plane CTRL-RUNTIME-009). Compose interpolates `${VAR:-}` from the process environment first and `.env` second, so a value an operator keeps in `.env` (for example `AVATAR_DRIVER=null`) still reaches the container.

**Container healthcheck** (`:39-46`): `node packages/control/dist/healthcheck.js $$SERVICE`, interval 10 s, timeout 5 s, 3 retries, 30 s start period. `SERVICE` is baked into the image (`Dockerfile:20`). The script is in `@cohost/control` (`packages/control/src/healthcheck.ts:10-31`): it reads the last 200 entries of `cohost:health`, takes the newest heartbeat for the named service, and is healthy iff it is not `stopping` and younger than `STALE_FACTOR` (3) times that heartbeat's own `intervalMs`; it self-terminates with exit 1 after 4 s. The healthcheck only reports; no `depends_on` waits for an application service to be healthy, so health gates nothing at startup. Heartbeat semantics belong to control-plane.

**`models`**: `until curl -sf ollama:11434/api/tags; do sleep 2; done`, then for `LLM_MODEL`, `VISION_MODEL`, `EMBED_MODEL` POSTs `/api/pull` with `curl -fsS` into a temp file and prints its last 200 bytes (`:96-107`). A pull fails when curl reports an HTTP error or the response holds an `"error"` line (Ollama reports a pull error that begins after the response started as a 200 with an `{"error":...}` line); the loop still tries the remaining models, then the container exits non-zero (DEPLOY-COMPOSE-011). It has no restart policy, so the failure stays visible in `docker compose ps`. `memory` and `cortex` stay on `service_started` for `ollama`: both wait for the model backend themselves. It is not profile-gated: it runs on every plain `docker compose up -d`, as do `tts` and `stt`; the only way to start without them is to name services explicitly, as the comment at `:5` shows. It does not pull `STT_MODEL`.

**GPU overlay**: the `x-gpu` anchor adds an NVIDIA `deploy.resources.reservations.devices` entry (`count: all`) to `ollama`, `tts`, `stt` and swaps the `tts`/`stt` images to the GPU variants (`docker-compose.gpu.yml:6-23`). `KOKORO_IMAGE` / `SPEACHES_IMAGE` override the image in both files, so setting one for a GPU host also changes the base (CPU) file's default image.

**Voice reachability**: `voice` listens on `VOICE_PORT` (default 8700, `services/voice/src/index.ts:21`) and advertises `urls.voice()` = `http://voice:8700` inside Compose; nothing publishes it. The dashboard proxies `/audio/*` to `VOICE_URL` (the `/audio/` route in `services/dashboard/src/routes.ts`), which is the only supported path for host-side players (browsers, OBS, any tool outside the Compose network); in-network sinks such as `ears` fetch `http://voice:8700` directly. Host-run services that need voice's HTTP server directly (for example `pnpm dev` services next to a containerised `voice`) cannot reach it; that topology is not supported.

## Image build

`Dockerfile`, three stages on `node:22-slim`:

1. `base`: `corepack enable && corepack prepare pnpm@10.0.0 --activate`, `WORKDIR /app` (`:6-8`).
2. `build`: `CI=true`, copy `pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json`, then `packages/` and `services/`, `pnpm install --frozen-lockfile`, `pnpm exec tsc -b` (`:10-16`). The root `tsconfig.json` references all 17 projects, so every service directory must exist in the build context and every image compiles the whole workspace.
3. `runtime`: `ARG SERVICE`, `ENV NODE_ENV=production SERVICE=${SERVICE}`, `COPY --from=build /app /app` (the full tree including sources and dev dependencies), `CMD ["sh","-c","exec node services/${SERVICE}/dist/index.js"]` (`:18-23`).

The Dockerfile does not prune (`:3-5`): under pnpm 10, `pnpm prune --prod` empties `services/*/node_modules` and drops the `@cohost/*` workspace links (issue #6), and `pnpm deploy --prod` on pnpm 10.0.0 needs `inject-workspace-packages=true`, which fails `--frozen-lockfile` unless enabled workspace-wide (commit 18ea80a). The consequence is a larger image that ships dev dependencies. No `USER` is set (containers run as root, so files the config loader seeds into the bind mount are root-owned on Linux hosts) and the Dockerfile declares no `HEALTHCHECK` (Compose supplies it).

`.dockerignore`: `node_modules`, `**/node_modules`, `**/dist`, `.git`, `data`, `.env`, `**/*.tsbuildinfo`, `**/*.log`, `config/.vts-token`, `config/config.yaml`, `config/personality.md`, `config/expressions.yaml` (`:1-12`). Excluding `.tsbuildinfo` stops stale host incremental state from making `tsc -b` in the image skip emitting while `**/dist` is ignored (issue #7, commit 7e89e4e). It does not exclude `worktrees/`, `docs/` or `graphify-out/`, which only inflate the context. `config/` can hold the VTube Studio credential (`<config>/.vts-token`, `services/avatar/src/drivers/vtube-studio.ts:104`) and the operator's own `config.yaml`, `personality.md` and `expressions.yaml`; `.dockerignore` excludes those four files so neither the credential nor operator files reach the daemon (DEPLOY-IMG-005). The `config/*.example.*` files stay in the context; the Dockerfile copies only `packages/` and `services/`, and config arrives by bind mount.

## Installer: `scripts/install.sh`

`set -euo pipefail`, runs from the repo root, flag `--no-pull`. Steps in order:

1. Detect WSL (`grep -qi microsoft /proc/version`), source `/etc/os-release`, warn if the distro is not Ubuntu or Debian (`:16-24`).
2. Detect NVIDIA via `nvidia-smi` (`:26-34`).
3. If `docker` is missing, install docker-ce from the Docker apt repo, `usermod -aG docker`, start the daemon (`service` on WSL, `systemctl` otherwise), then stop and exit non-zero with a "log out and back in, then re-run" message, because the current shell lacks the new group and the docker commands below would fail part-way (DEPLOY-INST-010, `:36-55`); on every run, die if `docker compose version` fails (`:57`).
4. If a GPU exists and `docker info` shows no NVIDIA runtime, install `nvidia-container-toolkit` if needed, `nvidia-ctk runtime configure`, restart Docker (`:59-74`).
5. If Node is missing or its numeric major (from `node -p "process.versions.node.split('.')[0]"`) is below 22, install NodeSource `setup_22.x` (piped to `sudo -E bash`) (DEPLOY-INST-009); if `pnpm` is missing, `corepack enable` and prepare `pnpm@10.0.0` (`:76-83`).
6. Seed `.env` and the three `config/` files from their examples if absent (`:85-95`); rewrite the `COMPOSE_FILE=` line in `.env` on every run from the GPU detected on that run (GPU: `docker-compose.yml:docker-compose.gpu.yml`), replacing a hand-set value by design (`:96-101`); `mkdir -p data` (`:102`, nothing references `data/` afterwards).
7. `pnpm install --frozen-lockfile`, aborting with its error on a lockfile mismatch as CI and the `Dockerfile` do, never falling back to a plain `pnpm install` (DEPLOY-INST-012, `:108`), then `pnpm typecheck` (`:104-110`).
8. Unless `--no-pull`: `docker compose pull --ignore-buildable`, `up -d ollama models`, follow `models` logs, `docker compose wait models` (`:112-122`).
9. Smoke test: `up -d redis postgres`, then `probe <name> 60 <fn>` polls `redis-cli ping`, `pg_isready` and, when pulling, Ollama `/api/tags` once a second until each passes (printing `  <name> ok`) or 60 s elapse, when it prints one failure line naming the probe and exits non-zero (DEPLOY-INST-007, `:124-145`). The probes compare command substitutions rather than piping into `grep -q`, so `pipefail` cannot turn an early-closing reader into a false failure.
10. Next steps (`:146-166`): the dashboard URL uses `DASHBOARD_PORT` from the calling shell, else the last `DASHBOARD_PORT=` line of `.env` parsed with `sed` (inline comment, quotes and CR stripped, non-numeric rejected, default 3000), never sourcing `.env` (DEPLOY-INST-008); the Docker-free dev loop lists `redis postgres ollama tts stt` (DEPLOY-INST-011). `corepack prepare pnpm@10.0.0` (`:83`) duplicates `package.json:8` and `Dockerfile:7`.

## Build, test and CI

**Workspace and TypeScript**: `pnpm-workspace.yaml` globs `packages/*` and `services/*`. `tsconfig.json` is solution-style (`files: []`, 17 references: config, bus, llm, modules, working-memory, control, testing plus the 10 services). `tsconfig.base.json` sets ES2022, NodeNext, `strict`, `composite`, declarations and `noUncheckedIndexedAccess`, with `lib: ["ES2022"]` (no DOM). Every per-package tsconfig includes only `src`, so test files are executed through `tsx` but not type-checked by `tsc -b`.

**Root scripts** (`package.json:12-25`): `build`, `typecheck` (`tsc -b --noEmit`), `lint` (identical to `typecheck`; there is no linter), `dev` (`pnpm -r --parallel --filter './services/*' dev`; each service runs `tsx watch src/index.ts`), `reflect`, `clean`, `test` (`tsc -b && node --import tsx --test "packages/*/test/*.test.ts" "services/*/test/*.test.ts"`), `test:only`, and the `docs:*` scripts. `pnpm.onlyBuiltDependencies` allows install scripts for `esbuild`, `@snazzah/davey`, `libsodium-wrappers`, `opusscript` (`package.json:32-39`). `packageManager` pins `pnpm@10.0.0`; `engines.node` is `>=22`.

**Workflows** (`.github/workflows/`):

| Workflow | Triggers | What it does | Notes |
| --- | --- | --- | --- |
| `test.yml` | PR, push `main`; cancels older runs of the same ref | Redis 7 service, `REDIS_URL=redis://127.0.0.1:6379`, `pnpm install --frozen-lockfile`, `pnpm test`; 10 min | Redis presence makes the bus round-trip tests run instead of skipping; no Postgres or Ollama; actions pinned by major tag (`checkout@v4`, `pnpm/action-setup@v4`, `setup-node@v4`) |
| `compose-smoke.yml` | PR, push `main`; cancels older | `scripts/compose-smoke.sh`; 15 min | `checkout@v4` |
| `dco.yml` | PR; cancels older | `scripts/dco-check.sh <base> <head>` over the PR's commits (full-history checkout of the PR head): every non-merge commit must carry `Signed-off-by: <author name> <author email>`; 5 min | plain bash and git, no third-party action; commits already on the base are outside the range (DEPLOY-CI-005); `checkout@v7.0.1` |
| `docs-build.yml` | PR; cancels older | install, `pnpm docs:build`; no upload, no deploy; 10 min | same exact pins as `pages.yml` (DEPLOY-CI-004) |
| `pages.yml` | push `main`, manual dispatch | build job: install, `pnpm docs:build`, upload `docs/.vitepress/dist`; deploy job: `deploy-pages` to `github-pages` | exact-version pins (`checkout@v7.0.1`, `pnpm/action-setup@v6.1.0`, `setup-node@v7.1.0`, `configure-pages@v6.0.0`, `upload-pages-artifact@v5.0.0`, `deploy-pages@v5.0.1`), the latest release tags when the workflow was written (commit 686cc8f) |

`scripts/compose-smoke.sh`: copies `.env.example` to `.env` if missing, `docker compose up -d --build redis <services>` (default `salience affect avatar dashboard`, chosen because they need no models or credentials, `:2-5`), polls until each service reaches Compose health status `healthy` with `restarts=0`, within one `SMOKE_WAIT` budget (60 s) for all services, failing at once on a restart, an exit or an `unhealthy` verdict (DEPLOY-CI-002); the `x-ts-service` healthcheck gives each of the four default services one; on failure prints `docker compose logs --tail 20`; a `trap` always runs `docker compose down -v`, which also deletes the volumes. It covers four of ten services. Its purpose is the regression guard for issue #6 (`:2-3`, commit 18ea80a).

There is no lint, image-publish or release workflow.

## Docs site

VitePress 1.6.4 (exact pin, `package.json:30`). `docs/.vitepress/config.ts`: `base: '/cohost/'`, `cleanUrls`, `lastUpdated: false`, `ignoreDeadLinks: [/^https?:\/\/localhost/]`, local search, a hand-written nav and sidebar (Guide, Testing, Specs, Plans, Examples), AGPL footer. `srcExclude` (`config.ts:12`) is `['arrows/**', 'intent/**', 'high-level-design.md']`: these keep the linked-intent documents out of the published site and the search index, and keep their relative links to non-markdown files from failing the build, since only localhost links are ignored (commit 700192f). Every entry matches a file under `docs/` (DEPLOY-DOCS-006).

`scripts/docs-prepare.mjs`: maps `README.md` to `docs/guide/index.md`, `examples/README.md` to `docs/examples/index.md`, and each `examples/<d>/README.md` to `docs/examples/<d>.md`; removes `docs/guide` and `docs/examples` first; prepends a "Generated ... Edit the source" comment; rewrites inline `](relative)` links (regex at `:35`) to site paths for generated and native pages (`docs/TESTING.md`, `docs/SPEC-DRIVEN.md`) and otherwise to `github.com/CoderCoco/cohost/{blob|tree}/main/...`. It throws if `examples/` is missing (`:18`) and does not rewrite reference-style or HTML links. `docs/guide/`, `docs/examples/`, `docs/.vitepress/cache` and `docs/.vitepress/dist` are git-ignored (`.gitignore:14-19`). Hand-written pages: `docs/index.md` (home hero), `docs/TESTING.md`, `docs/SPEC-DRIVEN.md`, `docs/plans/control-plane.md` (header "Status: proposal (planning only, no implementation)", though the plan is implemented by PRs #20-#23).

## Licensing and contribution

`LICENSE` is the 661-line AGPL v3 text, added as the canonical gnu.org text (commit 686cc8f); the root and all 17 workspace `package.json` files declare `AGPL-3.0-only`. `CONTRIBUTING.md` states contributions are under the same license and requires a DCO 1.1 sign-off on every commit (`git commit -s`; amend with `-s` or `git rebase --signoff`), with the DCO text embedded. The README License section repeats this (README.md:361-367). The `dco` workflow checks sign-offs on new pull requests against the commit author (DEPLOY-CI-005); commits already on `main` are not re-checked, and a trailer that names someone other than the author (as 686cc8f's names `Pane <runpane@users.noreply.github.com>`) fails.

## Developer scripts (`scripts/dev/`)

`bus-pub.ts` validates a payload with the bus zod schemas then publishes (`exit 1` on rejection, `2` on unknown type, bad JSON or no arguments); `bus-tail.ts` does a non-group `XREAD` tail with `--replay N`, `--json` and type filters; `stub-llm.ts` fakes Ollama `/api/tags` and `/api/chat` (not `/api/embed`) on `STUB_LLM_PORT` (11434); `stub-tts.ts` fakes `/v1/audio/speech` and returns a pulsing 24 kHz WAV on `STUB_TTS_PORT` (8880). All import the bus from `../../packages/bus/src` (source, not `dist`). Since `llm.provider: mock` and `voice.engine: stub` exist (config segment), these stubs are largely superseded for service-level runs, but `docs/TESTING.md` still presents them as the primary substitutes.

## README and documentation versus code

| Claim | Where | Reality |
| --- | --- | --- |
| VTube Studio token saved to `config/.vts-token` | README.md:214 | Correct: avatar passes `stateDir: configDir()` (`services/avatar/src/index.ts:30`, `drivers/vtube-studio.ts:104`); `.gitignore` ignores the file (`.gitignore:11-12`, DEPLOY-REPO-004) |
| `docker compose up -d` is the "core" stack | README.md:49 | Starts everything without a profile, including `models`, `tts`, `stt`; the minimal command is in a compose comment (`:5`) |
| `config.yaml`, `personality.md`, `expressions.yaml` are untracked | README.md:135-140 | True per `.gitignore:8-10`; text speaks to users upgrading from earlier tracked copies |
| voice HTTP on 8700 | `docker-compose.yml:18`, `services/voice/src/index.ts:21` | Container-internal only; browsers go through the dashboard's `/audio/` proxy |
| `docs/plans/control-plane.md` is a proposal | its header | Implemented by PRs #20-#23 |

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Image strategy | One Dockerfile, `SERVICE` build arg, whole workspace compiled in each image | per-service Dockerfiles; a shared base image plus per-service layers | `Dockerfile:1-2`: "One Dockerfile for every TypeScript service … The whole workspace is built once (layer-cached across services) and shipped as-is." Per-service Dockerfiles would repeat the same install and build steps for each service and drift apart; a shared base image adds a second image to build, tag and keep in step. One file with a build arg keeps a single build recipe and lets Docker reuse the install and compile layers across every service image. |
| Dev dependencies in runtime | Ship the entire build stage, no prune | `pnpm prune --prod`; `pnpm deploy --prod` | `Dockerfile:3-5`; commit 18ea80a: prune drops the workspace links (#6); `deploy --prod` on pnpm 10.0.0 needs `inject-workspace-packages`, which breaks `--frozen-lockfile` unless enabled workspace-wide; "trade-off is a larger image (dev deps kept)". |
| Config delivery | Bind-mount `./config` at `/app/config` | bake config into the image; named volume | `Dockerfile:22` ("config is bind-mounted at runtime") and `docker-compose.yml:20,32-33` record the choice. The files are the operator's to edit and are written at runtime: the operator edits `config.yaml` and `personality.md` on the host, the dashboard personality editor saves `personality.md` (`PUT /personality`), and avatar writes the VTS token there. A bind mount makes each edit visible in place without a rebuild; baking config in would need a rebuild per edit and put user files in the image, and a named volume hides the files from the host editor. |
| Port exposure | Infra on `127.0.0.1`, dashboard on all interfaces, voice unpublished | publish everything; reverse proxy | Infra: `docker-compose.yml:55` "for `pnpm dev` outside docker". Dashboard: README.md:222-232 (OBS Browser Source at `http://<ai-pc>:3000/?sink=1`, two-PC setup). Voice unpublished: owner decision 2026-11-01, host-side players reach voice's audio only through the dashboard proxy, and the LAN is the trust boundary. |
| Optional services | Compose `profiles` for eyes and ears | separate compose files; always on | `docker-compose.yml:6-7,170,175`; README.md:58-63 ("Add the optional pieces when you're ready"). |
| GPU support | Separate overlay file selected via `COMPOSE_FILE` in `.env` | profile; per-service image variables only | `docker-compose.yml:1-2` ("CPU-only by default; GPU is layered on via docker-compose.gpu.yml"), `docker-compose.gpu.yml:1-4`; `install.sh:96-101` writes the variable. |
| Health signalling | Heartbeat-freshness healthcheck through the bus, not HTTP probes | HTTP `/health` per service | `openspec/changes/archive/2026-11-01-add-service-health/design.md:36-37` (D5): uniform across the eight services with no HTTP port; per-service HTTP ports rejected as eight new surfaces. |
| Containerised dashboard | Monitor-only, enforced by `CONTROL_ENABLED: "0"` in the shared `x-ts-service` `environment:` (DEPLOY-COMPOSE-016); service control runs from a host-run dashboard | mount `/var/run/docker.sock` into the container; leave `.env` in charge; pin it in the `dashboard` service only | `openspec/changes/archive/2026-11-01-add-service-control/design.md:28`; README.md:325-332. Owner decision 2026-11-01 to pin it: with `CONTROL_ENABLED=1` from `.env` the container binds loopback inside itself and the published port stops answering. The pin sits in the anchor (owner decision B17) rather than on the dashboard service: only the dashboard reads the variable, so the anchor is equivalent today and also covers a service added later. |
| Isolation env in Compose | Pass the isolation preset variables through as `${VAR:-}` in `x-ts-service` (DEPLOY-COMPOSE-017) | name each in every service; leave isolated starts host-only | Owner decision 2026-11-01: the control plane's compose runtime sets them on the CLI process, which reaches a container only through the `environment:` block; `:-` keeps the YAML default when unset. |
| Smoke test scope | Four credential-free services, required to reach `healthy` with no restarts | all services; container state and restart count only | `scripts/compose-smoke.sh:2-5` ("Only services that need no models/credentials"); commit 18ea80a (regression guard for #6). Owner decision 2026-11-01 to require `healthy`: every application service has a heartbeat healthcheck, and a `running` but `unhealthy` container is a failure. The script polls against one `SMOKE_WAIT` budget (60 s) instead of sleeping a fixed time, because the first healthcheck runs 10 s after start and a fixed 15 s sleep leaves no margin; a restart, an exit or an `unhealthy` verdict fails at once. |
| Docs site source | Generate guide and examples from READMEs at build time | maintain duplicate pages in `docs/` | `scripts/docs-prepare.mjs:1-4` ("so the originals stay the source of truth"); commit 686cc8f ("README stays the source of truth"). |
| Docs hosting | GitHub Pages via Actions on push to `main`; a build-only run on every pull request | Netlify/Vercel; build only on `main` | Commit 686cc8f adds `pages.yml` on push to `main` and `workflow_dispatch`. Owner decision 2026-11-01 to build on PRs: with `ignoreDeadLinks` limited to localhost, a dead link would otherwise first fail on `main`. |
| Licence and sign-off | AGPL-3.0-only plus DCO, the DCO enforced in CI for new pull requests with the sign-off matching the author, by a plain git script (`scripts/dco-check.sh`) | CLA; MIT/Apache; DCO by convention only; a third-party DCO app or action | `CONTRIBUTING.md:3-16`; commit 686cc8f. Enforcement is an owner decision 2026-11-01 (a mandatory rule nothing checks is not mandatory). The reasons for AGPL over a permissive licence and DCO over a CLA are not recorded `[inferred]`. |
| Installer scope | Bash script for Ubuntu/Debian/WSL2 only | cross-platform setup; Makefile | `scripts/install.sh:2` ("Ubuntu/Debian (native) and WSL2"), README.md:53-56. Owner decision 2026-11-01: the installer serves the owner's own stream setup; other streamers are not a target, though installer defects are still bugs. |
| Installer strictness | Abort on a lockfile mismatch, on any failed smoke probe (polling, not a fixed sleep), and after a fresh Docker install that needs a re-login | fall back and warn; continue and print "Done" | Owner decision 2026-11-01: a half-installed stack that reports success is worse than a clear stop; the lockfile rule matches CI and the `Dockerfile` (DEPLOY-INST-007, -010, -012). |
| `COMPOSE_FILE` in `.env` | Rewritten from the detected GPU on every installer run | write once; respect a hand-set value | Owner decision 2026-11-01: re-detecting each run keeps the overlay right after a GPU or driver change (DEPLOY-INST-006). |
| Infra restart policy | `redis` and `postgres` restart unless stopped, like every other long-running service | no policy | Owner decision 2026-11-01: every application container depends on `redis` (DEPLOY-COMPOSE-015). |
| `models` failure | Exit non-zero after trying every model when a pull fails (HTTP error or an `"error"` line in the response); `memory`/`cortex` stay on `service_started` | exit 0 and leave the failure in the log; stop at the first failed pull; `curl -f` alone (misses errors Ollama reports in a 200 stream) | Owner decision 2026-11-01: a failed pull must be visible in `docker compose ps`; both consumers already wait for the model backend themselves (DEPLOY-COMPOSE-011). |
| Bedrock credentials in Compose | `AWS_*` keys in `.env`; no `~/.aws` mount | mount `~/.aws` into application services | Owner decision 2026-11-01: a home-directory mount would expose credentials to all ten containers (DEPLOY-README-002). |
| Secrets in the build context | `.dockerignore` excludes `.env`, `config/.vts-token` and the three user config files | rely on the Dockerfile copying only `packages/` and `services/` | Owner decision 2026-11-01: the context is sent to the daemon whatever the Dockerfile copies (DEPLOY-IMG-005). |
| Test runner | Node's built-in `node:test` through `tsx`, tests excluded from `tsc -b` | vitest/jest | `package.json:19`, README.md:342. The runner ships with Node, so testing adds no framework dependency, and `tsx` runs the TypeScript tests without a compile step; keeping tests out of `tsc -b` keeps the build output to service code. vitest or jest would add a dependency and its configuration for features the tests do not use. |

## Open Questions & Future Decisions

1. **Unpinned images.** `ollama/ollama:latest`, `curlimages/curl:latest`, Kokoro and speaches `latest-*` tags (`docker-compose.yml:78,90,110,115`) and Postgres `pg16` major pin only; CI and the base image pin `redis:7-alpine`. Actions are pinned by major tag in `test.yml` and `compose-smoke.yml` and by exact version in `pages.yml`, `docs-build.yml` and `dco.yml`.
2. **`data/` directory.** The installer creates it (`install.sh:102`) and `.dockerignore:5` and `.gitignore:5` exclude it, but nothing else references it.
3. **Image size and duplication.** Every image carries all services' built code plus dev dependencies and sources (`Dockerfile:21`). A per-service filtered install becomes possible once the pnpm version or the `inject-workspace-packages` setting changes (commit 18ea80a).
4. **Pnpm version in three places** (`package.json:8`, `Dockerfile:7`, `install.sh:83`); CI reads `packageManager`. Updating needs three edits.
5. **Stale documentation.** `docs/plans/control-plane.md` still says "proposal" (see the table above).
6. **Linked-intent development is unenforced.** The LID workflow in `CLAUDE.md` has no CI check.
7. **Unverifiable here.** That `LICENSE` is byte-for-byte the canonical AGPL v3 text (DEPLOY-LIC-001) rests on commit 686cc8f's description; it was not compared against gnu.org. The Compose behaviours in DEPLOY-COMPOSE-003/-006/-010/-015/-016/-017, the installer's Docker-install stop (DEPLOY-INST-010) and the smoke script's health polling (DEPLOY-CI-002) were read from the files, not executed (no Docker in the environment that wrote them); the Compose file was parsed as YAML, the `models` pull loop was run against a stub `curl`, the installer's `probe`, port parsing and Node-major check and `scripts/dco-check.sh` were run in isolation.

## References

**Files in this segment**
- Compose and image: `docker-compose.yml`, `docker-compose.gpu.yml`, `Dockerfile`, `.dockerignore`
- Scripts: `scripts/install.sh`, `scripts/compose-smoke.sh`, `scripts/dco-check.sh`, `scripts/docs-prepare.mjs`, `scripts/dev/bus-pub.ts`, `scripts/dev/bus-tail.ts`, `scripts/dev/stub-llm.ts`, `scripts/dev/stub-tts.ts`
- CI: `.github/workflows/test.yml`, `.github/workflows/compose-smoke.yml`, `.github/workflows/dco.yml`, `.github/workflows/docs-build.yml`, `.github/workflows/pages.yml`
- Workspace: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `.gitignore`
- Governance and docs: `LICENSE`, `CONTRIBUTING.md`, `docs/.vitepress/config.ts`, `docs/index.md`, `README.md` (Quick start 43-71, Upgrading 135-140, Two-PC 227-232, service control 287-332, Developing 334-352), `docs/TESTING.md`, `.env.example`

**Other segments (direction)**
- Deployment depends on every service segment (builds and runs them) and on `config` (`.env.example`, `config/*.example.*`, `CONFIG_DIR`, seeding), `control-plane` (the healthcheck binary `packages/control/dist/healthcheck.js` and heartbeats), `event-bus` (`scripts/dev` imports `packages/bus/src`; Redis is the only service every container waits for), `memory`/`cortex`/`voice`/`ears`/`eyes` (dependency ordering), and `dashboard` (the only published port, `/audio/` proxy, `DASHBOARD_URL` for uploads).
- Nothing depends on deployment at runtime.

**External services and tools**: Docker Engine and Compose v2, NVIDIA container toolkit, Redis 7, pgvector (Postgres 16), Ollama, Kokoro-FastAPI, speaches, GitHub Actions and Pages, VitePress 1.6.4, pnpm 10.0.0, corepack, NodeSource.

**Design records**: `openspec/changes/archive/2026-11-01-add-service-health/design.md` (D5, healthcheck), `openspec/changes/archive/2026-11-01-add-service-control/design.md` (host-run vs docker socket), `openspec/changes/archive/2026-11-01-add-test-injection/design.md` (`DASHBOARD_URL`). Process docs: `CLAUDE.md`, `docs/SPEC-DRIVEN.md`.
