import type { Bus } from "@cohost/bus";
import { retryWithBackoff, type Heartbeat } from "@cohost/shared";
import type { Config, Logger } from "@cohost/config";
import type { BusEvent } from "@cohost/bus";
import type { MemoryHealth } from "./health.js";
import { DimensionMismatchError, type MemoryBackend } from "./store.js";

/** Everything the startup sequence touches, injected so it can be tested without Redis, Ollama or Postgres. */
export interface StartupDeps {
  cfg: Config["brain"]["memory"];
  log: Logger;
  bus: Pick<Bus, "subscribe">;
  store: Pick<MemoryBackend, "init">;
  health: Pick<MemoryHealth, "setOllama" | "setPostgres">;
  heartbeat: Pick<Heartbeat, "ready" | "degraded">;
  /** True once Ollama answers. */
  ping: () => Promise<boolean>;
  onEvent: (ev: BusEvent) => Promise<void>;
  /** Live note capture (MEM-CAPTURE-001): when given, it is the handler of a third consumer group, `memory-notes`, for `chat.message`. */
  onCaptureEvent?: (ev: BusEvent) => Promise<void>;
  /** Called once the service is ready: the consolidation catch-up check (MEM-CONSOL-015). Its failure never fails startup. */
  onStarted?: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const RETRY_MS = 3000;
const MAX_INIT_RETRIES = 20;

/** Wait for dependencies, initialise the store, subscribe both consumer groups, report ready. Throws on fatal startup errors. */
export async function startMemory({ cfg, log, bus, store, health, heartbeat, ping, onEvent, onCaptureEvent, onStarted, sleep }: StartupDeps): Promise<void> {
  const { store: storeKind, embedder: embedderKind } = cfg;
  // @spec MEM-START-004
  if (storeKind !== "postgres" || embedderKind !== "ollama") {
    log.warn({ store: storeKind, embedder: embedderKind }, "memory running with a non-default backend (mode mock); data is not durable");
  }
  // @spec MEM-START-001, MEM-HEALTH-007
  if (storeKind === "postgres" && embedderKind === "ollama") {
    await retryWithBackoff(async () => {
      if (!(await ping())) { health.setOllama(false); throw new Error("ollama does not answer"); }
    }, {
      baseMs: RETRY_MS, maxMs: RETRY_MS, factor: 1, sleep,
      onFailure: () => {
        heartbeat.degraded("waiting for ollama (embeddings)");
        log.warn("waiting for ollama (embeddings)...");
      },
    });
    health.setOllama(true);
  }
  // @spec MEM-START-002, MEM-HEALTH-004, MEM-HEALTH-006, MEM-HEALTH-007, MEM-STORE-002
  if (storeKind === "postgres") {
    let tries = 0;
    await retryWithBackoff(async () => {
      tries++;
      try { await store.init(); health.setPostgres(true); }
      catch (err) { health.setPostgres(false); throw err; }
    }, {
      baseMs: RETRY_MS, maxMs: RETRY_MS, factor: 1, sleep,
      // A configuration error, not an outage: retrying cannot fix it. Nor can retrying forever.
      isFatal: (err) => err instanceof DimensionMismatchError || tries > MAX_INIT_RETRIES,
      onFailure: (err, attempt) => {
        heartbeat.degraded(`waiting for postgres (init attempt ${attempt} failed)`);
        log.warn({ err: String(err) }, "postgres not ready, retrying in 3s");
      },
    });
  } else {
    // @spec MEM-START-003
    await store.init();
  }
  // @spec MEM-EVT-001, MEM-START-005, MEM-SURF-001
  // Two consumer groups so a recall never queues behind the (embed + INSERT) writes.
  // `ready` waits for both groups to exist; a subscription that rejects first fails startup.
  const groupReady = (): { ready: Promise<void>; onReady: () => void } => {
    let onReady!: () => void;
    const ready = new Promise<void>((resolve) => { onReady = resolve; });
    return { ready, onReady };
  };
  const main = groupReady();
  const recall = groupReady();
  const groups = [main, recall];
  const running = [
    bus.subscribe({ group: "memory", types: ["chat.message", "speech.heard", "brain.say", "brain.status"], start: "resume", onReady: main.onReady }, onEvent),
    bus.subscribe({ group: "memory-recall", types: ["memory.recall.request", "memory.notes.request", "memory.viewers.request"], start: "resume", onReady: recall.onReady }, onEvent),
  ];
  // @spec MEM-CAPTURE-001, MEM-VOICE-003
  // A third group for note capture, so a slow classifier call never delays memory writes or recall answers.
  if (onCaptureEvent) {
    const notes = groupReady();
    groups.push(notes);
    running.push(bus.subscribe({ group: "memory-notes", types: ["chat.message", "speech.heard"], start: "resume", onReady: notes.onReady }, onCaptureEvent));
  }
  // The subscriptions run until the bus stops; only their early failure matters here.
  await Promise.race([Promise.all(groups.map((g) => g.ready)), ...running]);
  heartbeat.ready();
  log.info({ recall_k: cfg.recall_k }, "memory online");
  // @spec MEM-CONSOL-015
  await onStarted?.().catch((err) => log.warn({ err: String(err) }, "consolidation catch-up check failed"));
}
