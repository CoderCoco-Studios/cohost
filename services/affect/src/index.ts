/**
 * affect — the mood region (limbic system).
 *
 * Reads the same senses as everyone else and keeps a running valence/arousal
 * state that drifts back to baseline on its own. Publishes `affect.state` so:
 *   - the avatar can wear a resting expression between lines,
 *   - the cortex can colour its reply with the current mood,
 *   - salience can get chattier when things are exciting.
 * No LLM, no database — it's a couple of numbers and a half-life.
 */
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { createAppraiser } from "./appraise.js";
import { Affect } from "./affect.js";

const log = createLogger("affect");
const cfg = loadConfig();
const bus = new Bus("affect", log);
const appraiser = createAppraiser(cfg, log);
const affect = new Affect({ cfg, bus, appraiser, log });

async function main() {
  void bus.subscribe(
    { group: "affect", types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "control"], fromNow: true },
    (ev) => affect.onEvent(ev),
  );
  setInterval(() => affect.publish(), cfg.brain.affect.publish_ms);
  log.info({ half_life_ms: cfg.brain.affect.half_life_ms, appraiser: appraiser.kind }, "affect online");
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
