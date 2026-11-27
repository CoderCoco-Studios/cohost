---
title: Hook server in Python
description: Run a Python server that answers the three brain hooks, check it with the try-it script, point cohost at it and put your own model behind it.
track: advanced
verified: f126b94
---

# Hook server in Python

You will have a small Python server that answers the three brain [hooks](../../start/glossary.md#hook) ([salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect) and the critic), checked by a script and wired into your co-host. [Brain hooks](hooks.md) is the contract it follows. The server here is a toy: each handler is a few lines where a model you trained or chose goes.

## What you need

- Python 3, which comes from the checkout's `mise.toml` through `mise install`. The server uses only its standard library, so there is nothing to install.
- `curl` and a shell, for the try-it script.
- A checkout of cohost with mise, with the commands run from its top folder. [Developer setup](../dev-setup.md) covers it.
- For pointing the co-host at it: [Docker](../../start/glossary.md#docker), if the services run in [containers](../../start/glossary.md#container).

## Steps

1. Start the server. It listens on port 8900 and prints one line for each request it answers.

   ```sh
   mise run example:hook-server:py
   ```

2. In a second terminal, ask it the three questions cohost asks, with the try-it script (it is the same script for every language).

   ```sh
   mise run example:hook-try
   ```

   The script is these three requests:

   <<< @/../examples/modules/try.sh#requests

   It prints one reply per line. They should read, once the spacing is ignored:

   <<< @/../examples/modules/try.expected.txt

   Python writes a space after each colon and comma; the check compares the JSON, so that difference does not matter.

3. Point a hook at it in `config/config.yaml`. The services run in containers, so they reach a server on your machine by the name `host.docker.internal`, not `localhost`.

   ```yaml
   brain:
     salience: { module: { kind: http, url: "http://host.docker.internal:8900/salience" } }
     affect:   { module: { kind: http, url: "http://host.docker.internal:8900/affect" } }
     cortex:   { critic: { kind: http, url: "http://host.docker.internal:8900/critic", timeout_ms: 2500 } }
   ```

4. Restart the service that owns each hook, so it reads the new address. The dashboard's Services screen has a Restart button on its row.

A hook server is not a service, so there is no [heartbeat](../../start/glossary.md#heartbeat) of its own to look for: it sends no heartbeat, and nothing on the Services screen lists it. The service that calls it shows its health, as the `hook.<name>` dependency. When your server is down, the region answers with its built-in rules and keeps going.

## The whole server

This is `examples/modules/server.py`, the file the script is checked against:

<<< @/../examples/modules/server.py

The three functions near the top are the judgements. Everything under `# --- plumbing` reads the request, picks a function by path and writes the reply. It handles each request on its own thread, so one slow or stalled client never holds up the others.

## Put your model in

Replace the body of one function and leave the plumbing alone. Each handler takes the parsed request (a dictionary) and returns the reply (a dictionary), so a model call fits straight in. For salience, a reply with one score between 0 and 1 for each [event](../../start/glossary.md#event), in the same order:

<<< @/../examples/modules/server.py#salience

Load your model once, at the top of the file, not inside the function: a handler runs for every decision, and the region gives up on a call after `timeout_ms`. If your model needs a [GPU](../../start/glossary.md#gpu) or is slow, lower its work per call rather than raising the timeout, because a late reply is dropped and the rules answer instead.

A handler that raises an error does no harm. The server answers 500 with the error text, and the region uses its rules for that call. Run `mise run example:hook-try` again after each change to see that the replies still have the right shape.

## How you know it worked

- `mise run example:hook-try` prints the three lines above.
- The server's terminal shows a `/salience`, `/affect` or `/critic` line for each decision once a hook points at it.
- The Services screen shows `hook.<name>` as `ok` under the dependencies of the service that owns the hook, and its log has no `module failed` warnings.

## If it didn't

- **`try.sh` prints nothing, or `curl` cannot connect.** The server is not running, or it listens on another port. Start it again and check the address you gave `try.sh`.
- **`Address already in use`.** Another program has port 8900. Stop it, or stop the earlier copy of this server.
- **A line differs from the expected one.** Read the difference against the contract on [Brain hooks](hooks.md): a wrong type, a missing field or scores in the wrong order each make the region use its rules.
- **Connection refused from a container.** Use `host.docker.internal`, not `localhost`, in `url`. The server already listens on every address of your machine.
- **The hook shows `down`.** Five failed calls in a row make the region skip the hook for a minute. Fix the server; the next call after the minute restores it.
