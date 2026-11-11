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
import { Bus } from "@cohost/bus";
import { onShutdown, startHeartbeat } from "@cohost/shared";
import { createLogger, loadConfig, loadPersonality } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { createCritic } from "./critic.js";
import { Cortex } from "./cortex.js";
import { cortexHealth } from "./health.js";
import { startCortex, trackLlm, waitForLlm } from "./startup.js";

const log = createLogger("cortex");
const cfg = loadConfig();
const bus = new Bus("cortex", log);
const provider = createChatProvider(cfg.llm);
let llmOk = false;
// A provider whose ping always answers true says nothing until a reply has been tried (CTX-HEALTH-004).
let llmProbed = !provider.pingIsNominal;
const heartbeat = startHeartbeat(bus, { ...cortexHealth(() => llmOk, cfg.llm.provider, () => llmProbed, provider.pingIsNominal === true), log });
// @spec CTX-HEALTH-003
const llm = trackLlm(provider, (ok) => { llmOk = ok; llmProbed = true; });
const critic = createCritic(cfg, log);
const cortex = new Cortex({ cfg, bus, llm, critic, log, loadPersonality });

async function main() {
  // @spec CTX-START-002
  if (llm.name === "mock") log.warn("llm.provider is mock: replies are canned echoes, not a real model (mode mock)");
  // @spec CTX-START-001, CTX-HEALTH-002
  await waitForLlm(provider, { log, setOk: (ok) => { llmOk = ok; }, onDown: (detail) => heartbeat.degraded(detail) });
  await startCortex({ bus, cortex, heartbeat, onFatal: (err) => { log.error({ err }, "fatal"); process.exit(1); } });
  log.info({ provider: llm.name, model: llm.model, critic: critic.kind, name: cfg.cohost.name }, "cortex online");
}

// @spec CTX-START-004
main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
