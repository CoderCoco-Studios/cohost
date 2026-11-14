import type { Bus } from "@cohost/bus";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { createLogger } from "@cohost/config";
import { Ollama } from "@cohost/llm";
import { MemoryHealth } from "./health.js";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { createMemoryHandler } from "./region.js";
import { runConsolidation } from "./consolidation.js";
import { createConsolidatorHook } from "./consolidator.js";
import { createCaptureHandler, createCaptureHook } from "./capture.js";
import { ConsolidationScheduler } from "./scheduler.js";
import { startMemory } from "./startup.js";

/** What `memoryMain` needs from a Bus; tests pass a fake. */
export type MemoryBus = HealthPublisher & Pick<Bus, "publish" | "subscribe" | "stop">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, signals or exit. */
export type MemoryEnv = Pick<RunServiceOptions<MemoryBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Builds the store, handlers and consolidation scheduler, then starts the subscriptions (startMemory). */
export async function memoryMain(ctx: ServiceContext<MemoryBus>, health: MemoryHealth, env: Pick<MemoryEnv, "sleep"> = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
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
  // Live note capture: its own small model (never the cortex's), in its own consumer group; new dirty notes feed the scheduler.
  const onCaptureEvent = createCaptureHandler({
    cfg: cfg.brain.memory,
    store,
    hook: createCaptureHook(cfg, log),
    log,
    onNotesWritten: () => scheduler.notifyDirty(), // @spec MEM-CONSOL-001
  });
  // @spec MEM-CONSOL-013, MEM-START-006
  // The bus stops first so no handler runs against a closing store, then the shutdown run is owed and the store closes.
  onStop(async () => { await bus.stop(); await scheduler.shutdown(); await store.close(); });
  await startMemory({
    cfg: cfg.brain.memory,
    log,
    bus,
    store,
    health,
    heartbeat,
    ping: () => new Ollama(cfg.llm).ping(),
    onEvent,
    onCaptureEvent,
    onStarted: () => scheduler.startup(), // @spec MEM-CONSOL-015
    sleep: env.sleep ?? realSleep,
  });
}

/** The service entry: bootstrap, then `memoryMain`. */
export function runMemory(env: MemoryEnv = {}): Promise<void> { // @spec MEM-START-006
  const { sleep, ...boot } = env;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("memory");
  let health!: MemoryHealth;
  return runService<MemoryBus>({
    service: "memory",
    health: (cfg) => { health = new MemoryHealth(cfg.brain.memory); return health.spec; },
    main: (ctx) => memoryMain(ctx, health, { sleep }),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); });
}
