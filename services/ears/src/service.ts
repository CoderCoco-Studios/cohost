/**
 * The ears service body, split from `index.ts` so the whole start-up (plans, idle, sources, shutdown) can run under test
 * through `runService` with fakes. `index.ts` only hands this to `runService`.
 */
import { ConnectorRegistry, type Bus, type BusEvent } from "@cohost/bus";
import { earsSources, type Config } from "@cohost/config";
import { startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { EarsHealth, earsPlan } from "./health.js";
import { createDirCapture } from "./capture-dir.js";
import { createHttpCapture } from "./capture-http.js";
import type { CaptureAdapter, HearClip } from "./capture.js";
import { createConnectorSource, type ConnectorSource } from "./connector-source.js";
import { Hearing, sttTranscriber, stubTranscriber } from "./hearing.js";
import { createInjectHandler } from "./inject.js";
import { EARS_LOOP_TYPES, createEarsHandler, subscribeEars } from "./session.js";
import { stopAll } from "./sources.js";

export interface EarsServiceOptions {
  /** How often the connector registry is re-read, ms (default 5000, the registration interval). */
  registryIntervalMs?: number;
  /** How often the frame accounting is written into the heartbeat detail, ms (default 1000). */
  refreshMs?: number;
}

export function createEarsService(opts: EarsServiceOptions = {}): {
  health(cfg: Config): HeartbeatSpec;
  main(ctx: ServiceContext<Bus>): Promise<void>;
} {
  let health: EarsHealth | undefined;
  /** Adapters by source name, and why a source is down (start failure). */
  const adapters = new Map<string, CaptureAdapter>();
  const failed = new Map<string, string>();
  const statusOf = (name: string): "ok" | "down" => (failed.has(name) ? "down" : adapters.get(name)?.status() ?? "down");
  const planOf = (cfg: Config) => earsPlan(earsSources(cfg.ears), cfg.ears.dir.path.trim() !== "");

  return {
    health(cfg) {
      health = new EarsHealth(planOf(cfg), cfg.ears.stt_engine === "stub", statusOf);
      return health.spec;
    },

    // @spec EARS-START-008, EARS-SRC-003, EARS-SRC-004, EARS-SRC-008, EARS-CON-001, EARS-CON-002, EARS-CAP-003
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
      const hear: HearClip = (clip, speaker, source, speakerId) => hearing.heardClip(clip, speaker, source, speakerId);

      // The registry is read once before any source starts, so a connector already present is seen at start.
      const registry = new ConnectorRegistry(bus, opts.registryIntervalMs, (err) => log.warn({ err: String(err) }, "connector registry read failed"));
      await registry.start();
      const connectorNames = plan.runnable.filter((s) => s.kind === "connector").map((s) => s.name);

      // The one `http` listener, shared by the `http` source and by every connector source whose registration says `http`.
      // It binds when `http` is enabled or when such a registration is first seen (EARS-SRC-009).
      const httpCapture = createHttpCapture({
        ...cfg.ears.http, hear, log,
        accepts: (tag) => connectorNames.includes(tag) && registry.offer("audio-in", tag)?.cap.transport === "http",
      });
      let httpStart: Promise<void> | undefined;
      const ensureHttp = (): Promise<void> => (httpStart ??= httpCapture.start());
      const listener = { ensure: ensureHttp, bound: () => httpCapture.status() === "ok" };

      const sources = new Map<string, ConnectorSource>();
      for (const src of plan.runnable) {
        if (src.kind === "http") {
          adapters.set("http", { name: "http", start: ensureHttp, stop: () => httpCapture.stop(), status: () => httpCapture.status() });
        } else if (src.kind === "dir") {
          adapters.set("dir", createDirCapture({ path: cfg.ears.dir.path, pollMs: cfg.ears.dir.poll_ms, hear, log }));
        } else {
          const cs = createConnectorSource({ name: src.name, bus, registry, hear, log, silenceMs: cfg.ears.silence_ms, listener });
          sources.set(src.name, cs);
          adapters.set(src.name, cs);
        }
      }

      const statsText = (): string => [...sources.entries()].map(([n, s]) => `${n} ${s.stats()}`).join("; ");
      const detailOf = (name: string): string => failed.get(name) ?? sources.get(name)?.detail() ?? "";
      /** One heartbeat state from every source: degraded while any enabled source is down, ready once all are up. */
      let reported = "";
      const refresh = (): void => {
        const down = plan.sources.filter((s) => s.gap !== undefined || statusOf(s.name) === "down");
        if (down.length === 0) {
          heartbeat.setDetail(statsText() || undefined);
          if (reported !== "ready") { reported = "ready"; heartbeat.ready(); }
          return;
        }
        const reasons = down.map((s) => s.gap ?? detailOf(s.name)).filter((d) => d !== "");
        const text = reasons.join("; ");
        if (reported !== `degraded:${text}`) { reported = `degraded:${text}`; heartbeat.degraded(text || undefined); }
      };
      const unwatch = registry.on(refresh);
      const refreshTimer = setInterval(() => { if (sources.size > 0) refresh(); }, opts.refreshMs ?? 1000);
      refreshTimer.unref();

      // One shutdown step, first in reverse order: every source stops on its own (the clip in flight finishes), then the bus.
      onStop(async () => {
        clearInterval(refreshTimer);
        unwatch();
        registry.stop();
        await stopAll([...adapters.values(), ...(adapters.has("http") ? [] : [{ name: "http", start: ensureHttp, stop: () => httpCapture.stop(), status: () => httpCapture.status() }])], log);
      });

      // @spec EARS-SRC-004
      const started = await Promise.allSettled([...adapters.values()].map((a) => a.start()));
      started.forEach((r, i) => {
        if (r.status === "fulfilled") return;
        const a = [...adapters.values()][i]!;
        failed.set(a.name, `ears ${a.name} source failed to start: ${String(r.reason)}`);
        log.error({ err: String(r.reason) }, `ears ${a.name} source failed to start`);
      });
      refresh();
    },
  };
}
