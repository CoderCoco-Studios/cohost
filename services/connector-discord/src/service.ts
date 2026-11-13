/**
 * The connector service body, split from `index.ts` so the whole start-up (plans, idle, login, registration, capture,
 * playout, shutdown) can run under test through `runService` with fakes.
 */
import type { Readable, Transform } from "node:stream";
import { createAudioPlayer, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { GatewayIntentBits } from "discord.js";
import { ConnectorRegistrar, FrameSequencer, FrameTracker, type Bus, type CapabilityEntry } from "@cohost/bus";
import type { Config } from "@cohost/config";
import { startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { createDiscordVoiceSession, type DiscordVoiceDeps } from "@cohost/shared/discord-voice";
import { SpeakerCapture, IN_FORMAT } from "./capture.js";
import { connectorHealth, connectorPlan, readToken } from "./health.js";
import { Playout, OUT_FORMAT } from "./playout.js";

/** Source and sink tag of this connector (CONN-DISC-005). */
const TAG = "discord";
const VERSION = "0.1.0";

export interface ConnectorServiceOptions {
  /** Environment to read `DISCORD_TOKEN` from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Registration and heartbeat-detail refresh period, ms (default 5000 / 1000). */
  intervalMs?: number;
  refreshMs?: number;
  // Replacements for tests: no network, no real audio player or decoder.
  voice?: DiscordVoiceDeps;
  createPlayer?: () => AudioPlayer;
  createResource?: (stream: Readable) => AudioResource;
  createDecoder?: () => Transform;
}

const capabilities = (ready: boolean): CapabilityEntry[] => [
  { cap: "audio-in", tag: TAG, format: IN_FORMAT, ready },
  { cap: "audio-out", tag: TAG, format: OUT_FORMAT, ready, flush: true }, // @spec CONN-DISC-012, CONN-FLUSH-001
];

export function createConnectorService(opts: ConnectorServiceOptions = {}): {
  health(cfg: Config): HeartbeatSpec;
  main(ctx: ServiceContext<Bus>): Promise<void>;
} {
  const token = readToken(opts.env ?? process.env);
  let voiceReady = false;
  let registrar: ConnectorRegistrar | undefined;
  let capture: SpeakerCapture | undefined;
  const planOf = (cfg: Config) => connectorPlan(cfg.connections.discord.enabled, token !== "");
  /** Whether the last registration written offers the capability with `ready` true. */
  const offered = (cap: "audio-in" | "audio-out"): boolean => registrar?.last?.capabilities.some((c) => c.cap === cap && c.tag === TAG && c.ready) ?? false;

  return {
    health: (cfg) => connectorHealth(planOf(cfg), {
      voiceReady: () => voiceReady,
      audioIn: () => offered("audio-in") && capture?.running === true,
      audioOut: () => offered("audio-out"),
    }),

    // @spec CONN-DISC-001, CONN-DISC-002, CONN-DISC-003, CONN-DISC-004, CONN-DISC-005, CONN-DISC-009, CONN-DISC-010, CONN-DISC-011, CONN-HLTH-001, CONN-HLTH-002, CONN-BP-003, CONN-BP-005, CONN-ISO-002
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = planOf(cfg);
      // @spec CONN-DISC-011
      if (plan === "off") {
        const idle = startIdle({ heartbeat, log, kind: "off", reason: "connections.discord.enabled is false: idle, no Discord client, nothing registered (mode off)" });
        onStop(() => idle.stop());
        return;
      }
      // @spec CONN-DISC-002
      if (plan === "no-token") {
        const idle = startIdle({ heartbeat, log, kind: "degraded", reason: "DISCORD_TOKEN is not set" });
        onStop(() => idle.stop());
        return;
      }

      const target = cfg.connections.discord;
      const sequencer = new FrameSequencer();
      const tracker = new FrameTracker(OUT_FORMAT);
      const player = (opts.createPlayer ?? createAudioPlayer)();
      player.on("error", (err) => log.warn({ err: err.message }, "player error"));
      const playout = new Playout({ player, createResource: opts.createResource });
      capture = new SpeakerCapture({
        write: (frame) => bus.publishFrame("in", TAG, frame), sequencer, log, createDecoder: opts.createDecoder,
      });
      const cap = capture;

      // ---- state: what the registration and the heartbeat report
      let settled = false; // the first join attempt has resolved
      let joinError: string | undefined;
      let discarded = 0;
      let reported: string | undefined;
      const conflict = (): string | undefined => {
        const last = registrar?.last;
        return last && last.capabilities.length < capabilities(true).length ? last.detail : undefined;
      };
      const reason = (): string | undefined => (!voiceReady ? joinError ?? "voice connection is not ready" : conflict());
      const dropped = (): number => tracker.dropped + discarded + playout.dropped + cap.dropped;
      const stats = (): string => `lost ${tracker.lost}, dropped ${dropped()}`;

      const refresh = (): void => {
        if (!settled) return;
        const why = reason();
        if (why) {
          const text = `${why}; ${stats()}`;
          if (reported !== text) { reported = text; heartbeat.degraded(text); }
        } else {
          heartbeat.setDetail(stats());
          if (reported !== "ready") { reported = "ready"; heartbeat.ready(); }
        }
      };
      // A state change is written to the registry at once, not at the next interval; writes are serialised and a write
      // skipped because another is in flight is retried until the registration shows the current readiness.
      let chain: Promise<void> = Promise.resolve();
      const sync = (): void => {
        refresh();
        chain = chain.then(async () => {
          for (let i = 0; i < 20; i++) {
            await registrar?.tick();
            if (registrar?.last?.capabilities.every((c) => c.ready === voiceReady)) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          refresh();
        }).catch((err) => log.warn({ err }, "registration write failed"));
      };

      registrar = new ConnectorRegistrar(
        bus,
        {
          id: TAG, kind: "discord", version: VERSION, intervalMs: opts.intervalMs,
          capabilities: () => capabilities(voiceReady),
          status: () => (!settled ? { state: "starting" } : reason() ? { state: "degraded", detail: reason() } : { state: "ready" }),
        },
        () => log.error("another connector instance registered as discord and took over; this one stopped registering"),
        (err) => log.warn({ err }, "registration write failed"),
      );
      await registrar.start();

      // @spec CONN-BP-003, CONN-BP-005, CONN-DISC-008
      // Live read of the sink for the whole run; frames are played only while the connection is Ready and discarded otherwise.
      void bus.tailAudio("out", TAG, (decoded) => {
        const f = tracker.accept(decoded);
        if (!f) return;
        if (!voiceReady) { discarded++; return; }
        playout.push(f);
      }).catch((err) => log.error({ err }, "audio.out read ended"));

      // @spec CONN-DISC-003, CONN-DISC-004
      const guildKey = (): string => {
        if (!target.guild_id) throw new Error("connections.discord.guild_id is not set");
        return target.guild_id;
      };
      const channelKey = (): string => {
        if (!target.voice_channel_id) throw new Error("connections.discord.voice_channel_id is not set");
        return target.voice_channel_id;
      };
      const session = createDiscordVoiceSession({
        token,
        guildId: guildKey,
        channelId: channelKey,
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
        selfDeaf: false,
        selfMute: false,
        fetchMembers: true,
        log,
        deps: opts.voice,
        onConnected(conn, ctx) {
          conn.subscribe(player);
          cap.attach(conn, ctx);
          voiceReady = true;
          joinError = undefined;
          settled = true;
          sync();
        },
        onDisconnected() {
          voiceReady = false;
          joinError = "voice disconnected, rejoining";
          cap.detach();
          playout.close();
          sync();
        },
        onJoinFailed(err) {
          voiceReady = false;
          joinError = `voice join failed: ${String(err)}`;
          settled = true;
          sync();
        },
      });

      const refreshTimer = setInterval(refresh, opts.refreshMs ?? 1000);
      refreshTimer.unref?.();

      // @spec CONN-DISC-009
      // One shutdown sequence: registration deleted, voice connection and client destroyed; runService stops the bus after.
      onStop(async () => {
        clearInterval(refreshTimer);
        await registrar?.stop();
        cap.detach();
        playout.close();
        await session.stop();
      });

      // @spec CONN-DISC-001
      // A failed login is fatal: the registration is withdrawn and the error propagates to `runService`, which exits with status 1.
      try {
        await session.start();
      } catch (err) {
        log.error({ err }, "discord login failed");
        clearInterval(refreshTimer);
        await registrar.stop();
        throw err;
      }
    },
  };
}
