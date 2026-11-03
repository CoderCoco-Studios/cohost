/**
 * voice — turns `brain.say` into audio.
 *
 * Calls the TTS container (Kokoro-FastAPI, OpenAI-compatible), computes a
 * mouth envelope for lip-sync, keeps the WAV in memory and serves it over
 * HTTP so any "sink" (dashboard audio page captured by OBS, the Discord bot)
 * can fetch and play it. Sinks report `voice.playing` / `voice.done`; if no
 * sink picks an utterance up, a virtual sink times it so the brain moves on.
 */
import { Bus } from "@cohost/bus";
import { createLogger, envOr, loadConfig, urls } from "@cohost/config";
import { runVoice } from "./boot.js";

const log = createLogger("voice");

void runVoice({
  log,
  setup: () => {
    const cfg = loadConfig();
    return { cfg, bus: new Bus("voice", log), port: Number(envOr("VOICE_PORT", "8700")), publicUrl: urls.voice() };
  },
});
