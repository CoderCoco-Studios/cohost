---
title: Add a TypeScript service
description: Run a complete cohost service that watches a file and tells the co-host when the song changes, then see what it takes to make it a module of the repository.
track: advanced
verified: f126b94
---

# Add a TypeScript service

You will have a small service running on the [bus](../../start/glossary.md#bus): it watches a text file, the "now playing" file many streaming setups write, and tells the co-host when the song changes. It is built the way every cohost service is, so after running it you will know what a service must do, and which files turn it from an example into a module of the repository.

A service built on `@cohost/bus` gets what the bus gives: every [event](../../start/glossary.md#event) it publishes is checked against the event's schema, its [heartbeat](../../start/glossary.md#heartbeat) shows on the dashboard's Services screen, and a manifest entry lets the dashboard start, stop and configure it. A program that talks to [Redis](../../start/glossary.md#redis) some other way gets none of that.

## What you need

- A checkout of cohost, with the commands run from its top folder, installed and built with `pnpm install` and `pnpm build`. [Developer setup](../dev-setup.md) covers both, and covers starting Redis in a [container](../../start/glossary.md#container).
- Redis running on `localhost:6379`, which is where the services look for it by default.
- A `config/config.yaml`. Every service loads the same config, and the first run of any service creates it from `config/config.example.yaml`.
- A text file holding a song title. Create `song.txt` anywhere you like, with a title such as `Blue Monday` on one line.

## Steps

1. Read the service. It has three parts. The first is its types: what it needs from a bus, and the one small piece of state its heartbeat reads.

   <<< @/../examples/service/now-playing.ts#types

   The second is the service itself. Its four numbered comments are the four things a service does: join the bus, sense the world, clean up when stopped, and say it is ready.

   <<< @/../examples/service/now-playing.ts#main

   The third is the entry. `runService` is the one entry of every cohost service. It makes the logger, loads the config, builds the bus, starts the heartbeat in `starting`, calls your function, and arranges the clean shutdown when the process is stopped. It never declares the service ready; your function does that once it can do its job.

   <<< @/../examples/service/now-playing.ts#entry

   A few choices are worth noticing. The service publishes `vision.summary`, an event type that already exists, which the brain reads as something the co-host noticed. It reads `brain.say` through a [consumer group](../../start/glossary.md#consumer-group) of its own, started at the newest entry, so it never replays old lines. And the heartbeat's `file` dependency is `down` whenever the file cannot be read, so the Services screen shows the service as `degraded` and names the dependency, the way a real service reports a missing account.

2. Run it with the path of your file.

   ```sh
   node --import tsx examples/service/now-playing.ts song.txt
   ```

   With no path it prints a usage line and exits with status 1.

3. In a second terminal, watch the events it publishes.

   ```sh
   node --import tsx scripts/dev/bus-tail.ts vision.summary
   ```

   Change the title in `song.txt` and save. A `vision.summary` event reading `Now playing: ` and the new title appears within two seconds.

4. Make the co-host speak the title, and see the service notice. Publish a line that names the song:

   ```sh
   node --import tsx scripts/dev/bus-pub.ts brain.say '{"id":"t1","text":"I love this song, Blue Monday!","emotion":"happy"}'
   ```

   If the title in your file is `Blue Monday`, the service's terminal logs `co-host mentioned the song`. The match ignores capital letters.

## From example to module

The example is not yet a module of cohost: it has no manifest entry and no [Compose](../../start/glossary.md#docker-compose) service, so the dashboard cannot start it and does not know which settings it reads. The contract a module meets has four obligations, and the example meets the last one only. Meeting the first three is a matter of files, in this order:

1. A new folder under `services/`, named for your service, holding your file as `src/index.ts`, a `package.json` that depends on `@cohost/bus`, `@cohost/config` and `@cohost/shared` with `workspace:*`, and a `tsconfig.json` that references the packages it uses. Inside the folder, import the packages by name instead of by path.
2. An entry in `packages/control/src/manifest.ts`. It names the `config.yaml` sections the service reads, the services it uses, whether it honours `pause`, and its test input. That one entry is what makes the dashboard's settings editor, its start and stop buttons and its test panel know the service.
3. A service in `docker-compose.yml`, copied from a neighbour such as `salience`, so it starts with the rest.
4. A reference to the new folder in the root `tsconfig.json`, so `pnpm build` builds it.

A new kind of event is one more entry in `packages/bus/src/events.ts`: a name and the schema of its payload. The example avoids that on purpose, because an example that needs a new event type would have to change the bus to run.

## How you know it worked

- The Services screen of the [dashboard](../../guide/operate/dashboard.md) lists `now-playing` as `up` while the file exists, with the dependency `file: ok`. Delete the file and the row turns `degraded` within a few seconds, with `file: down`.
- `bus-tail` prints a `vision.summary` event for the first title and for each change, and none while the title stays the same.
- This runs the service against a stand-in bus, with no Redis, and every check passes:

  ```sh
  node --import tsx --test packages/testing/test/example-service.test.ts
  ```

- This type-checks the example against the real packages:

  ```sh
  pnpm exec tsc -p examples/tsconfig.json
  ```

## If it didn't

- **A usage line and nothing else.** The path was missing. Pass the file's path after the script.
- **`config` errors on start, or the process exits at once.** `runService` ends the process with status 1 when the config does not load. Run any other service once, or copy `config/config.example.yaml` to `config/config.yaml`, and try again.
- **`Cannot find module` for a path under `packages/`.** The workspace is not built. Run `pnpm build`; the example imports the built packages.
- **The service waits and prints nothing.** It cannot reach Redis. Start it, or set `REDIS_URL` to where it runs.
- **No `vision.summary` appears.** The title must be non-empty and different from the last one it published. A file the service cannot read publishes nothing, and shows as `down` on the Services screen.
