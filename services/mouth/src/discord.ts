import { GatewayIntentBits } from "discord.js";
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { Readable } from "node:stream";
import type { Publisher } from "@cohost/bus";
import type { Heartbeat } from "@cohost/shared";
import type { Config, Logger } from "@cohost/config";
import { createDiscordVoiceSession, type DiscordVoiceDeps, type DiscordVoiceSession } from "@cohost/shared/discord-voice";
import type { FallbackLine } from "./fallback.js";
import { Playback, httpAudio, type PlaybackDeps } from "./playback.js";
import { outputTarget, type MouthOutput } from "./session.js";

/** The `discord` output's name, which is also its sink name (MOUTH-ROUTE-001). */
const OUTPUT = "discord";

export interface DiscordDeps {
  cfg: Config;
  bus: Publisher;
  log: Logger;
  heartbeat: Pick<Heartbeat, "ready" | "degraded">;
  /** The co-host's bot token (`DISCORD_TOKEN`, MOUTH-SESS-008). */
  token: string;
  /** This output's fallback line over the shared clip cache; without it a give-up is a silent skip. */
  fallback?: FallbackLine;
  setReady(ready: boolean): void;
  isReady(): boolean;
  /** The live `gain_db` (MOUTH-LIVE-002); default: the configured one. */
  gainDb?: () => number;
  // Replacements for tests: no network, no real audio player.
  fetchAudio?: (url: string) => Promise<Buffer>;
  createPlayer?: () => AudioPlayer;
  createResource?: (pcm: Buffer) => AudioResource;
  voice?: DiscordVoiceDeps;
  guard?: Pick<PlaybackDeps, "fetchTimeoutMs" | "watchdogGraceMs" | "maxQueue">;
}

/** The Discord output, ready to be started: the output the bus loop feeds and the voice session that connects it. */
export interface DiscordOutput {
  output: MouthOutput & { playback: Playback; close(): void };
  /** `start()` logs in and joins in the background; `stop()` destroys the voice connection and the client. */
  session: Pick<DiscordVoiceSession, "start" | "stop">;
}

/**
 * The Discord output: the co-host's own bot, which joins the voice channel self-deafened (retrying until it succeeds) and plays
 * `voice.utterance` on it. Only loaded in the `discord` plan. The caller subscribes the bus loop before calling `session.start()`
 * and owns shutdown: it stops the clip refresh, calls `session.stop()` and then stops the bus.
 */
export function createDiscordOutput(deps: DiscordDeps): DiscordOutput {
  const { cfg, bus, log } = deps;
  const out = cfg.mouth.outputs.discord;
  const player = (deps.createPlayer ?? createAudioPlayer)();
  const resource = deps.createResource ?? ((pcm: Buffer) => createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }));

  const playback = new Playback({
    bus, log, sink: OUTPUT, gainDb: deps.gainDb ?? out.gain_db, fallback: deps.fallback, fetchAudio: deps.fetchAudio ?? httpAudio,
    play: (pcm) => player.play(resource(pcm)),
    stop: () => { player.stop(true); },
    ...deps.guard,
  });

  // The connection itself (join, retry, rejoin on disconnect) is the shared Discord voice session; mouth only attaches its
  // player and reports what the heartbeat needs. mouth needs no member names, so it does not request the privileged
  // GuildMembers intent; it is self-deafened (it discards received audio) and not self-muted.
  // @spec MOUTH-SESS-002, MOUTH-SESS-003, MOUTH-SESS-004, MOUTH-SESS-009
  const session = createDiscordVoiceSession({
    token: deps.token,
    guildId: () => outputTarget(out).guildId,
    channelId: () => outputTarget(out).channelId,
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    selfDeaf: true,
    selfMute: false,
    log,
    deps: deps.voice,
    onConnected(conn) {
      conn.subscribe(player);
      deps.setReady(true);
      deps.heartbeat.ready();
    },
    onDisconnected: () => deps.setReady(false),
    onJoinFailed(err) {
      deps.setReady(false);
      deps.heartbeat.degraded(`voice join failed: ${String(err)}`);
    },
  });

  // @spec MOUTH-PLAY-004
  player.on(AudioPlayerStatus.Idle, () => void playback.onIdle());
  // @spec MOUTH-PLAY-007
  player.on("error", (err) => log.warn({ err: err.message, output: OUTPUT }, "player error"));

  return {
    output: { name: OUTPUT, isReady: deps.isReady, playback, close: () => playback.close() },
    session,
  };
}
