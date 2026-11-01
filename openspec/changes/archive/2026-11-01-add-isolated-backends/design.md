## Context

Config is loaded by `loadConfig()` from `config/config.yaml` with `${VAR}` / `${VAR:-default}` substitution; there is no generic env-override layer, so a preset env var only works if the yaml references it. Today `provider: ollama`, `engine: "kokoro"` and `vision.enabled: false` are literals in `config/config.example.yaml`. Backends already sit behind seams: `createChatProvider`/`createEmbedder` (llm), `kokoroSynth` injected into `Voice` (`synth` dep), avatar driver registry, `MemoryStore(embedder, cfg, log)`, `Hearing`/`Playback` deps in ears. Sibling changes: `add-service-health` defines the heartbeat (`{service, instance, pid, version, startedAt, state, deps, mode, detail?, intervalMs}`); `add-service-control` defines the supervisor/registry that passes env.

## Goals / Non-Goals

**Goals**
- Every service can start with only Redis and stay up, observable as mock/off/degraded.
- Opt-in only: defaults unchanged for every key.
- No config.yaml edits needed: one env var per service flips it.

**Non-Goals**
- Realistic fakes (the mock LLM is not a smart model). Heartbeat and lifecycle (siblings). Changing real backends.

## Decisions

### D1. Production mock providers, not test fakes
Mock/off backends are normal providers in the owning package/service, selected by config, so a supervisor or `docker compose` can run them. `packages/testing` fakes (`FakeBus`, `testConfig`) stay test-only and may import the same canned fixtures from the owning package, never the reverse.
Alternatives: (a) reuse `packages/testing` in services - rejected, pulls test code into runtime and the fakes assume in-process buses; (b) separate dev-only mock containers/HTTP stubs (fake Ollama/Kokoro servers) - rejected, adds processes and still exercises HTTP paths we want to skip; (c) a build flag stripping mocks - see Open Questions.

### D2. Env contract (all via `${VAR:-default}` in `config.example.yaml`)
| Service | Preset env | Config key | Maps to | Status |
|---|---|---|---|---|
| cortex (and any llm user) | `LLM_PROVIDER=mock` | `llm.provider` | `mock` | new env, new enum value (key exists; yaml literal becomes `"${LLM_PROVIDER:-ollama}"`) |
| memory | `MEMORY_STORE=memory`, `MEMORY_EMBEDDER=hash` | `brain.memory.store`, `brain.memory.embedder` | `mock` | new keys, new envs |
| voice | `VOICE_ENGINE=stub` | `voice.engine` | `mock` | new enum value, new env (literal `"kokoro"` becomes `"${VOICE_ENGINE:-kokoro}"`) |
| chat | `CHAT_SOURCE=fake` | `chat.source` | `mock` | new key/env |
| eyes | `VISION_ENABLED=false` (already the default) | `vision.enabled` | `off` | key exists; env new (`enabled: ${VISION_ENABLED:-false}`) |
| ears | `EARS_SOURCE=off` | `ears.source` | `off` | new key/env |
| avatar | `AVATAR_DRIVER=null` | `avatar.driver` | existing | env exists |
| salience, affect, dashboard | none | - | - | already Redis-only |
Verified against `packages/config/src/schema.ts` and `config/config.example.yaml`: `llm.provider`, `voice.engine`, `vision.enabled`, `avatar.driver` exist; the other four keys and all envs except `AVATAR_DRIVER` are new. The `mode` label (`mock`|`off`|`live`) is what the heartbeat from `add-service-health` reports; chat/ears/eyes with a real source report `live`.

### D3. Mock LLM behavior
`MockProvider` (`name: "mock"`, `model` from config): `chat()` returns a deterministic reply derived from the last user message (echo-style one-liner, e.g. `[happy] mock: <trimmed text>`), honoring the existing reply tag format so cortex parsing, critic and emotion paths run; `json: true` returns `{}`-compatible deterministic JSON so `module.kind: llm` hooks fall back cleanly. `ping()` is true. `Embedder`: hash-based fixed-dimension (64) unit vector from token hashes, so similar text has nonzero cosine similarity and recall tests are meaningful. Same input always gives the same output.

### D4. Memory
Main already ships an in-process store (`InMemoryStore` in `fake-store.ts`, `brain.memory.store: memory`) behind the `MemoryBackend` interface `MemoryStore` implements (`remember`, `recall`, viewer tracking, `close`); this change reuses it rather than adding a second one. It honors the 2-minute recall exclusion and `min_similarity`, so `createMemoryHandler` is unchanged. `main()` skips `ollama.ping()` unless `store=postgres` and `embedder=ollama` (the fake embeds with its own hashing) and skips `store.init()` retries unless `store=postgres`. In-memory data is lost on exit (documented). `reflect` is unsupported with `memory` (logs and no-ops).

### D5. Voice stub
Synth returns a PCM16 mono WAV at `voice.sample_rate` of silence with duration from text length (e.g. 60 ms per character, min 400 ms), so `parseWav`/`envelope` and `voice.utterance` fields stay real. Envelope is all zeros.

### D6. Chat fake source
Reads lines from stdin when it is a TTY/pipe, else cycles a built-in script (interval `chat.fake.interval_ms`, default 8000, users `fake_viewer1..n`), passing each through the normal `createChatFilter` so ignore rules apply. Does not touch `@twurple`. If `chat.source=twitch` and the channel is empty: instead of `exit(1)`, idle and report `degraded` with `deps: {twitch: "down"}`. Rationale: the supervisor must not see a crash loop for a configuration gap.

### D7. Eyes and ears idle states
Eyes: when `vision.enabled` is false the OBS connect loop never starts; process idles (timer only keeps alive), `mode: "off"`. Ears: `source=off` skips Discord client creation, idles, `mode: "off"`; with `source=discord` and no `DISCORD_TOKEN` it idles `degraded` (`deps: {discord: "down"}`) rather than `exit(1)`. Login failure with a token present keeps current exit(1) behavior (real error, supervisor should see it).

### D8. Dependency closure for "run X isolated"
Isolation starts the target plus its `requires` (bus-level, from the registry in `add-service-control`) in preset env, never the whole stack. Minimum closures this change guarantees workable: cortex = cortex + salience + affect (memory optional: cortex already answers without recall after `recall_timeout_ms`; with memory included it runs memory+hash); memory = memory alone; voice = voice (+ cortex chain to produce input, optional); avatar = avatar; chat/eyes/ears = themselves. This change only guarantees each member can run with Redis alone; computing the closure belongs to `add-service-control`.

## Risks / Trade-offs

- A mock mistaken for live: mitigated by heartbeat `mode`, a startup `warn` log naming the mock backend, and mock never being default.
- Mock drift from real behavior: contract tests run the shared provider/embedder interface suite against both.
- Idle-instead-of-exit can hide a misconfigured prod: mitigated by `degraded` + `deps` in heartbeat and a warn log every 60 s.
- `memory` store grows unbounded (main's fake has no cap): acceptable for short isolated runs; revisit if a long soak needs it.

## Migration Plan

Additive. Existing configs keep working (new keys default to current behavior). `config.example.yaml` changes only literals to `${VAR:-same-literal}`, so seeded `config.yaml` files keep working; users with an older `config.yaml` simply do not get env-flippable presets until they re-copy.

## Open Questions

1. Ship mocks in production images (default: yes; code is small, no extra deps, and a dev-only build flag would make "isolated" unavailable in compose) or behind a build flag? Needs owner decision (plan section 11 Q5).
2. Should a fake OBS source (`vision.source: fake`) and a file-based `speech.heard` injector be added later? Deferred.
