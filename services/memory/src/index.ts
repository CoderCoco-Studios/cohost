/**
 * memory — the hippocampus. The only region that touches Postgres.
 *
 * Writes: everything that addresses the co-host, everything said in voice,
 * and everything the co-host says itself gets embedded and stored. Viewers
 * get a row so regulars are recognised.
 *
 * Reads: answers `memory.recall.request` with `memory.recall.reply`, and
 * announces `memory.viewer` when someone who addressed the co-host is new
 * or a regular. The cortex is the usual caller, but any region may ask.
 *
 * Consolidation ("sleep") is reflect.ts, run between streams.
 */
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { Ollama } from "@cohost/llm";
import { MemoryHealth } from "./health.js";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { createMemoryHandler } from "./region.js";
import { startMemory } from "./startup.js";

const log = createLogger("memory");
const cfg = loadConfig();
const bus = new Bus("memory", log);
const health = new MemoryHealth(cfg.brain.memory);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });
const rawEmbedder = createMemoryEmbedder(cfg); // ollama is local whatever the chat provider; hash is offline
const store = createStore(cfg, health.embedder(rawEmbedder), log, (ok) => health.setPostgres(ok)); // @spec MEM-HEALTH-005
const onEvent = createMemoryHandler({ cfg, bus, store, log });

const main = () => startMemory({
  cfg: cfg.brain.memory,
  log,
  bus,
  store,
  health,
  heartbeat,
  ping: () => new Ollama(cfg.llm).ping(),
  onEvent,
  sleep,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// @spec MEM-START-006
main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); await store.close(); });
