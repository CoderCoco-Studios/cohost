---
title: Fake inputs
description: Put fake events on the bus and watch what comes out, from the dashboard, bus:pub and bus:tail, with three worked recipes.
track: advanced
verified: a86e930
---

# Fake inputs

Every service that talks to the outside world is a publisher and subscriber of [events](../../start/glossary.md#event) on the [bus](../../start/glossary.md#bus). To test everything downstream of one, publish the event it would have produced. This page lists every way to do that, from the most realistic to the most direct, then shows three recipes.

## What you need

- A built workspace (`mise run build`) and [Redis](../../start/glossary.md#redis) running (`mise run infra:up`). See [Developer setup](../dev-setup.md).
- The services you want to watch running. [One service on its own](isolated.md) shows how to start them with no accounts.
- For the dashboard routes: the [dashboard](../../guide/operate/dashboard.md) running (`mise run dashboard`) and the [control token](../../start/glossary.md#control-token) from your password manager, exported as `CONTROL_TOKEN` in the shell you run `curl` from (never in `.env`).

## Injection surfaces

| Surface | Where | What runs | Needs |
| --- | --- | --- | --- |
| Service-level text, image or audio | The **Test inputs** card on the **Live** screen, or `POST /inject/text` with `level: service`, `POST /inject/image`, `POST /inject/audio` | The real path through `chat`, `eyes` or `ears`: the dashboard publishes `inject.request`, the service answers with `inject.result`, and the upload travels through Redis | The target service running; a model or [STT](../../start/glossary.md#stt) server unless its stub engine is on |
| Bus-level text | `POST /inject/text` with `level: bus` and `as` set to `chat`, `speech` or `vision` | Publishes `chat.message`, `speech.heard` or `vision.summary` directly with `injected: true`; no `inject.result` | Redis and the dashboard |
| Any bus event | `mise run bus:pub -- <type> '<json>'` | A zod-validated publish with source `dev-pub` | Redis only |
| Operator controls | `POST /control` with `say`, `mute`, `unmute`, `forget_context`, `reload_personality`, `pause` or `resume`, and an optional `target` | The `control` event | Redis and the dashboard |
| A unit's declared input | The **Test** side panel on a service's row on the **Services** screen, or `POST /inject/event` with `{ unit, type, data }` | One bus event the service declares as an input, refused when that service is not running | The service running |
| Stub backends | An isolated start of the unit (the **Isolated** switch in the **Start** dialog, or `mise run cohostctl -- start <service> --isolated`), or the real keys `vision.provider: stub`, `ears.stt_engine: stub`, `voice.engine: stub`, `llm.provider: mock`, `chat.sources: [fake]`, `mouth.outputs.dryrun.enabled: true` | The service's own code with the outside call replaced | Nothing outside |

Injected events carry `injected: true`, so they are easy to tell apart on the feed. `remember` (off by default) decides whether `memory` keeps them. An injected `brain.say` is a test input only through `POST /inject/event`; the dashboard's `say` control is the operator's.

The full request and response shapes are on [HTTP routes](../reference/http.md).

## bus:pub and bus:tail

Two tasks, each running a script in `scripts/dev/` with the arguments after `--`. Redis's own `redis-cli XADD` would skip payload validation and the field layout of an event, which is why they exist.

```bash
mise run bus:pub -- --list                    # every event type
mise run bus:pub -- <type> '<json payload>'   # validate with zod, then publish
mise run bus:tail -- [--replay N] [--json] [type ...]
```

- `bus:pub` rejects a bad payload before it reaches the bus, printing the zod issues and exiting 1; an unknown type exits 2. Fields with defaults can be left out. Payload shapes are on [Bus events](../reference/events.md).
- `bus:tail` is a plain `XREAD`, not a [consumer group](../../start/glossary.md#consumer-group), so it never takes events from a service. Long arrays, such as the voice envelope, print as `[63 items]`.
- `mise run bus:tail -- avatar.state` floods the terminal at 5 events a second. Name the types you want instead of tailing everything.
- The stream persists between runs, so `--replay N` shows old traffic. `DEL cohost:events` in `redis-cli` clears it.

## Recipe A: one region alone

Run `salience` and watch it react to one chat line.

```bash
mise run dev:salience     # terminal 1
mise run bus:tail         # terminal 2
mise run bus:pub -- chat.message \
  '{"platform":"twitch","user":"viewer","text":"hey Coco what game is this?","mentionsCohost":true}'
```

Terminal 2 shows the line you published and then [salience](../../start/glossary.md#salience)'s decision:

```text
dev-pub    chat.message    {"platform":"twitch","user":"viewer","text":"hey Coco what game is this?",...,"mentionsCohost":true}
salience   attention.focus {"reason":"mentioned","score":1,"focus":{"kind":"chat","who":"viewer",...,"mention":true}}
```

Salience subscribes from `latest`, so start it before you publish and give it a second to connect. It decides on a finished line of speech at once (`brain.salience.trigger_on_speech`); chat and vision events wait for the next poll, `brain.salience.tick_ms`.

## Recipe B: the full talking loop, no GPU, no accounts

Everything except `chat`, `memory`, `eyes` and `ears`, using the stand-in servers from [One service on its own](isolated.md).

```bash
mise run build
mise run stub:tts &
mise run stub:llm &
export VOICE_URL=http://127.0.0.1:8700
mise run --jobs 5 dev:salience ::: dev:affect ::: dev:cortex ::: dev:voice ::: dev:avatar &

mise run bus:tail -- attention.focus brain.status brain.say voice.utterance voice.playing voice.done affect.state
```

In another shell:

```bash
mise run bus:pub -- chat.message '{"platform":"twitch","user":"viewer","text":"hey Coco what game is this?","mentionsCohost":true}'
```

You should see this sequence, most of the time spent in the stub [TTS](../../start/glossary.md#tts) "speaking":

```text
chat.message -> affect.state (mood: happy)
             -> attention.focus (mentioned, 1.0)
             -> brain.status thinking -> brain.say -> brain.status speaking
             -> voice.utterance -> voice.playing (sink virtual) -> voice.done -> brain.status idle
```

`cortex` logs `memory region did not answer in time` because no `memory` is running. That is expected.

Add the dashboard (`mise run dashboard`, then <http://localhost:3000>, the port being `dashboard.port`) to watch the same events in a browser. Its controls are plain HTTP, so they script well. The route needs the control token (`mise run config:token` sets it and the installer runs it; the dashboard does not start without one), sent from `CONTROL_TOKEN` exported in this shell:

```bash
curl -XPOST localhost:3000/control -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' -d '{"cmd":"say","text":"hi"}'
```

This answers 204 and puts a `control` event on the bus. The page plays audio only after you turn it on with the header's **Audio off** button (it then reads **Audio on**), because browsers block autoplay.

## Recipe C: a hand-made input for a downstream service

Skip the brain and speak directly. With the stub TTS, `voice` and `avatar` running:

```bash
mise run bus:pub -- brain.say '{"id":"t1","text":"Hello chat!","emotion":"happy"}'
```

`voice.utterance` appears with its envelope, `avatar.state` moves to `emotion: happy`, and `GET /audio/t1.wav` on the voice service answers 200.

Stand-ins for services you cannot run:

```bash
mise run bus:pub -- chat.message '{"platform":"twitch","user":"mod1","text":"welcome in!","isMod":true}'
mise run bus:pub -- vision.summary '{"text":"The player falls into lava and dies.","changed":true}'
mise run bus:pub -- speech.heard '{"speaker":"Chris","text":"did you see that?","durationMs":1200}'
mise run bus:pub -- control '{"cmd":"mute"}'
```

The first three stand in for `chat`, `eyes` and `ears`; the last is an operator command (`unmute`, `say` with `text`, `forget_context` and `reload_personality` also work). These payloads validate, but whether salience acts on one depends on its score against `brain.salience.speak_threshold` (0.6 by default). A mention scores 1.0, speech 0.9, a question 0.55, a mod or subscriber 0.35, a screen change 0.3 and plain chat 0.15.

To force a line without scoring, add a `brain.salience.reflexes` entry on the Settings screen (section `brain.salience`) or with `mise run config:set`: a [reflex](../../start/glossary.md#reflex) goes straight to `brain.say`. Or publish `brain.say` yourself, as in the first command of this recipe.

## How you know it worked

- `bus:tail` prints the events you expect, in order, with the source of each service.
- The Services screen shows the services you started with the mode `mock` where a stand-in is on.
- `inject.result` answers each service-level injection with `ok: true`, or a `detail` that says what was missing.

## If it didn't

- **Nothing reacts.** The service subscribes from `latest`: start it before you publish.
- **`bus:pub` exits 1.** The payload failed validation; read the zod issue list it printed against [Bus events](../reference/events.md).
- **The dashboard answers 401 or 409.** 401 means the bearer token is missing or wrong; 409 means the service the injection is for is not running.
