# Choosing the model behind the cortex

`LLM_PROVIDER` in `.env` picks who answers; everything else in the stack stays
local (embeddings included, so memory never has to be rebuilt). Restart with
`docker compose up -d cortex memory` after changing these.

## Local GPU (default)

```ini
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:7b-instruct-q4_K_M      # 8 GB VRAM
# LLM_MODEL=qwen2.5:14b-instruct-q4_K_M   # 12 GB+
docker compose up -d models                 # pulls whatever LLM_MODEL names
```

## A GPU box you rent by the hour (vLLM, TGI, llama.cpp server)

Anything that serves `POST /v1/chat/completions`. On the box:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key change-me
```

Here:

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=http://<box-ip>:8000/v1
LLM_API_KEY=change-me
LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct
```

The same three keys work for hosted routers (OpenRouter, Groq, Together,
Fireworks): use their base URL, key and model id.

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=meta-llama/llama-3.3-70b-instruct
```

## Claude via the Claude API

```ini
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-5-5
ANTHROPIC_API_KEY=sk-ant-...
```

`llm.claude.*` in `config/config.yaml` tunes it: `effort: low` suits one-line
replies, `max_tokens: 2048` leaves room for thinking (it shares the cap with
the reply), `fallbacks: true` retries on another Claude model if a safety
classifier declines a request.

## Claude via Amazon Bedrock

Billed to your AWS account. Enable the model in the Bedrock console for your
region first.

```ini
LLM_PROVIDER=bedrock
LLM_MODEL=anthropic.claude-opus-5-5
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
# or AWS_PROFILE=... with a mounted ~/.aws, or an instance role on EC2
```

Server-side fallbacks aren't offered on Bedrock; a classifier decline simply
means the co-host says nothing that turn. Non-Claude Bedrock models (Llama,
Mistral) aren't covered by this provider.

## Mixing

The cortex and the hooks can use different providers: Claude for what it says,
a 3B local model for the hooks (`MODULE_LLM_PROVIDER` / `MODULE_LLM_MODEL`).
See `../modules/README.md`.
