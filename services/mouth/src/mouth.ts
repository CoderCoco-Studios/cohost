/**
 * mouth's wiring: the startup plan, the outputs it runs, the one bus loop that feeds them, the fallback clip refresh and
 * the teardown steps. `runService` (index.ts) calls `health` and then `main`; tests call the same two with fakes.
 */
import type { Bus } from "@cohost/bus";
import { dataDir, urls, type Config } from "@cohost/config";
import { startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { ClipCache, ClipMirror, clipDir, startClipSync } from "./clips.js";
import { createDryrunOutput } from "./dryrun.js";
import { ClaimMemory, FallbackLine } from "./fallback.js";
import { MouthHealth, mouthPlan, readToken } from "./health.js";
import { createMouthHandler, subscribeMouth, type MouthOutput } from "./session.js";

/** What mouth needs from the bus: publish, the one subscription, heartbeats and stop. */
export type MouthBus = Pick<Bus, "publish" | "publishHealth" | "resetGroup" | "subscribe" | "stop" | "consumer">;

export interface MouthOptions {
  /** The co-host's bot token; default `DISCORD_TOKEN`. */
  token?: string;
  /** Loads discord.js and `@discordjs/voice`; only called in the `discord` plan (MOUTH-START-003). */
  loadDiscord?: () => Promise<typeof import("./discord.js")>;
  // Replacements for tests.
  clipSync?: typeof startClipSync;
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Repeat interval of the no-token reminder, ms (default 60000). */
  idleWarnEveryMs?: number;
}

const NO_TOKEN = "DISCORD_TOKEN is not set";

/**
 * One mouth service: `health(cfg)` is the heartbeat spec for `runService`, `main(ctx)` the service itself. Both read the same
 * plan, derived from the config and the token.
 */
// @spec MOUTH-START-006, MOUTH-SESS-007, MOUTH-START-001, MOUTH-START-002, MOUTH-START-003, MOUTH-START-004, MOUTH-START-005, MOUTH-DRY-001, MOUTH-DRY-005
export function createMouth(opts: MouthOptions = {}) {
  const token = () => opts.token ?? readToken();
  const ready = new Map<string, boolean>();

  return {
    health(cfg: Config): HeartbeatSpec {
      const plan = mouthPlan(cfg.mouth.outputs, !!token());
      return new MouthHealth(plan, cfg.mouth.outputs, (name) => ready.get(name) ?? false).spec;
    },

    async main({ cfg, bus, log, heartbeat, onStop }: ServiceContext<MouthBus>): Promise<void> {
      const o = cfg.mouth.outputs;
      const plan = mouthPlan(o, !!token());
      const idle = (kind: "off" | "degraded", reason: string) => {
        const plane = startIdle({ heartbeat, log, kind, reason, warnEveryMs: opts.idleWarnEveryMs });
        onStop(() => plane.stop());
      };

      // The idle plans: no Discord client, no subscription, no clips, nothing published but the heartbeat.
      if (plan === "off") return idle("off", "no mouth output is enabled: idle, no Discord client, nothing played");
      if (plan === "no-token") return idle("degraded", NO_TOKEN);

      // discord | local: one clip cache and claim memory for every output; each output has its own fallback line state.
      const cache = new ClipCache();
      const claims = new ClaimMemory();
      const fallbackFor = (sink: string) => new FallbackLine({ cache, claims, sink, minIntervalMs: cfg.mouth.fallback.min_interval_ms });
      const outputs: MouthOutput[] = [];
      let session: { start(): Promise<void>; stop(): Promise<void> } | undefined;

      if (plan === "discord") {
        // discord.js and friends are only loaded when a session will actually be opened.
        const { createDiscordOutput } = await (opts.loadDiscord ?? (() => import("./discord.js")))();
        const d = createDiscordOutput({
          cfg, bus, log, heartbeat, token: token(), fallback: fallbackFor("discord"), fetchAudio: opts.fetchAudio,
          setReady: (v) => { ready.set("discord", v); },
          isReady: () => ready.get("discord") ?? false,
        });
        outputs.push(d.output);
        session = d.session;
        onStop(() => d.session.stop());
      }
      if (o.dryrun.enabled) {
        const dry = createDryrunOutput({ bus, log, failEvery: o.dryrun.fail_every, fallback: fallbackFor("dryrun"), fetchAudio: opts.fetchAudio });
        ready.set("dryrun", true);
        outputs.push(dry);
      }
      for (const out of outputs) if (out.close) onStop(() => out.close!());

      // One loop for the whole `mouth` group, established before any login (MOUTH-PLAY-001, MOUTH-START-005).
      await subscribeMouth(bus, createMouthHandler({ outputs, claims, log }), log);

      // @spec MOUTH-FALL-012, MOUTH-FALL-014, MOUTH-FALL-018
      const clipSync = (opts.clipSync ?? startClipSync)({ baseUrl: urls.voice(), cache, mirror: new ClipMirror(clipDir(dataDir())), log });
      onStop(() => clipSync.stop());

      if (plan === "local") {
        // No Discord client. A Discord output that is enabled but has no token is reported as in the `no-token` plan.
        if (o.discord.enabled) idle("degraded", NO_TOKEN);
        else heartbeat.ready();
        return;
      }

      // @spec MOUTH-SESS-001, MOUTH-SESS-008
      await session!.start().catch((err) => { log.error({ err }, "discord login failed"); throw err; });
    },
  };
}
