# Examples

- `providers/` — `.env` recipes for each model backend: local Ollama, a rented
  GPU box or hosted router (OpenAI-compatible), Claude API, Amazon Bedrock.
- `modules/` — the three brain hooks (salience scoring, affect appraisal, the
  cortex critic) as rules, as an LLM call, or as your own model over HTTP,
  with a runnable `server.py` stand-in.
