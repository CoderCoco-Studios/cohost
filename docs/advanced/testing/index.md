---
title: Running the tests
description: Run the whole suite, one package or one file, and see what CI runs and which tests skip themselves.
track: advanced
verified: a86e930
---

# Running the tests

This is the first of six testing pages. It covers the automated suite. The others cover running a [single service on its own](isolated.md), putting [fake inputs](inject.md) on the bus, bringing in [real hardware and accounts](real-backends.md), the [single-PC checklist](single-pc.md) and the [unit-test helpers](helpers.md).

All commands run from the repository root.

## What you need

| Need | Why |
| --- | --- |
| The toolchains from `mise install` | `mise run test` builds the workspace, the native [bus](../../start/glossary.md#bus) addon included, before it tests; see [Developer setup](../dev-setup.md) |
| [Redis](../../start/glossary.md#redis) 6.2 or newer at `redis://127.0.0.1:6379` (or `REDIS_URL`) | The bus round-trip tests. Without it they skip themselves |
| [Postgres](../../start/glossary.md#postgres) with [pgvector](../../start/glossary.md#pgvector), pointed to by `COHOST_TEST_DATABASE_URL` | The memory store tests against a real database. Without the variable they skip themselves |

The easiest Redis is the [Compose](../../start/glossary.md#docker-compose) one: `docker compose up -d redis`, or `mise run infra:up` for all the infrastructure. It binds `127.0.0.1:6379`, which is where the suite looks. Any Redis 6.2 or newer on that port works too.

## Run everything

```bash
mise run test         # the Rust tests, the build, then every TypeScript test
mise run test:only    # the TypeScript tests without the build
mise run test:rust    # the Rust tests only
mise run typecheck    # tsc -b, the dashboard UI and every test directory
```

Every test task runs the tests through `scripts/test-env.sh`, which sets a temporary `COHOST_DATA_DIR` and a temporary `CONFIG_DIR` holding copies of the `config/*.example.*` files, with `COHOST_ENV_FILE` and `COHOST_KEY_FILE` pointed inside it, and removes both afterwards. A test that needs a settings store makes its own under that data directory, under a master key in that folder, so no test writes log files into your `data/`, opens your settings store, or reads your `.env` or your master key. The script also sets `COHOST_TEST_ENV=1`, under which the settings store refuses to fall back to `~/.config/cohost/master.key`: a test that opens a store without `COHOST_KEY_FILE` fails instead of touching your key. A test that starts a program with an environment it builds itself (not a copy of `process.env`) must put `COHOST_KEY_FILE` in it; `packages/config/test/toolchain.test.ts` checks that.

`mise run test` runs the `test:rust` and `build` tasks first (`build` catches type errors in the source; `mise run typecheck`, part of `mise run lint`, also checks the tests), then runs every `test/*.test.ts` under `packages/*` and `services/*`, and the dashboard UI's `.test.tsx` files, with Node's `node:test` runner through `tsx`. Run `mise run test:only` for a quick loop once the workspace is built. `mise run lint` adds oxlint, `cargo fmt --check` and Clippy; CI runs it beside the tests.

The suite needs no network, no [GPU](../../start/glossary.md#gpu) and no account. Region logic is tested against a fake bus (see [Unit-test helpers](helpers.md)), HTTP backends against local stub servers.

### Tests that skip themselves

A skipped test is not a failed one, but a run with skips is not a full pass. These skip when their dependency is missing:

| Test | Skips unless |
| --- | --- |
| Bus round trips in `packages/bus/test/bus.test.ts`, each titled with `(needs Redis)` | A Redis answers at `REDIS_URL` |
| Memory store against real Postgres, `services/memory/test/notes-store.pg.test.ts` | `COHOST_TEST_DATABASE_URL` names a reachable pgvector database, for example `postgres://cohost:cohost@127.0.0.1:5432/cohost_test`. When `CI` is set and the database is unreachable, the test fails instead of skipping |
| The live-stack test, `services/dashboard/test/live-stack.e2e.test.ts` | `COHOST_LIVE_STACK=1`, [Docker](../../start/glossary.md#docker) answers, `CONTROL_TOKEN` is in the environment of the command (exported from your password manager, never in `.env`), and ports 3000 and 3001 are free |
| The Claude API smoke test in `packages/llm/test/backends.test.ts` | `ANTHROPIC_API_KEY` and `COHOST_LIVE_CLAUDE_MODEL` are both set |

## Run one package, one service or one test

`mise run test:file` runs Node's test runner over the files you give it after the task name. It builds first, because the packages a test imports resolve to their built `dist/` and the native addon; flags for the runner go before the files.

```bash
mise run test:file -- services/salience/test/*.test.ts       # one service
mise run test:file -- packages/bus/test/*.test.ts            # one package
mise run test:file -- services/voice/test/wav.test.ts        # one file
mise run test:file -- --test-name-pattern="mention" services/salience/test/*.test.ts   # by test name
```

Where the tests live:

| Area | Test files |
| --- | --- |
| `packages/bus`, `config`, `llm`, `modules`, `working-memory` | `packages/*/test/` |
| `services/salience`, `affect`, `cortex`, `memory` | The [brain regions](../../start/glossary.md#brain-region); the `*.region.test.ts` files use `FakeBus` |
| `services/voice` | The [TTS](../../start/glossary.md#tts) client, the WAV parser, the envelope, the HTTP endpoint, the virtual sink |
| `services/avatar` | Engine smoothing and idle motion; the drivers against fake sockets |
| `services/ears`, `mouth`, `eyes`, `chat`, `connector-discord` | Transcription and describer logic with fake backends, the [connector](../../start/glossary.md#connector) source and [sink](../../start/glossary.md#sink) against a fake bus, the chat filter |
| `packages/shared`, `control` | The shared runtime (bootstrap, lifecycle, idle plan, inject handler, Discord session), the manifest and the stack controller |
| `services/dashboard` | HTTP routes, the live feed, the React UI (happy-dom, by role and accessible name) |
| `crates/*/tests` | The Rust bus client; run with `mise run test:rust` |

## What CI runs

Four workflows watch every pull request and every push to `main`. Each step is an action or one `mise run <task>`, the same command you run locally:

| Workflow | Runs |
| --- | --- |
| `test` | `mise run lint`, `mise run test`, then `mise run test:rust-example` (the Rust bus example's round trip, which must run rather than skip), with Redis 8 and a pgvector Postgres as service [containers](../../start/glossary.md#container) so nothing skips |
| `lid-check` | `mise run lid-check`: every `@spec` ID in code and tests exists and is defined once |
| `compose-smoke` | `mise run smoke` builds the service images and requires `salience`, `affect` and `avatar` to reach healthy, then starts `tools` and checks from inside it that the name `redis` resolves and the name `salience` does not (`tools` is on a Redis-only network), then `mise run test:launch` runs the launch end-to-end test against a real Compose project |
| `docs-build` | `mise run docs:build`, the documentation site and its checks (pull requests only) |

On pull requests the `cla` workflow also runs `mise run cla`, which checks that every commit author has signed the [CLA](../../project/contributing.md#sign-the-cla). It runs from `main`'s own copy of the script, never the pull request's, so a change to `scripts/cla/` takes effect only after it merges; its tests run on fixtures in `packages/config/test/cla.test.ts`.

## Known problems

- **Bus state persists in Redis between runs.** Services that subscribe from `latest` ignore old [events](../../start/glossary.md#event), but `mise run bus:tail -- --replay 20` shows them. Reset the stream with `docker compose exec redis redis-cli DEL cohost:events`.
- **Real integrations are not run by the suite.** The suite never touches the [Kokoro](../../start/glossary.md#kokoro) GPU image, [OBS](../../start/glossary.md#obs), Discord, the authenticated Twitch path or [VTube Studio](../../start/glossary.md#vtube-studio). [Real hardware and accounts](real-backends.md) says which of those have been run and how to check the rest, and [Status](../../project/status.md) lists what has run against the real services.
