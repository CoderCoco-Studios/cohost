/**
 * reflect — run after a stream (`pnpm reflect` or
 * `docker compose run --rm memory node services/memory/dist/reflect.js`).
 *
 * Reads everything remembered since the last reflection, asks the LLM what
 * the co-host should carry forward, and appends it to the "## Learned"
 * section of personality.md. This is how the personality drifts over time
 * instead of resetting every stream. Edit the file by hand whenever you like.
 */
import { createLogger, loadConfig, loadPersonality, savePersonality } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { runReflect } from "./reflect-run.js";

const log = createLogger("reflect");
const cfg = loadConfig();
const llm = createChatProvider(cfg.llm);
const memory = createStore(cfg, createMemoryEmbedder(cfg), log);

const main = () => runReflect({ cfg, llm, memory, log, loadPersonality, savePersonality, now: () => new Date() });

// @spec MEM-REFLECT-009
main()
  .catch((err) => { log.error({ err }, "reflect failed"); process.exitCode = 1; })
  .finally(() => memory.close());
