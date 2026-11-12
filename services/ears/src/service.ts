/**
 * The ears service body, split from `index.ts` so the whole start-up (plans, idle, Discord, shutdown) can run under test
 * through `runService` with fakes. `index.ts` only hands this to `runService`.
 */
import type { Bus, BusEvent } from "@cohost/bus";
import { earsSources, type Config } from "@cohost/config";
import { startIdle, type Heartbeat, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { EarsHealth, earsPlan, idleDetail, readEarsToken } from "./health.js";
import { createDirCapture } from "./capture-dir.js";
import { createHttpCapture } from "./capture-http.js";
import type { CaptureAdapter, HearClip } from "./capture.js";
import { Hearing, sttTranscriber, stubTranscriber } from "./hearing.js";
import { createInjectHandler } from "./inject.js";
import { EARS_LOOP_TYPES, createEarsHandler, subscribeEars } from "./session.js";
import { createAbsentConnector, stopAll } from "./sources.js";

export interface EarsServiceOptions {
  /** Environment to read `EARS_DISCORD_TOKEN` and `DISCORD_TOKEN` from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Loads `discord.js` and friends; only called when `discord` is an enabled, runnable source (EARS-SRC-001). */
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
  /** Adapters by source name, and why a source is down (start failure or session report). */
  const adapters = new Map<string, CaptureAdapter>();
  const failed = new Map<string, string>();
  const statusOf = (name: string): "ok" | "down" => (failed.has(name) ? "down" : adapters.get(name)?.status() ?? "down");
  const planOf = (cfg: Config) =>
    earsPlan(earsSources(cfg.ears), cfg.ears.dir.path.trim() !== "", earsToken.hasToken ? undefined : idleDetail(earsToken));

  return {
    health(cfg) {
      health = new EarsHealth(
        planOf(cfg), () => voiceReady, cfg.ears.stt_engine === "stub",
        statusOf,
      );
      return health.spec;
    },

    // @spec EARS-START-008, EARS-SRC-003, EARS-SRC-004, EARS-SRC-008
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = planOf(cfg);
      const stub = cfg.ears.stt_engine === "stub";
      const h = health!;
      // @spec EARS-STUB-002
      if (stub) log.warn("ears.stt_engine is stub: transcripts are fixed text (stub transcript), nothing is sent to the STT service");
      const transcribe = h.track(stub ? stubTranscriber() : sttTranscriber(cfg.ears));
      // Injected clips only need the transcriber, so this works whatever the sources.
      const onInject = createInjectHandler({ bus, log, transcribe });

      // @spec EARS-START-003, EARS-INJ-009, EARS-START-006
      // inject.request is consumed once, before any source starts, and stays up whatever the sources do.
      await subscribeEars(bus, EARS_LOOP_TYPES, createEarsHandler({ onInject: (ev: BusEvent<"inject.request">) => onInject(ev) }), log);

      const gaps = plan.sources.filter((s) => s.gap !== undefined);

      // @spec EARS-SRC-008, EARS-START-001, EARS-CAP-010
      if (plan.runnable.length === 0) {
        if (gaps.length > 1) for (const g of gaps) log.error(g.gap!);
        const idle = plan.sources.length === 0
          ? startIdle({ heartbeat, log, kind: "off", reason: "ears.sources is empty: idle, no Discord client, nothing heard (mode off)" })
          : startIdle({ heartbeat, log, kind: "degraded", reason: gaps.map((g) => g.gap).join("; ") });
        // @spec EARS-START-005
        onStop(() => idle.stop());
        return;
      }
      // @spec EARS-SRC-003
      for (const g of gaps) log.error(g.gap!);

      // @spec EARS-SRC-007
      const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe });
      const hear: HearClip = (clip, speaker, source) => hearing.heardClip(clip, speaker, source);
      const connectors = plan.runnable.filter((s) => s.kind === "connector").map((s) => s.name);
      /** Sources whose first start has not settled; a still-connecting Discord session is not a failure. */
      const pending = new Set<string>();
      const detailOf = (name: string): string => failed.get(name) ?? (adapters.has(name) && adapters.get(name)!.status() === "down" ? `${name} connector not connected` : "");
      /** One heartbeat state from every source: degraded while any enabled source is down, ready once all are up. */
      const refresh = (): void => {
        const down = plan.sources.filter((s) => s.gap !== undefined || statusOf(s.name) === "down");
        if (down.length === 0 && pending.size === 0) return heartbeat.ready();
        const reasons = down.map((s) => s.gap ?? (failed.get(s.name) ?? detailOf(s.name))).filter((d) => d !== "");
        if (down.some((s) => !pending.has(s.name))) heartbeat.degraded(reasons.join("; ") || undefined);
      };

      const solo = plan.runnable.length === 1;
      for (const src of plan.runnable) {
        if (src.kind === "discord") {
          pending.add("discord");
          // The session reports through this view of the heartbeat; the one state is computed across all sources.
          const view = {
            ready: () => { pending.delete("discord"); failed.delete("discord"); refresh(); },
            degraded: (d?: string) => { pending.delete("discord"); failed.set("discord", d ?? "discord down"); refresh(); },
          } as Pick<Heartbeat, "ready" | "degraded"> as Heartbeat;
          adapters.set("discord", {
            name: "discord",
            status: () => (voiceReady ? "ok" : "down"),
            stop: async () => { await session?.stop(); },
            // discord.js and friends are only loaded when a session will actually be opened.
            start: async () => {
              const { startDiscord } = await loadDiscord();
              session = await startDiscord({
                cfg, bus, log, heartbeat: view, onInject, transcribe, token: earsToken.token, subscribe: false,
                setVoiceReady: (v) => { voiceReady = v; },
              });
            },
          });
        } else if (src.kind === "http") {
          adapters.set("http", createHttpCapture({ ...cfg.ears.http, sources: connectors, hear, log }));
        } else if (src.kind === "dir") {
          adapters.set("dir", createDirCapture({ path: cfg.ears.dir.path, pollMs: cfg.ears.dir.poll_ms, hear, log }));
        } else {
          adapters.set(src.name, createAbsentConnector(src.name));
        }
      }
      let session: { stop(): Promise<void> } | undefined;

      // One shutdown step, first in reverse order: every source stops on its own (the clip in flight finishes), then the bus.
      onStop(() => stopAll([...adapters.values()], log));

      // @spec EARS-SRC-004
      const started = await Promise.allSettled([...adapters.values()].map((a) => a.start()));
      started.forEach((r, i) => {
        if (r.status === "fulfilled") return;
        const a = [...adapters.values()][i]!;
        // A login failure with discord as the only source is fatal (EARS-SESS-001); otherwise the source is down, the rest run.
        if (a.name === "discord" && solo) throw r.reason;
        pending.delete(a.name);
        const why = `ears ${a.name} source failed to start: ${String(r.reason)}`;
        failed.set(a.name, why);
        log.error({ err: String(r.reason) }, `ears ${a.name} source failed to start`);
      });
      refresh();
    },
  };
}
