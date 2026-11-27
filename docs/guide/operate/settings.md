---
title: Settings, backups and recovery
description: Where cohost keeps its settings and credentials, how to change them, the recovery key and the control token, what to do after a reboot, backups, export and import, moving to another PC, and recovery mode.
track: simple
verified: a86e930
---

# Settings, backups and recovery

Every setting, the co-host's personality, its emotion map and every credential (API keys, bot tokens, passwords) live in one place on your PC: the **settings store**. There is no settings file to edit by hand. You change things on the dashboard's **Settings** screen or with a short `mise run config:*` command, and cohost backs the store up for you. This page covers where it all lives, how to change it, how to keep it safe and how to get it back when something goes wrong.

## What you need

- A finished install: [Install for real](../install/real-install.md) or [Try it with no accounts](../install/first-run.md). The installer creates the settings store, the master key and the control token.
- A password manager, for the two things the installer shows you once: the recovery key and the control token.
- A terminal in the cohost folder for the `mise run` commands on this page.

## Where your settings live

The settings store is one database file, `data/store/cohost.db` in the cohost folder (`COHOST_DATA_DIR` moves the whole `data/` folder, the store with it). Backups go beside it in `data/store/backups/`.

Credentials are stored encrypted (AES-256-GCM) under a **master key**, a small file kept outside the cohost folder: `~/.config/cohost/master.key` (or under `$XDG_CONFIG_HOME/cohost/` when that is set; `COHOST_KEY_FILE` names another place). Only you can read it (mode 0600). Because the key is outside the folder, a copy of the folder, of `data/` or of a backup carries no usable credential.

Your services never open the store. Before each start cohost hands every service a copy of the settings it reads, and after the start it hands over that service's credentials in memory only; nothing writes a credential to a file, an environment variable or the `.env` file. `.env` holds only a few plain host settings, such as `COMPOSE_PROFILES` and `DASHBOARD_HOST`.

The committed files `config/config.example.yaml`, `config/personality.example.md` and `config/expressions.example.yaml` are the starting values of a new store, and the example file documents every setting. Editing them changes nothing in a store that already exists.

## Changing a setting

On the dashboard, open **Settings** and pick a section. Change a value, press **Check** to validate it and **Save** to store it. A value you stored is marked `saved`; one you never changed shows `default`. A change applies when the services that read it next start, and after a save a banner names them with a **Restart** button. The [dashboard tour](dashboard.md#the-settings-screen) covers the screen.

From a terminal, name the setting by its dotted path. Arguments go after `--`:

```bash
mise run config:get -- llm.model
mise run config:set -- llm.model "qwen2.5:14b-instruct-q4_K_M"
mise run config:reset -- llm.model
```

`config:get` prints the value in effect, with `# default` above it when you never set it. `config:set` reads the value as YAML (`3000` is a number, `true` a switch, other text a string), checks it, stores it and names the services that apply it at their next start. `config:reset` removes your value so the default applies again. Every setting is listed on the [configuration reference](../../advanced/reference/config.md).

**Credentials** are set separately, because they are never shown again once stored. On the Settings screen a credential has a masked field marked **Set** or **Not set**; type the value and save it, or clear it. From a terminal:

```bash
mise run config:secret -- llm.claude.api_key
mise run config:secret -- llm.claude.api_key --clear
```

The first asks for the value without showing it as you type. A credential is never given on the command line, where it would land in your shell history. `config:get` on a credential path prints only `set` or `not set`.

**The personality** is a document in the store. Edit it on the dashboard (**Settings**, then **Personality**), or print it with `mise run config:personality` and edit it in your `$EDITOR` with `mise run config:personality -- --edit`. See [Personality](../tune/personality.md).

To find every problem that stops the store from being used, run `mise run config:check`. It prints `ok` when there is none.

## The recovery key

The master key's text is your **recovery key**. The installer prints it once, the first time the store is created. **Save it in your password manager.** It is the only way to get your stored credentials back if the key file is lost, for example after a disk failure or a reinstall of the operating system.

```bash
mise run config:key -- --show
mise run config:key -- --confirm
```

`--show` prints the recovery key again. If the key was made where no terminal could show it, the program printed `a recovery key was created; run mise run config:key -- --show` instead, and the dashboard shows a banner until you confirm you saved it: `--confirm` prints the key once more and clears the banner, as does the banner's **I have saved it** button.

Two more forms:

- `mise run config:key -- --rotate` makes a new master key, re-encrypts every credential under it and shows the new recovery key, which you save in place of the old one. The old key file is kept beside the new one as `master.key.rotated-<stamp>`, so backups taken before the rotation still open.
- `mise run config:key -- --restore` asks for a recovery key without showing it and writes the key file from it. Use it when the key file is gone but the store is still there.

If the key file is missing and the store holds credentials, cohost never makes a new key on its own: the programs that open the store refuse and name the fix. Restore the key, restore a backup (`mise run config:restore -- <backup>`), or, as a last resort, start the credentials over:

```bash
mise run config:reset-credentials
```

It asks you to type `delete credentials`, then deletes every stored credential and makes a new master key (save the new recovery key it shows). Enter your credentials again afterwards, and set the control token again with `mise run config:token` so the ears listener gets its key back.

## The control token and the unlock link

The **control token** is the one password of the dashboard: every button that changes something needs it. The installer sets one and prints it once. Keep it in your password manager. The store keeps only a check value (an scrypt hash), never the token, and the token never goes in `.env`: the dashboard refuses to start if `.env` or its environment defines `CONTROL_TOKEN`.

```bash
mise run config:token
mise run config:token -- --stdin
```

The first makes a new random token and prints it once. The second sets your own token, at least 32 characters, asked for without showing it. Setting a token replaces the one before and locks every browser the dashboard had unlocked, at once.

Most of the time you never type the token. Every time the dashboard starts, it prints an **unlock link** to its terminal (never to its log file):

```text
Unlock this browser: http://127.0.0.1:3000/unlock?n=...
```

Opening it unlocks that browser for 90 days. Each link works once, within 10 minutes. For another browser, or once the link expired, run `mise run dashboard:unlock` while the dashboard runs: it asks for the token without showing it (or takes it from `CONTROL_TOKEN` in that command's own shell) and prints a fresh link. A browser that is not unlocked asks for the token in the [Access dialog](dashboard.md#the-access-dialog).

A script or `curl` sends the token as `Authorization: Bearer <token>`. To run such an example, export `CONTROL_TOKEN` in that one shell from your password manager; never write it into `.env`.

## After a reboot

Credentials live only in memory inside the running [containers](../../start/glossary.md#container), so a reboot clears them. [Docker](../../start/glossary.md#docker) restarts the containers by itself, but they wait, showing `waiting for credentials` and unhealthy on the Services screen, until something hands their credentials over again. Either:

- start the dashboard with `mise run dashboard`, which delivers them as it starts and again whenever a service waits; or
- run `mise run deliver`, which delivers them once without the dashboard.

## Backups and restore

cohost backs the store up by itself at the dashboard's first start of each day (UTC) and before every import, restore or upgrade of the store's layout. To take one now:

```bash
mise run config:backup
```

Backups are `data/store/backups/cohost-<yyyymmddThhmmssZ>.db`; the ten newest are kept. A backup holds credentials only encrypted, so it is useful only with the master key it was made under (or a rotated key file kept beside the current one). Keep your recovery key saved, and a backup is enough to get everything back.

To go back to a backup:

```bash
mise run config:restore -- data/store/backups/cohost-20261127T020000Z.db
```

The restore checks the file first and refuses one that is damaged, from another build or under a key it does not have. It takes a backup of the current store before it replaces it. Settings apply at each service's next start. When the dashboard is in [recovery mode](#recovery-mode) with a damaged store, its screen lists the backups with a **Restore** button each.

## Export and import

An export is a readable YAML copy of your settings, the personality and the emotion map, good for keeping a copy, comparing two setups or moving to another PC.

```bash
mise run config:export -- cohost-settings.yaml
mise run config:export -- cohost-settings.yaml --secrets
```

Without a file name it prints to the terminal. A comment at the top lists which credentials are set, never their values. With `--secrets` the export also carries the credentials, encrypted with a passphrase you type twice (at least 12 characters); keep that passphrase as safe as the file.

```bash
mise run config:import -- cohost-settings.yaml --dry-run
mise run config:import -- cohost-settings.yaml
```

`--dry-run` shows what would be added, changed or removed, and the credentials it would set, and writes nothing. The real import takes a backup first and then makes the store match the file: settings, personality and emotion map, and the credentials too when the file carries them (it asks for the passphrase). A file with any problem is refused whole, listing each problem.

## Moving to another PC

The simple way is an export with credentials:

1. On the old PC, run `mise run config:export -- cohost-settings.yaml --secrets` and choose a passphrase.
2. Copy the file to the new PC, and install cohost there with [Install for real](../install/real-install.md).
3. On the new PC, run `mise run config:import -- cohost-settings.yaml`, type the passphrase, then delete the file.

The new PC keeps the control token its installer printed. To use your old one, run `mise run config:token -- --stdin` there and paste it at the prompt.

The other way moves the store itself. Before you run the installer on the new PC, put the master key file in the same place there (`~/.config/cohost/master.key`, mode 0600), so the installer does not make a new one. Install cohost, copy a backup from the old PC's `data/store/backups/` to the new PC, and run `mise run config:restore -- <that file>`. The store then holds the old settings, credentials and control token.

## Recovery mode

When the dashboard starts and the store cannot be used, it does not exit. It serves a **Config recovery** screen in place of the usual ones, and its log says `config recovery mode: <cause>, <n> problems; fix them at <url>`. Services cannot start until it is fixed; **Stop the stack** still works. Once nothing is wrong, the dashboard starts normally by itself and the page reloads.

There are four causes:

| Cause | What it means | The fix on the screen |
| --- | --- | --- |
| Damaged store | The database fails its integrity check. | Restore one of the listed backups, or import an export file (with its passphrase, if it carries credentials). The damaged file is kept aside as `cohost.db.damaged-<stamp>`. |
| Newer store | The store was made by a newer build of cohost. | Update cohost to that build or a later one. |
| Missing key | The master key file is missing, is the wrong key, or can be read by other users. | Enter the recovery key (only from a browser on the same PC), or discard the stored credentials after typing `delete credentials`. For a permissions problem, run the `chmod 600` the message names. |
| Invalid settings | A stored setting fails this build's checks, typically after an update. | Set or reset each failing setting, or **Reset all failing keys**. |

For the first three causes, the unlock link and unlocked browsers do not work, because the browser's unlock is itself protected by the master key: the screen asks for the control token from your password manager. If even the token's check value cannot be read, the screen shows the commands to run on the PC instead: `mise run config:restore`, `mise run config:import` or `mise run config:key -- --restore`.

## Bringing in settings files from an older install

An install from before the settings store kept its settings in files: `config/config.yaml`, `config/personality.md`, `config/expressions.yaml`, credentials in `secrets/secrets.yaml`, and `CONTROL_TOKEN` in `.env`. Bring them in once, then delete them.

1. See what would change. Each flag is optional; give the files you have:

   ```bash
   mise run config:import -- --dry-run --settings config/config.yaml --personality config/personality.md --expressions config/expressions.yaml --secrets secrets/secrets.yaml
   ```

   A setting that is not part of this build, or a credential found in the settings file, is left out and listed as a note.

2. Run the same command without `--dry-run`.
3. Check the store:

   ```bash
   mise run config:check
   ```

   It prints `ok`.

4. Keep the control token: run `mise run config:token -- --stdin` and paste the old `CONTROL_TOKEN` value at the hidden prompt (or set a new one with `mise run config:token`), and save it in your password manager. Then remove the `CONTROL_TOKEN` line from `.env`.
5. Delete `config/config.yaml`, `config/config.yaml.bak`, `config/personality.md`, `config/expressions.yaml`, `config/.vts-token`, `secrets/secrets.yaml`, `data/chat/twitch-token.json` and the `data/tts-pocket-secret/` folder. The store holds the settings and credentials they held; the runtime tokens of chat and avatar are kept encrypted under `data/chat/` and `data/avatar/` from their next start.

## How you know it worked

- `mise run config:check` prints `ok`.
- The dashboard opens to its usual screens, not **Config recovery**, and **Settings** shows your values marked `saved`.
- After a reboot and `mise run dashboard`, every service on the Services screen comes back `up`.

## If it didn't

- A program refuses and names the master key: the key file is missing or wrong. Run `mise run config:key -- --restore` with your recovery key. See [The recovery key](#the-recovery-key).
- The dashboard refuses to start and names `CONTROL_TOKEN`: `.env` or your shell defines it. Remove it, and set the token with `mise run config:token -- --stdin` if the store has none yet.
- Services stay `waiting for credentials`: start the dashboard or run `mise run deliver`. See [After a reboot](#after-a-reboot).
- Anything else: [Troubleshooting](../troubleshooting.md).
