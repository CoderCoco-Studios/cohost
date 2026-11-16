---
title: Hook server in TypeScript
description: Run a TypeScript server on Node, with no packages, that answers the three brain hooks, check it with the try-it script, point cohost at it and put your own model behind it.
track: advanced
verified: f126b94
---

# Hook server in TypeScript

You will have a small TypeScript server, with nothing to install, that answers the three brain [hooks](../../start/glossary.md#hook) ([salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect) and the critic), checked by a script and wired into your co-host. [Brain hooks](hooks.md) is the contract it follows. The server here is a toy: each handler is a few lines where a model you trained or chose goes.

## What you need

- Node 22.18 or later. The file `examples/modules/server.ts` runs with `node` on Node 22.18 or later, which strips the types as it reads the file, so there is no build step and no package to install. Check with `node --version`.
- `curl` and a shell, for the try-it script.
- A checkout of cohost, with the commands run from its top folder. [Developer setup](../dev-setup.md) covers it.
- For pointing the co-host at it: [Docker](../../start/glossary.md#docker), if the services run in [containers](../../start/glossary.md#container).

## Steps

1. Start the server. It listens on port 8900 and prints `listening on 8900`. Give another port as the first argument, or `0` for any free port.

   ```sh
   node examples/modules/server.ts
   ```

2. In a second terminal, ask it the three questions cohost asks, with the try-it script (it is the same script for every language).

   ```sh
   sh examples/modules/try.sh
   ```

   The script is these three requests:

   <<< @/../examples/modules/try.sh#requests

   It prints one reply per line. They should read, once the spacing is ignored:

   <<< @/../examples/modules/try.expected.txt

   JavaScript writes `1` where the file has `1.0`; the check compares the JSON, so the two are the same number.

3. Point a hook at it in `config/config.yaml`. The services run in containers, so they reach a server on your machine by the name `host.docker.internal`, not `localhost`.

   ```yaml
   brain:
     salience: { module: { kind: http, url: "http://host.docker.internal:8900/salience" } }
     affect:   { module: { kind: http, url: "http://host.docker.internal:8900/affect" } }
     cortex:   { critic: { kind: http, url: "http://host.docker.internal:8900/critic", timeout_ms: 2500 } }
   ```

4. Restart the service that owns each hook, so it reads the new address. The dashboard's Services screen has a Restart button on its row when the controls are on.

A hook server is not a service, so there is no [heartbeat](../../start/glossary.md#heartbeat) of its own to look for: it sends no heartbeat, and nothing on the Services screen lists it. The service that calls it shows its health, as the `hook.<name>` dependency. When your server is down, the region answers with its built-in rules and keeps going.

## The whole server

This is `examples/modules/server.ts`, the file the script is checked against. It imports only Node's built-in modules, and it uses only the parts of TypeScript that Node can strip: type annotations, `type` and `interface`. Syntax that produces code at run time, such as an `enum`, will not run this way.

<<< @/../examples/modules/server.ts

Node answers requests concurrently, so a client that stalls halfway through its request never holds up the others.

## Put your model in

Replace the body of one function and leave the plumbing alone. Each handler takes the parsed request and returns the reply, so a model call fits straight in. Here is the critic, which blocks a line with a link and trims a longer one to a sentence:

<<< @/../examples/modules/server.ts#critic

To call a model that takes time, make the handler `async` and, in the plumbing, make the `end` callback `async` and `await` the call to `fn`: the reply is written when the answer is ready. Keep the call well inside `timeout_ms`, because a late reply is dropped and the rules answer instead.

A handler that throws does no harm. The server answers 500 with the message, and the region uses its rules for that call. Run `sh examples/modules/try.sh` again after each change to see that the replies still have the right shape.

## How you know it worked

- `sh examples/modules/try.sh` prints the three lines above.
- The Services screen shows `hook.<name>` as `ok` under the dependencies of the service that owns the hook, and its log has no `module failed` warnings.
- Stop the server: the co-host keeps talking with the rules answers, and the region logs one warning, not one for each call.

## If it didn't

- **`node` prints a syntax error at a type.** The Node you run is older than 22.18, so it does not strip types. Check `node --version` and update Node.
- **`try.sh` prints nothing, or `curl` cannot connect.** The server is not running, or it listens on another port. Start it again and check the address you gave `try.sh`.
- **`EADDRINUSE`.** Another program has port 8900. Stop it, or start this server on another port and give `try.sh` that address.
- **A line differs from the expected one.** Read the difference against the contract on [Brain hooks](hooks.md): a wrong type, a missing field or scores in the wrong order each make the region use its rules.
- **Connection refused from a container.** Use `host.docker.internal`, not `localhost`, in `url`. The server already listens on every address of your machine.
