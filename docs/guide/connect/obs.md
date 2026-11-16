---
title: OBS and the voice on stream
description: Add the co-host's voice to your stream with an OBS Browser Source, on the same PC or a second one, and optionally let it see your game through obs-websocket.
track: simple
verified: f126b94
---

# OBS and the voice on stream

By the end of this page your viewers will hear the co-host, because [OBS](../../start/glossary.md#obs) carries its voice into your stream. Optionally, the co-host will also be able to see your game.

There are two separate jobs here, and you can do just the first:

- **The voice on stream.** A [Browser Source](../../start/glossary.md#browser-source) in OBS shows a small web page that plays the co-host's voice. No virtual audio cables are needed.
- **The co-host's eyes (optional).** The `eyes` service asks OBS for a screenshot of your game every few seconds, through [obs-websocket](../../start/glossary.md#obs-websocket), and a vision model describes what changed.

::: aside
Without the browser source I am just talking to myself in a very expensive way. With it, you get a co-host. Choose wisely.
:::

## What you need

- A [real install](../install/real-install.md), or the [no-accounts run](../install/first-run.md), with the dashboard running and audio turned on (the header's **Audio off** button, which then reads **Audio on**) at least once in a normal browser.
- OBS. For the eyes you need version 28 or newer, which has obs-websocket built in.
- For a second PC: both machines on the same network, and the second PC's firewall letting you reach the AI PC on port 3001.

## Steps: the voice on stream, same PC

Use this when OBS runs on the same computer as the dashboard.

1. In OBS, add a new **Browser Source** to your scene.

2. For the address, enter the dashboard's [sink](../../start/glossary.md#sink) page:

   ```text
   http://localhost:3000/?sink=1
   ```

   The port is the `dashboard.port` key in `config/config.yaml`; 3000 is the default.

3. Tick **Control audio via OBS**.

4. Press OK. The source plays every utterance and reports back to the co-host that the audio is playing, so the avatar's mouth moves in time.

## Steps: the voice on stream, second PC

Use this when OBS runs on a different computer (a gaming PC, say) from the one running cohost, which this page calls the AI PC.

1. Find the AI PC's address on your network.

2. In OBS on the gaming PC, add a **Browser Source** with the address:

   ```text
   http://<ai-pc>:3001/?sink=1
   ```

   Replace `<ai-pc>` with the AI PC's address. Port 3001 is the `dashboard.lan_port` key in `config/config.yaml`. It serves only the sink page and its files, the live feed, the audio and the playback reports, never the controls, so it is safe to reach from the network.

3. Tick **Control audio via OBS**.

4. If OBS runs on that second PC, it is also where the avatar app usually runs. Everything else (the stack, the models, the dashboard) stays on the AI PC. To show the avatar, either run the avatar app on the gaming PC, or run it on the AI PC and send it to OBS over NDI. See [Avatar](avatar.md).

## Steps: the co-host's eyes (optional)

1. In OBS, open Tools, WebSocket Server Settings. Turn the server on, keep the port at 4455, and set a password.

2. Check that your scene has a source that can produce a screenshot, and note its exact name. The default the co-host looks for is `Game Capture`.

3. Put OBS's details in `config/config.yaml`:

   ```yaml
   vision:
     enabled: true
     obs:
       host: "host.docker.internal"
       port: 4455
       source: "Game Capture"
   ```

   `host.docker.internal` is how a [container](../../start/glossary.md#container) reaches OBS running on the same machine. If OBS is on a second PC, put that PC's address in `vision.obs.host` instead, and make sure obs-websocket listens on the network and the firewall allows port 4455.

   The OBS WebSocket password is a credential, so it goes in the **OBS password** secret field of **Settings**, **Vision** (saving needs your control token), or in `config/secrets.yaml` by hand:

   ```yaml
   vision:
     obs:
       password: "your-obs-password"
   ```

4. Start the `eyes` service by listing its profile in `.env`:

   ```dotenv
   COMPOSE_PROFILES=eyes
   ```

   If you already list other profiles in `COMPOSE_PROFILES`, add `eyes` to that list instead of replacing it.

5. Press **Launch** in the dashboard again, or start it by hand:

   ```bash
   docker compose --profile eyes up -d
   ```

   The vision model (`vision.model` in `config/config.yaml`) is downloaded by the first Launch, through [Ollama](../../start/glossary.md#ollama). A graphics card helps a lot with how quickly it answers.

## How you know it worked

- The voice: with the sink page loaded in OBS, a reply makes the source's audio meter move, and viewers hear it. If you turned **Control audio via OBS** off, the audio will not reach the stream.
- The eyes: the Services screen shows `eyes` as `up` with its OBS dependency `ok`, and `vision.summary` lines appear on the live feed when the screen changes.
- With OBS closed, `eyes` shows `degraded` with OBS `down` and keeps retrying every ten seconds, backing off up to a minute. Starting OBS fixes it without a restart.

## If it didn't

- **No sound on stream.** Check that **Control audio via OBS** is ticked, that the address is the sink page (`?sink=1`), and that the dashboard page is reachable from OBS. Open the same address in a browser: the page says whether audio is on, and **Turn audio on** starts playback if the browser blocked it.
- **The second PC cannot load the page.** Use the `dashboard.lan_port` port (3001 by default), not `dashboard.port` (3000), and check the AI PC's firewall.
- **`eyes` stays `degraded`.** OBS is not reachable, or the password is wrong (the log shows the login error). Check `vision.obs.host`, `vision.obs.port` and `vision.obs.source` in `config/config.yaml`, `vision.obs.password` in `config/secrets.yaml`, and that the named source exists in OBS. Restart `eyes` after an edit.
- **The eyes have not been run against a real OBS yet.** The obs-websocket path is covered by tests, not yet by a live run. If it misbehaves, the logs will say where.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Give the co-host a body: [Avatar](avatar.md).
