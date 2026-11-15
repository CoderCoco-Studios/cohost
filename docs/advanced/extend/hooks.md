---
title: Brain hooks
description: How rules, llm and http hooks work, the request and reply of each hook, and a runnable Python server you can start from.
track: advanced
verified: f126b94
---

# Brain hooks: rules, a model call, or your own server

A [hook](../../start/glossary.md#hook) is the one place in a [brain region](../../start/glossary.md#brain-region) where its judgement lives. [Salience](../../start/glossary.md#salience) scores [events](../../start/glossary.md#event), [affect](../../start/glossary.md#affect) works out how a line moves the mood, the [cortex](../../start/glossary.md#cortex)'s critic vets a reply before it is spoken, and memory captures and tidies notes about viewers. Each hook can run one of three kinds, and you pick per hook in `config/config.yaml`. This page is the contract, with a runnable Python example. The contract is plain HTTP and JSON, so a server in any language works.

## What you need

- A working co-host, or at least `cortex`, `salience` and `affect` running. [One service on its own](../testing/isolated.md) shows how to start them with no accounts.
- For the example: Python 3. It uses only the standard library.
- [Docker](../../start/glossary.md#docker) on the same machine, if the services run in [containers](../../start/glossary.md#container). The services reach your server by name, `host.docker.internal`.

## The five hooks

| Hook key in `config.yaml` | Region | The question it answers |
| --- | --- | --- |
| `brain.salience.module` | `salience` | How much does each event deserve a reaction? |
| `brain.affect.module` | `affect` | How does this line move the mood? |
| `brain.cortex.critic` | `cortex` | Is this reply fine to say out loud? |
| `brain.memory.notes.capture` | `memory` | Does this chat line reveal something worth a viewer note? |
| `brain.memory.notes.consolidator` | `memory` | How should these notes be merged, reworded or dropped? |

Every hook has the same shape in the config:

```yaml
module:            # or `critic:` under cortex, `capture:` and `consolidator:` under brain.memory.notes
  kind: rules      # rules | llm | http
  url: ""          # http: where to POST
  timeout_ms: 8000
  llm:             # llm: override the provider and model; empty = the same as llm.* at the top of the file
    provider: ""
    model: ""
```

| Kind | What runs | Latency | Needs |
| --- | --- | --- | --- |
| `rules` | The built-in heuristics (the default for salience, affect and the critic) | None | Nothing |
| `llm` | One chat call to a model, with the answer parsed as JSON | One [LLM](../../start/glossary.md#llm) call | Any `llm` provider |
| `http` | A `POST` to a URL you serve | Your server's | A running server |

Whatever the kind, a timeout, an error or an unusable reply falls back to the `rules` answer, so a hook can die mid-stream and the co-host keeps going. A hook that fails five calls in a row is skipped for a minute, with the rules answering meanwhile and nothing billed, then tried again. The service's [heartbeat](../../start/glossary.md#heartbeat) shows `hook.<name>` as `down` while a hook is being skipped or its provider does not answer. The keys are in [Configuration](../reference/config.md).

## `rules`

The built-in judge: fixed weights in salience, word lists in affect, a pass-through in the critic, and no note in capture.

```yaml
brain:
  salience: { module: { kind: rules } }
  affect:   { module: { kind: rules } }
  cortex:   { critic: { kind: rules } }
```

## `llm`

Each hook becomes one extra chat request with a JSON reply. Point hooks at a small, fast model so they do not compete with the cortex for the [GPU](../../start/glossary.md#gpu):

```yaml
llm:                                   # the cortex keeps talking through Claude ...
  provider: anthropic
  model: claude-opus-5-5

brain:
  affect:                              # ... mood from a model's read of each line, on a 3B local model
    module:
      kind: llm
      llm: { provider: ollama, model: "qwen2.5:3b-instruct" }
  cortex:                              # an inner editor that can veto or tighten a line before it is spoken
    critic:
      kind: llm
      llm: { provider: ollama, model: "qwen2.5:3b-instruct" }
  salience:                            # scoring runs every tick; keep it on rules unless you have GPU to spare
    module: { kind: rules }
```

Leave `llm.provider` and `llm.model` under a hook empty to reuse the cortex's model. Setting `llm.provider` on a hook requires setting `llm.model` too, because a model id is only valid for one provider, and config loading rejects the combination otherwise. The two memory hooks default to local [Ollama](../../start/glossary.md#ollama) when they name no provider, so chat lines and health or family notes stay on your machine even when the cortex uses a hosted model.

Hook calls are cut off at `timeout_ms`. The default is 8000 for every hook, long enough for a hosted Claude model with thinking; `config.example.yaml` sets the critic to 2500, capture to 20000 and the consolidator to 60000. Small local models answer in well under a second, so lower it if you want a quick give-up. The prompts live in `services/salience/src/scoring.ts`, `services/affect/src/appraise.ts`, `services/cortex/src/critic.ts`, `services/memory/src/capture.ts` and `services/memory/src/consolidator.ts`.

## `http`: your own server

cohost `POST`s the hook's input as a JSON body to exactly the `url` you configured, with `Content-Type: application/json`, and expects a successful (2xx) status with a JSON reply. Any other status, a body that is not JSON, or a reply that fails the checks below makes the region use its rules for that call. The path in the URL is yours to design; the example server routes on it.

```yaml
brain:
  salience: { module: { kind: http, url: "http://host.docker.internal:8900/salience" } }
  affect:   { module: { kind: http, url: "http://host.docker.internal:8900/affect" } }
  cortex:   { critic: { kind: http, url: "http://host.docker.internal:8900/critic", timeout_ms: 2500 } }
```

Mix freely: affect on `http` with a sentiment model you fine-tuned, the critic on `llm`, salience on `rules`.

### Salience: `POST /salience`

The request is a batch of events and the current mood's arousal:

| Field | Type | Meaning |
| --- | --- | --- |
| `events[]` | array | The events to score |
| `events[].kind` | `chat`, `speech` or `vision` | Which sense it came from |
| `events[].who` | string, optional | The speaker's name |
| `events[].text` | string | What was said or seen |
| `events[].mention` | boolean | The co-host's name was used |
| `events[].isMod`, `events[].isSub` | boolean | The viewer is a moderator or subscriber |
| `events[].changed` | boolean | A vision event that differs from the last one |
| `arousal` | number, 0 to 1 | The co-host's current energy |

The reply is `{"scores": [0.15, 1.0, ...]}`: exactly one number per event, in the same order. A score outside 0 to 1 is clamped; a wrong count is unusable and the rules answer instead.

### Affect: `POST /affect`

| Request field | Type | Meaning |
| --- | --- | --- |
| `source` | `chat` or `speech` | Where the line came from |
| `who` | string | The speaker |
| `text` | string | The line |
| `mention` | boolean | The co-host's name was used |
| `valence`, `arousal` | numbers | The current [mood](../../start/glossary.md#valence-arousal): valence from -1 to 1, arousal from 0 to 1 |

The reply is `{"valence_delta": 0.2, "arousal_delta": 0.05}`, each from -0.5 to 0.5 (larger values are clamped).

### Critic: `POST /critic`

| Request field | Type | Meaning |
| --- | --- | --- |
| `text` | string | The line about to be spoken |
| `emotion` | string | Its emotion: `neutral`, `happy`, `laugh`, `surprised`, `smug`, `sad`, `angry`, `confused` or `think` |
| `reason` | string | Why the co-host is speaking, such as `mentioned` |
| `transcript` | string | Recent lines for context |

The reply is one of:

| Reply | Effect |
| --- | --- |
| `{"ok": true}` | The line is spoken as it is |
| `{"ok": true, "text": "fixed line", "emotion": "neutral"}` | A non-empty `text` replaces the line, and `emotion` replaces its emotion |
| `{"ok": false, "note": "why"}` | The line is dropped; `note` says why |

### Memory: capture and consolidator

These two take the input shapes the memory service builds, as the JSON body.

| Hook | Request | Reply |
| --- | --- | --- |
| Capture | `viewer`, `line`, `notes[]` (texts of the viewer's notes) and `suppressionReasons[]` | `{"note": null}` for nothing worth keeping, or `{"note": {"category": "general", "text": "...", "hint": "..."}}`. `category` is `general`, `health` or `family`; `text` is at most 120 characters and `hint` at most 80, and a note about politics, money or subscriber status is refused |
| Consolidator | `viewer`, `notes[]` and `suppressionReasons[]` | `{"ops": [...]}` where each op is `{"op": "merge", "ids": [...], "text": "..."}`, `{"op": "rewrite", "id": 1, "text": "..."}` or `{"op": "drop", "id": 1}` |

The note rules are checked by the memory service whatever your server says, so a reply that breaks them is dropped.

### JSON Schemas

The replies of salience, affect and the critic are published as JSON Schema in [`examples/modules/schemas/`](https://github.com/CoderCoco-Studios/cohost/tree/main/examples/modules/schemas) (`salience.json`, `affect.json` and `critic.json`). They are generated from `packages/modules/src/schemas.ts` with `node scripts/gen-hook-schemas.mjs`, and a test checks them against each region's validator. A schema cannot say "one score per event"; the region enforces that.

## The Python example

[`examples/modules/server.py`](https://github.com/CoderCoco-Studios/cohost/blob/main/examples/modules/server.py) is a complete server for the three main hooks, standard library only, with a toy in each handler where your model goes. [`examples/modules/fixtures/contracts.json`](https://github.com/CoderCoco-Studios/cohost/blob/main/examples/modules/fixtures/contracts.json) holds sample requests and replies for each endpoint, and a test checks every one against the real validators.

Run it from the repository root:

```bash
python3 examples/modules/server.py        # listens on :8900
```

Try the endpoints:

```bash
curl -s -XPOST localhost:8900/salience -d '{"events":[{"kind":"chat","text":"hey Coco?","mention":true}],"arousal":0.2}'
curl -s -XPOST localhost:8900/affect -d '{"source":"chat","who":"a","text":"this is awesome!","mention":false,"valence":0,"arousal":0}'
curl -s -XPOST localhost:8900/critic -d '{"text":"hello","emotion":"happy","reason":"x","transcript":""}'
```

They answer `{"scores": [1.0]}`, `{"valence_delta": 0.0, "arousal_delta": 0.05}` and `{"ok": true}`. Then set a hook to `kind: http` as above and restart the service that owns it from the Services tab. The Python is short. Each endpoint is a function from the parsed request to the reply:

```python
def critic(req):
    """Should this line be said? Here: block anything with a URL, trim to one sentence."""
    text = req["text"]
    if "http" in text.lower():
        return {"ok": False, "note": "no links on air"}
    first = re.split(r"(?<=[.!?])\s+", text.strip())[0]
    if first == text:
        return {"ok": True}
    return {"ok": True, "text": first, "emotion": req.get("emotion") or "neutral"}

ROUTES = {"/salience": salience, "/affect": affect, "/critic": critic}
```

and the plumbing serves one request per thread, so a slow call never blocks the others: `ThreadingHTTPServer` with daemon threads, a handler that reads the JSON body, picks the function by path, and answers `200` with the reply, or `500` with an error (which makes the region use its rules).

## How you know it worked

- The region's log has no `module failed` warnings, and your server's log shows a request per decision.
- The Services tab shows `hook.<name>` as `ok` under the service's dependencies. It shows `down` while the hook is being skipped.
- Stop your server: the co-host keeps talking with the rules answers, and the region logs one warning, not one per call.

## If it didn't

- **`module returned something unusable; using rules`.** The reply failed the checks above: a wrong score count, a missing field, a delta of the wrong type. Compare it with the contract and with `examples/modules/fixtures/contracts.json`.
- **Connection refused from a container.** Use `host.docker.internal`, not `localhost`, in `url`, and bind your server to `0.0.0.0` as the example does.
- **The hook is `down` after a few failures.** Five failures in a row start a one-minute skip. Fix the server; the next try after the minute restores it.
- **Config refuses to load.** `kind: http` needs a non-empty `url`, and `llm.provider` on a hook needs `llm.model`.

## Training your own

Everything a hook would learn from is already on the [bus](../../start/glossary.md#bus) and in [Postgres](../../start/glossary.md#postgres). `chat.message` and `speech.heard` events, with the `attention.focus` and `brain.say` that followed them, form a labelled dataset for salience. The `memories` table and the `affect.state` history form one for affect. Train offline, serve the model behind one of the endpoints above, and set `kind: http` in `config.yaml`. Nothing else changes.

## Adding a sixth hook

A hook is a `Module<I, O>` from `packages/modules` with a `rules` function and optional `llm` and `http` specs. Copy `services/affect/src/appraise.ts`, add a `ModuleSchema` field under the region in `packages/config/src/schema.ts`, and call `module.run(input)` where the judgement used to be inline.
