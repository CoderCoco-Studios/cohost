# Brain hooks: rules, an LLM call, or your own model

Three regions expose a hook where their judgement lives. Each hook runs one of
three kinds, chosen per hook in `.env` (wired through `config/config.yaml`):

| hook                | region   | question it answers                          | `.env` keys                                  |
| ------------------- | -------- | -------------------------------------------- | -------------------------------------------- |
| `salience.module`   | salience | how much does each event deserve a reaction? | `SALIENCE_MODULE`, `SALIENCE_MODULE_URL`     |
| `affect.module`     | affect   | how does this line move my mood?             | `AFFECT_MODULE`, `AFFECT_MODULE_URL`         |
| `cortex.critic`     | cortex   | is this reply okay to say out loud?          | `CORTEX_CRITIC`, `CORTEX_CRITIC_URL`         |

| kind    | what runs                                                     | latency      | needs              |
| ------- | ------------------------------------------------------------- | ------------ | ------------------ |
| `rules` | the built-in heuristics (default)                             | none         | nothing            |
| `llm`   | a chat model, answer parsed as JSON                           | one LLM call | any `llm` provider |
| `http`  | `POST` to a URL you serve — a model you trained, or anything  | your call    | a running server   |

Whatever the kind, a timeout, an error, or an unparseable answer falls back to
`rules`, so a module can die mid-stream and the co-host keeps going.

## 1. `rules` (default)

Leave the keys empty. This is what ships: fixed weights in salience, word
lists in affect, pass-through in the critic.

```ini
SALIENCE_MODULE=
AFFECT_MODULE=
CORTEX_CRITIC=
```

## 2. `llm`: a sub-region that is its own model call

Each hook becomes one extra chat request with a JSON reply. Point the hooks at
a small, fast model so they don't compete with the cortex for the GPU:

```ini
# the cortex keeps talking through Claude ...
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-5-5
ANTHROPIC_API_KEY=sk-ant-...

# ... while the hooks use a 3B model on the local GPU
MODULE_LLM_PROVIDER=ollama
MODULE_LLM_MODEL=qwen2.5:3b-instruct

AFFECT_MODULE=llm        # mood from a model's read of each line instead of word lists
CORTEX_CRITIC=llm        # an inner editor that can veto or tighten a line before it's spoken
SALIENCE_MODULE=rules    # scoring runs every 1.5s tick; keep it on rules unless you have GPU to spare
```

Leave `MODULE_LLM_*` empty to reuse the cortex's model. The prompts live in
`services/salience/src/scoring.ts`, `services/affect/src/appraise.ts` and
`services/cortex/src/critic.ts`.

## 3. `http`: a model you trained

Serve the three endpoints and point the hooks at them. `server.py` in this
directory is a complete, dependency-free stand-in with the exact contracts:

```bash
python3 examples/modules/server.py        # :8900, /salience /affect /critic
```

```ini
SALIENCE_MODULE=http
SALIENCE_MODULE_URL=http://host.docker.internal:8900/salience
AFFECT_MODULE=http
AFFECT_MODULE_URL=http://host.docker.internal:8900/affect
CORTEX_CRITIC=http
CORTEX_CRITIC_URL=http://host.docker.internal:8900/critic
```

Mix freely: `AFFECT_MODULE=http` with a sentiment model you fine-tuned, the
critic on `llm`, salience on `rules`.

### Contracts

```
POST /salience
  { "events": [ { "kind": "chat|speech|vision", "who": "name?", "text": "...",
                  "mention": bool, "isMod": bool, "isSub": bool, "changed": bool }, ... ],
    "arousal": 0..1 }
  -> { "scores": [ 0..1, ... ] }        one per event, same order

POST /affect
  { "source": "chat|speech", "who": "name", "text": "...", "mention": bool,
    "valence": -1..1, "arousal": 0..1 }
  -> { "valence_delta": -0.5..0.5, "arousal_delta": -0.5..0.5 }

POST /critic
  { "text": "line about to be spoken", "emotion": "happy|...", "reason": "mentioned|...",
    "transcript": "recent lines" }
  -> { "ok": true }
   | { "ok": true, "text": "fixed line", "emotion": "neutral" }
   | { "ok": false, "note": "why" }
```

### Training your own

Everything a module would learn from is already on the bus and in Postgres:
`chat.message` / `speech.heard` with the `attention.focus` and `brain.say`
that followed are a labelled dataset for salience, and the `memories` table
plus `affect.state` history is one for affect. Train offline, serve behind
one of the endpoints above, flip the `.env` key. Nothing else changes.

## Adding a fourth hook

A hook is a `Module<I, O>` from `packages/modules` with a `rules` function and
optional `llm` / `http` specs. Copy `services/affect/src/appraise.ts`, add a
`ModuleSchema` field under the region in `packages/config/src/schema.ts`, and
call `module.run(input)` where the judgement used to be inline.
