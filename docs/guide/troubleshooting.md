---
title: Troubleshooting
description: Symptoms, causes and fixes for the problems you are most likely to meet, grouped by the step you were on.
track: simple
verified: f126b94
---

# Troubleshooting

Find the step you were on, then the symptom. Each entry gives the likely cause and what to do. When a service misbehaves, two tools help every time: the **Services** screen of the [dashboard](operate/dashboard.md) (read it with [Service health](operate/health.md)) and a service's [container](../start/glossary.md#container) log:

```bash
docker compose logs --tail 50 cortex
```

Swap `cortex` for the service you are chasing. The images for every service build and start, so a service that will not run almost always has a setting or an outside dependency to fix, and its log says which.

### Where the logs are

Each line in the terminal and in `docker compose logs` reads `14:03:22.517 ERROR cortex: message`: the time, the level, the program and the message. A message of several lines, such as the list of problems in an invalid `config.yaml`, prints as indented lines below it, and details such as an error's stack print indented underneath.

Every program also writes its full log to `data/logs/<program>.log` in the checkout: `dashboard.log`, `chat.log`, `cortex.log`, `consolidate.log` and so on. Each line there is one JSON entry with every detail, including the exact time. A file that grows past 10 MiB is moved aside as `<program>.1.log` (then `.2.log`, `.3.log`) and the oldest beyond three is deleted; `logging` in `config/config.yaml` changes the level, the terminal format and those limits (see [Configuration](../advanced/reference/config.md#logging)). The `tools` service writes no file: read it with `docker compose logs tools`.

### `data/logs` or its files belong to root

- **Cause:** the containers run as root, so the log files they write are root's (mode 0644: you can read them, and only root can delete them). The dashboard, `cohostctl` and the installer create `data/logs` as you before any container starts; a `docker compose up` run by hand on a checkout with no `data/logs` lets Docker create the folder as root, and programs you then run on your PC cannot write their log there. They warn once in the terminal and carry on without a file.
- **Fix:** `sudo chown -R "$USER" data/logs` gives the folder back to you. To remove container-written files, use `sudo rm data/logs/<file>`.

### Removing chat text from the logs

- **Cause:** the logs hold what passes through the co-host: chat messages, what it heard and what it said. A viewer's forget request removes their notes and memories, not log lines.
- **Fix:** delete the files under `data/logs/` (with `sudo` for the ones containers wrote). Rotation also deletes old files on its own as new ones fill.

## Installing and starting the dashboard

### `@cohost/bus cannot load the native addon`

The full message continues `(...): looked for cohost-bus.linux-x64-gnu.node for platform ... at <path>. Build it with mise run build:native.`

- **Cause:** the [bus](../start/glossary.md#bus) client has a small compiled part, and it has not been built on this machine (or this machine is not 64-bit Linux, the only kind it supports). Every `mise run` task that starts a program on your machine, such as `mise run dashboard` or `mise run cohostctl`, builds it first, so this message means the program was started some other way, or the build failed.
- **Fix:** start the program through its task (`mise run dashboard`, `mise run cohostctl`), or build the part with `mise run build:native` and read the error it prints. The build uses the Rust and Zig that mise installs from `mise.toml`; if `mise run doctor` or `mise install` reports a problem, fix that first. See [What you need](install/prerequisites.md).

### The dashboard will not start, mentioning `CONTROL_TOKEN`

- **Cause:** `CONTROL_TOKEN` in `.env` is missing, empty, or shorter than 32 characters. It is cohost's one lock, so the dashboard does not start without it, in normal mode or in config recovery mode. The message says which (missing or too short) and never prints the value.
- **Fix:** run `./scripts/install.sh` again, which fills an empty `CONTROL_TOKEN` (it warns about a hand-set one that is too short and leaves it alone), or put a value of at least 32 characters on the `CONTROL_TOKEN=` line yourself: `openssl rand -hex 24` makes one. Then start the dashboard again and open the unlock link it prints.

### The dashboard says the config is invalid

The page shows **Config recovery** instead of the usual screens, and the terminal shows `Invalid <path>/config.yaml:` followed by the failing keys and `config recovery mode: <n> problems; fix them at http://127.0.0.1:3000`.

- **Cause:** `config/config.yaml` or `secrets/secrets.yaml` does not pass the checks every program makes when it starts. The usual reasons: a file from an older cohost still holds `${NAME}` placeholders (cohost substitutes none; every value is written as it is), a value is out of range, or the file is not valid YAML. Every other program refuses to start with such a file, so the dashboard starts in recovery mode to let you fix it; Launch, Rebuild and every service start or restart are refused until the file is valid, and so are `cohostctl launch`, `rebuild`, `start`, `restart` and `restart-all`.
- **Fix:** open the page at the address in the log (the usual one, or `http://localhost:3000` when the `dashboard` section itself is broken). Each failing key has its own row: type a value and press **Set**, press **Use** to keep the value an old placeholder fell back to, or press **Reset to default**. **Reset all failing keys** does that for every key it can, using each placeholder's fallback when it has one; what is left needs a value from you (a model name, for example). A credential written into `config.yaml` is removed there: set it afterwards in **Settings**, in the section the row names, with its masked field. A YAML syntax error (the row says `not valid YAML at line <l>, column <c>`) has **Edit config.yaml as text** (or **Edit secrets.yaml as text**): fix that line in the text box and press **Save**; the box stays open with the new position until the file parses. Opening and saving either file ask for the control token. If you save an empty file by mistake, the button stays there to put the text back. You can also fix the line in a text editor and press **Check again**. If the stack is still running from before, **Stop the stack** stops it without a valid config, as `mise run cohostctl stop-all` does. Every button asks for the control token, unless the browser is unlocked. Nothing changes in the file until you press a button, and your comments are kept. When the last key is fixed the page says the dashboard is starting and reloads into the normal screens; there is nothing to restart.

### The address is already in use

- **Cause:** something else on your PC uses port 3000 or 3001.
- **Fix:** set `dashboard.port` and `dashboard.lan_port` (3000 and 3001 by default, and they must differ) in `config/config.yaml`, then start the dashboard again. The startup log prints the URL it actually uses.

### The Access dialog rejects my token

- **Cause:** the token you typed is not the `CONTROL_TOKEN` in `.env`, or `.env` changed after the dashboard started (it reads `.env` once, at start).
- **Fix:** copy the whole value after `CONTROL_TOKEN=` in `.env`, with no spaces or quotes, and restart the dashboard if `.env` changed after it started. The dialog shows the command that prints the line (`grep ^CONTROL_TOKEN= .env`). A rejected token is never kept, so you can try again in the same dialog.

### The unlock link says it is not valid

- **Cause:** each unlock link works once and only for 10 minutes, and a restart of the dashboard ends the links it printed before. The link was already opened, is older than 10 minutes, or came from an earlier start.
- **Fix:** while the dashboard runs, run `mise run dashboard:unlock` and open the link it prints, or restart the dashboard and open the link in its terminal.

### I changed `CONTROL_TOKEN` and the page is locked again

- **Cause:** expected. `CONTROL_TOKEN` signs the sessions of browsers unlocked by the unlock link, so a new token ends every one of them.
- **Fix:** open a fresh unlock link: restart the dashboard (it reads `.env` at start) and open the link it prints, or run `mise run dashboard:unlock`. Then press **Restart all**, so `ears` gets the audio listener key derived from the new token.

### My settings are not being read

- **Cause:** the co-host reads `config/` (including `config.yaml`), `secrets/secrets.yaml` and `.env` from the workspace root, the nearest folder above where it runs that holds `pnpm-workspace.yaml` (the cohost checkout's top folder). A copy in some other folder is ignored.
- **Fix:** edit `config/config.yaml`, `secrets/secrets.yaml` and `.env` in the checkout's top folder. Setting `CONFIG_DIR` moves the config folder, and `COHOST_ENV_FILE` moves the `.env` file. A key that is spelled wrong is ignored, and every service logs a warning that names it at startup.

### A program on my PC cannot reach the voice service

- **Cause:** `VOICE_URL` is where programs look for the voice service. On the host it defaults to `http://127.0.0.1:8700`, your own PC, and the stack publishes that port only on your own PC. In the stack, [Compose](../start/glossary.md#docker-compose) sets it to `http://voice:8700` for the containers.
- **Fix:** if the voice service runs somewhere else, set `VOICE_URL` in `.env`. Otherwise check the voice service is `up` on the Services screen.

## Docker and Launch

### The stack status says `Docker unavailable`

- **Cause:** the dashboard could not run the `docker` command. On [WSL2](../start/glossary.md#wsl2) without Docker Desktop's WSL integration, there is no `docker` on the path; [Docker](../start/glossary.md#docker) lives in Windows as `docker.exe`.
- **Fix:** set `COHOST_DOCKER_BIN=docker.exe` in `.env` and restart the dashboard. If a [GPU](../start/glossary.md#gpu) overlay list in `COMPOSE_FILE` then breaks (Windows splits it on `;`), also set `COMPOSE_PATH_SEPARATOR=:`. The **Stack** card shows what Docker said, which usually names the real problem (for example, the Docker daemon is not running).

### Launch takes forever the first time

- **Cause:** the first Launch builds every service image and downloads the models, several gigabytes in all.
- **Fix:** wait. The **Stack** card shows the phase and a timer. Later Launches reuse what was built.

### A model did not download

- **Cause:** the `models` one-shot exits with an error if the main, vision or [embedding](../start/glossary.md#embedding) model fails to download. The models are the ones `config/config.yaml` names (`llm.model`, `llm.embed_model` and `vision.model`). A failed download of a hook model is only a warning.
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
- **Fix:** press **Launch**. If the **Stack** card says the bus is unreachable, that is the same fault.

### A service is `degraded` with a dependency `down`

- **Cause:** a thing it relies on is not answering. A name like `hook.cortex.critic` means a [hook](../start/glossary.md#hook) set to ask a model or your own server cannot reach it. The service carries on with its built-in rules meanwhile.
- **Fix:** fix or restart the named dependency, or set the hook back to `rules`.

### `ears` answers 401, or `deps.http` is `down` with the listener key missing

- **Cause:** the `http` audio listener checks every clip for a key derived from `CONTROL_TOKEN`, on loopback too. Either `ears` was started without the key (a hand-run `docker compose up`, or a start that skipped the control plane: the dashboard, `cohostctl` and `mise run dev` deliver it), `CONTROL_TOKEN` changed since `ears` started, or the client sending the clip has a different `CONTROL_TOKEN` in its shell.
- **Fix:** start or restart `ears` from the dashboard or `cohostctl`; after changing `CONTROL_TOKEN`, press **Restart all**. Set `CONTROL_TOKEN` in the client's shell to the value in `.env`. See [Send audio to ears](../advanced/extend/audio-in.md).

### The `chat` service does nothing

- **Cause:** `chat.twitch.channel` is empty, so the chat service stays idle and logs a warning.
- **Fix:** set `chat.twitch.channel` in `config/config.yaml` (see [Twitch chat](connect/twitch.md)) and restart `chat`. For scripted messages with no channel, start `chat` isolated (the **Isolated** switch in the **Start** dialog on the Services screen, or `mise run cohostctl start chat --isolated`), or add `fake` to `chat.sources`.

### The `youtube` chat source stops with a reason

The `chat` log and the Services screen name the reason. Each one has one fix:

- `chat.youtube.video is not a YouTube video URL or id`: the value names no video. Use the watch link or the video id, not a channel or handle.
- `the API key was rejected` or `authentication failed`: the key is wrong or missing from `secrets.yaml`. Restart `chat` after you change it.
- `live chat is disabled for this broadcast` or `the broadcast has ended`: the source stops and does not retry. Start a new broadcast, set its URL and restart `chat`.
- `this chat refuses the API key`: the key works for the lookup but not for this chat. Check the key's project and its restrictions.
- `video ... was not found`: private, deleted or mistyped. Check the URL.

### The `youtube` source is `retrying` with the reason `quota`

The daily YouTube Data API quota is spent. The source looks the broadcast up again every hour and resumes on its own. A larger `chat.youtube.poll_floor_ms` spends less.

## The co-host's behaviour

### It never speaks

Work down the list:

1. The header status says `Muted`: press **Unmute co-host** (or `m`) to unmute.
2. Audio is off in the browser: press **Audio off** in the dashboard header so it reads **Audio on** (on the sink page, **Turn audio on**), or on the [sink](../start/glossary.md#sink) page [OBS](../start/glossary.md#obs) plays. Browsers block sound until you press it.
3. [Salience](../start/glossary.md#salience) has nothing worth answering. Mention its name with **Test inputs**. If that works, lower `speak_threshold` or `idle_chatter_ms`; see [When it talks](tune/talkativeness.md).
4. A brain part is paused: the Services screen shows a `Paused` badge; press **Resume**.
5. The voice service is not `up`.

### It only says canned lines

- **Cause:** a mock backend is on. An isolated start of `cortex` (or `llm.provider: mock`) gives deterministic offline replies. The mode column says `mock`.
- **Fix:** restart the unit without **Isolated** (see [Install for real](install/real-install.md)), and check that `llm.provider` in `config/config.yaml` names a real provider.

### I changed a setting and nothing happened

- **Cause:** services read their settings when they start.
- **Fix:** restart the services that read them; the **Settings** screen offers to after a save, and [Starting and stopping](operate/start-stop.md) shows how. A credential saved on the **Settings** screen or in `secrets/secrets.yaml` applies the same way: restart the service that reads it. Changes to `.env` need a **Launch**.

### A reflex never fires

- **Cause:** the pattern does not match the text (check the escaping: backslashes are doubled in YAML), the `on` sense is wrong, or the rule is still in its cooldown.
- **Fix:** test with **Test inputs**, using a line that should match. See [When it talks](tune/talkativeness.md).

### The face never changes

- **Cause:** no avatar driver is configured, or the avatar app is not connected.
- **Fix:** follow [Avatar](connect/avatar.md). Meanwhile the **Avatar** card on the dashboard's **Live** screen still follows the mood.

## Memory

### The Viewers screen asks for the token or says 401

- **Cause:** this browser is locked. Viewer notes are personal data, so reading them needs the control token like every change does.
- **Fix:** enter the `CONTROL_TOKEN` from `.env` in the Access dialog, or open the unlock link the dashboard printed (`mise run dashboard:unlock` prints a fresh one). See [Memory and viewer notes](tune/memory.md).

### The memory service will not start after I changed the embedding model

- **Cause:** the new model's vectors are a different size from the stored ones, so the service refuses to start.
- **Fix:** stop memory and run `mise run cohostctl reembed`. See [Starting and stopping](operate/start-stop.md).

### No notes are being written about viewers

- **Cause:** the notes models (the `llm.model` entries under `brain.memory.notes.capture` and `brain.memory.notes.consolidator`) did not download, or the memory service is in [mock mode](../start/glossary.md#mock-mode) with the in-memory store.
- **Fix:** Launch again so `models` retries the download, and check the memory row on the Services screen.

### The reflection pass did nothing

- **Cause:** fewer than 5 new memories since the last reflection, a model answer with no bullet points, or another memory job running. See [After a stream](operate/after-stream.md).

## Known limits

- **Old traffic can reappear.** The bus keeps its history in Redis between runs, so replaying it with the developer tools shows messages from earlier sessions. A **fresh** start skips the backlog.
- **Not everything has been tried against the real service.** What has been run live and what has not is on the [Status page](../project/status.md).

## Still stuck

Ask in an issue on [the GitHub repository](https://github.com/CoderCoco-Studios/cohost), and include the service's log and its row from the Services screen.
