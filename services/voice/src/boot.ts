import http from "node:http";
import { type Bus, type SubscribeStart } from "@cohost/bus";
import { join } from "node:path";
import { dataDir, envOr, urls, type Config, type Logger } from "@cohost/config";
import { runService, type RunServiceOptions } from "@cohost/shared";
import { Voice, kokoroRequestSettings, kokoroSynth, stubSynth } from "./voice.js";
import { ClipService } from "./clips.js";
import { VoiceHealth } from "./health.js";

/** What boot needs from a Bus (a fake in tests). */
export type VoiceBus = Pick<Bus, "publish" | "publishHealth" | "consumer" | "resetGroup" | "subscribe" | "stop">;

/** Everything is optional: the defaults are the process's real configuration, bus, signals and exit. The replacements are for tests. */
export interface VoiceBoot extends Pick<RunServiceOptions<VoiceBus>, "log" | "loadConfig" | "createBus" | "onShutdown" | "exit"> {
  /** HTTP port; default `VOICE_PORT`, else 8700. */
  port?: number;
  /** Base URL sinks fetch audio from; default `urls.voice()`. */
  publicUrl?: string;
  /** The fallback clip store; default `<dataDir()>/voice/fallback-clips`. */
  clipDir?: string;
}

/** The voice subscription's start mode: `brain.say` is never replayed after a restart (VOICE-SYN-001). */
const START: SubscribeStart = "latest";

/**
 * Start the voice service and run its bus loop until it ends, through the shared `runService` bootstrap: a
 * configuration that does not load, any later startup failure (binding the port, positioning the consumer group) or a
 * subscription that rejects past the bus's own retry ends the process with status 1 (the latter two logged `fatal`).
 */
export async function runVoice(boot: VoiceBoot = {}): Promise<void> { // @spec VOICE-SYN-006, VOICE-HLTH-001, VOICE-HLTH-004
  let health: VoiceHealth | undefined;
  await runService<VoiceBus>({
    service: "voice",
    health: (cfg: Config) => (health = new VoiceHealth(cfg.voice.engine)).spec,
    log: boot.log,
    loadConfig: boot.loadConfig,
    createBus: boot.createBus,
    onShutdown: boot.onShutdown,
    exit: boot.exit,
    main: async ({ cfg, bus, log, heartbeat, onStop }) => {
      const port = boot.port ?? Number(envOr("VOICE_PORT", "8700"));
      const publicUrl = boot.publicUrl ?? urls.voice();
      if (cfg.voice.engine === "stub") log.warn("voice.engine is stub: no TTS, utterances are silent (mode mock)"); // @spec VOICE-STUB-003
      const synth = cfg.voice.engine === "stub" ? stubSynth(cfg.voice) : health!.track(kokoroSynth(cfg.voice)); // @spec VOICE-STUB-002, VOICE-HLTH-002
      // The stub engine has no clip service: it never touches the store and the fallback routes answer 404 (VOICE-CLIP-008).
      const clips = cfg.voice.engine === "stub" ? undefined : new ClipService({
        dir: boot.clipDir ?? join(dataDir(), "voice", "fallback-clips"),
        lines: cfg.voice.fallback.lines,
        engine: cfg.voice.engine,
        settings: kokoroRequestSettings(cfg.voice),
        synth,
        log: log as Logger,
      });
      const voice = new Voice({ bus, log, synth, publicUrl, clips });

      const server = http.createServer(voice.handle);
      onStop(() => { voice.stop(); clips?.stop(); server.close(); }); // @spec VOICE-HLTH-004, VOICE-HLTH-005
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); }); // @spec VOICE-HTTP-005

      // Ready means "can receive brain.say": the group exists at the newest entry before the loop reads.
      await bus.resetGroup("voice");
      heartbeat.ready(); // @spec VOICE-HLTH-001
      void clips?.start(); // in the background, after ready: a brain.say never waits on clip generation (VOICE-CLIP-003)
      log.info({ port, public: publicUrl, voice: cfg.voice.voice }, "voice online");

      await bus.subscribe({ group: "voice", types: ["brain.say", "voice.playing", "voice.failed", "voice.stop"], start: START }, (ev) => voice.onEvent(ev)); // @spec VOICE-SYN-001, VOICE-SINK-010, VOICE-STOP-001
    },
  });
}
