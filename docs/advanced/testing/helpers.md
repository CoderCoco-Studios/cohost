---
title: Unit-test helpers
description: The @cohost/testing package, with a complete region test you can copy as a starting point.
track: advanced
verified: f126b94
---

# Unit-test helpers: `@cohost/testing`

`packages/testing/src/index.ts` holds the helpers every region test uses. They let you test a service's logic with no [Redis](../../start/glossary.md#redis), no [Docker](../../start/glossary.md#docker) and no network: a complete config, a fake [bus](../../start/glossary.md#bus) that records what was published, and a way to build the [events](../../start/glossary.md#event) a subscriber would receive.

## The helpers

| Helper | What it is |
| --- | --- |
| `testConfig(overrides?)` | A complete, schema-validated `Config`, with `cooldown_ms` and `idle_chatter_ms` under `brain.salience` zeroed so tests do not wait. Overrides deep-merge |
| `FakeBus` | The same `publish` validation as the real bus, but it records instead of using Redis. `.of(type)` returns the payloads of one type, `.types()` the types in order, `.published` everything, `.clear()` resets, and `.fail` injects publish errors. It also records [heartbeats](../../start/glossary.md#heartbeat) (`.health`) and uploads (`.uploads`) |
| `event(type, data, source?)` | A `BusEvent` as a subscriber would receive it, with defaults applied |
| `silentLog` and `recordingLog()` | A logger that does nothing, and one that keeps `lines` and `msgs(level)` |
| `waitFor(cond, what?, ms?)` | Polls until a condition is true, for async regions such as the [cortex](../../start/glossary.md#cortex) |
| `runHeartbeat(spec, drive?)` | Runs a service's heartbeat against a `FakeBus` and returns every heartbeat published |
| `ConnectorFakeBus` | A `FakeBus` with an in-memory connector registry and audio streams, for code that consumes a [connector](../../start/glossary.md#connector) such as `ears` and `mouth` |
| `unitContractTests` | The per-service checks shared by each service's `contract.test.ts` |
| `FakeTransport` and friends (`fake-transport.ts`) | A scripted transport that lets the real `Bus` facade run its loops, validation and backoff with no Redis and no native addon |

## A complete test

Put this in `services/salience/test/`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { createScorer } from "../src/scoring.js";

test("a mention makes salience publish attention.focus", async () => {
  const cfg = testConfig();
  const bus = new FakeBus();
  const s = new Salience({ cfg, bus, scorer: createScorer(cfg, silentLog), log: silentLog });

  await s.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hey Coco?", mentionsCohost: true }));
  await s.tick();

  assert.equal(bus.of("attention.focus")[0]?.reason, "mentioned");
});
```

Run it from the repository root, after `mise run build` and in a shell where mise is active ([Running the tests](index.md#run-one-package-one-service-or-one-test) says why):

```bash
node --import tsx --test services/salience/test/<file>.test.ts
```

The existing `services/*/test/*.region.test.ts` files are the best templates for your own.

## Habits that keep tests fast

- Build the config with `testConfig({ ... })` and pass only the keys the test is about.
- Drive time with an injected clock where a service accepts one (`now` in `Salience`), not with sleeps.
- Mark a test that needs Redis or a database so it skips when the dependency is missing, as `packages/bus/test/bus.test.ts` does, and say so in its title. [Running the tests](index.md) lists the tests that skip themselves.
- Annotate a test with the spec it exercises, for example `// @spec SAL-DECIDE-008`, so `mise run lid-check` can follow it. [How specs work](../../project/spec-driven.md) explains the convention.
