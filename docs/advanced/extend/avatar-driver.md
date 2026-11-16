---
title: Add an avatar driver
description: Write an avatar driver that sends the co-host's face and gestures to your own program over UDP, then register it so cohost can pick it by name.
track: advanced
verified: f126b94
---

# Add an avatar driver

You will have a small avatar driver, `UdpJsonDriver`, that sends each movement of the co-host's avatar to any program that can read a UDP socket, and you will know the three edits that make cohost pick a driver by name. cohost ships drivers for [VTube Studio](../../start/glossary.md#vtube-studio) and for the [VMC](../../start/glossary.md#vmc) protocol; this page is for an app neither of them reaches.

## What you need

- A checkout of cohost, with the commands run from its top folder. [Developer setup](../dev-setup.md) covers it.
- The workspace built once with `pnpm build`, because the type check at the end reads the built packages.
- A program that listens on a UDP port and reads JSON. The driver's side of the conversation is only a sender, so nothing here needs that program to exist yet.

## How a driver fits

The avatar service owns everything about timing. Its engine smooths the mood and the mouth into one set of numbers, and calls the driver at `avatar.fps` frames a second, 30 by default, with them. The driver does not decide anything; it translates. That is the whole contract, and it has three kinds of call:

| The engine calls | When | What the driver does |
| --- | --- | --- |
| `setParams` | Every frame | Passes the mouth, head, eye and blink numbers on |
| `setExpression` | When the emotion changes | Names the app's own expression for the canonical emotion |
| `trigger` | When the co-host performs a gesture | Names the app's own animation |

Two details matter for what you write. `connect` and `disconnect` bracket the time the driver is usable, and `connected()` tells the engine which side of that it is on. And because `setParams` runs at frame rate, the example never throws from a call: when it cannot reach its app it logs a warning and carries on.

## Steps

1. Read the driver. It is one class, and the file is the one the tests run.

   <<< @/../examples/avatar-driver/udp-json.ts#driver

   Each call becomes one JSON datagram, so the receiving program reads one JSON object per packet. `setExpression` and `trigger` look the name up in `ctx.expressions` and `ctx.gestures`, the two maps cohost reads from `config/expressions.yaml`, and send the canonical name itself when the map has nothing for it. Sending is wrapped in a `try` and has an error callback, because UDP failures arrive both ways, and both end in a log line instead of an exception.

2. See what goes over the wire. Every packet has a `type`, and the rest depends on it:

   ```text
   {"type":"params","mouthOpen":0.4,"mouthSmile":0.1,"headX":-2,"headY":0,"headZ":0,"eyeX":0,"eyeY":0,"blink":0}
   {"type":"expression","name":"Expr Happy","intensity":0.8}
   {"type":"gesture","name":"Anim Wave"}
   ```

   Angles are in degrees, the mouth and blink run from 0 to 1, and the eyes from -1 to 1. Your receiving program decides what each number does to the model.

3. Teach cohost the driver's name. The example is not registered, so this is the path your own driver takes, in three files:

   - Copy the file into `services/avatar/src/drivers/`, next to the other drivers, and change its one type import to `../types.js`. Then add a `case "udp-json"` to `createDriver` in `services/avatar/src/drivers/index.ts` that builds `new UdpJsonDriver({ host, port })` from the config, as the `vmc` case does.
   - Add `udp-json` to the `avatar.driver` list in `packages/config/src/schema.ts`, with a section beside `vmc` that holds its `host` and `port`, and the same section with defaults in `config/config.example.yaml`.
   - Add a block named `udp-json` to `config/expressions.example.yaml`, mapping the canonical emotions (`neutral happy laugh surprised smug sad angry confused think`) to the names your app uses. A gesture map is optional:

   ```text
   udp-json:
     neutral: "Idle"
     happy: "Smile"
     sad: "Frown"
     gestures:
       wave: "Wave"
   ```

   cohost copies `config/expressions.example.yaml` to `config/expressions.yaml` the first time it runs and never overwrites it afterwards, so add the same block to your own `config/expressions.yaml` too.

4. Choose the driver and restart the avatar service, so it reads the new setting. The setting is the `avatar.driver` key in `config/config.yaml`, which accepts the name once step 2 has added it to the schema:

   ```text
   avatar:
     driver: "udp-json"
   ```

## How you know it worked

- This runs the driver against a real UDP socket on your machine and prints one line for each check, ending in `pass 5`:

  ```sh
  node --import tsx --test services/avatar/test/example-driver.test.ts
  ```

- This type-checks every example against the real interfaces. It prints nothing when it is happy:

  ```sh
  pnpm exec tsc -p examples/tsconfig.json
  ```

- After step 4, your receiving program gets a `params` packet 30 times a second (the default `avatar.fps`), and an `expression` packet when the co-host's mood changes.

## If it didn't

- **The avatar service logs `udp-json send failed`.** The host or port is wrong, or the address does not resolve. The driver logs the reason and keeps going, so the service stays up; fix the address in your config and restart it.
- **cohost refuses to start with an `avatar.driver` error.** The name is missing from the list in `packages/config/src/schema.ts`. The config schema rejects any value it does not list.
- **Packets arrive but the model does not change expression.** The map has no entry for that emotion, so the canonical name went out. Add it to `config/expressions.yaml`.
- **Nothing arrives and nothing is logged.** UDP never says whether anyone is listening. Check that the service picked the driver (`avatar.driver` in `config/config.yaml`) and that your program listens on the port from the config.
