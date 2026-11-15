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

Which model answers is a `config/config.yaml` setting, `llm.provider`. The model's name goes in `llm.model`, written the way that provider names it. Secrets such as API keys never go in `config.yaml`; they go in `.env`.

| `llm.provider` | What it is | Key in `.env` |
| --- | --- | --- |
| `ollama` | A model on your own [GPU](../../start/glossary.md#gpu), run by [Ollama](../../start/glossary.md#ollama). The default. | none |
| `openai` | Any server that speaks the OpenAI chat format: a GPU box you rent by the hour, or a hosted router such as OpenRouter, Groq, Together or Fireworks. | `LLM_API_KEY` |
| `anthropic` | Claude through the Claude API. | `ANTHROPIC_API_KEY` |
| `bedrock` | Claude through Amazon Bedrock, billed to your AWS account. | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

Two things stay local whatever you choose. The [embeddings](../../start/glossary.md#embedding) that power [memory](memory.md) always come from local Ollama, so switching the chat model never changes the memory database. And the small model that writes [viewer notes](memory.md) defaults to local Ollama too, so chat lines and sensitive notes do not leave your machine unless you name another provider for that hook.

What does leave the machine with a hosted choice is the text the co-host's brain sends to the model: the prompt with recent chat, memories and the [personality](personality.md), and the reflection pass after a stream.

After changing `config.yaml`, restart the parts that read the `llm` section. Each is one command:

```bash
pnpm cohostctl restart cortex
pnpm cohostctl restart memory
pnpm cohostctl restart salience
pnpm cohostctl restart affect
```

Or press **Save** on the dashboard's **settings** tab and let it offer to restart them. After changing `.env`, press **Launch** again in the dashboard so the [containers](../../start/glossary.md#container) see the new values; the [Starting and stopping](../operate/start-stop.md) page explains Launch.

## Local GPU (the default)

```yaml
llm:
  provider: ollama
  model: "${LLM_MODEL}"
```

The model name comes from `.env`, so the stack's `models` one-shot can download it on Launch. Pick a size to match your card's video memory (VRAM):

```dotenv
LLM_MODEL=qwen2.5:7b-instruct-q4_K_M
# 12 GB of VRAM or more:
# LLM_MODEL=qwen2.5:14b-instruct-q4_K_M
```

The first one suits an 8 GB card. To upgrade your card later, change the line in `.env` and press **Launch**. Nothing else changes. The first download is several gigabytes, so give it a few minutes.

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
    api_key: "${LLM_API_KEY}"
```

```dotenv
LLM_API_KEY=change-me
```

Use a real secret instead of `change-me`, and the same one on both sides. A plain `http://` address sends that key and your chat over the open internet; put the box behind HTTPS or an SSH tunnel if it is not on your own network.

### A hosted router

The same shape works for hosted routers (OpenRouter, Groq, Together, Fireworks): their base URL, your key, and their model id. For OpenRouter:

```yaml
llm:
  provider: openai
  model: meta-llama/llama-3.3-70b-instruct
  openai: { base_url: "https://openrouter.ai/api/v1", api_key: "${LLM_API_KEY}" }
```

## Claude through the Claude API

```yaml
llm:
  provider: anthropic
  model: claude-opus-5-5
  claude:
    api_key: "${ANTHROPIC_API_KEY}"
    effort: low
    max_tokens: 2048
    fallbacks: true
```

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
```

The `claude` keys tune how Claude answers:

| Key | Meaning |
| --- | --- |
| `effort` | How hard it thinks. `low` suits one-line replies. |
| `max_tokens` | A cap on thinking and the reply together, so leave it roomier than the 120 used for local models. |
| `fallbacks` | If a safety check declines a reply, retry on another Claude model. Claude API only. |

## Claude through Amazon Bedrock

Bedrock bills to your AWS account. In the Bedrock console, enable the model for your region first.

```yaml
llm:
  provider: bedrock
  model: anthropic.claude-opus-5-5
  bedrock: { region: us-east-1 }
```

Put your AWS keys in `.env`:

```dotenv
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

The keys go in `.env` because the stack's containers do not mount your home directory, so an AWS profile in `~/.aws` is not visible to them. On an AWS machine with an instance role, the role works too. An empty `bedrock.region` uses `AWS_REGION` from `.env`.

Server-side fallbacks are not offered on Bedrock; if a safety check declines a reply, the co-host says nothing that turn. Bedrock models other than Claude (Llama, Mistral) are not covered by this provider.

## Mix models

The brain's [hooks](../../start/glossary.md#hook) can each use a different model from the main one. A popular combination is a big hosted model for what the co-host says and a small local one, such as a 3-billion-parameter model, for the quick judgement calls (`brain.salience.module.llm`, `brain.affect.module.llm`, `brain.cortex.critic.llm`). The [Brain hooks page](../../advanced/extend/hooks.md) shows how.

::: aside
A bigger brain will not make me funnier on its own. It will just make me wrong in longer sentences. That is what the personality file is for.
:::

## How you know it worked

- The dashboard's **services** tab shows `cortex` as `up` with mode `live` ([Service health](../operate/health.md) explains the columns).
- Send a line with **test inputs** on the live tab and the reply reads in the new model's style.
- For a local model, `docker compose ps` lists the `models` one-shot as exited after it has downloaded.

## If it didn't

- `cortex` is `degraded` or the replies never come: the model server may be unreachable or the key wrong. Check `llm.openai.base_url`, the key in `.env` and the [cortex](../../start/glossary.md#cortex)'s detail column on the services tab. See [Troubleshooting](../troubleshooting.md).
- The download is stuck or failed: the `models` one-shot exits with an error if the main, vision or embedding model fails to download. Check your disk space and connection and press **Launch** again.
- Replies are cut short or empty on Claude: raise `llm.claude.max_tokens`, since thinking and the reply share it.
