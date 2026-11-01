/**
 * salience — the attention region (think amygdala + salience network).
 *
 * Watches every sense on the bus, keeps its own short working memory, and
 * decides *when* the co-host should speak. It never talks to the LLM: when
 * something is worth a response it publishes `attention.focus` and the cortex
 * takes it from there. It also owns the reflex fast path — canned reactions
 * that go straight to `brain.say` without waiting for anyone to think.
 *
 * Inputs it listens to from other regions: `affect.state` (an excited mood
 * lowers the bar to speak), `brain.status` / `brain.say` (don't pile on while
 * the cortex is thinking or the voice is still playing).
 */
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { createScorer } from "./scoring.js";
import { Salience } from "./salience.js";
import { salienceHealth } from "./health.js";

const log = createLogger("salience");
const cfg = loadConfig();
const bus = new Bus("salience", log);
const heartbeat = startHeartbeat(bus, { ...salienceHealth, log }); // @spec SAL-HEALTH-001
const scorer = createScorer(cfg, log); // @spec SAL-SCORE-007
const salience = new Salience({ cfg, bus, scorer, log });

async function main() {
  void bus.subscribe( // @spec SAL-IN-001
    {
      group: "salience",
      types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "brain.status", "affect.state", "control"],
      fromNow: true,
    },
    (ev) => salience.onEvent(ev),
  );
  setInterval(() => void salience.tick(), cfg.brain.salience.tick_ms); // @spec SAL-FOCUS-001
  heartbeat.ready();
  log.info({ reflexes: salience.reflexes.size, threshold: cfg.brain.salience.speak_threshold, scorer: scorer.kind }, "salience online");
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); }); // @spec SAL-HEALTH-003
onShutdown(async () => { bus.stop(); });
