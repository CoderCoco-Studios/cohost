# Choosing the model behind the cortex

`llm.provider` in `config/config.yaml` picks who answers; only the API key goes
in `.env`. Everything else in the stack stays local (embeddings included, so
memory never has to be rebuilt). Restart with `docker compose up -d cortex memory salience affect`
after changing these.

## Local GPU (default)

```yaml
llm:
  provider: ollama
  model: "${LLM_MODEL}"        # the tag in .env, so `docker compose up models` can pull it
```

```ini
LLM_MODEL=qwen2.5:7b-instruct-q4_K_M      # 8 GB VRAM
# LLM_MODEL=qwen2.5:14b-instruct-q4_K_M   # 12 GB+
```

## A GPU box you rent by the hour (vLLM, TGI, llama.cpp server)

Anything that serves `POST /v1/chat/completions`. On the box:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key change-me
```

Here:

```yaml
llm:
  provider: openai
  model: meta-llama/Llama-3.3-70B-Instruct
  openai:
    base_url: "http://<box-ip>:8000/v1"
    api_key: "${LLM_API_KEY}"
```

```ini
LLM_API_KEY=change-me
```

The same shape works for hosted routers (OpenRouter, Groq, Together,
Fireworks): their base URL, key and model id.

```yaml
llm:
  provider: openai
  model: meta-llama/llama-3.3-70b-instruct
  openai: { base_url: "https://openrouter.ai/api/v1", api_key: "${LLM_API_KEY}" }
```

## Claude via the Claude API

```yaml
llm:
  provider: anthropic
  model: claude-opus-5-5
  claude:
    api_key: "${ANTHROPIC_API_KEY}"
    effort: low          # thinking depth; low suits one-line replies
    max_tokens: 2048     # thinking and the reply share this cap
    fallbacks: true      # retry on another Claude model if a safety classifier declines
```

```ini
ANTHROPIC_API_KEY=sk-ant-...
```

## Claude via Amazon Bedrock

Billed to your AWS account. Enable the model in the Bedrock console for your
region first.

```yaml
llm:
  provider: bedrock
  model: anthropic.claude-opus-5-5
  bedrock: { region: us-east-1 }
```

```ini
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
# or AWS_PROFILE=... with a mounted ~/.aws, or an instance role on EC2
```

Server-side fallbacks aren't offered on Bedrock; a classifier decline simply
means the co-host says nothing that turn. Non-Claude Bedrock models (Llama,
Mistral) aren't covered by this provider.

## Mixing

The cortex and the hooks can use different providers: Claude for what it says,
a 3B local model for the hooks (`brain.<region>.module.llm`). See
`../modules/README.md`.
