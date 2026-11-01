# deployment specs

Prefix `DEPLOY`. Observed at git 686cc8f. No OpenSpec capability covers this segment (`openspec/specs/` has no deployment, CI or docs-site capability), so no spec below carries an OpenSpec reference. `[x]` = observed in the files; `[ ]` = intended by the files' own comments or the README but broken, missing or inconsistent.

## Compose topology

- [x] **DEPLOY-COMPOSE-001**: The base `docker-compose.yml` shall define the infrastructure services `redis`, `postgres`, `ollama`, `tts`, `stt` and the one-shot `models`, and one application service per directory under `services/` (`chat`, `salience`, `affect`, `memory`, `cortex`, `voice`, `avatar`, `dashboard`, `eyes`, `ears`).
- [x] **DEPLOY-COMPOSE-002**: Each application service shall be built from the single root `Dockerfile` with the build argument `SERVICE` set to its directory name, and shall inherit the shared `x-ts-service` settings: `restart: unless-stopped`, `env_file: .env`, the in-network URLs `REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `DASHBOARD_URL` and `CONFIG_DIR=/app/config`, the `./config:/app/config` bind mount, the `host.docker.internal:host-gateway` extra host, and a dependency on `redis` being healthy.
- [x] **DEPLOY-COMPOSE-003**: While a variable is set in a service's `environment` block (`REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `DASHBOARD_URL`, `CONFIG_DIR`), the Compose stack shall use that value over the same name in `.env`, so those addresses cannot be changed through `.env` for containerised services.
- [x] **DEPLOY-COMPOSE-004**: The `eyes` service shall belong only to the `eyes` profile and the `ears` service only to the `ears` profile, so a plain `docker compose up -d` does not start them.
- [x] **DEPLOY-COMPOSE-005**: Where a service has dependencies beyond redis, Compose shall order startup as follows: `memory` waits for `redis` and `postgres` healthy and `ollama` started; `cortex` for `redis` healthy and `ollama` started; `voice` for `redis` healthy and `tts` started; `ears` for `redis` healthy and `stt` started.
- [x] **DEPLOY-COMPOSE-006**: The infrastructure ports `redis` 6379, `postgres` 5432, `ollama` 11434, `tts` 8880 and `stt` 8000 shall be published on `127.0.0.1` only, and only `dashboard` shall be published on all interfaces, at host port `DASHBOARD_PORT` (default 3000) mapped to container port 3000.
- [x] **DEPLOY-COMPOSE-007**: The `voice` service shall publish no host port; its HTTP server (`VOICE_PORT`, default 8700) shall be reachable only on the Compose network, and the dashboard shall serve audio to browsers by proxying `/audio/` requests to `VOICE_URL`.
- [x] **DEPLOY-COMPOSE-008**: When the `models` service starts, it shall wait for `ollama` to answer `/api/tags` and then request `/api/pull` for `LLM_MODEL`, `VISION_MODEL` and `EMBED_MODEL` from `.env` and exit; it shall not pull `STT_MODEL`.
- [x] **DEPLOY-COMPOSE-009**: The stack shall persist data in the named volumes `redis-data`, `pg-data`, `ollama-data` and `stt-cache`; `redis` and `postgres` shall expose healthchecks (`redis-cli ping`, `pg_isready -U cohost`) used by `depends_on`.
- [x] **DEPLOY-COMPOSE-010**: Where `docker-compose.gpu.yml` is layered over the base file (via `-f` or `COMPOSE_FILE`), the overlay shall add an NVIDIA device reservation (`count: all`) to `ollama`, `tts` and `stt` and switch `tts` and `stt` to the GPU images `kokoro-fastapi-gpu` and `speaches:latest-cuda` unless `KOKORO_IMAGE` / `SPEACHES_IMAGE` are set.
- [ ] **DEPLOY-COMPOSE-011**: If a model pull requested by the `models` service fails, then the `models` container shall report failure (non-zero exit) instead of exiting successfully. (Gap: pulls are `curl -s ... | tail -c 200` and the loop's exit status is that of `echo`, `docker-compose.yml:83-85`; the failure is only visible in the log text.)

## Container health

- [x] **DEPLOY-HC-001**: Every application service container shall run the healthcheck `node packages/control/dist/healthcheck.js $SERVICE` every 10 s with a 5 s timeout, 3 retries and a 30 s start period, with `SERVICE` taken from the image environment (`Dockerfile:20`).
- [x] **DEPLOY-HC-002**: When the healthcheck runs, it shall exit 0 only if the newest `service.heartbeat` for that service on `cohost:health` is younger than 3 times its declared interval and its state is not `stopping`, and shall exit 1 when no heartbeat is found, the heartbeat is stale, Redis cannot be read, or 4 s elapse. (Semantics owned by control-plane; this spec records the compose wiring.) <!-- test: packages/control/test/healthcheck.test.ts:12 --> <!-- test: packages/control/test/healthcheck.test.ts:36 -->

## Image build

- [x] **DEPLOY-IMG-001**: The `Dockerfile` shall build in three stages on `node:22-slim` (`base` with corepack-activated `pnpm@10.0.0`, `build`, `runtime`), where `build` copies the workspace manifests, `packages/` and `services/`, runs `pnpm install --frozen-lockfile` and `pnpm exec tsc -b`, and `runtime` copies the entire `/app` from `build`.
- [x] **DEPLOY-IMG-002**: The image shall set `NODE_ENV=production` and `SERVICE` from the build argument and start with `exec node services/${SERVICE}/dist/index.js`; it shall contain every service's built code regardless of `SERVICE`. <!-- test: scripts/compose-smoke.sh:17 -->
- [x] **DEPLOY-IMG-003**: The `Dockerfile` shall not run `pnpm prune --prod` (it removes the `@cohost/*` workspace links under pnpm 10 and crash-loops every service, issue #6); the smoke script shall guard this regression. <!-- test: scripts/compose-smoke.sh:2 -->
- [x] **DEPLOY-IMG-004**: The `.dockerignore` shall exclude `node_modules`, `**/dist`, `.git`, `data`, `.env`, `**/*.tsbuildinfo` and `**/*.log` from the build context, so stale incremental-build state cannot stop `tsc -b` from emitting output in the image and secrets in `.env` are not sent to the daemon.

## Installer

- [x] **DEPLOY-INST-001**: When `scripts/install.sh` runs, it shall detect WSL2 from `/proc/version`, read `/etc/os-release`, warn but continue on a distribution other than Ubuntu or Debian, and report whether an NVIDIA GPU is visible through `nvidia-smi`.
- [x] **DEPLOY-INST-002**: Where `docker` is not installed, the installer shall install `docker-ce`, the CLI, containerd, buildx and the compose plugin from Docker's apt repository, add the user to the `docker` group and start the daemon (`service docker start` on WSL, `systemctl enable --now docker` otherwise), then require `docker compose version` to succeed.
- [x] **DEPLOY-INST-003**: Where an NVIDIA GPU is detected and `docker info` does not list an NVIDIA runtime, the installer shall install `nvidia-container-toolkit` if absent, run `nvidia-ctk runtime configure --runtime=docker` and restart Docker.
- [x] **DEPLOY-INST-004**: Where Node is missing or older than 22, the installer shall install Node 22 from NodeSource; where `pnpm` is missing it shall enable corepack and prepare `pnpm@10.0.0`.
- [x] **DEPLOY-INST-005**: When `.env`, `config/config.yaml`, `config/personality.md` or `config/expressions.yaml` is missing, the installer shall copy it from `.env.example` or the matching `config/*.example.*` file, and shall never overwrite an existing one.
- [x] **DEPLOY-INST-006**: When the installer runs, it shall set `COMPOSE_FILE` in `.env` to `docker-compose.yml:docker-compose.gpu.yml` if an NVIDIA GPU was detected and `docker-compose.yml` otherwise, replacing any existing value on every run.
- [x] **DEPLOY-INST-007**: When the installer runs, it shall install workspace dependencies, typecheck, and unless `--no-pull` is given pull images (`--ignore-buildable`), start `ollama` and `models` and wait for the model pull, then start `redis` and `postgres` and check each (`redis-cli ping`, `pg_isready`, and Ollama `/api/tags` when pulling).
- [ ] **DEPLOY-INST-008**: When the installer finishes, it shall print the dashboard URL using the `DASHBOARD_PORT` from `.env`. (Gap: `.env` is never sourced by the script, so `${DASHBOARD_PORT:-3000}` always prints 3000, `scripts/install.sh:135`.)
- [ ] **DEPLOY-INST-009**: When the installer decides whether Node is recent enough, it shall compare the numeric major version correctly. (Gap: `node -v | cut -c2-3` is used as an integer at `scripts/install.sh:76`; a single-digit major yields a value like `9.` that breaks the test, and a three-digit major is truncated.)
- [ ] **DEPLOY-INST-010**: If `docker` was installed during the same run, then the installer shall continue to work without a re-login. (Gap: the user is only added to the `docker` group at `scripts/install.sh:52`, so later `docker info` / `docker compose pull` calls in the same shell run without the group and, under `set -e`, abort the script; `[inferred]` from reading, not executed.)
- [ ] **DEPLOY-INST-011**: When the installer prints the Docker-free dev loop, it shall list the same infrastructure containers the README lists (`redis postgres ollama tts stt`). (Gap: `scripts/install.sh:139` omits `stt`, README.md:337 includes it.)

## Continuous integration

- [x] **DEPLOY-CI-001**: When a pull request is opened or `main` is pushed, the `test` workflow shall start a `redis:7-alpine` service, set `REDIS_URL`, run `pnpm install --frozen-lockfile` and `pnpm test` on Node 22 with a 10 minute timeout, and cancel an older run of the same ref. <!-- test: .github/workflows/test.yml:12 -->
- [x] **DEPLOY-CI-002**: When a pull request is opened or `main` is pushed, the `compose-smoke` workflow shall run `scripts/compose-smoke.sh`, which builds and starts `redis` plus the named services (default `salience affect avatar dashboard`), waits `SMOKE_WAIT` seconds (default 15), fails unless each service container is `running` with `restarts=0`, prints the last 20 log lines of a failing service, and always runs `docker compose down -v` on exit. <!-- test: scripts/compose-smoke.sh:16 -->
- [x] **DEPLOY-CI-003**: When `main` is pushed or the workflow is dispatched manually, the `pages` workflow shall run `pnpm docs:build`, upload `docs/.vitepress/dist` and deploy it to the `github-pages` environment, serialising runs without cancelling an in-flight deploy.
- [ ] **DEPLOY-CI-004**: When a pull request changes documentation or `README.md`, CI shall build the docs site so a broken link or template error is caught before merge. (Gap: `pages.yml` runs only on push to `main` and manual dispatch, `.github/workflows/pages.yml:3-6`; with `ignoreDeadLinks` limited to localhost, a dead link first fails on `main`.)
- [ ] **DEPLOY-CI-005**: When a pull request is opened, CI shall reject commits that lack a DCO `Signed-off-by` line. (Gap: `CONTRIBUTING.md:6-16` makes sign-off mandatory, but no workflow or app enforces it; `.github/workflows/` holds only `test`, `compose-smoke` and `pages`.)

## Docs site

- [x] **DEPLOY-DOCS-001**: When `pnpm docs:build` (or `docs:dev`) runs, the system shall first run `scripts/docs-prepare.mjs` and then `vitepress build docs` (or `dev`), publishing under base path `/cohost/` with clean URLs and local search.
- [x] **DEPLOY-DOCS-002**: When `scripts/docs-prepare.mjs` runs, it shall delete `docs/guide` and `docs/examples`, then generate `docs/guide/index.md` from `README.md`, `docs/examples/index.md` from `examples/README.md` and `docs/examples/<name>.md` from each `examples/<name>/README.md`, each prefixed with a "Generated ... Edit the source" banner comment.
- [x] **DEPLOY-DOCS-003**: When docs-prepare copies a README, it shall rewrite each relative inline markdown link to the site page of a generated or native page (`docs/TESTING.md`, `docs/SPEC-DRIVEN.md`) when the target is one, and otherwise to `https://github.com/CoderCoco/cohost/blob/main/...` (file) or `.../tree/main/...` (directory), leaving absolute, root-relative and `#` links untouched.
- [x] **DEPLOY-DOCS-004**: The `.gitignore` shall exclude the generated `docs/guide/` and `docs/examples/` and VitePress's `docs/.vitepress/cache` and `docs/.vitepress/dist`.
- [x] **DEPLOY-DOCS-005**: The VitePress `srcExclude` shall exclude `arrows/**`, `intent/**` and `high-level-design.md` so the linked-intent documents are not published or search-indexed. (`docs/.vitepress/config.ts:12`; added with the LID mapping commit because VitePress builds every `.md` under `docs/` and fails on relative links to non-markdown targets.)

## Licensing and contribution

- [x] **DEPLOY-LIC-001**: The repository shall be licensed AGPL-3.0-only: `LICENSE` holds the unmodified AGPL v3 text, and the root `package.json` and every `packages/*/package.json` and `services/*/package.json` declare `"license": "AGPL-3.0-only"`.
- [x] **DEPLOY-LIC-002**: Where a contribution is submitted, `CONTRIBUTING.md` shall require that it is licensed under the same AGPL-3.0-only terms and that every commit carries a Developer Certificate of Origin 1.1 sign-off (`git commit -s`), with the DCO text embedded in the file.

## Workspace and repository hygiene

- [x] **DEPLOY-REPO-001**: The pnpm workspace shall consist of `packages/*` and `services/*`, and the root `tsconfig.json` shall be a solution file with a project reference for every one of the 7 packages and 10 services and no extras.
- [x] **DEPLOY-REPO-002**: The root `package.json` shall provide `build` (`tsc -b`), `typecheck` (`tsc -b --noEmit`), `test` (`tsc -b` then Node's test runner via `tsx` over `packages/*/test/*.test.ts` and `services/*/test/*.test.ts`), `test:only` (same without the build), `dev` (every service with `tsx watch`), `reflect`, `clean` and the `docs:*` scripts, and pin `pnpm@10.0.0` through `packageManager` with `node >=22`.
- [x] **DEPLOY-REPO-003**: The `.gitignore` shall exclude `node_modules/`, `dist/`, `*.tsbuildinfo`, `.env`, `data/`, `*.log` and the three user-owned files `config/config.yaml`, `config/personality.md` and `config/expressions.yaml`.
- [ ] **DEPLOY-REPO-004**: The `.gitignore` shall exclude the VTube Studio auth token that the avatar service writes to `config/.vts-token`. (Gap: `services/avatar/src/index.ts:30` and `services/avatar/src/drivers/vtube-studio.ts:104` write `<configDir>/.vts-token`; `.gitignore` has no entry for it, so `git add -A` would stage a credential.)

## Documentation consistency

- [ ] **DEPLOY-README-001**: Where `.env.example` describes which models the `models` service pulls, the description shall list only `LLM_MODEL`, `VISION_MODEL` and `EMBED_MODEL`. (Gap: `.env.example:9-15` heads `STT_MODEL` under "Ollama models (pulled by the `models` service)"; the compose pull loop does not include it, `docker-compose.yml:83`.)
- [ ] **DEPLOY-README-002**: Where documentation tells an operator to authenticate Bedrock with `AWS_PROFILE` and a mounted `~/.aws`, the Compose stack shall provide that mount. (Gap: `examples/providers/README.md:86` and `.env.example:20` suggest it; the only bind mount on application services is `./config`, `docker-compose.yml:22`.)
- [ ] **DEPLOY-README-003**: The testing guide `docs/TESTING.md` shall not list as open the problems that the code has since fixed. (Gap: its "Known problems" 1, 2, 3, 4, 5, 9 and 10 describe the cwd-relative config dir, the missing `.env` message, the `VOICE_URL` default, no fake memory store, `eyes` connecting to OBS while disabled, `pnpm prune --prod` and the `.tsbuildinfo` leak; at 686cc8f these are fixed by `findWorkspaceRoot` (`packages/config/src/index.ts:13-24`), the `.env` hint (`index.ts:100-103`), `urls.voice` (`index.ts:162-163`), `brain.memory.store: memory`, the eyes idle path (`services/eyes/src/index.ts:78-83`), `Dockerfile:3-5` and `.dockerignore:7`.)

## Dev helpers

- [x] **DEPLOY-DEV-001**: When `scripts/dev/bus-pub.ts <type> <json>` runs, it shall validate the payload through the bus event schema, publish it, and exit 1 with the rejection message on an invalid payload and 2 for an unknown type or unparsable JSON; `--list` shall print the known event types.
- [x] **DEPLOY-DEV-002**: When `scripts/dev/bus-tail.ts` runs, it shall tail the bus with a non-group read (so it never consumes a service's events), optionally replay the last N events, filter by event type, and print JSON lines with `--json`.
- [x] **DEPLOY-DEV-003**: When `scripts/dev/stub-llm.ts` runs, it shall serve `GET /api/tags` and `POST /api/chat` on `STUB_LLM_PORT` (default 11434) with a canned reply echoing the last user line, and when `scripts/dev/stub-tts.ts` runs it shall serve `POST /v1/audio/speech` on `STUB_TTS_PORT` (default 8880) returning a 24 kHz mono 16-bit WAV about 65 ms per character long (0.4 s to 8 s).
