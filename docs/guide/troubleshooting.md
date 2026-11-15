---
title: Troubleshooting
description: Symptoms, causes and fixes for the problems you are most likely to meet, grouped by the step you were on.
track: simple
verified: f126b94
---

# Troubleshooting

Find the step you were on, then the symptom. Each entry gives the likely cause and what to do. When a service misbehaves, two tools help every time: the **services** tab of the [dashboard](operate/dashboard.md) (read it with [Service health](operate/health.md)) and a service's [container](../start/glossary.md#container) log:

```bash
docker compose logs --tail 50 cortex
```

Swap `cortex` for the service you are chasing. The images for every service build and start, so a service that will not run almost always has a setting or an outside dependency to fix, and its log says which.

## Installing and starting the dashboard

### `@cohost/bus cannot load the native addon`

The full message continues `(...): looked for cohost-bus.linux-x64-gnu.node for platform ... at <path>. Build it with pnpm build:native.`

- **Cause:** the [bus](../start/glossary.md#bus) client has a small compiled part, and it has not been built on this machine (or this machine is not 64-bit Linux, the only kind it supports).
- **Fix:** run `pnpm build:native`, or `pnpm build`, which runs it first. It needs the Rust toolchain that the installer puts on the machine; see [What you need](install/prerequisites.md). Do this before `pnpm dashboard` or `pnpm cohostctl`.

### The dashboard will not start, mentioning `CONTROL_TOKEN`

- **Cause:** `CONTROL_ENABLED=1` is set but `CONTROL_TOKEN` is empty. The dashboard refuses to run its controls without a token. The same refusal happens if `DASHBOARD_HOST` is set to something other than `127.0.0.1` without a token.
- **Fix:** put a long random value on the `CONTROL_TOKEN=` line in `.env`. The installer fills one in; to make one by hand, run `openssl rand -hex 24`. Then start the dashboard again.

### The address is already in use

- **Cause:** something else on your PC uses port 3000 or 3001.
- **Fix:** set `DASHBOARD_PORT` (and `DASHBOARD_LAN_PORT`) in `.env`, or set `PORT`, which takes priority for the dashboard. The dashboard prints the address it ended up on when it starts.

### The page asks for a token and rejects mine

- **Cause:** the token you typed is not the `CONTROL_TOKEN` in `.env`, or `.env` changed after the dashboard started.
- **Fix:** copy the value from `.env` exactly and restart the dashboard. The page asks once per browser tab, so close the tab and reopen it.

### My settings are not being read

- **Cause:** the co-host reads `config/` and `.env` from the workspace root, the nearest folder above where it runs that holds `pnpm-workspace.yaml`. A copy in some other folder is ignored.
- **Fix:** edit `config/config.yaml` and `.env` in the checkout's top folder. Setting `CONFIG_DIR` moves the config folder, and `COHOST_ENV_FILE` moves the `.env` file. A key that is spelled wrong is ignored, and every service logs a warning that names it at startup.

### A program on my PC cannot reach the voice service

- **Cause:** `VOICE_URL` is where programs look for the voice service. On the host it defaults to `http://127.0.0.1:8700`, your own PC, and the stack publishes that port only on your own PC. In the stack, [Compose](../start/glossary.md#docker-compose) sets it to `http://voice:8700` for the containers.
- **Fix:** if the voice service runs somewhere else, set `VOICE_URL` in `.env`. Otherwise check the voice service is `up` on the services tab.

## Docker and Launch

### The `stack:` pill says `docker unavailable`

- **Cause:** the dashboard could not run the `docker` command. On [WSL2](../start/glossary.md#wsl2) without Docker Desktop's WSL integration, there is no `docker` on the path; [Docker](../start/glossary.md#docker) lives in Windows as `docker.exe`.
- **Fix:** set `COHOST_DOCKER_BIN=docker.exe` in `.env` and restart the dashboard. If a [GPU](../start/glossary.md#gpu) overlay list in `COMPOSE_FILE` then breaks (Windows splits it on `;`), also set `COMPOSE_PATH_SEPARATOR=:`. The panel shows what Docker said, which usually names the real problem (for example, the Docker daemon is not running).

### Launch takes forever the first time

- **Cause:** the first Launch builds every service image and downloads the models, several gigabytes in all.
- **Fix:** wait. The stack panel shows the phase and a timer. Later Launches reuse what was built.

### A model did not download

- **Cause:** the `models` one-shot exits with an error if the main, vision or [embedding](../start/glossary.md#embedding) model fails to download. A failed download of `NOTES_MODEL` is only a warning.
- **Fix:** check disk space and your connection, then press **Launch** again to retry. `docker compose ps` shows whether `models` ended in an error.

### Launch, Stop or a restart answers `busy`

- **Cause:** the dashboard and `cohostctl` share one lock so two actions never collide, and the other is mid-action.
- **Fix:** wait for it to finish. A lock left behind by a crashed process clears automatically.

## Services and health

### A service is `stale`, `down` or `crash-looping`

- **Cause:** it stopped, crashed, or cannot start. `crash-looping` means it restarted three times in a minute.
- **Fix:** read its log with `docker compose logs --tail 50 <service>`. Common finds are a missing account setting, a model server that is not running, or the native addon error above. See [Service health](operate/health.md) for what each state means.

### Everything is `unknown`

- **Cause:** nothing has been launched, or the dashboard cannot reach Redis, the system's [message bus](../start/glossary.md#redis).
- **Fix:** press **Launch**. If the stack panel says the bus is unreachable, that is the same fault.

### A service is `degraded` with a dependency `down`

- **Cause:** a thing it relies on is not answering. A name like `hook.cortex.critic` means a [hook](../start/glossary.md#hook) set to ask a model or your own server cannot reach it. The service carries on with its built-in rules meanwhile.
- **Fix:** fix or restart the named dependency, or set the hook back to `rules`.

### The `chat` service does nothing

- **Cause:** no `TWITCH_CHANNEL` is set, so the chat service stays idle and logs a warning.
- **Fix:** set `TWITCH_CHANNEL` in `.env` (see [Twitch chat](connect/twitch.md)), or set `CHAT_SOURCE=fake` to get scripted messages with no channel.

## The co-host's behaviour

### It never speaks

Work down the list:

1. The status pill says `muted`: press **mute** again to unmute.
2. Audio is off in the browser: press **enable audio** on the dashboard, or on the [sink](../start/glossary.md#sink) page [OBS](../start/glossary.md#obs) plays. Browsers block sound until you press it.
3. [Salience](../start/glossary.md#salience) has nothing worth answering. Mention its name with **test inputs**. If that works, lower `speak_threshold` or `idle_chatter_ms`; see [When it talks](tune/talkativeness.md).
4. A brain part is paused: the services tab shows a `paused` badge; press **resume**.
5. The voice service is not `up`.

### It only says canned lines

- **Cause:** a mock backend is on. `LLM_PROVIDER=mock` gives deterministic offline replies. The mode column says `mock`.
- **Fix:** remove the mock lines from `.env` (see [Install for real](install/real-install.md)) and Launch again.

### I changed a setting and nothing happened

- **Cause:** services read their settings when they start.
- **Fix:** restart the services that read them; the settings tab offers to after a save, and [Starting and stopping](operate/start-stop.md) shows how. Changes to `.env` need a **Launch**.

### A reflex never fires

- **Cause:** the pattern does not match the text (check the escaping: backslashes are doubled in YAML), the `on` sense is wrong, or the rule is still in its cooldown.
- **Fix:** test with **test inputs**, using a line that should match. See [When it talks](tune/talkativeness.md).

### The face never changes

- **Cause:** no avatar driver is configured, or the avatar app is not connected.
- **Fix:** follow [Avatar](connect/avatar.md). Meanwhile the **avatar preview** on the dashboard's live tab still follows the mood.

## Memory

### The Viewers tab is locked or says 403

- **Cause:** `VIEWERS_TOKEN` is empty or missing, so the tab stays locked on purpose.
- **Fix:** set it in `.env` and restart the dashboard. See [Memory and viewer notes](tune/memory.md).

### The memory service will not start after I changed the embedding model

- **Cause:** the new model's vectors are a different size from the stored ones, so the service refuses to start.
- **Fix:** stop memory and run `pnpm cohostctl reembed`. See [Starting and stopping](operate/start-stop.md).

### No notes are being written about viewers

- **Cause:** the small notes model (`NOTES_MODEL`) did not download, or the memory service is in [mock mode](../start/glossary.md#mock-mode) with the in-memory store.
- **Fix:** Launch again so `models` retries the download, and check the memory row on the services tab.

### The reflection pass did nothing

- **Cause:** fewer than 5 new memories since the last reflection, a model answer with no bullet points, or another memory job running. See [After a stream](operate/after-stream.md).

## Known limits

- **Old traffic can reappear.** The bus keeps its history in Redis between runs, so replaying it with the developer tools shows messages from earlier sessions. A **fresh** start skips the backlog.
- **Not everything has been tried against the real service.** What has been run live and what has not is on the [Status page](../project/status.md).

## Still stuck

Ask in an issue on [the GitHub repository](https://github.com/CoderCoco-Studios/cohost), and include the service's log and its row from the services tab.
