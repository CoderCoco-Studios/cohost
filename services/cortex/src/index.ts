/**
 * cortex — the language region (prefrontal + Broca's, if you like).
 *
 * The only region that calls the chat LLM. It keeps its own working memory
 * of the conversation and waits to be told what to do:
 *   - salience says `attention.focus`  → think, then publish `brain.say`
 *   - memory answers `memory.recall.reply` and volunteers `memory.viewer`
 *   - affect says `affect.state`        → colours the prompt
 *   - the operator says `control`       → mute / say / reload personality
 *
 * It does not decide *whether* to speak and it does not remember anything
 * past the window — those are other regions' jobs. If the memory region is
 * down it simply answers without recall.
 */
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, loadConfig, loadPersonality } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { createCritic } from "./critic.js";
import { Cortex } from "./cortex.js";

const log = createLogger("cortex");
const cfg = loadConfig();
const bus = new Bus("cortex", log);
const llm = createChatProvider(cfg.llm);
const critic = createCritic(cfg, log);
const cortex = new Cortex({ cfg, bus, llm, critic, log, loadPersonality });

async function main() {
  while (!(await llm.ping())) {
    log.warn({ provider: llm.name, model: llm.model, error: llm.lastError }, "waiting for the model backend...");
    await sleep(3000);
  }
  await cortex.status("idle");
  void bus.subscribe(
    {
      group: "cortex",
      types: [
        "chat.message", "speech.heard", "vision.summary", "brain.say", "voice.done",
        "attention.focus", "memory.recall.reply", "memory.viewer", "affect.state", "control",
      ],
      fromNow: true,
    },
    (ev) => cortex.onEvent(ev),
  );
  log.info({ provider: llm.name, model: llm.model, critic: critic.kind, name: cfg.cohost.name }, "cortex online");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
