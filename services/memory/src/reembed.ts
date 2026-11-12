/**
 * reembed — run once after changing the embedder (`pnpm reembed`, or `node services/memory/dist/reembed.js`;
 * `docker compose run --rm reembed`, or `cohostctl reembed`) with the memory service stopped.
 *
 * Re-embeds every stored memory, viewer note and deletion record with the configured embedder and moves the vector
 * columns to its dimension, so a database the service refuses to start on ("memories table has vector(N)") becomes usable.
 * Text and every other column are untouched; an interrupted run leaves the old vectors serving and a rerun resumes.
 */
import { createLogger, loadConfig } from "@cohost/config";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { runReembed } from "./reembed-run.js";

const log = createLogger("reembed");
const cfg = loadConfig();
const store = createStore(cfg, createMemoryEmbedder(cfg), log);

// @spec MEM-REEMBED-006
runReembed({ cfg, store, log })
  .catch((err) => { log.error({ err }, "reembed failed"); process.exitCode = 1; });
