/**
 * The Discord voice session ears and mouth each hold through their own bot. Exported only from the
 * `@cohost/shared/discord-voice` subpath so a service that does not use Discord never loads `discord.js`
 * or a native voice module (SHARED-DVS-001).
 */
import { Client, type GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import type { Logger } from "@cohost/config";
import { retryWithBackoff, singleFlight } from "./retry.js";

/** The Discord pieces a test replaces; production uses discord.js and @discordjs/voice. */
export interface DiscordVoiceDeps {
  createClient?: (intents: GatewayIntentBits[]) => Client;
  joinVoiceChannel?: typeof joinVoiceChannel;
  entersState?: typeof entersState;
  sleep?: (ms: number) => Promise<void>;
}

/** Handed to `onConnected` beside the connection: what a service needs for member names and user lookups. */
export interface SessionContext {
  client: Client;
  channel: VoiceBasedChannel;
}

export interface DiscordVoiceSessionOptions {
  token: string;
  /** The guild and channel to join; a function is resolved at each join attempt, so a missing setting fails that attempt (and is retried) rather than construction. */
  guildId: string | (() => string);
  channelId: string | (() => string);
  intents: GatewayIntentBits[];
  selfMute: boolean;
  selfDeaf: boolean;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Fetch the guild's members before joining (needs the Server Members intent; ears names speakers). */
  fetchMembers?: boolean;
  onConnected(connection: VoiceConnection, ctx: SessionContext): void;
  onDisconnected?(): void;
  onJoinFailed?(err: unknown, attempt: number): void;
  /** Join retry delays, ms (default 5000 doubling to 60000). */
  join?: { baseMs?: number; maxMs?: number };
  deps?: DiscordVoiceDeps;
}

export interface DiscordVoiceSession {
  /** Log in, then join once the client is ready (the join loop runs in the background). Rejects when the login fails. */
  start(): Promise<void>;
  isReady(): boolean;
  stop(): Promise<void>;
}

/** How long a join may take to reach Ready, and how long a Disconnected connection may take to recover. */
const READY_TIMEOUT_MS = 20_000;
const RECOVER_TIMEOUT_MS = 5_000;
const REJOIN_DELAY_MS = 5_000;

// @spec SHARED-DVS-001, SHARED-DVS-002, SHARED-DVS-003, SHARED-DVS-004, SHARED-DVS-005, SHARED-DVS-006, SHARED-DVS-007
export function createDiscordVoiceSession(o: DiscordVoiceSessionOptions): DiscordVoiceSession {
  const { log } = o;
  const join = o.deps?.joinVoiceChannel ?? joinVoiceChannel;
  const enters = o.deps?.entersState ?? entersState;
  const client = (o.deps?.createClient ?? ((intents) => new Client({ intents })))(o.intents);
  const baseMs = o.join?.baseMs ?? 5000;
  const maxMs = o.join?.maxMs ?? 60_000;
  let connection: VoiceConnection | undefined;
  let ready = false;
  let stopped = false;
  const wakes = new Set<() => void>();

  // A sleep that `stop()` cuts short, so a session retrying with a 60 s delay still ends at once.
  const sleep = o.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); wakes.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    wakes.add(done);
  }));

  async function joinOnce(): Promise<void> {
    const guildId = typeof o.guildId === "function" ? o.guildId() : o.guildId;
    const channelId = typeof o.channelId === "function" ? o.channelId() : o.channelId;
    const guild = await client.guilds.fetch(guildId);
    const channel = (await guild.channels.fetch(channelId)) as VoiceBasedChannel | null;
    if (!channel?.isVoiceBased()) throw new Error(`voice channel ${channelId} is not a voice channel`);
    if (o.fetchMembers) await guild.members.fetch().catch(() => undefined);

    const conn = join({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: o.selfMute,
      selfDeaf: o.selfDeaf,
    });
    connection = conn;
    await enters(conn, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    ready = true;
    log.info({ channel: channel.name }, "joined voice");
    // @spec SHARED-DVS-003
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          enters(conn, VoiceConnectionStatus.Signalling, RECOVER_TIMEOUT_MS),
          enters(conn, VoiceConnectionStatus.Connecting, RECOVER_TIMEOUT_MS),
        ]);
      } catch {
        if (stopped) return;
        ready = false;
        log.warn("voice disconnected, rejoining in 5s");
        o.onDisconnected?.();
        conn.destroy();
        void run(REJOIN_DELAY_MS);
      }
    });
    try { o.onConnected(conn, { client, channel }); } catch (err) { log.error({ err }, "onConnected failed"); }
  }

  // @spec SHARED-DVS-004, SHARED-DVS-006
  const run = singleFlight((firstDelayMs: number): Promise<void> =>
    retryWithBackoff(joinOnce, {
      baseMs, maxMs, firstDelayMs, sleep, isStopped: () => stopped,
      onFailure: (err, attempt) => {
        ready = false;
        connection?.destroy(); // a half-open connection would block the retry
        connection = undefined;
        log.warn({ err: String(err), attempt }, "voice join failed, retrying");
        o.onJoinFailed?.(err, attempt);
      },
    }).then(() => undefined));

  return {
    async start() {
      client.once("ready", () => {
        log.info({ user: client.user?.tag }, "discord ready");
        void run(0).catch((err) => log.error({ err }, "voice join loop failed"));
      });
      await client.login(o.token);
    },
    isReady: () => ready,
    // @spec SHARED-DVS-007
    async stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      for (const w of [...wakes]) w();
      connection?.destroy();
      await client.destroy();
    },
  };
}
