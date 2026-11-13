---
node: connections
supersedes: ../../ears/decisions/listen-speak-split.md
---

# Decision: external services attach through a connector protocol, and one Discord connector holds the bot

## Context

The co-host hears people and speaks to them, and today both directions run through Discord. A bot account holds at most one voice connection per guild: a second `joinVoiceChannel` as the same bot in the same guild moves or replaces the first. Whatever process holds the connection both receives the channel's audio and is the only one that can send audio into it as that bot.

The previous decision, [listen-speak-split](../../ears/decisions/listen-speak-split.md), kept ears and mouth as separate services and gave each its own Discord bot (`EARS_DISCORD_TOKEN`, `DISCORD_TOKEN`). That bought independent lifecycles at a price the owner no longer wants to pay: a second Discord application to create and invite, two bots visible in the channel, a guard against the same token in both processes, and a listener that is mute and a speaker that is deaf because each bot joins for one purpose. The owner's direction is one bot login.

Two further needs shape the choice. Listening already takes audio from more places than Discord and will take more (the host's desktop audio through a capture helper, a microphone); the co-host's voice goes, or will go, to more places than a Discord channel. Each such place is an external program that talks to a service outside the Compose stack's own code (Discord's gateway, a Windows audio API). And the independence the split bought must survive: restarting, stopping or crashing one direction must leave the other running.

What is at stake: a design that leaves the Discord connection inside ears or mouth forces the single bot to live in one of them and ties the other's audio to that process; a design that merges the two halves undoes the owner's direction that listening and speaking are separate modules; a design that streams live audio between processes adds a transport the rest of the system deliberately avoids.

## Decision Elements

Gates:

- **One voice connection per bot per guild** (inherited, Discord). Exactly one process joins a guild's voice as the bot.
- **The event stream stays small and replayable** (inherited, HLD tenet 1 and the Binary payloads decision, narrowed by this decision). Audio never rides `cohost:events`: that stream is capped at 20 000 entries, read by every service and shown in the dashboard feed. An option that puts PCM on it fails.
- **One bot login** (owner direction). An option that needs two Discord applications fails.

Weighted criteria:

- **Independent lifecycle** (major; owner direction): listening, speaking and the Discord connection restart, fail and deploy separately; a failure is contained to what depends on it.
- **A path for non-Discord audio** (major; owner direction): the desktop-audio helper and any later source or output attach without a new transport per source.
- **Setup burden** (moderate): what the owner creates and configures in Discord and `.env`.
- **What viewers see** (moderate): one co-host in the channel, the bot they know.
- **Moving parts** (minor): processes, transports and failure modes added.

## Options in the Domain

### Keep two processes with two bots

The status quo. Passes the voice-connection gate and the event-stream gate. Gives full independence. Fails one bot login by construction, keeps the token guard and the two-bots-in-channel setup, and gives the desktop helper no shared way in: it would keep its own HTTP path into ears while mouth outputs grow their own adapters.

### Merge ears and mouth into one process

One service holds the one Discord session, with listening and speaking as modules (the "one process, two modules" option of the earlier record). Passes every gate with no new transport. Fails independent lifecycle: one heartbeat, one container and one restart for both directions, so a playback bug stops listening and the other way round. It also reverses the owner's direction that the two halves are separate modules, and puts every future source and output into the same process.

### A Discord-only connections service

A process holds the Discord session and exchanges audio with ears and mouth over Redis, with stream names and a frame format specific to Discord. Passes the gates and keeps one bot and independent lifecycles. Fails a path for non-Discord audio: the desktop helper would still need its own transport and its own registration, a second design of the same thing. The shared parts (naming, frame format, loss policy, liveness) are the same size whether or not they are generalised, so the Discord-only version saves almost nothing and has to be reworked for the next source.

### HTTP between services

mouth POSTs each line's WAV to a Discord-side endpoint and ears fetches captured audio from one. Allowed for binary transfer by tenet 1 and used for utterance audio today. Fails for live capture: a per-speaker stream needs framing, reconnection and back-pressure over HTTP, and the services would call each other directly, which tenet 1 rejects.

### A connector protocol with the Discord connector as its first connector (chosen)

A **connector** is an external process that attaches to the bus dynamically. It registers itself, heartbeats, declares what it offers (capabilities such as audio in and audio out) and names the source tags and sink tags it serves. Live audio travels on dedicated capped Redis streams beside the event stream, `audio.in.<source>` and `audio.out.<sink>`, never on it. The Discord connector is a connector that owns the bot login and the one voice connection: it publishes each human speaker's audio to `audio.in.discord`, and plays what mouth writes to `audio.out.discord`. ears consumes sources; mouth writes sinks. Neither holds a Discord client.

Passes every gate: one process joins voice, the event stream carries no audio, one token. Independent lifecycle holds in the sense that matters: ears, mouth and the connector each restart without the others, and a failure is confined to the audio path that depends on it (see Selection). The desktop helper migrates onto the same protocol by registering a source tag. Costs: a live-audio transport with loss policy and pacing that no other part of cohost had; a new single point of failure for Discord audio only; a narrowing of the Binary payloads decision.

## Why the session broker is now accepted

The earlier record rejected "two processes sharing one bot through a session broker" for three reasons. Each is reassessed:

| Earlier objection | Now |
| --- | --- |
| It needs a live-audio transport with per-speaker multiplexing and back-pressure that no other part has | The need now exists independently of Discord: any external audio source needs the same transport. It is designed once, with a stated loss policy ([connections LLD](../connections-design.md)), and bounded by capped streams. The HLD gate it collided with protects `cohost:events`; dedicated audio streams outside it keep that stream small and replayable, so the gate's purpose holds. |
| The broker is a single point of failure for both directions | The connector is a single point of failure for the Discord connection only. Listening to other sources, the dashboard sink, the `file` and `http` outputs, injection, chat, the brain and the avatar do not depend on it, and when it is down ears and mouth report the dependency `down` and keep running. A failure the owner already accepts: the Discord bot itself being offline. |
| Restarting the broker drops both directions | True and accepted. Restarting the connector drops the Discord audio in both directions for the length of a rejoin (seconds), and nothing else. The alternative that avoided this needed two bots, which the owner no longer wants. |

What changed is the owner's weighting: one bot login and a general path for external audio now outrank the fully independent Discord lifecycle of two bots.

## Selection

A connector protocol with the Discord connector as its first connector, because it is the only option that gives one bot login, a general path for non-Discord audio, and independent restarts of ears and mouth together. Failure containment replaces the stronger isolation of two bots: the connector's failure affects only Discord audio in and out, reported honestly as a dependency, and every consumer keeps running.

Fit: the selection flips to a merged ears-and-mouth process if the owner decides one restart for listening and speaking is acceptable, which removes the transport but not the connector's value for desktop audio; it flips to two bots if Discord audio's availability is judged more important than one login. It stays independent of how many connectors and tags exist, since those are registrations.

## Consequences for other decisions

- [listen-speak-split](../../ears/decisions/listen-speak-split.md) is superseded; its record of why listening and speaking are separate services still stands, and its Discord-bot choice does not.
- ears and mouth hold no Discord client, read no Discord token, and drop the same-token guard; `DISCORD_TOKEN` is read only by the Discord connector.
- The HLD's Binary payloads decision is narrowed: live audio rides dedicated capped streams outside `cohost:events` and outside the event catalogue.
