/**
 * consolidate — run once after the AI is shut down (`pnpm consolidate`, or
 * `node services/memory/dist/consolidate.js`; `docker compose run --rm consolidate`, or `cohostctl consolidate`).
 *
 * Tidies every viewer note that has not been looked at yet: fades and promotes
 * notes, drops what the owner asked to forget, and has the consolidator model merge
 * duplicates and recheck sensitivity. Optional: if it is not run, the memory
 * service catches up on the next start.
 */
import { createLogger, loadConfig } from "@cohost/config";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { createConsolidatorHook } from "./consolidator.js";
import { runConsolidate } from "./consolidate-run.js";

const log = createLogger("consolidate");
const cfg = loadConfig();
const store = createStore(cfg, createMemoryEmbedder(cfg), log);
const hook = createConsolidatorHook(cfg, log);

// @spec MEM-CONSOL-012
runConsolidate({ cfg, store, hook, log })
  .then((res) => { if (res) log.info(res, `consolidate ${res.status}`); })
  .catch((err) => { log.error({ err }, "consolidate failed"); process.exitCode = 1; });
