/**
 * affect — the mood region (limbic system).
 *
 * Reads the same senses as everyone else and keeps a running valence/arousal
 * state that drifts back to baseline on its own. Publishes `affect.state` so:
 *   - the avatar can wear a resting expression between lines,
 *   - the cortex can colour its reply with the current mood,
 *   - salience can get chattier when things are exciting.
 * No database, and no model on the default path: the mood is a couple of numbers and a
 * half-life, and the default `rules` appraiser is word lists. An `llm` or `http` appraiser
 * (`brain.affect.module`) puts a model behind the appraisal of each line, never behind the
 * mood arithmetic itself.
 */

import { runAffect } from "./main.js";

void runAffect(); // the shared bootstrap handles failures: it logs and exits 1
