import { tracked, type HeartbeatSpec } from "@cohost/bus";
import type { Embedder } from "@cohost/llm";

type Dep = "ok" | "down";

/** Tracks memory's two dependencies from the calls it actually makes. */
export class MemoryHealth {
  private postgres: Dep = "down";
  private ollama: Dep = "down";

  /** `fake` = brain.memory.store is the in-process fake: mode `mock`, no real deps. */
  constructor(private fake = false) {}

  readonly spec: HeartbeatSpec = {
    service: "memory",
    mode: () => (this.fake ? "mock" : "live"),
    deps: () => (this.fake
      ? { postgres: "n/a", ollama: "n/a" }
      : { postgres: this.postgres, ollama: this.ollama }),
  };

  setOllama(ok: boolean): void { this.ollama = ok ? "ok" : "down"; }
  setPostgres(ok: boolean): void { this.postgres = ok ? "ok" : "down"; }

  /** An embedder whose success/failure drives `deps.ollama`. */
  embedder(inner: Embedder): Embedder {
    return { embed: tracked((t: string) => inner.embed(t), (ok) => this.setOllama(ok)) };
  }
}
