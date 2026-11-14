import { tracked, type HeartbeatSpec } from "@cohost/shared";
import type { Config } from "@cohost/config";
import type { Embedder } from "@cohost/llm";
import type { hookHealth } from "@cohost/modules";

type Dep = "ok" | "down";

/**
 * Tracks memory's two dependencies from the calls it actually makes.
 * A dependency the config doesn't use (`memory` store, `hash` embedder) reports `n/a`,
 * and either one being non-default makes the mode `mock`.
 */
export class MemoryHealth {
  private postgres: Dep = "down";
  private ollama: Dep = "down";
  private hooks?: ReturnType<typeof hookHealth>;

  readonly spec: HeartbeatSpec;

  // @spec MEM-HEALTH-001, MEM-HEALTH-002
  constructor(backend: Pick<Config["brain"]["memory"], "store" | "embedder"> = { store: "postgres", embedder: "ollama" }) {
    const usesPg = backend.store === "postgres";
    const usesOllama = usesPg && backend.embedder === "ollama"; // the in-process fake never embeds via Ollama
    this.spec = {
      service: "memory",
      mode: () => (usesPg && usesOllama && this.hooks?.mode() !== "mock" ? "live" : "mock"),
      deps: () => ({ postgres: usesPg ? this.postgres : "n/a", ollama: usesOllama ? this.ollama : "n/a", ...this.hooks?.deps() }),
    };
  }

  // @spec MEM-HEALTH-008
  /** Adds the notes hooks' dependencies to `deps` and makes the mode `mock` while either hook runs on the mock provider. */
  attachHooks(hooks: ReturnType<typeof hookHealth>): void { this.hooks = hooks; }

  setOllama(ok: boolean): void { this.ollama = ok ? "ok" : "down"; }
  setPostgres(ok: boolean): void { this.postgres = ok ? "ok" : "down"; }

  // @spec MEM-HEALTH-003
  /** An embedder whose success/failure drives `deps.ollama`. */
  embedder(inner: Embedder): Embedder {
    return { embed: tracked((t: string) => inner.embed(t), (ok) => this.setOllama(ok)) };
  }
}
