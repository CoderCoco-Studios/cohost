import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { Bus, Heartbeat } from "@cohost/bus";
import { dataDir, urls, type Config, type Logger } from "@cohost/config";
import { createJoiner } from "@cohost/shared";
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
  // mouth needs no member names, so it does not request the privileged GuildMembers intent.
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = createAudioPlayer();
  let connection: VoiceConnection | undefined;
  let stopped = false;

  // The spoken fallback line: mouth's own clip cache (memory + disk mirror), refreshed from voice's HTTP routes.
  const clipCache = new ClipCache();
  const claims = new ClaimMemory();
  const fallback = new FallbackLine({ cache: clipCache, claims, sink: OUTPUT, minIntervalMs: cfg.mouth.fallback.min_interval_ms });
  const playback = new Playback({
    bus, log, fallback, sink: OUTPUT, gainDb: out.gain_db, fetchAudio: httpAudio,
    play: (pcm) => player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })),
  });

  // @spec MOUTH-SESS-002, MOUTH-SESS-003, MOUTH-SESS-004
  async function join() {
    const target = outputTarget(out);
    const guild = await client.guilds.fetch(target.guildId);
    const channel = (await guild.channels.fetch(target.channelId)) as VoiceBasedChannel | null;
    if (!channel?.isVoiceBased()) throw new Error("mouth.outputs.discord.voice_channel_id is not a voice channel");

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, // mouth discards received audio; deafened, Discord sends none and the channel shows the bot only speaks
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy(); // a half-open connection would block the retry
      connection = undefined;
      throw err;
    }
    connection.subscribe(player);
    deps.setReady(true);
    deps.heartbeat.ready();
    log.info({ channel: channel.name }, "joined voice");

    // @spec MOUTH-SESS-005
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        deps.setReady(false);
        log.warn("voice disconnected, rejoining in 5s");
        connection?.destroy();
        void joiner.run(5000);
      }
    });
  }

  // @spec MOUTH-SESS-006
  const joiner = createJoiner({
    join,
    isStopped: () => stopped,
    onFailure: (err, attempt) => {
      deps.setReady(false);
      log.warn({ err: String(err), attempt }, "voice join failed, retrying");
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

  client.once("ready", () => {
    log.info({ user: client.user?.tag }, "discord ready");
    void joiner.run().catch((err) => log.error({ err }, "voice join loop failed"));
  });

  // @spec MOUTH-SESS-001, MOUTH-SESS-008
  client.login(readToken()).catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });

  return {
    clipSync,
    session: {
      async stop() {
        stopped = true;
        connection?.destroy();
        await client.destroy();
      },
    },
  };
}
