---
title: Status
description: What has run against real accounts and apps, and what has not yet.
track: project
---

# Status

Every service is built, type-checked and covered by unit and glue tests. The loop
chat, [salience](../start/glossary.md#salience), [cortex](../start/glossary.md#cortex), voice, avatar, dashboard runs end to end in [mock mode](../start/glossary.md#mock-mode), and
every service can start alone with only [Redis](../start/glossary.md#redis), because each outside dependency has
a mock backend.

| Piece | State |
| --- | --- |
| Brain (salience, [affect](../start/glossary.md#affect), memory, cortex), voice, avatar (null driver), dashboard, control plane | Built and exercised against the stub voice, mock [LLM](../start/glossary.md#llm) and in-process memory. The real [Ollama](../start/glossary.md#ollama), [Kokoro](../start/glossary.md#kokoro) and [Postgres](../start/glossary.md#postgres) [containers](../start/glossary.md#container) were run on a CPU box. |
| `mouth` (writes her voice to [connector](../start/glossary.md#connector) [sinks](../start/glossary.md#sink)) | Built, with a stuck-playback guard, a spoken fallback line and a test-only `dryrun` output. Its Discord sink belongs to the connector and has not been run against a real Discord server. |
| `ears` (listens to connector sources) | Built. It holds no Discord client; the Discord receive path lives in the connector, which is unverified against real Discord. |
| `connector-discord` (the one bot) | Built. The join, the receive path and the native voice dependencies (`libsodium-wrappers`, `@snazzah/davey`, `opusscript`) are unverified against real Discord. |
| `eyes` ([OBS](../start/glossary.md#obs) vision) | Built. The OBS WebSocket path has not been run against a real OBS, and the vision model needs a [GPU](../start/glossary.md#gpu) for good latency. |
| `chat` (Twitch) | Built. Anonymous read-only chat was run against Twitch. The signed-in path and token refresh were not. |
| Avatar drivers | [VMC](../start/glossary.md#vmc) was run against a UDP listener. [VTube Studio](../start/glossary.md#vtube-studio) only against a fake socket, so expect to tune parameter names the first time. |
| [Compose](../start/glossary.md#docker-compose) and installer | Read and parsed. A [Docker](../start/glossary.md#docker)-gated end-to-end Launch test runs in CI. The full real stack is waiting on the single-PC checklist. |

What is left is a first run with real accounts and apps: Discord (one bot), Twitch,
OBS and VTube Studio. The records of runs so far are in the
[Verification log](verification-log.md).
