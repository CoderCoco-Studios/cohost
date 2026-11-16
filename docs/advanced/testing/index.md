---
title: Running the tests
description: Run the whole suite, one package or one file, and see what CI runs and which tests skip themselves.
track: advanced
verified: f126b94
---

# Running the tests

This is the first of six testing pages. It covers the automated suite. The others cover running a [single service on its own](isolated.md), putting [fake inputs](inject.md) on the bus, bringing in [real hardware and accounts](real-backends.md), the [single-PC checklist](single-pc.md) and the [unit-test helpers](helpers.md).

All commands run from the repository root.

## What you need

| Need | Why |
| --- | --- |
| A built workspace | `pnpm test` builds it for you; see [Developer setup](../dev-setup.md) for the Rust toolchain that the native [bus](../../start/glossary.md#bus) addon needs |
| [Redis](../../start/glossary.md#redis) 6.2 or newer at `redis://127.0.0.1:6379` (or `REDIS_URL`) | The bus round-trip tests. Without it they skip themselves |
| [Postgres](../../start/glossary.md#postgres) with [pgvector](../../start/glossary.md#pgvector), pointed to by `COHOST_TEST_DATABASE_URL` | The memory store tests against a real database. Without the variable they skip themselves |

The easiest Redis is the [Compose](../../start/glossary.md#docker-compose) one: `docker compose up -d redis`. It binds `127.0.0.1:6379`, which is where the suite looks. Any Redis 6.2 or newer on that port works too.

## Run everything

```bash
pnpm test         # build the native addon, tsc -b, then every test
pnpm test:only    # the same tests without the build step
pnpm typecheck    # tsc -b: type-checks every project
```

`pnpm test` runs `pnpm build:native` and `tsc -b` first, which is what catches type errors, then runs every `test/*.test.ts` under `packages/*` and `services/*` with Node's `node:test` runner through `tsx`. Run `pnpm test:only` for a quick loop once the workspace is built.

The suite needs no network, no [GPU](../../start/glossary.md#gpu) and no account. Region logic is tested against a fake bus (see [Unit-test helpers](helpers.md)), HTTP backends against local stub servers.

### Tests that skip themselves

A skipped test is not a failed one, but a run with skips is not a full pass. These skip when their dependency is missing:

| Test | Skips unless |
| --- | --- |
| Bus round trips in `packages/bus/test/bus.test.ts`, each titled with `(needs Redis)` | A Redis answers at `REDIS_URL` |
| Memory store against real Postgres, `services/memory/test/notes-store.pg.test.ts` | `COHOST_TEST_DATABASE_URL` names a reachable pgvector database, for example `postgres://cohost:cohost@127.0.0.1:5432/cohost_test`. When `CI` is set and the database is unreachable, the test fails instead of skipping |
| The live-stack test, `services/dashboard/test/live-stack.e2e.test.ts` | `COHOST_LIVE_STACK=1`, [Docker](../../start/glossary.md#docker) answers, `CONTROL_TOKEN` is in the environment, and ports 3000 and 3001 are free |
| The Claude API smoke test in `packages/llm/test/backends.test.ts` | `ANTHROPIC_API_KEY` and `COHOST_LIVE_CLAUDE_MODEL` are both set |

## Run one package, one service or one test

The root has no per-package `test` script; call the runner directly. Tests import sources through `tsx`, so no build is needed:

```bash
node --import tsx --test services/salience/test/*.test.ts       # one service
node --import tsx --test packages/bus/test/*.test.ts            # one package
node --import tsx --test services/voice/test/wav.test.ts        # one file
node --import tsx --test --test-name-pattern="mention" services/salience/test/*.test.ts   # by test name
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
| `services/dashboard` | HTTP routes, the live feed, the page script (a stub DOM in `node:vm`) |
| `crates/*/tests` | The Rust bus client; run with `cargo test --workspace` |

## What CI runs

Four workflows watch every pull request and every push to `main`:

| Workflow | Runs |
| --- | --- |
| `test` | `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, then `pnpm test`, with Redis 8 and a pgvector Postgres as service [containers](../../start/glossary.md#container) so nothing skips |
| `lid-check` | `node scripts/lid-check.mjs`: every `@spec` ID in code and tests exists and is defined once |
| `compose-smoke` | `scripts/compose-smoke.sh` builds the service images and requires `salience`, `affect` and `avatar` to reach healthy, then runs the launch end-to-end test against a real Compose project |
| `docs-build` | `pnpm docs:build`, the documentation site and its checks (pull requests only) |

## Known problems

- **Bus state persists in Redis between runs.** Services that subscribe from `latest` ignore old [events](../../start/glossary.md#event), but `bus-tail --replay` shows them. Reset the stream with `docker compose exec redis redis-cli DEL cohost:events`.
- **Real integrations are not run by the suite.** The suite never touches the [Kokoro](../../start/glossary.md#kokoro) GPU image, [OBS](../../start/glossary.md#obs), Discord, the authenticated Twitch path or [VTube Studio](../../start/glossary.md#vtube-studio). [Real hardware and accounts](real-backends.md) says which of those have been run and how to check the rest, and [Status](../../project/status.md) lists what has run against the real services.
