/**
 * salience — the attention region (think amygdala + salience network).
 *
 * Watches every sense on the bus, keeps its own short working memory, and
 * decides *when* the co-host should speak. The chat path never talks to the
 * LLM: when something is worth a response it publishes `attention.focus` and
 * the cortex takes it from there (only the optional `llm` scorer kind calls a
 * model, to rate events). It also owns the reflex fast path — canned reactions
 * that go straight to `brain.say` without waiting for anyone to think.
 *
 * Inputs it listens to from other regions: `affect.state` (an excited mood
 * lowers the bar to speak), `brain.status` / `brain.say` (don't pile on while
 * the cortex is thinking or the voice is still playing).
 */
import { createLogger } from "@cohost/config";
import { main } from "./main.js";

void main(createLogger("salience")); // main() handles its own failures: logs `fatal` and exits 1
