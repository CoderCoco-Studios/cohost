---
node: ears
---

# Decision: listening and speaking as separate services, each with its own Discord bot

## Context

The co-host hears people and speaks to them. Hearing turns each person's voice into `speech.heard`; speaking plays the co-host's synthesized lines (`voice.utterance`) somewhere people hear them, reports `voice.playing` / `voice.done` / `voice.failed` as a sink in voice's arbitration protocol, and says a pre-generated fallback line when a line cannot play.

Today both directions run through Discord: the co-host sits in a voice channel, listens to the humans there and speaks back. The owner wants listening and speaking to be separate modules so each can be tuned, and so the owner can define where audio is routed: listening will take audio from more sources than Discord, and the co-host's voice will go to more outputs than the Discord channel and the dashboard page.

The constraint that shapes every option is Discord's: a bot account holds at most one voice connection per guild. A second `joinVoiceChannel` with the same bot in the same guild moves or replaces the first connection. Whatever process holds the Discord voice connection both receives the channel's audio and is the only one that can send audio into it as that bot.

What is at stake: a split that leaves both directions on one Discord session keeps them restarting, failing and deploying together, which is what the owner wants to end; a split that streams raw audio between processes adds a transport the rest of the system deliberately avoids (HLD tenet 1 and the Binary payloads decision: audio travels over HTTP by URL, never on the bus).

## Decision Elements

Gates:

- **One voice connection per bot per guild** (inherited, Discord). An option in which two processes join one guild's voice as the same bot fails.
- **Binary audio never rides the bus** (inherited, HLD Binary payloads). An option that moves live PCM between services over Redis fails.

Weighted criteria:

- **Independent lifecycle** (major; owner direction): restarting, stopping or crashing one direction leaves the other running, with its own health, Compose service and manifest unit.
- **Owner-defined routing** (major; owner direction): where the co-host's voice goes, and which sources are heard, is set per direction without touching the other.
- **Setup burden** (moderate): what the owner must create and configure in Discord and `.env`.
- **What viewers see** (moderate): the bot people see speak should be the co-host they know.
- **Moving parts** (minor): new transports, processes and failure modes.

## Options in the Domain

### One process, two modules

Keep one service holding one Discord session, with the listening and speaking code as separate modules inside it and separate config sections. Passes both gates with no new transport and no second bot. Fails independent lifecycle: one heartbeat, one container, one restart for both directions, so a playback bug that crashes the process stops listening too. Routing can be per module, but every output and source shares the process.

### Two processes sharing one bot through a session broker

A third process holds the Discord session; the listening and speaking services exchange audio with it (received PCM out to the listener, playback PCM or WAV URLs in from the speaker) over HTTP or a WebSocket. Passes both gates if the stream avoids the bus, and keeps one bot. The broker becomes a new single point of failure for both directions, so lifecycle is only partly independent: restarting the broker drops both. It adds a live-audio transport, per-speaker stream multiplexing and back-pressure that no other part of cohost has.

### Two processes, two bots (chosen)

ears listens through a bot of its own (`EARS_DISCORD_TOKEN`); mouth speaks through the co-host's existing bot (`DISCORD_TOKEN`). Each holds its own voice connection, so both can sit in the same channel. Passes both gates. Fully independent lifecycle, health, Compose service and manifest unit. Routing is independent too: each side has its own guild and channel keys, so the co-host can even listen in one channel and speak in another. Costs: the owner creates a second Discord application and invites it with Connect only; two bots appear in the channel; ears must ignore the speaking bot's audio, which it does by ignoring every bot account; ears refuses to log in with the speaking bot's token, since that would put one bot in two processes.

### Speaking folded into voice

voice, which synthesizes and arbitrates, also plays to outputs; ears keeps listening with its own session. Passes both gates and needs one bot, since ears no longer speaks. Fails a design rule voice rests on (voice plays nothing; sinks claim and play), and puts playback in the process whose failure the fallback line exists to survive: when voice is down, the output that should say "my voice just blue-screened" is down with it.

## Selection

Two processes with two bots, because it is the only option that gives both directions a fully independent lifecycle without a new live-audio transport. The co-host's existing bot keeps speaking, so viewers see the same co-host and an upgrade without the new token loses listening, not speech. The second bot is a one-time setup step, and the heartbeat names the missing or conflicting token.

Fit: the selection would flip to one process with two modules if the owner valued a single bot over independent restarts, and to a session broker if Discord ever forbade a second bot in the channel. It stays independent of how many outputs or sources each side grows, since those are adapters inside each service.
