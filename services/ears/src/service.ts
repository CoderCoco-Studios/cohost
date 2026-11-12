/**
 * The ears service body, split from `index.ts` so the whole start-up (plans, idle, Discord, shutdown) can run under test
 * through `runService` with fakes. `index.ts` only hands this to `runService`.
 */
import type { Bus, BusEvent } from "@cohost/bus";
import { urls, type Config } from "@cohost/config";
import { startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { EarsHealth, earsPlan, idleDetail, readEarsToken } from "./health.js";
import { sttTranscriber, stubTranscriber } from "./hearing.js";
import { createInjectHandler } from "./inject.js";
import { EARS_LOOP_TYPES, createEarsHandler, subscribeEars } from "./session.js";

export interface EarsServiceOptions {
  /** Environment to read `EARS_DISCORD_TOKEN` and `DISCORD_TOKEN` from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Loads `discord.js` and friends; only called in the `discord` plan (EARS-START-004). */
  loadDiscord?: () => Promise<Pick<typeof import("./discord.js"), "startDiscord">>;
}

export function createEarsService(opts: EarsServiceOptions = {}): {
  health(cfg: Config): HeartbeatSpec;
  main(ctx: ServiceContext<Bus>): Promise<void>;
} {
  const env = opts.env ?? process.env;
  const loadDiscord = opts.loadDiscord ?? (() => import("./discord.js"));
  const earsToken = readEarsToken(env);
  let voiceReady = false;
  let health: EarsHealth | undefined;

  return {
    health(cfg) {
      const plan = earsPlan(cfg.ears.source, earsToken.hasToken);
      health = new EarsHealth(plan, () => voiceReady, cfg.ears.stt_engine === "stub");
      return health.spec;
    },

    // @spec EARS-START-008
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = earsPlan(cfg.ears.source, earsToken.hasToken);
      const stub = cfg.ears.stt_engine === "stub";
      const h = health!;
      // @spec EARS-STUB-002
      if (stub) log.warn("ears.stt_engine is stub: transcripts are fixed text (stub transcript), nothing is sent to the STT service");
      const transcribe = h.track(stub ? stubTranscriber() : sttTranscriber(cfg.ears));
      // Injected clips only need the transcriber, so this works in every plan (off / no-token / discord).
      const onInject = createInjectHandler({ bus, log, dashboardUrl: urls.dashboard(), transcribe });

      // @spec EARS-START-004
      if (plan === "discord") {
        // discord.js and friends are only loaded when a session will actually be opened.
        const { startDiscord } = await loadDiscord();
        // Subscribes to the bus before joining voice; a failed login rejects and `runService` exits 1 (EARS-SESS-001).
        const session = await startDiscord({
          cfg, bus, log, heartbeat, onInject, transcribe, token: earsToken.token,
          setVoiceReady: (v) => { voiceReady = v; },
        });
        // One shutdown sequence: voice connection and client, then the bus (which `runService` stops last).
        // @spec EARS-SESS-008
        onStop(() => session.stop());
        return;
      }

      // @spec EARS-START-003, EARS-INJ-009, EARS-START-006
      // Idle: no Discord client; only inject.request is consumed, process stays up.
      await subscribeEars(bus, EARS_LOOP_TYPES, createEarsHandler({ onInject: (ev: BusEvent<"inject.request">) => onInject(ev) }), log);
      // @spec EARS-START-001, EARS-START-002, EARS-START-007
      const idle = plan === "off"
        ? startIdle({ heartbeat, log, kind: "off", reason: "ears.source is off: idle, no Discord client, nothing heard (mode off)" })
        : startIdle({ heartbeat, log, kind: "degraded", reason: idleDetail(earsToken) });
      // @spec EARS-START-005
      onStop(() => idle.stop());
    },
  };
}
