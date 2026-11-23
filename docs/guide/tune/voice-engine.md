---
title: Choose a voice engine
description: Pick the speech engine that says the co-host's lines, from the Kokoro server cohost runs itself to an OpenAI-compatible server or a Pocket TTS server, with the trade-offs, the network each one uses and a recipe for each.
track: simple
verified: 938a38e3
---

# Choose a voice engine

The co-host speaks each line through one speech engine, chosen by `voice.engine` in `config.yaml`. [Kokoro](../../start/glossary.md#kokoro) is the default and needs no setup. This page says what each engine costs you and what it sends over the network, so you can pick one on purpose.

## What you need

- A running co-host. [Try it with no accounts](../install/first-run.md) runs the default stack.
- The dashboard's **Settings** screen, or a text editor for `config/config.yaml`.

## The four engines

| Engine (`voice.engine`) | Speech server | Where it runs | Text leaves the machine? | Parallel requests |
| --- | --- | --- | --- | --- |
| `kokoro` (default) | Kokoro-FastAPI, the [`tts`](../../start/glossary.md#tts) [container](../../start/glossary.md#container) | Inside the [Docker Compose](../../start/glossary.md#docker-compose) stack | No, unless you point `TTS_URL` elsewhere | 2 |
| `pocket` | Kyutai Pocket TTS, the `tts-pocket` container | Inside the stack, behind the `pocket` [profile](../../start/glossary.md#compose-profile) | No, unless `voice.pocket.url` names another host | 1 |
| `openai` | Any server that speaks the OpenAI speech route | Wherever you run it, or a hosted service | Yes, to the address you write in `voice.openai.base_url` | 2 |
| `stub` | None | Nowhere | No | none |

`stub` makes silent clips the length of the text. Use it to test the rest of the stack without a voice server; the co-host is silent while it is set.

### Kokoro

The default. The voice is a Kokoro voice id, such as `af_heart` (the default), or a mix such as `af_bella(2)+af_sky`. Speed, language and the text clean-up switches are read from `voice.speed`, `voice.lang_code` and `voice.normalization`. Nothing to configure for the default stack.

### Pocket TTS

Kyutai's Pocket TTS runs on the CPU (about two cores). It handles one request at a time, so a line and a fallback clip wait for each other. Its voice is a catalogue name such as `alba` (the default), or the address of a voice file. Speed is not used by this engine.

To use it:

1. Enable its [Compose profile](../../start/glossary.md#compose-profile): add `pocket` to `COMPOSE_PROFILES` in `.env`, then start the stack again. The server is published on `127.0.0.1:8881` for checks.
2. Set `voice.engine` to `pocket`. Leave `voice.pocket.url` at its default, `http://tts-pocket:8000`, which is the container's address on the Compose network.
3. Restart the voice service. The first start downloads the model into the `tts-pocket-cache` volume, which can take a while. Until the model has loaded the dashboard shows voice as degraded; cohost checks the server's `/health` every 10 seconds and clears the state when the model answers.

Pocket's server adds 200 ms of silence to every reply. cohost keeps it, so a line lasts that much longer and the mouth closes after the speech.

### OpenAI-compatible servers

This engine sends the text of every line to the address you write. There is no default address, so nothing is sent until you set one. Use it for a speech server on another machine you own, or for a hosted service.

1. Set `voice.engine` to `openai`.
2. Set `voice.openai.base_url` to the server's address including its version path, for example `http://my-gpu-box:8880/v1`.
3. Set `voice.openai.model` to the model name the server expects, for example `tts-1`.
4. Set `voice.voice` to a voice name the server knows. It has no default.
5. For a hosted service, put the key in `voice.openai.api_key` in `config/secrets.yaml`. It is sent only to `base_url`.

If `base_url`, `model` or `voice` is blank, the co-host still starts, but it speaks nothing and the dashboard shows voice as degraded, with the missing key named.

## Where the text goes

- **On your network** (`kokoro`, and `pocket` at its default): the text stays on the machine or the Compose network.
- **Off your network** (an `openai` address outside your LAN, or a Pocket URL on another host): voice logs one warning at start that names the engine and the host. The lines and the fallback phrases are sent there, and so is the API key when one is set. Point the address only at a server you trust.

## Changing the engine

The engine and its settings are read once, when the voice service starts. Change them in Settings or `config.yaml`, then restart the stack or the voice service. A change to the engine, its server, its voice or its model makes cohost regenerate the fallback clips at the next start; a rotated API key does not.

If a server is slow to answer, raise `voice.timeout_ms` (default 15000). It is the longest wait for the first sound of a line, and for each gap in it, before that line is given up.

## Check that it works

- The dashboard's Services screen shows `voice` as ready, with its engine and host in the detail. Degraded means the server is down or not configured; the detail says which.
- Send the co-host a line. A spoken reply means the engine works; a line that fails shows in the voice log as `tts failed`, with the server's reply.

## Related

- [Configuration reference](../../advanced/reference/config.md#voice): every `voice.*` key and its default.
- [Environment and ports](../../advanced/reference/env.md): the Compose profiles and the ports they publish.
