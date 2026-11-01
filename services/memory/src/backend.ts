import type { Config, Logger } from "@cohost/config";
import { HashEmbedder, Ollama, type Embedder } from "@cohost/llm";
import { InMemoryStore } from "./fake-store.js";
import { MemoryStore, type MemoryBackend } from "./store.js";

// @spec MEM-BACKEND-003
/** Embedder per `brain.memory.embedder`: `ollama` is always the real client, `hash` never touches the network. */
export function createMemoryEmbedder(cfg: Config): Embedder {
  return cfg.brain.memory.embedder === "hash" ? new HashEmbedder() : new Ollama(cfg.llm);
}

// @spec MEM-BACKEND-001, MEM-BACKEND-002
/** Store per `brain.memory.store` (Postgres is only opened when selected). */
export function createStore(cfg: Config, embedder: Embedder, log: Logger): MemoryBackend {
  return cfg.brain.memory.store === "memory"
    ? new InMemoryStore(cfg.brain.memory) // main's fake: own hashed bag-of-words, ignores `embedder`
    : new MemoryStore(embedder, cfg.brain.memory, log);
}
