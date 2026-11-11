import { GatewayIntentBits } from "discord.js";
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";
import type { Bus } from "@cohost/bus";
import type { Heartbeat } from "@cohost/shared";
import { dataDir, urls, type Config, type Logger } from "@cohost/config";
import { createDiscordVoiceSession } from "@cohost/shared/discord-voice";
import { ClaimMemory, ClipCache, ClipMirror, FallbackLine, clipDir, startClipSync } from "./fallback.js";
import { Playback, httpAudio } from "./playback.js";
import { readToken } from "./health.js";
import { createMouthHandler, outputTarget, subscribeMouth } from "./session.js";

/** The `discord` output's name, which is also its sink name (MOUTH-ROUTE-001). */
const OUTPUT = "discord";

export interface DiscordDeps {
  cfg: Config;
  bus: Bus;
  log: Logger;
  heartbeat: Heartbeat;
  setReady(ready: boolean): void;
  isReady(): boolean;
}

/** A running Discord output; `stop` tears down the voice connection and the client, `clipSync` the fallback clip refresh. */
export interface DiscordSession {
  session: { stop(): Promise<void> };
  clipSync: { stop(): void };
}

/**
 * The Discord output: handles the bus first, then logs in as the co-host's bot, joins the voice channel self-deafened
 * (retrying until it succeeds) and plays `voice.utterance` on it. Only loaded in the `discord` plan. The caller owns
 * shutdown: it stops the clip refresh, calls `session.stop()` and then stops the bus.
 */
export async function startDiscord(deps: DiscordDeps): Promise<DiscordSession> {
  const { cfg, bus, log } = deps;
  const out = cfg.mouth.outputs.discord;
  const player = createAudioPlayer();

  // The spoken fallback line: mouth's own clip cache (memory + disk mirror), refreshed from voice's HTTP routes.
  const clipCache = new ClipCache();
  const claims = new ClaimMemory();
  const fallback = new FallbackLine({ cache: clipCache, claims, sink: OUTPUT, minIntervalMs: cfg.mouth.fallback.min_interval_ms });
  const playback = new Playback({
    bus, log, fallback, sink: OUTPUT, gainDb: out.gain_db, fetchAudio: httpAudio,
    play: (pcm) => player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })),
  });

  // The connection itself (join, retry, rejoin on disconnect) is the shared Discord voice session; mouth only attaches its
  // player and reports what the heartbeat needs. mouth needs no member names, so it does not request the privileged
  // GuildMembers intent; it is self-deafened (it discards received audio) and not self-muted.
  // @spec MOUTH-SESS-002, MOUTH-SESS-003, MOUTH-SESS-004, MOUTH-SESS-009
  const session = createDiscordVoiceSession({
    token: readToken(),
    guildId: () => outputTarget(out).guildId,
    channelId: () => outputTarget(out).channelId,
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    selfDeaf: true,
    selfMute: false,
    log,
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

  // ---- playback
  // @spec MOUTH-PLAY-004
  player.on(AudioPlayerStatus.Idle, () => void playback.onIdle());
  // @spec MOUTH-PLAY-007
  player.on("error", (err) => log.warn({ err: err.message, output: OUTPUT }, "player error"));

  // The bus loop starts before the login and does not depend on the join. One loop for the whole `mouth` group: two loops
  // with different type filters would drop each other's events.
  // @spec MOUTH-PLAY-001, MOUTH-START-005, MOUTH-FALL-010, MOUTH-ROUTE-003
  await subscribeMouth(bus, createMouthHandler({ outputs: [{ name: OUTPUT, isReady: deps.isReady, playback }], claims, log }), log);

  // @spec MOUTH-FALL-012, MOUTH-FALL-014, MOUTH-FALL-018
  const clipSync = startClipSync({ baseUrl: urls.voice(), cache: clipCache, mirror: new ClipMirror(clipDir(dataDir())), log });

  // @spec MOUTH-SESS-001, MOUTH-SESS-008
  await session.start().catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });

  return { clipSync, session };
}
