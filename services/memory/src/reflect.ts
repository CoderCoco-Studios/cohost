/**
 * reflect — run after a stream (`mise run reflect` or
 * `docker compose run --rm memory node services/memory/dist/reflect.js`).
 *
 * Reads everything remembered since the last reflection, asks the LLM what
 * the co-host should carry forward, and appends it to the "## Learned"
 * section of personality.md. This is how the personality drifts over time
 * instead of resetting every stream. Edit the file by hand whenever you like.
 */
import { createLogger, loadConfig, type Config, loadPersonality, savePersonality } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { runReflectCommand } from "./reflect-run.js";

// @spec MEM-START-007
const log = createLogger("reflect");
let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err)); // no store opened, no model called
  process.exit(1);
}
const llm = createChatProvider(cfg.llm);
const memory = createStore(cfg, createMemoryEmbedder(cfg), log);

await runReflectCommand({ cfg, llm, memory, log, loadPersonality, savePersonality, now: () => new Date() });
