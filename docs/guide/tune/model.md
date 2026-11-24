---
title: Choose a model
description: Pick the language model that writes the co-host's replies, from a model on your own graphics card to a rented GPU box or a hosted API, with a copy-paste recipe for each.
track: simple
verified: f126b94
---

# Choose a model

The words your co-host says are written by a [language model](../../start/glossary.md#llm) (an LLM). By default it runs on your own graphics card. If your card is small, or you want a smarter co-host, you can point it at a bigger model somewhere else by changing a few lines. Everything else (ears, voice, avatar, memory) stays on your machine either way.

## What you need

- A working co-host. [Install for real](../install/real-install.md) or [Try it with no accounts](../install/first-run.md) comes first.
- For a rented box or a hosted model: an account with that provider and its key.

## How the choice works

Which model answers is a `config/config.yaml` setting, `llm.provider`. The model's name goes in `llm.model`, written the way that provider names it. Credentials such as API keys never go in `config.yaml`; they go in `config/secrets.yaml` (copy it from `config/secrets.example.yaml` if it is not there yet). It is git-ignored, and each key is named by its dotted path.

| `llm.provider` | What it is | Key in `secrets.yaml` |
| --- | --- | --- |
| `ollama` | A model on your own [GPU](../../start/glossary.md#gpu), run by [Ollama](../../start/glossary.md#ollama). The default. | none |
| `openai` | Any server that speaks the OpenAI chat format: a GPU box you rent by the hour, or a hosted router such as OpenRouter, Groq, Together or Fireworks. | `llm.openai.api_key` |
| `anthropic` | Claude through the Claude API. | `llm.claude.api_key` |
| `bedrock` | Claude through Amazon Bedrock, billed to your AWS account. | `llm.bedrock.access_key_id`, `llm.bedrock.secret_access_key` |

Two things stay local whatever you choose. The [embeddings](../../start/glossary.md#embedding) that power [memory](memory.md) always come from local Ollama, so switching the chat model never changes the memory database. And the small model that writes [viewer notes](memory.md) defaults to local Ollama too, so chat lines and sensitive notes do not leave your machine unless you name another provider for that hook.

What does leave the machine with a hosted choice is the text the co-host's brain sends to the model: the prompt with recent chat, memories and the [personality](personality.md), and the reflection pass after a stream.

After changing `config.yaml` or `secrets.yaml`, restart the parts that read the `llm` section. Each is one command:

```bash
pnpm cohostctl restart cortex
pnpm cohostctl restart memory
pnpm cohostctl restart salience
pnpm cohostctl restart affect
```

Or press **Save** on the dashboard's **Settings** screen and let it offer to restart them. A restart is what applies an edit to either file; the [Starting and stopping](../operate/start-stop.md) page covers restarting and Launch. The **Settings** screen edits both: ordinary keys are written to `config.yaml`, and an API key or password has a masked field (marked **Set** or **Not set**) that writes `secrets.yaml` and needs your control token.

## Streaming and tools

Two things the co-host asks of a model are worth knowing before you choose one.

**Streaming.** The co-host speaks a reply a clause at a time as the model writes it, so the wait before it starts talking is the time to the first clause, not to the whole reply. All four providers stream, so there is nothing to switch on. If a server answers with one whole reply instead of a stream, the co-host still speaks it; it just arrives late. A reply that stalls (no output within `llm.timeout_ms`, 60000 ms by default, or a pause that long between pieces) fails: with nothing said yet the co-host stays quiet that turn (unless it was waiting on a tool: then it says it could not find that out), and with some clauses already spoken the line ends cut short.

**Tools.** When you turn on [tools](../connect/built-in-tools.md), the model may ask for one in the middle of a reply, and the co-host runs it and lets the model continue. No tool is on by default, so tool use never reaches a model you have not chosen for it. Whether the model can use tools is up to the model: cohost sends the tools it is given and does not guess. A local Ollama model may have no tool support, and a server that rejects the request fails that reply rather than being retried without tools. A model that accepts tools and never asks for one simply writes text, which is normal. A model that writes a tool call out as plain text is spoken as text, not run. Pick a model that supports tool calling before you enable tools.

The same goes for pictures: a model for [vision](#pictures-for-the-vision-model) must accept images, and cohost cannot tell when a model accepts them and ignores them.

## Local GPU (the default)

```yaml
llm:
  provider: ollama
  model: "qwen2.5:7b-instruct-q4_K_M"
  # 12 GB of VRAM or more:
  # model: "qwen2.5:14b-instruct-q4_K_M"
```

The stack's `models` one-shot downloads the model `llm.model` names on Launch. Pick a size to match your card's video memory (VRAM). The first one suits an 8 GB card. To upgrade your card later, change the line in `config.yaml`, press **Launch** and restart the services above. Nothing else changes. The first download is several gigabytes, so give it a few minutes.

## A GPU box you rent by the hour

Rented machines run the model for you. Anything that serves the OpenAI chat route (`POST /v1/chat/completions`) works: vLLM, TGI, or the llama.cpp server. On the rented box, start the server:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key change-me
```

On your machine, point the co-host at it:

```yaml
llm:
  provider: openai
  model: meta-llama/Llama-3.3-70B-Instruct
  openai:
    base_url: "http://<box-ip>:8000/v1"
```

The key goes in `config/secrets.yaml`:

```yaml
llm:
  openai:
    api_key: "change-me"
```

Use a real secret instead of `change-me`, and the same one on both sides. A plain `http://` address sends that key and your chat over the open internet; put the box behind HTTPS or an SSH tunnel if it is not on your own network.

### A hosted router

The same shape works for hosted routers (OpenRouter, Groq, Together, Fireworks): their base URL, your key, and their model id. For OpenRouter:

```yaml
llm:
  provider: openai
  model: meta-llama/llama-3.3-70b-instruct
  openai: { base_url: "https://openrouter.ai/api/v1" }
```

with your OpenRouter key as `llm.openai.api_key` in `secrets.yaml`.

## Claude through the Claude API

```yaml
llm:
  provider: anthropic
  model: claude-opus-5-5
  claude:
    effort: low
    max_tokens: 2048
    fallbacks: true
```

The key goes in `config/secrets.yaml`:

```yaml
llm:
  claude:
    api_key: "sk-ant-..."
```

The `claude` keys tune how Claude answers:

| Key | Meaning |
| --- | --- |
| `effort` | How hard it thinks. `low` suits one-line replies. |
| `max_tokens` | A cap on thinking and the reply together, so leave it roomier than the 120 used for local models. |
| `fallbacks` | If a safety check declines a reply, retry on another Claude model. Claude API only, and only for a reply that is not streamed. The co-host's own replies are streamed (see [Streaming and tools](#streaming-and-tools)), so this applies to calls that wait for a whole reply. |

## Claude through Amazon Bedrock

Bedrock bills to your AWS account. In the Bedrock console, enable the model for your region first.

```yaml
llm:
  provider: bedrock
  model: anthropic.claude-opus-5-5
  bedrock: { region: us-east-1 }
```

Put your AWS access key in `config/secrets.yaml`. This is the only way Bedrock is given credentials:

```yaml
llm:
  bedrock:
    access_key_id: "AKIA..."
    secret_access_key: "..."
```

Both keys must be set together. With only one set, the services that build the model client (cortex, memory, [salience](../../start/glossary.md#salience) and [affect](../../start/glossary.md#affect)) refuse to start, so setting just one is an incomplete state to avoid. The stack's [containers](../../start/glossary.md#container) do not mount your home directory, and no AWS profile or `~/.aws` file is read. Create the key pair for an IAM user that may invoke Bedrock. `llm.bedrock.region` in `config.yaml` is required with the two keys; write the region of the Bedrock endpoint, such as `us-east-1`.

Server-side fallbacks are not offered on Bedrock; if a safety check declines a reply, the co-host says nothing that turn. Bedrock models other than Claude (Llama, Mistral) are not covered by this provider.

## Pictures for the vision model

The [OBS](../connect/obs.md) screenshots that the `eyes` service describes go to the chat provider named by `vision.provider`, using the model you name in `vision.model`:

| `vision.provider` | Where the picture goes |
| --- | --- |
| `ollama` (default) | Your Ollama server at `OLLAMA_URL`. On your machine or your LAN, nothing leaves it; a URL off the LAN sends the pictures off it. |
| `openai` | The OpenAI-compatible server at `llm.openai.base_url`. The default is the hosted `https://api.openai.com/v1`, so the picture leaves your machine; a server on your LAN keeps it there. |
| `anthropic`, `bedrock` | The hosted Claude API or Amazon Bedrock, with the keys from `secrets.yaml`. The picture leaves your machine. |
| `stub` | Nowhere: fixed text, no model. |

Each provider takes pictures in its own form. A model that takes no images fails the describe call with an error. A 400 or 422 from the provider reports that one frame as failed and leaves `vision` as it was; any other error marks `vision` down until a later describe succeeds. cohost cannot tell from a model's name whether it takes images, so check the model before you rely on it. For `openai`, `anthropic` and `bedrock`, bytes that are not a JPEG, PNG, GIF or WebP, such as a BMP or a PDF injected from the dashboard, are refused before anything is sent; `ollama` passes the bytes through unchecked.

When frames leave the LAN, eyes logs one warning at start that names the provider and, for `openai`, the host. Its [heartbeat](../../start/glossary.md#heartbeat) detail names the same destination. A blank `vision.model`, or a hosted provider without its keys, keeps eyes running with `vision` down and the reason in the detail; it describes nothing until you fix the setting.

## Mix models

The brain's [hooks](../../start/glossary.md#hook) can each use a different model from the main one. A popular combination is a big hosted model for what the co-host says and a small local one, such as a 3-billion-parameter model, for the quick judgement calls (`brain.salience.module.llm`, `brain.affect.module.llm`, `brain.cortex.critic.llm`). The [Brain hooks page](../../advanced/extend/hooks.md) shows how.

::: aside
A bigger brain will not make me funnier on its own. It will just make me wrong in longer sentences. That is what the personality file is for.
:::

## How you know it worked

- The dashboard's **Services** screen shows `cortex` as `up` with mode `live` ([Service health](../operate/health.md) explains the columns).
- Send a line with **Test inputs** on the **Live** screen and the reply reads in the new model's style.
- For a local model, `docker compose ps` lists the `models` one-shot as exited after it has downloaded.

## If it didn't

- `cortex` is `degraded` or the replies never come: the model server may be unreachable or the key wrong. Check `llm.openai.base_url`, the key in `secrets.yaml` and the [cortex](../../start/glossary.md#cortex)'s detail in the **Why** column of the Services screen. See [Troubleshooting](../troubleshooting.md).
- The download is stuck or failed: the `models` one-shot exits with an error if the main, vision or embedding model fails to download. Check your disk space and connection and press **Launch** again.
- Replies are cut short or empty on Claude: raise `llm.claude.max_tokens`, since thinking and the reply share it.
