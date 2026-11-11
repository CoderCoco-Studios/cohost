import http from "node:http";
import { type Bus, type SubscribeStart } from "@cohost/bus";
import { onShutdown, startHeartbeat } from "@cohost/shared";
import { join } from "node:path";
import { dataDir, type Config, type Logger } from "@cohost/config";
import { Voice, kokoroRequestSettings, kokoroSynth, stubSynth } from "./voice.js";
import { ClipService } from "./clips.js";
import { VoiceHealth } from "./health.js";

/** What boot needs from a Bus (a fake in tests). */
export type VoiceBus = Pick<Bus, "publish" | "publishHealth" | "consumer" | "resetGroup" | "subscribe" | "stop">;

export interface VoiceBoot {
  log: Logger;
  /** Load config and build the bus and endpoints. Runs inside the fatal handler, so a failure here logs `fatal`. */
  setup(): { cfg: Config; bus: VoiceBus; port: number; publicUrl: string; /** The fallback clip store; default `<dataDir()>/voice/fallback-clips`. */ clipDir?: string };
  onShutdown?: (fn: () => void | Promise<void>) => void;
  exit?: (code: number) => void;
}

/** The voice subscription's start mode: `brain.say` is never replayed after a restart (VOICE-SYN-001). */
const START: SubscribeStart = "latest";

/**
 * Start the voice service and run its bus loop until it ends. Any failure — setup, listening, positioning
 * the consumer group, or a subscription that rejects past the bus's own retry — is logged with message
 * `fatal` and ends the process with status 1.
 */
export async function runVoice(boot: VoiceBoot): Promise<void> { // @spec VOICE-SYN-006, VOICE-CLIP-003, VOICE-CLIP-008
  const { log } = boot;
  try {
    const { cfg, bus, port, publicUrl, clipDir } = boot.setup();
    const health = new VoiceHealth(cfg.voice.engine);
    const heartbeat = startHeartbeat(bus, { ...health.spec, log });
    if (cfg.voice.engine === "stub") log.warn("voice.engine is stub: no TTS, utterances are silent (mode mock)"); // @spec VOICE-STUB-003
    const synth = cfg.voice.engine === "stub" ? stubSynth(cfg.voice) : health.track(kokoroSynth(cfg.voice)); // @spec VOICE-STUB-002, VOICE-HLTH-002
    // The stub engine has no clip service: it never touches the store and the fallback routes answer 404 (VOICE-CLIP-008).
    const clips = cfg.voice.engine === "stub" ? undefined : new ClipService({
      dir: clipDir ?? join(dataDir(), "voice", "fallback-clips"),
      lines: cfg.voice.fallback.lines,
      engine: cfg.voice.engine,
      settings: kokoroRequestSettings(cfg.voice),
      synth,
      log,
    });
    const voice = new Voice({ bus, log, synth, publicUrl, clips });

    const server = http.createServer(voice.handle);
    (boot.onShutdown ?? onShutdown)(() => { clips?.stop(); server.close(); bus.stop(); }); // @spec VOICE-HLTH-004
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); }); // @spec VOICE-HTTP-005

    // Ready means "can receive brain.say": the group exists at the newest entry before the loop reads.
    await bus.resetGroup("voice");
    heartbeat.ready(); // @spec VOICE-HLTH-001
    void clips?.start(); // in the background, after ready: a brain.say never waits on clip generation (VOICE-CLIP-003)
    log.info({ port, public: publicUrl, voice: cfg.voice.voice }, "voice online");

    await bus.subscribe({ group: "voice", types: ["brain.say", "voice.playing", "voice.failed"], start: START }, (ev) => voice.onEvent(ev)); // @spec VOICE-SYN-001, VOICE-SINK-010
  } catch (err) {
    log.error({ err }, "fatal");
    (boot.exit ?? ((code: number) => process.exit(code)))(1);
  }
}
