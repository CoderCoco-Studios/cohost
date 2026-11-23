---
title: Rust bus client
description: Run a Rust program that appears on the dashboard with its own heartbeat and prints the type and source of every event on the bus, and learn what the Rust bus client does and does not give you.
track: advanced
verified: f126b94
---

# Rust bus client

You will have a Rust program on the cohost [bus](../../start/glossary.md#bus). It publishes its own [heartbeat](../../start/glossary.md#heartbeat), so it appears on the dashboard's Services screen beside the services cohost ships, and it prints one line for every [event](../../start/glossary.md#event) it sees. It uses only `crates/cohost-bus`, the Rust bus client, which is what a Rust service gets today.

## What the Rust client is

`crates/cohost-bus` is a client and not a runtime. It gives you the connections to [Redis](../../start/glossary.md#redis), every command the bus issues, and a typed codec for `service.heartbeat` and for the [connector](../../start/glossary.md#connector) registration. There is no shared runtime for Rust: nothing builds the logger, starts the heartbeat, handles shutdown or loads the config for you, as `runService` does for a TypeScript service. So:

- A Rust service publishes its own heartbeats, on its own timer. The example does, in a few lines.
- A Rust service answers `control` commands, such as the dashboard's start, stop and say, and `inject.request` test inputs, only if it implements them. The example implements neither, so the dashboard cannot stop it or feed it a test input.
- The codec checks `service.heartbeat` and the connector registration, and no other event type. Another type is added to the codec together with its contract fixtures, the JSON files in `packages/bus/fixtures/contract/` that both languages are tested against. Until then a Rust service should not publish or decode a payload of that type. The example publishes no event on the events stream for that reason, and reads only the envelope of the events it sees: their type and their source.

If you want a service that has all of those without writing them, [Add a TypeScript service](typescript-service.md) is the route with a runtime.

## What you need

- A checkout of cohost, with the commands run from its top folder. [Developer setup](../dev-setup.md) covers it.
- A Rust toolchain, the one `rust-toolchain.toml` pins, which Developer setup also covers.
- Redis running on `localhost:6379`, in a [container](../../start/glossary.md#container) as Developer setup describes, or at the address in `REDIS_URL`.

## Steps

1. Look at the manifest. The example is its own small Cargo workspace, `examples/Cargo.toml`, kept apart from the root so building the services never needs it. Its package depends on `cohost-bus` by path and on two crates the bus client already uses, at the same versions.

   <<< @/../examples/rust-bus/Cargo.toml

2. Read the heartbeat. It builds the typed `Heartbeat`, turns it into JSON, checks that JSON with `parse_heartbeat`, and only then appends it to the health stream. A heartbeat the contract would reject never leaves the program.

   <<< @/../examples/rust-bus/src/lib.rs#heartbeat

3. Read the loop. `run` publishes a heartbeat at once and every five seconds, creates a [consumer group](../../start/glossary.md#consumer-group) of its own at the end of the stream, and reads with it. For each event it writes `<type> from <source>` and acknowledges the entry. When it is asked to stop, it publishes one last heartbeat with the state `stopping` and closes the connection.

   <<< @/../examples/rust-bus/src/lib.rs#run

   The loop looks at the stop signal between reads and never inside one. A read that is cancelled halfway could drop entries Redis has already handed over, so stopping takes at most the read's block time of one second.

4. Read the program. It connects to `REDIS_URL`, or `redis://127.0.0.1:6379`, with the prefix `cohost`, and stops on Ctrl-C.

   <<< @/../examples/rust-bus/src/main.rs#main

5. Run it. The first build compiles the dependencies, so it takes a while.

   ```sh
   cargo run --manifest-path examples/Cargo.toml -p cohost-example-bus
   ```

6. In a second terminal, publish an event. The program prints its type and its source.

   ```sh
   node --import tsx scripts/dev/bus-pub.ts brain.say '{"id":"t1","text":"hello from the bus","emotion":"happy"}'
   ```

   The program's terminal shows `brain.say from dev-pub`. Press Ctrl-C there and it exits with status 0, after one more heartbeat.

## How you know it worked

- The Services screen of the [dashboard](../../guide/operate/dashboard.md) lists `rust-example` as `up`. When you press Ctrl-C its last heartbeat says `stopping`, and the row turns `down`.
- Each event on the bus, including the ones other services publish, becomes one line in the program's terminal.
- This runs the example's tests. They need Redis, and they choose a stream prefix of their own, so they never touch the `cohost` one. With `REDIS_URL` unset and no Redis on the default address they print `SKIP` and pass; with `REDIS_URL` set and Redis unreachable they fail:

  ```sh
  cargo test --manifest-path examples/Cargo.toml -p cohost-example-bus
  ```

## If it didn't

- **`rust-example: ...` and exit status 1.** The program could not reach Redis, or the connection dropped. The message names the cause. Start Redis, or set `REDIS_URL`, and run it again.
- **It runs but prints nothing.** The consumer group starts at the end of the stream, so it shows events published after it started. Publish one, as in step 6.
- **The Services screen does not list it.** The dashboard reads the health stream under the prefix `cohost`, and the program uses that prefix. Check that both use the same Redis.
- **The tests print `SKIP`.** `REDIS_URL` is unset and nothing answers at `redis://127.0.0.1:6379`, which is how the tests behave without Redis. Start Redis to run them for real. If `REDIS_URL` is set and Redis is unreachable, they fail instead.
