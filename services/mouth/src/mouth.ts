/**
 * mouth's wiring: the startup plan, the outputs it runs, the one bus loop that feeds them, the fallback clip refresh and
 * the teardown steps. `runService` (index.ts) calls `health` and then `main`; tests call the same two with fakes.
 */
import { ConnectorRegistry, type Bus } from "@cohost/bus";
import { dataDir, urls, type Config } from "@cohost/config";
import { controlFor, startIdle, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { ClipCache, ClipMirror, clipDir, startClipSync } from "./clips.js";
import { createConnectorOutput, type ConnectorOutput } from "./connector-output.js";
import { createDryrunOutput } from "./dryrun.js";
import { createFileOutput } from "./file-output.js";
import { ClaimMemory, FallbackLine } from "./fallback.js";
import { MouthHealth, mouthPlan } from "./health.js";
import { createHttpOutput, type HttpPost } from "./http-output.js";
import { Routing, setRoutingHandler, type RunningOutputs } from "./routing.js";
import { createMouthHandler, subscribeMouth, type MouthOutput } from "./session.js";
import { join } from "node:path";

/** What mouth needs from the bus: publish, the one subscription, audio frames, the connector registry, heartbeats and stop. */
export type MouthBus = Pick<Bus, "publish" | "publishHealth" | "resetGroup" | "subscribe" | "stop" | "consumer" | "publishFrame" | "listConnectors">;

export interface MouthOptions {
  // Replacements for tests.
  clipSync?: typeof startClipSync;
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** One `http` output delivery attempt (default: `fetch`). */
  httpPost?: HttpPost;
  /** How often the connector registry is re-read, ms (default 5000, the registration interval). */
  registryIntervalMs?: number;
}

/**
 * One mouth service: `health(cfg)` is the heartbeat spec for `runService`, `main(ctx)` the service itself. Both read the same
 * plan, derived from the config.
 */
// @spec MOUTH-START-006, MOUTH-START-001, MOUTH-START-003, MOUTH-START-004, MOUTH-START-005, MOUTH-DRY-001, MOUTH-DRY-005, MOUTH-LIVE-001, MOUTH-LIVE-004, MOUTH-SINK-001, MOUTH-CONN-001, MOUTH-CONN-002, MOUTH-CONN-003, MOUTH-HLTH-002
export function createMouth(opts: MouthOptions = {}) {
  const ready = new Map<string, boolean>();
  /** The `discord` output, once `main` has started it; its readiness is the connector's sink registration. */
  let discord: ConnectorOutput | undefined;
  /** The live routing, once `main` has started the outputs; the heartbeat reads it for outputs switched off live. */
  let routing: Routing | undefined;

  return {
    health(cfg: Config): HeartbeatSpec {
      const plan = mouthPlan(cfg.mouth.outputs);
      const isReady = (name: string): boolean => (name === "discord" ? discord?.isReady() ?? false : ready.get(name) ?? false);
      return new MouthHealth(plan, cfg.mouth.outputs, isReady, (name) => !routing?.isSwitchedOff(name)).spec;
    },

    async main({ cfg, bus, log, heartbeat, onStop }: ServiceContext<MouthBus>): Promise<void> {
      const o = cfg.mouth.outputs;
      const plan = mouthPlan(o);
      // The idle plan: no subscription, no clips, nothing published but the heartbeat.
      if (plan === "off") {
        const idle = startIdle({ heartbeat, log, kind: "off", reason: "no mouth output is enabled: idle, nothing played" });
        onStop(() => idle.stop());
        return;
      }

      // discord | local: one clip cache and claim memory for every output; each output has its own fallback line state.
      const cache = new ClipCache();
      const claims = new ClaimMemory();
      const fallbackFor = (sink: string) => new FallbackLine({ cache, claims, sink, minIntervalMs: cfg.mouth.fallback.min_interval_ms });
      const outputs: MouthOutput[] = [];
      const running: RunningOutputs = {};

      // @spec MOUTH-CONN-002, MOUTH-CONN-003
      if (plan === "discord") {
        // The Discord output is a sink served by the Discord connector: mouth reads the registry, writes frames, holds no client.
        const registry = new ConnectorRegistry(bus, opts.registryIntervalMs, (err) => log.warn({ err: String(err) }, "connector registry read failed"));
        await registry.start();
        onStop(() => registry.stop());
        discord = createConnectorOutput({
          bus, registry, log, tag: "discord", fallback: fallbackFor("discord"), fetchAudio: opts.fetchAudio,
          gainDb: () => routing?.gainDb("discord") ?? o.discord.gain_db,
        });
        outputs.push(discord);
        running.discord = { gain_db: o.discord.gain_db };
      }
      if (o.dryrun.enabled) {
        const dry = createDryrunOutput({ bus, log, failEvery: o.dryrun.fail_every, fallback: fallbackFor("dryrun"), fetchAudio: opts.fetchAudio });
        ready.set("dryrun", true);
        outputs.push(dry);
        running.dryrun = {};
      }
      // @spec MOUTH-FILE-001, MOUTH-HTTP-001, MOUTH-HTTP-005
      if (o.file.enabled) {
        const file = createFileOutput({ bus, log, dir: join(dataDir(), o.file.dir), maxFiles: o.file.max_files, fetchAudio: opts.fetchAudio });
        outputs.push(file);
        running.file = {};
      }
      if (o.http.enabled) {
        const http = createHttpOutput({
          bus, log, url: o.http.url, timeoutMs: o.http.timeout_ms, retries: o.http.retries, maxQueue: o.http.max_queue,
          fetchAudio: opts.fetchAudio, post: opts.httpPost,
        });
        outputs.push(http);
        running.http = {};
      }
      routing = new Routing(running);
      // The heartbeat's per-output readiness for the outputs with no connection of their own.
      for (const out of outputs) if (out.name === "file" || out.name === "http") ready.set(out.name, out.isReady());
      for (const out of outputs) if (out.close) onStop(() => out.close!());

      // One loop for the whole `mouth` group (MOUTH-PLAY-001, MOUTH-START-005).
      // mouth's only `control` command is `set_routing` (MOUTH-LIVE-001); mute and pause are ignored (MOUTH-PLAY-008).
      const control = controlFor("mouth", { set_routing: setRoutingHandler(routing, { heartbeat, log }) }, { log });
      await subscribeMouth(bus, createMouthHandler({
        outputs, claims, log, bus,
        onUnknownRoute: (ids) => heartbeat.setDetail(`route ignored unknown output id ${ids.map((i) => JSON.stringify(i)).join(", ")}; ${routing!.detail()}`),
        enabled: (name) => routing!.isEnabled(name), control }), log);

      // @spec MOUTH-FALL-012, MOUTH-FALL-014, MOUTH-FALL-018
      const clipSync = (opts.clipSync ?? startClipSync)({ baseUrl: urls.voice(), cache, mirror: new ClipMirror(clipDir(dataDir())), log });
      onStop(() => clipSync.stop());

      // A `discord` output with no connector behind it is a dependency `down` (the heartbeat turns degraded by itself);
      // mouth keeps running and starts playing on it when the sink appears (CONN-ISO-001).
      heartbeat.ready();
    },
  };
}
