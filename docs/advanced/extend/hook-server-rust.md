---
title: Hook server in Rust
description: Build and run a Rust server that answers the three brain hooks with only the standard library and serde_json, check it with the try-it script, point cohost at it and put your own model behind it.
track: advanced
verified: f126b94
---

# Hook server in Rust

You will have a small Rust server that answers the three brain [hooks](../../start/glossary.md#hook) ([salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect) and the critic), checked by a script and wired into your co-host. [Brain hooks](hooks.md) is the contract it follows. The server here is a toy: each handler is a few lines where a model you trained or chose goes.

## What you need

- Rust and `cargo`, which come from the checkout's `mise.toml` through `mise install`. The first build downloads one crate, `serde_json`, so it needs a network connection once.
- `curl` and a shell, for the try-it script.
- A checkout of cohost with mise, with the commands run from its top folder. [Developer setup](../dev-setup.md) covers it.
- For pointing the co-host at it: [Docker](../../start/glossary.md#docker), if the services run in [containers](../../start/glossary.md#container).

## Steps

1. Build and start the server. It listens on port 8900 and prints `listening on 8900`. The package belongs to the examples workspace, `examples/Cargo.toml`, which is separate from the one the services use. Give another port after `--` (`mise run example:hook-server:rust -- 8910`), or `0` for any free port.

   ```sh
   mise run example:hook-server:rust
   ```

2. In a second terminal, ask it the three questions cohost asks, with the try-it script (it is the same script for every language).

   ```sh
   mise run example:hook-try
   ```

   The script is these three requests:

   <<< @/../examples/modules/try.sh#requests

   It prints one reply per line. They should read, once the spacing is ignored:

   <<< @/../examples/modules/try.expected.txt

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

The package is two files. Its manifest depends on `serde_json` and nothing else, which keeps the build short:

<<< @/../examples/modules/rust/Cargo.toml

And its code, `examples/modules/rust/src/main.rs`:

<<< @/../examples/modules/rust/src/main.rs

The server reads each HTTP request by hand from a `TcpListener`: the request line, the headers, then as many body bytes as `Content-Length` says. It answers with `Connection: close`, one request on each connection, and gives every connection its own thread, so a client that stalls halfway through its request never holds up the others. That is enough for a hook, which is one JSON request and one JSON reply.

## Put your model in

Replace the body of one function and leave the plumbing alone. Each handler takes the parsed request (a `serde_json::Value`) and returns the reply as a `Value`, or an error message, so a model call fits straight in. Here is the critic, which blocks a line with a link and trims a longer one to a sentence:

<<< @/../examples/modules/rust/src/main.rs#critic

To run a model in Rust, add its crate to this package's `Cargo.toml` and load it once in `main`, not inside the handler, because a handler runs for every decision and the region gives up on a call after `timeout_ms`. A late reply is dropped and the rules answer instead.

A handler that returns an error does no harm. The server answers 500 with the message, and the region uses its rules for that call. Run `mise run example:hook-try` again after each change to see that the replies still have the right shape.

## How you know it worked

- `mise run example:hook-try` prints the three lines above.
- The Services screen shows `hook.<name>` as `ok` under the dependencies of the service that owns the hook, and its log has no `module failed` warnings.
- Stop the server: the co-host keeps talking with the rules answers, and the region logs one warning, not one for each call.

## If it didn't

- **`cargo` cannot download `serde_json`.** The first build needs the network. Run it once while online; later builds work offline.
- **`try.sh` prints nothing, or `curl` cannot connect.** The server is not running, or it listens on another port. Start it again and check the address you gave `try.sh`.
- **`Address already in use`.** Another program has port 8900. Stop it, or give the server another port after `--` and `try.sh` that address.
- **A line differs from the expected one.** Read the difference against the contract on [Brain hooks](hooks.md): a wrong type, a missing field or scores in the wrong order each make the region use its rules.
- **Connection refused from a container.** Use `host.docker.internal`, not `localhost`, in `url`. The server already listens on every address of your machine.
