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
 * Consolidation ("sleep") is reflect.ts, run between streams. Viewer notes are
 * tidied by a pass (consolidation.ts) the scheduler starts when enough notes are
 * dirty, while the cortex is idle; consolidate.ts runs one after shutdown.
 */
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { Ollama } from "@cohost/llm";
import { MemoryHealth } from "./health.js";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { createMemoryHandler } from "./region.js";
import { runConsolidation } from "./consolidation.js";
import { createConsolidatorHook } from "./consolidator.js";
import { ConsolidationScheduler } from "./scheduler.js";
import { startMemory } from "./startup.js";

const log = createLogger("memory");
const cfg = loadConfig();
const bus = new Bus("memory", log);
const health = new MemoryHealth(cfg.brain.memory);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });
const rawEmbedder = createMemoryEmbedder(cfg); // ollama is local whatever the chat provider; hash is offline
const store = createStore(cfg, health.embedder(rawEmbedder), log, (ok) => health.setPostgres(ok)); // @spec MEM-HEALTH-005
// Viewer-note consolidation: the hook is the cortex's model through local ollama; the scheduler decides when it runs.
const consolidator = createConsolidatorHook(cfg, log);
const scheduler = new ConsolidationScheduler({
  store,
  cfg: cfg.brain.memory.notes,
  log,
  runPass: ({ gate, signal }) => runConsolidation({ store, hook: consolidator, cfg: cfg.brain.memory, log, gate, signal }),
});
const onEvent = createMemoryHandler({ cfg, bus, store, admin: store, log, onBrainStatus: (state) => scheduler.onBrainStatus(state) });

const main = () => startMemory({
  cfg: cfg.brain.memory,
  log,
  bus,
  store,
  health,
  heartbeat,
  ping: () => new Ollama(cfg.llm).ping(),
  onEvent,
  onStarted: () => scheduler.startup(), // @spec MEM-CONSOL-015
  sleep,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// @spec MEM-START-006
main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
// @spec MEM-CONSOL-013
onShutdown(async () => { bus.stop(); await scheduler.shutdown(); await store.close(); });
