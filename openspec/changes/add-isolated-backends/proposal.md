## Why

Only salience, affect, avatar (`driver: null`) and dashboard run with Redis alone today. cortex blocks on `llm.ping()`, memory waits on Ollama and Postgres, chat exits 1 without `TWITCH_CHANNEL`, eyes loops on OBS even with `vision.enabled=false`, ears exits 1 without `DISCORD_TOKEN`, and voice only accepts `kokoro`. The planned control plane (see `docs/plans/control-plane.md` sections 2.5 and 7; siblings `add-service-health` and `add-service-control`) needs "run service X by itself, no accounts, no GPU, no keys" to be a real, supported state, for local dev, CI smoke runs and a dashboard "Start (isolated)" action.

## What Changes

- `llm.provider` gains `mock`: deterministic echo/canned replies, `ping()` true, deterministic hash embeddings (no Ollama). **New value, never default.**
- Memory gains `brain.memory.store` (`postgres` | `inmemory`, default `postgres`) and `brain.memory.embedder` (`ollama` | `hash`, default `ollama`); startup skips the Ollama/Postgres waits when not used.
- Voice `voice.engine` gains `stub`: silent WAV plus an envelope sized from the text, no TTS call.
- Chat gains `chat.source` (`twitch` | `fake`, default `twitch`); `fake` publishes scripted/stdin messages and needs no channel.
- Eyes honors `vision.enabled=false`: idle, never connects to OBS.
- Ears gains `ears.source` (`discord` | `off`, default `discord`); `off` idles without `DISCORD_TOKEN`.
- Services without their external dependency idle and report `degraded`/`off`/`mock` instead of exiting or blocking forever.
- Each service documents an **isolation preset** (env that flips it) in `config/config.example.yaml` via `${VAR:-default}`; the supervisor passes it, nobody edits `config.yaml`.
- Defines the dependency closure used for "run X isolated" (cortex needs salience + affect, etc.).
- No bus event is added or changed. Heartbeat `mode` values (`mock`/`off`/`live`) are defined by `add-service-health`; this change only states which backend maps to which value.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `llm`: `mock` provider; mock embedder; embedder selection.
- `config`: new keys/enums/defaults; env-driven preset variables.
- `memory`: in-memory store, hash embedder, startup without Postgres/Ollama.
- `voice`: `stub` engine.
- `chat`: `fake` source; no-channel behavior.
- `eyes`: `vision.enabled=false` is truly idle.
- `ears`: `off` source.
- `cortex`: starts and answers with the mock provider; isolated closure.

## Impact

- Code: `packages/llm`, `packages/config` (schema + `config/config.example.yaml`), `services/{memory,voice,chat,eyes,ears,cortex}/src/index.ts` and small new modules in the owning package/service. `packages/bus` untouched.
- Mock/off backends ship in production images (see design, Open Questions).

## Out of Scope

Heartbeat/`HealthTracker` (`add-service-health`), process/container start-stop and the registry/`requires` manifest (`add-service-control`), any change to real backends (Ollama, Postgres, Kokoro, Twitch, OBS, Discord), a fake OBS/`speech.heard` file injector (future), dashboard UI.
