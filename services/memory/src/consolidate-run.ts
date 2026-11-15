import type { Config, Logger } from "@cohost/config";
import type { MemoryBackend } from "./store.js";
import { META_SHUTDOWN_RUN_OWED, runConsolidation, type Consolidator, type PassResult } from "./consolidation.js";

export interface ConsolidateDeps {
  cfg: Config;
  store: Pick<MemoryBackend, "connect" | "close" | "getViewer" | "listNotes" | "listDeletions" | "dirtyViewerKeys" | "commitViewer" | "purgeSoftDeletions" | "withConsolidationLock" | "setMeta">;
  hook: Consolidator;
  log: Logger;
  now?: () => number;
}

// @spec MEM-CONSOL-012, MEM-CONSOL-017
/**
 * The one-shot `consolidate` command: one pass over every viewer with a dirty note, whatever `dirty_threshold` says and without
 * waiting for the cortex, then clears `notes.shutdown_run_owed` and closes the store. Like `reflect`, it opens the store with `connect()` (tables exist, no DDL, no embedder probe). Rejects on failure (the entry point exits 1);
 * resolves undefined, running no pass, with the in-memory store (nothing persists across processes).
 */
export async function runConsolidate({ cfg, store, hook, log, now }: ConsolidateDeps): Promise<PassResult | undefined> {
  if (cfg.brain.memory.store === "memory") {
    log.warn("consolidate does nothing with brain.memory.store=memory: notes do not persist across processes");
    return undefined;
  }
  try {
    await store.connect();
    const result = await runConsolidation({ store, hook, cfg: cfg.brain.memory, log, now });
    if (result.status === "completed") await store.setMeta(META_SHUTDOWN_RUN_OWED, "false");
    return result;
  } finally {
    await store.close();
  }
}
