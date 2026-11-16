import type { Config } from "./schema.js";

/** Local Ollama model names a config needs: `required` must be pulled, `optional` degrade a hook to its rules fallback when missing. */
export interface OllamaModels { required: string[]; optional: string[] }

/**
 * Which Ollama models this config needs, so the model names live only in `config.yaml`. `required` holds `llm.model`,
 * `llm.embed_model` and `vision.model` while their provider or engine is `ollama` (an empty vision model is none);
 * `optional` holds the model of each hook of `kind: llm` whose provider, its own or the inherited `llm.provider`, is `ollama`,
 * an unset hook model meaning `llm.model`. Neither list repeats a name, and `optional` leaves out names `required` holds.
 */
// @spec CFG-MODEL-001
export function ollamaModels(config: Config): OllamaModels {
  const required = new Set<string>();
  if (config.llm.provider === "ollama") required.add(config.llm.model);
  if (config.brain.memory.embedder === "ollama") required.add(config.llm.embed_model);
  if (config.vision.engine === "ollama" && config.vision.model) required.add(config.vision.model);

  const hooks = [
    config.brain.salience.module, config.brain.affect.module, config.brain.cortex.critic,
    config.brain.memory.notes.capture, config.brain.memory.notes.consolidator,
  ];
  const optional = new Set<string>();
  for (const hook of hooks) {
    if (hook.kind !== "llm") continue;
    if ((hook.llm.provider ?? config.llm.provider) !== "ollama") continue;
    const model = hook.llm.model ?? config.llm.model;
    if (!required.has(model)) optional.add(model);
  }
  return { required: [...required], optional: [...optional] };
}
