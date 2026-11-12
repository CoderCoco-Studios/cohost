import type { Config, Logger } from "@cohost/config";
import type { MemoryBackend, ReembedResult } from "./store.js";

export interface ReembedDeps {
  cfg: Config;
  store: Pick<MemoryBackend, "reembed" | "withConsolidationLock" | "close">;
  log: Logger;
}

// @spec MEM-REEMBED-001, MEM-REEMBED-002, MEM-REEMBED-004, MEM-REEMBED-005
/**
 * The one-shot `reembed` command: move every stored vector to the configured embedder's dimension while holding the
 * consolidation lock, then close the store. Rejects on failure (the entry point exits 1); resolves undefined, doing
 * nothing, with the in-memory store (nothing persists across processes).
 */
export async function runReembed({ cfg, store, log }: ReembedDeps): Promise<ReembedResult | undefined> {
  try {
    if (cfg.brain.memory.store === "memory") {
      log.warn("reembed does nothing with brain.memory.store=memory: vectors do not persist across processes");
      return undefined;
    }
    const out = await store.withConsolidationLock(() => store.reembed((table, done) => log.info({ table, done }, "re-embedding")));
    if (!out.ran) throw new Error("another memory pass holds the consolidation lock; try again when it has finished");
    const res = out.value;
    if (Object.keys(res.tables).length === 0) log.info({ dims: res.dims }, "reembed unchanged: every vector column already has the embedder's dimension");
    else log.info({ dims: res.dims, tables: res.tables }, "reembed completed");
    return res;
  } finally {
    await store.close();
  }
}
