## 1. Config and llm

- [x] 1.1 Extend `ConfigSchema`: `llm.provider` adds `mock`; `voice.engine` adds `stub`; add `brain.memory.store`, `brain.memory.embedder`, `chat.source`, `chat.fake.interval_ms`, `ears.source` with defaults (verify no default changes)
- [x] 1.2 Update `config/config.example.yaml` to `${VAR:-default}` for LLM_PROVIDER, MEMORY_STORE, MEMORY_EMBEDDER, VOICE_ENGINE, CHAT_SOURCE, VISION_ENABLED, EARS_SOURCE
- [x] 1.3 Tests in `packages/config/test/`: new defaults, invalid enum values, env flip, unset env equals old defaults
- [x] 1.4 Add hash embedder and `MockProvider` to `packages/llm/src`; wire `createChatProvider` and `createEmbedder`
- [x] 1.5 Tests in `packages/llm/test/`: determinism, ping, JSON mode, aborted signal, embedder similarity ordering, factory selection

## 2. memory

- [x] 2.1 Extract the store interface; add in-memory store (cap 2000, recall rules identical)
- [x] 2.2 Switch `services/memory/src/index.ts` on `store`/`embedder`; skip Ollama wait and Postgres retries when unused; reflect no-op for inmemory
- [x] 2.3 Tests in `services/memory/test/`: recall round trip, 2-minute exclusion, min_similarity, cap, no Ollama traffic with hash

## 3. voice

- [x] 3.1 Add stub synth (silent WAV, 60 ms/char, min 400 ms) and select it by `voice.engine`
- [x] 3.2 Tests in `services/voice/test/`: valid WAV parses, duration, zero envelope, no fetch call

## 4. chat

- [x] 4.1 Add fake source (stdin or scripted) through `createChatFilter`; do not import twurple when fake
- [x] 4.2 Replace `exit(1)` on empty channel with idle + degraded state
- [x] 4.3 Tests in `services/chat/test/`: scripted publish, ignored prefix, no-channel does not exit

## 5. eyes and ears

- [x] 5.1 Eyes: skip `connectObs`/loop entirely when `vision.enabled` is false
- [x] 5.2 Ears: `ears.source` switch; `off` and missing-token idle paths; keep exit(1) on login failure
- [x] 5.3 Tests in `services/eyes/test/` and `services/ears/test/` for the idle decisions (extract a pure decision function if needed)

## 6. cortex and wiring

- [x] 6.1 Cortex waits for ping without blocking forever silently (log + degraded hook point for `add-service-health`)
- [x] 6.2 Test in `services/cortex/test/`: mock provider produces `brain.say`; no-memory timeout path
- [x] 6.3 Each service logs a warn when a mock/off backend is active and exposes its `mode` label for `add-service-health` to publish
- [ ] 6.4 Smoke script/doc: `docker compose up -d redis` then run each service with its preset env; update README "stub TTS" mention
- [ ] 6.5 Run `pnpm test` and confirm green
