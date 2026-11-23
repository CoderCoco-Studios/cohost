---
title: Your own model server
description: What cohost asks of an OpenAI-compatible model server, and how to check a connection against a stub server before you point the co-host at a real one.
track: advanced
verified: f126b94
---

# Your own model server

You will have a [language model](../../start/glossary.md#llm) server that cohost can talk to, and a way to check the connection that works with any server. This page is the developer view: what cohost sends and what it reads back. Picking a provider and the copy-paste recipes for each live on [Choose a model](../../guide/tune/model.md).

## What you need

- A working checkout of cohost, or at least its `config/config.yaml`. [Developer setup](../dev-setup.md) covers it.
- Python 3 for `stub.py`, or Node 22.18 or later for `stub.ts`. The TypeScript file runs with `node` on Node 22.18 or later, which strips the types, so there is nothing to install.
- `curl`, which `try.sh` uses.
- For a real server: its own documentation. cohost only needs its address, so this page gives no launch commands for third-party servers. See the documentation of [vLLM](https://docs.vllm.ai/), [llama.cpp's server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) or [OpenRouter](https://openrouter.ai/docs) for theirs.

## What cohost asks of the server

Setting `llm.provider` to `openai` makes cohost speak the OpenAI chat format to whatever address `llm.openai.base_url` holds. It makes two kinds of request, both under that base URL:

| Request | Used for | What cohost reads |
| --- | --- | --- |
| `GET <base_url>/models` | The health check, run when `cortex` starts and retried every 3 seconds while it fails | Only that the status is 200 |
| `POST <base_url>/chat/completions` | Every line the co-host writes, and every `llm`-kind [hook](../../start/glossary.md#hook) call | `choices[0].message.content` of a reply that is not streamed; `delta.content` of each `data:` chunk of a streamed reply |

A server therefore has to honour four things: a reply in one of two forms, a `choices[0].message.content` string, the `/models` route answering 200, and, when `llm.openai.api_key` is set, the `Authorization: Bearer` header. A non-streamed call (`"stream": false`) is answered with one JSON body. A streamed call (`"stream": true`) is answered with a server-sent stream of `data:` chunks whose `delta.content` carries the text, the chunk with a `finish_reason` ends the reply, and a closing `data: [DONE]` is optional. A server that answers a streamed call with a single `application/json` body instead still works: cohost reads that body as the whole reply. The request carries `model`, `messages`, `temperature` and `max_tokens`. A chat turn also carries `stop` words that keep the model from writing the next speaker's line, and a hook call that wants JSON carries `response_format` with `json_object` instead. A server may ignore either.

When a request offers tools (the `tools` key, a list of functions with a name, a description and a JSON Schema for the arguments), a server that supports them answers a call the model wants to make in `choices[0].message.tool_calls`: one entry per call, `{"id": "...", "type": "function", "function": {"name": "...", "arguments": "<JSON string>"}}`, with `finish_reason` `tool_calls`. Arguments that are not a JSON object reach cohost as an invalid call and are sent back as `{}`. A streamed reply carries the call in `delta.tool_calls` fragments, each with the call's `index`: the `id` and `name` come first, and the `arguments` string is split across fragments. If the token limit (`finish_reason` `length`) cuts a call's arguments short, cohost drops that call and keeps the complete ones. A request with tools carries no `stop` words. A server that ignores `tools` answers as above and cohost reads text with no calls. The follow-up request that carries a call's result sends the assistant message with its `tool_calls` (`content` is `null` when the model wrote no text) and one `role: "tool"` message per result, with the call's `tool_call_id`; a server that supports tools must accept both.

Only chat goes to this server. [Embeddings](../../start/glossary.md#embedding), which power [memory](../../guide/tune/memory.md), are not sent to the model server: memory embeds with [Ollama](../../start/glossary.md#ollama) or the hash embedder, chosen by `brain.memory.embedder`, so changing the chat server never changes the memory database.

The co-host expects its reply as an emotion tag then the line, such as `[happy] Hello chat!`. The [cortex](../../start/glossary.md#cortex) reads the tag to drive the avatar. A model that does not write the tag still speaks; the line just carries no emotion.

## Check a connection against the stub

The stub is the smallest server that satisfies cohost, so it shows the shape cohost reads. It answers `GET /v1/models` with a one-model list and `POST /v1/chat/completions` with one fixed completion, whatever the request holds. Everything else gets a 404. There is one in Python and one in TypeScript. They behave the same.

The routes of the Python one:

<<< @/../examples/model-stub/stub.py#routes

The same routes in TypeScript:

<<< @/../examples/model-stub/stub.ts#routes

The reply is in the `[emotion] text` form, so a whole co-host pointed at the stub speaks a line:

<<< @/../examples/model-stub/stub.ts#reply

1. Start one stub. It listens on port 8901, a port nothing else in the stack uses, and prints `listening on 8901`. Pass another port as the first argument, or `0` for any free port.

   ```sh
   python3 examples/model-stub/stub.py
   ```

   Or, with Node:

   ```sh
   node examples/model-stub/stub.ts
   ```

2. In a second terminal, run the try-it script. It sends the two requests cohost sends:

   ```sh
   sh examples/model-stub/try.sh
   ```

   <<< @/../examples/model-stub/try.sh#requests

3. Compare what it printed with the replies the stub is expected to give, one JSON document per line:

   <<< @/../examples/model-stub/try.expected.txt

4. Run the same script against your real server by giving it the base URL, the one you would put in `llm.openai.base_url`:

   ```sh
   sh examples/model-stub/try.sh http://my-gpu-box:8000/v1
   ```

   The second reply will differ, since a real model writes its own words. What matters is the shape: a `choices` list whose first entry holds `message` with a `content` string.

## Point cohost at it

The settings are these three, shown here with the stub's address. Merge them into `config/config.yaml`, which keeps every other `llm` key as it was:

```yaml
llm:
  provider: openai
  model: stub
  openai:
    base_url: "http://127.0.0.1:8901/v1"
```

`model` is the name the server knows its model by, and the stub accepts any. A real server wants its own model id there. When the server needs a key, put it in `config/secrets.yaml` as `llm.openai.api_key`, as [Choose a model](../../guide/tune/model.md) describes. From inside a [container](../../start/glossary.md#container) the services cannot reach your machine as `127.0.0.1`; use `host.docker.internal` in the address instead. Then restart the services that read the `llm` section: `cortex`, `memory`, `salience` and `affect`.

## How you know it worked

- `sh examples/model-stub/try.sh` prints two lines that match the expected file.
- The dashboard's Services screen shows `cortex` as `up`, and its `llm` dependency as `ok`. The [service health page](../../guide/operate/health.md) explains the columns.
- A line sent with **Test inputs** on the Live screen is answered with `Hello from the stub model server.` and the emotion `happy`, as the [bus](../../start/glossary.md#bus) feed on the Live screen shows.
- `pnpm test` runs this example against cohost's own client, so the stub keeps working as the provider changes.

## If it didn't

- **`curl` prints nothing, or says it cannot connect.** The stub is not running, or the base URL has the wrong host or port. Start the stub again and check that it printed `listening on`.
- **The first reply is a 404 or an HTML page.** The base URL is missing its `/v1` part, or the server mounts its routes elsewhere. cohost adds only `/models` and `/chat/completions` to the base URL.
- **The `llm` dependency of `cortex` is `down`.** The `GET /models` check failed, or a reply failed: the server is unreachable, or it answered a status other than 200. A 401 or 403 usually means `llm.openai.api_key` is wrong. The cortex's detail column on the Services screen names the address and the status.
- **The co-host stays silent after a good check.** Read `choices[0].message.content` in the second reply. An empty string, or a `null`, gives cohost nothing to say. Reasoning models sometimes spend the whole `max_tokens` thinking; raise `llm.max_tokens` or pick a model that does not.
- **Hooks of kind `llm` fall back to their rules.** The stub's reply is not JSON, so a hook that asks for JSON ignores it. That is expected with the stub. See [Brain hooks](hooks.md) for what a hook does with an unusable reply.
