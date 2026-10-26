/**
 * voice — turns `brain.say` into audio.
 *
 * Calls the TTS container (Kokoro-FastAPI, OpenAI-compatible), computes a
 * mouth envelope for lip-sync, keeps the WAV in memory and serves it over
 * HTTP so any "sink" (dashboard audio page captured by OBS, the Discord bot)
 * can fetch and play it. Sinks report `voice.playing` / `voice.done`; if no
 * sink picks an utterance up, a virtual sink times it so the brain moves on.
 */
import http from "node:http";
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, envOr, loadConfig, urls } from "@cohost/config";
import { Voice, kokoroSynth, stubSynth } from "./voice.js";
import { VoiceHealth } from "./health.js";

const log = createLogger("voice");
const cfg = loadConfig();
const bus = new Bus("voice", log);
const health = new VoiceHealth(cfg.voice.engine);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });
const PORT = Number(envOr("VOICE_PORT", "8700"));
const PUBLIC = urls.voice();
if (cfg.voice.engine === "stub") log.warn("voice.engine is stub: no TTS, utterances are silent (mode mock)");
const synth = cfg.voice.engine === "stub" ? stubSynth(cfg.voice) : health.track(kokoroSynth(cfg.voice));
const voice = new Voice({ bus, log, synth, publicUrl: PUBLIC });

const server = http.createServer(voice.handle);
server.listen(PORT, () => { heartbeat.ready(); log.info({ port: PORT, public: PUBLIC, voice: cfg.voice.voice }, "voice online"); });

void bus.subscribe({ group: "voice", types: ["brain.say", "voice.playing"], fromNow: true }, (ev) => voice.onEvent(ev));

onShutdown(() => { server.close(); bus.stop(); });
