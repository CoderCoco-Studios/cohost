/**
 * memory — the hippocampus. The only region that touches Postgres.
 *
 * Writes: everything that addresses the co-host, everything said in voice,
 * and everything the co-host says itself gets embedded and stored. Viewers
 * get a row so regulars are recognised.
 *
 * Reads: answers `memory.recall.request` with `memory.recall.reply`, and
 * announces `memory.viewer` when someone who addressed the co-host is new
 * or a regular. The cortex is the usual caller, but any region may ask.
 *
 * Consolidation ("sleep") is reflect.ts, run between streams.
 */
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { createEmbedder, Ollama } from "@cohost/llm";
import { MemoryStore } from "./store.js";
import { createMemoryHandler } from "./region.js";

const log = createLogger("memory");
const cfg = loadConfig();
const bus = new Bus("memory", log);
const ollama = new Ollama(cfg.llm); // embeddings are always local, whatever the chat provider
const store = new MemoryStore(createEmbedder(cfg.llm), cfg.brain.memory, log);
const onEvent = createMemoryHandler({ cfg, bus, store });

async function main() {
  while (!(await ollama.ping())) {
    log.warn("waiting for ollama (embeddings)...");
    await sleep(3000);
  }
  for (let attempt = 1; ; attempt++) {
    try { await store.init(); break; }
    catch (err) {
      if (attempt > 20) throw err;
      log.warn({ err: String(err) }, "postgres not ready, retrying in 3s");
      await sleep(3000);
    }
  }
  // Two consumer groups so a recall never queues behind the (embed + INSERT) writes.
  void bus.subscribe({ group: "memory", types: ["chat.message", "speech.heard", "brain.say"], fromNow: true }, onEvent);
  void bus.subscribe({ group: "memory-recall", types: ["memory.recall.request"], fromNow: true }, onEvent);
  log.info({ recall_k: cfg.brain.memory.recall_k }, "memory online");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); await store.close(); });
