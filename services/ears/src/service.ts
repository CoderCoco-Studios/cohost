/**
 * The ears service body, split from `index.ts` so the whole start-up (plans, idle, sources, shutdown) can run under test
 * through `runService` with fakes. `index.ts` only hands this to `runService`.
 */
import { ConnectorRegistry, type BusEvent } from "@cohost/bus";
import { earsListenerVerifier, earsSources, egressDestinations, type Config } from "@cohost/config";
import { startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { EarsHealth, earsPlan, sttInfoOf } from "./health.js";
import { buildEngines, type BuiltEngines, type StreamingSttEngine } from "./engines.js";
import { SttRouter } from "./stt.js";
import { createDirCapture } from "./capture-dir.js";
import { createHttpCapture } from "./capture-http.js";
import type { CaptureAdapter, HearClip } from "./capture.js";
import { createConnectorSource, type ConnectorSource, type EarlyCounts } from "./connector-source.js";
import { Hearing } from "./hearing.js";
import { createInjectHandler } from "./inject.js";
import { EchoGate } from "./echo.js";
import { EARS_ECHO_LOOP_TYPES, EARS_LOOP_TYPES, createEarsHandler, subscribeEars } from "./session.js";
import { stopAll } from "./sources.js";
import { loadSilero, type LoadVad } from "./vad.js";

export interface EarsServiceOptions {
  /** How often the connector registry is re-read, ms (default 5000, the registration interval). */
  registryIntervalMs?: number;
  /** How often the frame accounting is written into the heartbeat detail, ms (default 1000). */
  refreshMs?: number;
  /** Loads the speech-activity detector for `ears.vad.engine: silero` (default: `loadSilero`); tests pass a fake. */
  loadVad?: LoadVad;
  /** The streaming engine `ears.stt_engine` names when it is `nemotron` or `kyutai` (EARS-ENG-001); a test passes its own to replace the built adapter. */
  streamingEngine?: StreamingSttEngine;
  /** The re-probe period of EARS-HLTH-008 (default `STT_PING_INTERVAL_MS`). */
  pingIntervalMs?: number;
}

export function createEarsService(opts: EarsServiceOptions = {}): {
  health: (cfg: Config) => HeartbeatSpec;
  main: (ctx: ServiceContext) => Promise<void>;
} {
  let health: EarsHealth | undefined;
  let built: BuiltEngines | undefined;
  /** Adapters by source name, and why a source is down (start failure). */
  const adapters = new Map<string, CaptureAdapter>();
  const failed = new Map<string, string>();
  const statusOf = (name: string): "ok" | "down" => (failed.has(name) ? "down" : adapters.get(name)?.status() ?? "down");
  const planOf = (cfg: Config) => earsPlan(earsSources(cfg.ears), cfg.ears.dir.path.trim() !== "");

  return {
    health(cfg) {
      built = buildEngines(cfg.ears, opts.streamingEngine ? { streaming: opts.streamingEngine } : {});
      health = new EarsHealth(planOf(cfg), cfg.ears.stt_engine === "stub", statusOf, sttInfoOf(built));
      return health.spec;
    },

    // @spec EARS-START-008, EARS-SRC-003, EARS-SRC-004, EARS-SRC-008, EARS-CON-001, EARS-CON-002, EARS-CAP-003
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = planOf(cfg);
      const stub = cfg.ears.stt_engine === "stub";
      const h = health!;
      const engines = built ?? buildEngines(cfg.ears, opts.streamingEngine ? { streaming: opts.streamingEngine } : {});
      const streaming = engines.selected.kind === "streaming";
      // @spec EARS-PART-011, EARS-PART-012
      const partialsOn = cfg.ears.partials === "on" && !stub;
      if (cfg.ears.partials === "on" && stub) log.warn("ears.partials is on but ears.stt_engine is stub: no speech.partial is published with the stub engine");
      if (partialsOn && !streaming && !cfg.ears.stt_gpu) log.warn("ears.partials is on and ears.stt_gpu is false: partial transcription may not keep up on a speech-to-text backend that is not on a GPU");
      // @spec EARS-STUB-002
      if (stub) log.warn("ears.stt_engine is stub: transcripts are fixed text (stub transcript), nothing is sent to the STT service");
      // @spec EARS-EARLY-009, EARS-EARLY-010
      const earlyOn = cfg.ears.early.enabled;
      if (earlyOn && streaming) log.warn(`ears.early.enabled is on but ears.stt_engine is ${engines.selected.name}, a streaming engine: early reply is off, because that engine ends utterances itself`);
      // stub is a batch engine (EARS-ENG-001), so early reply runs with it like any batch engine
      const earlyActive = earlyOn && !streaming;
      const earlyCounts: EarlyCounts = { published: 0, retracted: 0, reused: 0, late: 0 };
      // @spec EARS-HLTH-010
      if (plan.sources.length > 0) {
        for (const e of egressDestinations(cfg).filter((x) => x.service === "ears" && x.offLan)) {
          log.warn(`ears sends speech to ${e.engine} at ${e.host}, which is off the LAN`);
        }
      }
      const rt = new SttRouter({
        built: engines, health: h, log, timeoutMs: cfg.ears.stt_timeout_ms, maxSessions: cfg.ears.max_stt_sessions,
        ...(opts.pingIntervalMs === undefined ? {} : { pingIntervalMs: opts.pingIntervalMs }),
      });
      // mode off has no engine to probe (EARS-HLTH-008 applies to a live plan only)
      if (plan.sources.length > 0) rt.start();
      onStop(() => rt.stop());
      // Injected clips only need the batch engine, so this works whatever the sources.
      const onInject = createInjectHandler({ bus, log, transcribe: (audio, hint) => rt.transcribe(audio, hint ? { contentType: hint.contentType } : {}) });

      // @spec EARS-START-003, EARS-INJ-009, EARS-START-006
      // inject.request is consumed once, before any source starts, and stays up whatever the sources do.
      // Where an enabled source is named in ears.echo_suppress_sources the loop also reads the co-host's own playback (EARS-ECHO-001, EARS-ECHO-009).
      const gated = new Set(cfg.ears.echo_suppress_sources.filter((n) => plan.runnable.some((s) => s.name === n)));
      const gate = gated.size > 0 ? new EchoGate(cfg.ears.echo_tail_ms) : undefined;
      await subscribeEars(bus, gate ? EARS_ECHO_LOOP_TYPES : EARS_LOOP_TYPES, createEarsHandler({
        onInject: (ev: BusEvent<"inject.request">) => onInject(ev),
        ...(gate ? { onVoice: (ev: BusEvent<"voice.playing" | "voice.done">) => { // @spec EARS-ECHO-002
          if (ev.data.sink === "virtual") return; // virtual plays nothing anywhere (EARS-ECHO-002)
          if (ev.type === "voice.done") gate.done(ev.data.id, ev.data.seq);
          else gate.playing(ev.data.id, ev.data.seq);
        } } : {}),
      }), log);

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
      const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe: (wav, fallback) => rt.transcribe(wav, { fallback }), ...(gate ? { echo: { gate, sources: gated } } : {}) });
      const hear: HearClip = (clip, speaker, source, speakerId) => hearing.heardClip(clip, speaker, source, speakerId);

      // The registry is read once before any source starts, so a connector already present is seen at start.
      const registry = new ConnectorRegistry(bus, opts.registryIntervalMs, (err) => log.warn({ err: String(err) }, "connector registry read failed"));
      await registry.start();
      const connectorNames = plan.runnable.filter((s) => s.kind === "connector").map((s) => s.name);

      // The one `http` listener, shared by the `http` source and by every connector source whose registration says `http`.
      // It binds when `http` is enabled or when such a registration is first seen (EARS-SRC-009).
      // @spec EARS-SRC-013: the listener checks the delivered listener key; ears never reads CONTROL_TOKEN.
      const verifier = earsListenerVerifier(cfg);
      const httpCapture = createHttpCapture({
        host: cfg.ears.http.host, port: cfg.ears.http.port, hear, log, ...(verifier !== undefined ? { verifier } : {}),
        accepts: (tag) => connectorNames.includes(tag) && registry.offer("audio-in", tag)?.cap.transport === "http",
      });
      let httpStart: Promise<void> | undefined;
      const ensureHttp = (): Promise<void> => (httpStart ??= httpCapture.start());
      const listener = { ensure: ensureHttp, bound: () => httpCapture.status() === "ok" };

      const sources = new Map<string, ConnectorSource>();
      for (const src of plan.runnable) {
        if (src.kind === "http") {
          adapters.set("http", { name: "http", start: ensureHttp, stop: () => httpCapture.stop(), status: () => httpCapture.status() });
          // @spec EARS-SRC-013: no key delivered: every clip is refused 401, one warning, deps.http down; the other sources run.
          if (verifier === undefined) {
            const missing = "the http listener key (ears.http.verifier) is missing, so every POST /audio is refused 401: start ears through the control plane (Launch, Restart all or a unit start in the dashboard, or cohostctl), which delivers it";
            log.warn(missing);
            failed.set("http", missing);
          }
        } else if (src.kind === "dir") {
          adapters.set("dir", createDirCapture({ path: cfg.ears.dir.path, pollMs: cfg.ears.dir.poll_ms, hear, log }));
        } else {
          // @spec EARS-VAD-001, EARS-VAD-005, EARS-PART-001, EARS-PART-002
          const echoGated = gated.has(src.name);
          const cs = createConnectorSource({
            name: src.name, bus, registry, hear, log, silenceMs: cfg.ears.silence_ms, listener, maxUtteranceMs: cfg.ears.max_utterance_ms,
            ...(gate && echoGated ? { echoBlocked: (at: number) => gate.blocks(at) } : {}),
            ...(cfg.ears.vad.engine === "silero" ? { vad: { threshold: cfg.ears.vad.threshold, load: opts.loadVad ?? loadSilero } } : {}),
            ...(partialsOn ? { partials: {
              stepMs: cfg.ears.partial_step_ms, minSpeechMs: cfg.ears.min_speech_ms, dropPhrases: cfg.ears.drop_phrases,
              transcribe: (wav: Buffer) => rt.partial(wav), publish: async (data) => { await bus.publish("speech.partial", data); },
            } } : {}),
            streaming,
            // @spec EARS-SES-005: an echo-suppressed source never opens a session
            ...(rt.stream && !echoGated ? { stream: { router: rt, minSpeechMs: cfg.ears.min_speech_ms } } : {}),
            hearText: (text, durationMs, meta) => hearing.heardText(text, durationMs, meta),
            // @spec EARS-EARLY-001, EARS-EARLY-008: an echo-suppressed source never takes an early snapshot
            ...(earlyActive && !echoGated ? { early: {
              afterMs: cfg.ears.early.after_ms, max: cfg.ears.early.max_per_utterance, minSpeechMs: cfg.ears.min_speech_ms, dropPhrases: cfg.ears.drop_phrases,
              transcribe: (wav: Buffer) => rt.partial(wav),
              publish: async (data) => { await bus.publish("speech.early", data); },
              publishRetracted: async (data) => { await bus.publish("speech.retracted", data); },
              counts: earlyCounts,
            } } : {}),
          });
          sources.set(src.name, cs);
          adapters.set(src.name, cs);
        }
      }

      const statsText = (): string => [...sources.entries()].map(([n, s]) => `${n} ${s.stats()}`).join("; ");
      // @spec EARS-EARLY-011, EARS-EARLY-022
      const earlyText = (): string => {
        if (!earlyOn) return "";
        if (streaming) return "early reply off: streaming engine";
        return `early: ${earlyCounts.published} published, ${earlyCounts.retracted} retracted, ${earlyCounts.reused} reused, ${earlyCounts.late} late`;
      };
      const detailOf = (name: string): string => failed.get(name) ?? sources.get(name)?.detail() ?? "";
      /**
       * One heartbeat state from every source and the speech-to-text engine: degraded while any enabled source or `deps.stt`
       * is down, ready once all are up. The detail names the engine and its host (EARS-HLTH-009).
       */
      let reported = "";
      const refresh = (): void => {
        const down = plan.sources.filter((s) => s.gap !== undefined || statusOf(s.name) === "down");
        const sttDetail = h.sttDetail();
        const sttPart = [h.sttSummary(), sttDetail].filter((x) => x !== undefined).join(": ");
        if (down.length === 0 && sttDetail === undefined) {
          heartbeat.setDetail([statsText(), earlyText(), sttPart].filter((x) => x !== "").join("; ") || undefined);
          if (reported !== "ready") { reported = "ready"; heartbeat.ready(); }
          return;
        }
        const reasons = down.map((s) => s.gap ?? detailOf(s.name)).filter((d) => d !== "");
        const text = [...reasons, earlyText(), sttPart].filter((x) => x !== "").join("; ");
        if (reported !== `degraded:${text}`) { reported = `degraded:${text}`; heartbeat.degraded(text || undefined); }
      };
      h.changed = refresh;
      const unwatch = registry.on(refresh);
      const refreshTimer = setInterval(refresh, opts.refreshMs ?? 1000);
      refreshTimer.unref();

      // One shutdown step, first in reverse order: every source stops on its own (the clip in flight finishes), then the bus.
      onStop(async () => {
        h.changed = undefined;
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
